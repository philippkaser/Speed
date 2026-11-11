// Auto exposure: the camera meters the scene and sets its exposure, as a real camera does.
//
//  - Metering: the frame at 64 x 36 cells, each the average of 4 x 4 points of the exposed image (at
//    the base exposure: auto exposure's own share is divided out, so the meter never chases itself),
//    stored as log2 luminance with a weight from a centre-weighted pattern that favours the subject
//    (the lower middle of the frame: the car, the road ahead) over the sky. Read back asynchronously
//    every few frames (36 KB).
//  - Evaluation (CPU): a weighted histogram of the cells; the darkest 30% (tyre wells, deep shade) and
//    the brightest 10% (the sun, its glints, white clouds) are left out and the rest averaged in log
//    space, and the exposure follows 80% of its distance from KEY (partially, as an eye adapts): a
//    darker scene (cockpit, shade, pit garage, a TV shot down onto the track) gets more exposure, a
//    brighter one (looking into the sun, a wide shot full of sky) less, within minEv..maxEv stops of
//    the base exposure. KEY is calibrated on sunny chase views, so there the auto exposure sits near 0
//    and the game looks the same with it off.
//  - Adaptation: in stops, exponentially, faster when stopping down (light floods in) than when opening
//    up, as an eye does; after the start and after a camera cut (a new TV camera) the first readings
//    set the exposure directly.
import * as THREE from 'three/webgpu'
import { exp, float, Fn, log2, luminance, rtt, uv, vec2, vec4 } from 'three/tsl'

type N = any

const W = 64,
  H = 36
const TAPS = 4

export const AE = {
  /** share of the (weighted) histogram left out at the dark and the bright end */
  low: 0.3,
  high: 0.9,
  /** what the metered average is exposed to (before the tone curve), calibrated on sunny chase views */
  key: 0.28,
  /** share of the metered difference the exposure follows (a camera exposing for the cockpit blows
   *  out the windscreen; facing the sun it stops down without turning day to dusk) */
  strength: 0.8,
  /** the same when the scene meters darker than the key (opening up): a frame filled with asphalt and
   *  tyres, or a cockpit, must not lift the sunlit car and sky into the shoulder */
  openStrength: 0.5,
  /** range of the auto exposure around the base exposure, in stops */
  minEv: -2,
  maxEv: 2,
  /** adaptation rates (1/s): opening up (darker scene), stopping down (brighter scene) */
  openRate: 1.2,
  closeRate: 3,
  /** frames between meter readbacks */
  every: 4,
}

/** The meter: log2 luminance (r) and metering weight (g) per cell. */
export function exposureMeter(exposed: N, adapt: N) {
  const node = Fn(() => {
    const p = uv()
    const acc = float(0).toVar()
    for (let i = 0; i < TAPS; i++)
      for (let j = 0; j < TAPS; j++) {
        const o = vec2(((i + 0.5) / TAPS - 0.5) / W, ((j + 0.5) / TAPS - 0.5) / H)
        acc.addAssign(luminance(exposed.sample(p.add(o)).rgb))
      }
    const l = acc.div(TAPS * TAPS).div(adapt).max(1e-5)
    // centre-weighted towards the lower middle (uv y up): the subject counts most, the sky least
    const d = p.sub(vec2(0.5, 0.38)).div(vec2(0.34, 0.24))
    const w = exp(d.dot(d).negate()).mul(0.85).add(0.15)
    return vec4(log2(l), w, 0, 1)
  })()
  return rtt(node, W, H, { type: THREE.FloatType })
}

/** Weighted mean of log2 luminance between the low and high percentiles of the weights. */
export function evaluateMeter(px: ArrayLike<number>): number | null {
  const cells: [number, number][] = []
  let total = 0
  for (let i = 0; i + 1 < px.length; i += 4) {
    const l = px[i],
      w = px[i + 1]
    if (Number.isFinite(l) && Number.isFinite(w) && w > 0) {
      cells.push([l, w])
      total += w
    }
  }
  if (!cells.length) return null
  cells.sort((a, b) => a[0] - b[0])
  const lo = total * AE.low,
    hi = total * AE.high
  let c = 0,
    sum = 0,
    ws = 0
  for (const [l, w] of cells) {
    const a = Math.max(c, lo),
      b = Math.min(c + w, hi)
    if (b > a) {
      sum += l * (b - a)
      ws += b - a
    }
    c += w
    if (c >= hi) break
  }
  return ws > 0 ? sum / ws : null
}

/** Readings that set the exposure at once after the start and after a cut (the camera settles). */
const SETTLE = 6

/** State: the exposure (stops from the base), its target and the last metered value (log2). */
export const ae = { ev: 0, target: 0, measured: NaN, ready: false, pending: false, frame: 0, settle: 0, settleFrom: 0 }

/** Target exposure in stops for a metered log2 luminance. */
export const targetEv = (measured: number) => {
  const d = Math.log2(AE.key) - measured
  return Math.max(AE.minEv, Math.min(AE.maxEv, d * (d > 0 ? AE.openStrength : AE.strength)))
}

/**
 * One frame of auto exposure (after the frame is rendered): reads the meter every few frames and moves
 * the exposure towards its target. Returns the exposure in stops relative to the base.
 */
export function stepAutoExposure(renderer: THREE.WebGPURenderer, meter: { renderTarget: THREE.RenderTarget } | null, dt: number, cut: boolean) {
  if (!meter) {
    ae.ev = ae.target = 0
    ae.ready = false
    return 0
  }
  const frame = ae.frame++
  // a cut: the first readings of the new shot set the exposure at once
  if (cut) {
    ae.settle = SETTLE
    ae.settleFrom = frame
  }
  if (!ae.pending && frame % AE.every === 0) {
    ae.pending = true
    renderer
      .readRenderTargetPixelsAsync(meter.renderTarget, 0, 0, W, H)
      .then((px) => {
        const m = evaluateMeter(px as ArrayLike<number>)
        if (m === null) return
        ae.measured = m
        ae.target = targetEv(m)
        if (!ae.ready) {
          ae.ready = true
          ae.settle = SETTLE
          ae.settleFrom = 0
        }
        // settling: the first frames (still filling in) and a new shot are metered and set directly
        if (ae.settle > 0 && frame >= ae.settleFrom) {
          ae.ev = ae.target
          ae.settle--
        }
      })
      .catch(() => {})
      .finally(() => (ae.pending = false))
  }
  if (ae.ready) {
    const rate = ae.target > ae.ev ? AE.openRate : AE.closeRate
    ae.ev += (ae.target - ae.ev) * (1 - Math.exp(-Math.min(dt, 0.25) * rate))
  }
  return ae.ev
}
