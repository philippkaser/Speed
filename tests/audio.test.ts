import { expect, test } from 'bun:test'

// Minimal AudioWorklet global scope so the real processor can run headless.
type Proc = new (o: { processorOptions: object }) => { process: (i: unknown, o: Float32Array[][], p: Record<string, Float32Array>) => boolean }
const g = globalThis as unknown as Record<string, unknown>
let registered: Proc | null = null
g.sampleRate = 48000
g.AudioWorkletProcessor = class {}
g.registerProcessor = (_name: string, cls: Proc) => {
  registered = cls
}
await import('../src/audio/engine-worklet.js')

function render(layout: string, rpm: number, load: number, seconds = 0.5) {
  const P = registered!
  const proc = new P({ processorOptions: { layout } })
  const block = 128
  const out = new Float32Array(Math.floor((48000 * seconds) / block) * block)
  const params = { rpm: new Float32Array([rpm]), load: new Float32Array([load]), boost: new Float32Array([load * 0.8]), crackle: new Float32Array([0]), gain: new Float32Array([0.55]) }
  for (let i = 0; i < out.length; i += block) {
    const L = new Float32Array(block),
      R = new Float32Array(block)
    proc.process([], [[L, R]], params)
    out.set(L, i)
  }
  return out
}

function stats(x: Float32Array) {
  let sum = 0,
    peak = 0,
    finite = true
  // skip the parameter smoothing ramp
  for (let i = x.length / 2; i < x.length; i++) {
    const v = x[i]
    if (!Number.isFinite(v)) finite = false
    sum += v * v
    peak = Math.max(peak, Math.abs(v))
  }
  return { rms: Math.sqrt(sum / (x.length / 2)), peak, finite }
}

test('engine synthesiser produces bounded, load-dependent sound', () => {
  expect(registered).not.toBeNull()
  for (const layout of ['V8-cross', 'V8-flat']) {
    const idle = stats(render(layout, 1000, 0))
    const wot = stats(render(layout, 7000, 1))
    console.log(`${layout}: idle rms ${idle.rms.toFixed(3)}  full load @7000 rms ${wot.rms.toFixed(3)} peak ${wot.peak.toFixed(2)}`)
    expect(idle.finite && wot.finite).toBe(true)
    expect(wot.peak).toBeLessThan(1)
    expect(wot.rms).toBeGreaterThan(idle.rms)
    expect(idle.rms).toBeGreaterThan(0.005)
  }
})
