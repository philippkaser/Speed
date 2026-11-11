// The camera's picture (src/render/sensor.ts), its lens (src/render/lens.ts) and its iris
// (src/render/aperture.ts): tone curve, colour rendering, lens PSF and diffraction star.
import { expect, test } from 'bun:test'
import { CURVE, pictureRGB, toneCurve } from '../src/render/sensor'
import { SCATTER, scatterWeights } from '../src/render/lens'
import { computeStar, STAR_SIZE } from '../src/render/aperture'

const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

test('tone curve: anchored, monotonic, smooth, deep blacks and a soft shoulder into white', () => {
  expect(toneCurve(CURVE.keyIn)).toBeCloseTo(CURVE.keyOut, 6)
  let prev = 0,
    prevSlope = Infinity
  for (let ev = -12; ev <= 10; ev += 0.05) {
    const x = CURVE.keyIn * 2 ** ev
    const y = toneCurve(x)
    expect(y).toBeGreaterThan(prev)
    expect(y).toBeLessThan(1)
    // log-log slope changes smoothly (no kink anywhere, no hard clip)
    const slope = Math.log(toneCurve(x * 1.01) / y) / Math.log(1.01)
    if (ev > -11) expect(Math.abs(slope - prevSlope)).toBeLessThan(0.04)
    prev = y
    prevSlope = slope
  }
  // shadows: four stops under the key are near black; highlights: clouds keep detail, the sun is white
  expect(toneCurve(CURVE.keyIn / 16)).toBeLessThan(0.01)
  expect(toneCurve(1.5)).toBeLessThan(0.97)
  expect(toneCurve(64)).toBeGreaterThan(0.998)
  // headroom: sunlit paint and a sunlit white panel stay well under display white, so a bright car
  // keeps its colour and shading and the reflections in its clear coat show against it
  expect(toneCurve(0.8)).toBeLessThan(0.72)
  expect(toneCurve(1.2)).toBeLessThan(0.82)
  expect(toneCurve(4)).toBeGreaterThan(0.93)
  // contrast: a hard shadow on asphalt (2.5 stops under sunlit asphalt, the key) is at least 4.4 stops
  // darker on the display, and a stop above the key still opens up (by at least 1.3 stops)
  expect(Math.log2(CURVE.keyOut / toneCurve(CURVE.keyIn / 2 ** 2.5))).toBeGreaterThan(4.4)
  expect(Math.log2(toneCurve(CURVE.keyIn * 2) / CURVE.keyOut)).toBeGreaterThan(1.3)
})

test('picture: greys stay neutral, bright colours keep their hue on the way to white', () => {
  for (const x of [0.01, 0.13, 1, 10]) {
    const [r, g, b] = pictureRGB([x, x, x])
    expect(Math.abs(r - g)).toBeLessThan(2e-3)
    expect(Math.abs(b - g)).toBeLessThan(2e-3)
  }
  // a saturated red (a brake light, a red car in the sun): brighter with exposure, red stays the
  // largest channel and green never overtakes blue by much (no drift to orange / yellow) until white
  let prevL = 0
  for (let ev = -4; ev <= 9; ev += 0.5) {
    const k = CURVE.keyIn * 2 ** ev
    const c = pictureRGB([k * 4, k * 0.2, k * 0.15])
    expect(lum(c)).toBeGreaterThanOrEqual(prevL - 1e-6)
    prevL = lum(c)
    expect(c[0]).toBeGreaterThanOrEqual(Math.max(c[1], c[2]) - 1e-6)
    if (c[0] < 0.999) expect(c[1] - c[2]).toBeLessThan(0.25)
  }
  // far beyond white everything is white
  const w = pictureRGB([500, 20, 5])
  expect(Math.min(...w)).toBeGreaterThan(0.95)
})

test('lens scatter: energy is SCATTER.k and the PSF is the same at every resolution', () => {
  const energyWithin = (h: number, r: number) => {
    const { a, s } = scatterWeights(h)
    return a.reduce((acc, ai, i) => acc + ai * (1 - Math.exp(-(r * r) / (2 * s[i] * s[i]))), 0)
  }
  for (const h of [360, 540, 720, 1080, 1440, 2160]) {
    const { a } = scatterWeights(h)
    expect(a.reduce((x, y) => x + y, 0)).toBeCloseTo(SCATTER.k, 6)
  }
  for (const r of [0.01, 0.03, 0.1, 0.3]) {
    const ref = energyWithin(1080, r)
    for (const h of [720, 1440, 2160]) expect(Math.abs(energyWithin(h, r) - ref)).toBeLessThan(0.15 * SCATTER.k)
  }
  // long tailed: a real share of the scattered light reaches past a tenth of the frame
  expect(SCATTER.k - energyWithin(1080, 0.1)).toBeGreaterThan(0.08 * SCATTER.k)
})

test('diffraction star: spikes only (no core), unit mean, point symmetric', () => {
  const s = computeStar()
  const S = STAR_SIZE
  let sum = 0,
    core = 0,
    asym = 0,
    tot = 0
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 3
      for (let c = 0; c < 3; c++) {
        expect(Number.isFinite(s[i + c]) && s[i + c] >= 0).toBe(true)
      }
      const l = lum([s[i], s[i + 1], s[i + 2]])
      sum += l
      if (Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2) < 2) core += l
      // the far field of a real aperture is point symmetric: compare with the mirrored texel
      const j = ((S - 1 - y) * S + (S - 1 - x)) * 3
      if (x > 8 && y > 8) {
        asym += Math.abs(l - lum([s[j], s[j + 1], s[j + 2]]))
        tot += l
      }
    }
  expect(sum / (S * S)).toBeCloseTo(1, 3)
  expect(core).toBe(0)
  expect(asym / tot).toBeLessThan(0.05)
})

test('HDR tone curve: the SDR curve at P = 1, the same mid-tones, highlights up to the peak', async () => {
  const { toneCurve, toneCurveHDR, CURVE } = await import('../src/render/sensor')
  for (const x of [0.001, 0.01, 0.13, 1, 10, 100]) expect(toneCurveHDR(x, 1)).toBeCloseTo(toneCurve(x), 10)
  for (const P of [2, 4.9, 10]) {
    // the key (sunlit asphalt) lands exactly where SDR puts it
    expect(toneCurveHDR(CURVE.keyIn, P)).toBeCloseTo(CURVE.keyOut, 8)
    // shadows within a third of a stop of SDR (the soft SDR shoulder already bends the curve at the
    // key, the HDR one does not, so with the key held the toe sits a little lower), the shoulder
    // opens up, never beyond the peak, monotonic
    expect(Math.abs(toneCurveHDR(0.01, P) / toneCurve(0.01) - 1)).toBeLessThan(0.26)
    expect(toneCurveHDR(8, P)).toBeGreaterThan(toneCurve(8) * 1.2)
    let prev = 0
    for (let x = 1e-4; x < 1e4; x *= 1.2) {
      const y = toneCurveHDR(x, P)
      expect(y).toBeGreaterThanOrEqual(prev)
      expect(y).toBeLessThanOrEqual(P)
      prev = y
    }
  }
})
