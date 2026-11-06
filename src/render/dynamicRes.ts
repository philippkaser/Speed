// Resolution management: the output is always the display's native resolution; the scene (and every
// pass drawn from its G-buffer) renders at an internal scale that the temporal upscaler (taa.ts)
// reconstructs to the output, the way current console racing games and engines work (GT7's
// checkerboard 4K, FSR 2, DLSS, UE's TSR).
//
//  - A pixel budget per quality preset caps the internal resolution (High renders at most ~1440p and
//    upscales to a 4K display; at 1080p it renders natively).
//  - Dynamic resolution keeps the frame inside its budget: it measures the GPU's own time per frame
//    with timestamp queries where the browser offers them (so a CPU-bound frame never costs
//    resolution), the frame interval otherwise, and steers the scale with hysteresis, in steps small
//    enough to be invisible under the temporal upscaler, at most twice a second (a change resizes the
//    G-buffer).
import type * as THREE from 'three/webgpu'
import { renderScale } from './taa'

/** Internal pixel budgets (megapixels) of the presets. */
export const PIXEL_BUDGET = { low: 1.0, medium: 2.1, high: 3.7, ultra: 8.3 } as const

export const dynRes = {
  /** current internal scale (per axis) */
  scale: 1,
  /** the GPU's time for the last measured frame (ms), 0 if unknown */
  gpuMs: 0,
  /** smoothed frame interval (ms) */
  frameMs: 16.7,
  /** whether the GPU time comes from timestamp queries */
  timestamps: false,
  /** internal and output size, for the overlay */
  inW: 0,
  inH: 0,
  outW: 0,
  outH: 0,
}

interface Options {
  preset: keyof typeof PIXEL_BUDGET
  /** the player's cap on the internal scale (Settings: render resolution) */
  maxScale: number
  dynamic: boolean
  targetFps: number
  /** whether a temporal upscaler reconstructs the output (otherwise the scale stays fixed) */
  temporal: boolean
}

const STEP = 1 / 32
let _accT = 0
let _hist: number[] = []
let _pending = false
let _lastChange = 0

/** The scale cap from the preset's pixel budget for this output size. */
export function budgetScale(preset: keyof typeof PIXEL_BUDGET, outW: number, outH: number) {
  const px = Math.max(1, outW * outH) / 1e6
  return Math.min(1, Math.sqrt(PIXEL_BUDGET[preset] / px))
}

const quantise = (s: number) => Math.round(s / STEP) * STEP

/**
 * Called once per frame after rendering. Returns the internal scale to render the next frame at.
 */
export function stepDynamicRes(renderer: THREE.WebGPURenderer, dt: number, outW: number, outH: number, o: Options) {
  const now = performance.now()
  dynRes.outW = outW
  dynRes.outH = outH
  dynRes.frameMs += (dt * 1000 - dynRes.frameMs) * 0.1
  const backend = renderer.backend as unknown as { trackTimestamp?: boolean }
  dynRes.timestamps = !!backend.trackTimestamp
  if (dynRes.timestamps && !_pending) {
    _pending = true
    renderer
      .resolveTimestampsAsync('render' as never)
      .then((ms) => {
        if (typeof ms === 'number' && ms > 0) dynRes.gpuMs = ms
      })
      .catch(() => {})
      .finally(() => (_pending = false))
  }
  const cap = Math.max(0.5, Math.min(o.maxScale, budgetScale(o.preset, outW, outH)))
  const floorScale = Math.min(cap, o.preset === 'low' ? 0.5 : 0.6)
  let s = dynRes.scale
  if (!o.temporal || !o.dynamic) s = cap
  else {
    // the cost of this frame: the GPU's own time where measured, else the frame interval
    const cost = dynRes.timestamps && dynRes.gpuMs > 0 ? dynRes.gpuMs : dt * 1000
    _hist.push(cost)
    if (_hist.length > 90) _hist.shift()
    _accT += dt
    const budget = 1000 / o.targetFps
    if (_accT > 0.5 && _hist.length >= 20 && now - _lastChange > 500) {
      _accT = 0
      const sorted = [..._hist].sort((a, b) => a - b)
      const p90 = sorted[Math.floor(sorted.length * 0.9)]
      // GPU cost scales with pixels (scale squared): aim for 85% of the budget
      if (p90 > budget * 0.97) s = Math.max(floorScale, s * Math.max(0.85, Math.sqrt((budget * 0.85) / p90)))
      else if (p90 < budget * 0.72) s = Math.min(cap, s + 2 * STEP)
      s = quantise(Math.min(cap, Math.max(floorScale, s)))
      if (s !== dynRes.scale) {
        _lastChange = now
        _hist = []
      }
    }
    s = Math.min(cap, Math.max(floorScale, s))
  }
  dynRes.scale = s
  renderScale.value = s
  dynRes.inW = Math.floor(outW * s)
  dynRes.inH = Math.floor(outH * s)
  return s
}
