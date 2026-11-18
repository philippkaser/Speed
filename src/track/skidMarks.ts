// Skid marks: what a weekend of racing leaves on the asphalt, baked once per track into a map in
// track coordinates (s along the lap, d across it) for the road and kerb shaders.
//
// Racing is messy. Every car brakes, slides and spins its wheels on a line a little different from the
// ideal one, and some of them make mistakes. So the marks are not drawn along the racing line: each
// is on its own car's line (carLine below: near the racing line and drifting across it, anywhere across
// the road, or on the inside), and they are of every kind:
//  - lock-ups into the braking zones: one or both front tyres, straight along the car's path, dark
//    where the tyre stopped and fading as the brakes come off, anywhere from on the line to well off it;
//  - slides through the corners: arcs that drift towards the outside as the car runs wide, often both
//    rear tyres, sometimes the fronts as well a little inside them; the heaviest crop of all;
//  - wheelspin out of the slow corners: dark where the power went down, fading, wobbling where the rear
//    stepped out and was caught;
//  - and on the straights a few: weaving to warm the tyres, a lock-up, wheelspin, a moment.
// Ages differ (faint and grey to fresh and black), many marks are broken where the tyre gripped for a
// moment. The live marks the cars lay during a session are decals on top (render/Effects.tsx).
import { clamp, smoothstep } from '../physics/math'
import type { Track } from './track'

/** Map cells: SKID_COLS across -SKID_HALF..SKID_HALF m (the road and its kerbs), up to SKID_ROWS rows along the lap. */
export const SKID_COLS = 256
export const SKID_HALF = 10
const SKID_ROWS = 8192
/** half the distance between a GT3's left and right tyres' marks (m) */
const AXLE = 0.8

export interface SkidMap {
  /** darkness 0..255, row-major (rows along the lap, SKID_COLS across) */
  data: Uint8Array
  rows: number
  /** metres of lap per row */
  rowLen: number
  /** marks laid, by kind */
  counts: Record<'lockup' | 'slide' | 'wheelspin' | 'straight', number>
  /** tyre tracks laid, and how many lie more than 2 m off the racing line at their middle */
  tracks: number
  offLine: number
}

/** A seeded PRNG (mulberry32): the same marks every time for a track. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Mark {
  s0: number
  len: number
  /** lateral position (m) at distance x along the mark */
  d: (x: number) => number
  /** darkness (0..1) at distance x along the mark (0..1 of its length: u) */
  a: (u: number) => number
  width: number
  /** share of the mark that is broken (the tyre gripped for a moment) */
  broken: number
}

/**
 * Bakes the marks. `density` scales how many (1: a race weekend's worth).
 */
export function bakeSkidMarks(track: Track, density = 1, seed = track.def.seed * 31 + 7): SkidMap {
  const r = rng(seed)
  const n = track.n
  const L = track.length
  const DSm = L / n
  const rows = Math.min(SKID_ROWS, Math.ceil(L / 0.5))
  const rowLen = L / rows
  const cell = (2 * SKID_HALF) / SKID_COLS
  const acc = new Float32Array(rows * SKID_COLS)
  const idx = (s: number) => ((Math.round(s / DSm) % n) + n) % n
  const gauss = () => (r() + r() + r() - 1.5) * 1.15

  // where the tyres work hardest
  const brake = track.brakeZone
  const corner = new Float32Array(n),
    exit = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = track.speed[i]
    corner[i] = clamp((v * v * Math.abs(track.racingCurv[i])) / 13, 0, 1)
    const dv = track.speed[(i + 4) % n] - v
    exit[i] = clamp(dv / 0.5, 0, 1) * (1 - smoothstep(30, 55, v))
  }

  const counts = { lockup: 0, slide: 0, wheelspin: 0, straight: 0 }
  let tracks = 0,
    offLine = 0
  const lay = (m: Mark) => {
    const steps = Math.ceil(m.len / rowLen)
    const mid = m.d(m.len / 2)
    tracks++
    if (Math.abs(mid - track.racing[idx(m.s0 + m.len / 2)]) > 2) offLine++
    // the breaks: a few gaps of 1-4 m where the tyre gripped
    const gaps: [number, number][] = []
    for (let g = 0; g < Math.round(m.broken * 4); g++) {
      const at = r() * m.len
      gaps.push([at, at + 1 + r() * 3])
    }
    for (let k = 0; k <= steps; k++) {
      const x = k * rowLen
      if (gaps.some(([a, b]) => x > a && x < b)) continue
      const s = m.s0 + x
      const i = idx(s)
      const d = m.d(x)
      // on the asphalt and the kerbs only
      const lim = d > 0 ? track.hw[i] + track.L.kerb[i] : track.hw[i] + track.R.kerb[i]
      if (Math.abs(d) > lim - 0.1) continue
      const a = m.a(x / m.len) * (0.8 + 0.2 * r())
      if (a <= 0.01) continue
      const row = ((Math.floor(s / rowLen) % rows) + rows) % rows
      const half = m.width / 2
      const c0 = Math.max(0, Math.floor((d - half - cell + SKID_HALF) / cell))
      const c1 = Math.min(SKID_COLS - 1, Math.ceil((d + half + cell + SKID_HALF) / cell))
      for (let c = c0; c <= c1; c++) {
        const dc = (c + 0.5) * cell - SKID_HALF
        // (never past the kerb, where the kerb starts or ends within the mark's width)
        if (Math.abs(dc) > (dc > 0 ? track.hw[i] + track.L.kerb[i] : track.hw[i] + track.R.kerb[i])) continue
        // the tyre's width with soft edges, a little lighter down the middle (the tread's grooves)
        const e = Math.abs(dc - d)
        const p = smoothstep(half + cell * 0.6, half - cell * 0.6, e) * (1 - 0.25 * smoothstep(half * 0.6, 0, e) * 0.5)
        const j = row * SKID_COLS + c
        acc[j] = 1 - (1 - acc[j]) * (1 - a * p)
      }
    }
  }
  const racing = (s: number) => track.racing[idx(s)]
  /**
   * The line of the car that left a mark, as a lateral position along it (m) from distance x. Most cars
   * are near the racing line, but not on it, and drifting across it; a good share are somewhere else
   * entirely (in traffic, side by side, on a lap of their own); some are on the inside, defending or
   * diving for a pass (`out`: the side of the outside of the corner).
   */
  const carLine = (s0: number, len: number, out: number): ((x: number) => number) => {
    const k = r()
    const slope = (r() - 0.5) * (2.4 / Math.max(len, 20))
    if (k < 0.5) {
      const o0 = gauss() * 1.3
      return (x) => racing(s0 + x) + o0 + slope * x
    }
    if (k < 0.82) {
      // anywhere across the road, following the road's sweep more than the racing line's
      const hw = track.hw[idx(s0)]
      const target = (r() * 2 - 1) * (hw - 1.1)
      const o0 = target - racing(s0) * 0.4
      return (x) => racing(s0 + x) * 0.4 + o0 + slope * x
    }
    const o0 = -out * (1.8 + r() * 2.4)
    return (x) => racing(s0 + x) + o0 + slope * x
  }
  /** a mark's darkness: fresh ones black, old ones grey */
  const age = () => 0.25 + 0.7 * r() ** 0.7

  for (let s = 0; s < L; s += 2.5) {
    const i = idx(s)
    const out = -Math.sign(track.racingCurv[i]) || 1
    const pB = 0.55 * brake[i],
      pC = 0.42 * corner[i],
      pE = 0.5 * exit[i],
      pS = 0.022
    const total = (pB + pC + pE + pS) * density
    if (r() > total) continue
    const pick = r() * (pB + pC + pE + pS)
    if (pick < pB) {
      // a lock-up into the braking zone: one front tyre or both, along the car's path (its own line)
      counts.lockup++
      const len = 6 + r() ** 1.5 * 34
      const path = carLine(s, len, out)
      const curve = (r() - 0.5) * 0.8
      const both = r() < 0.6
      const a0 = age()
      for (const side of both ? [-1, 1] : [r() < 0.5 ? -1 : 1])
        lay({ s0: s, len, width: 0.24, broken: r() * 0.6, d: (x) => path(x) + curve * (x / len) ** 2 + side * AXLE, a: (u) => a0 * (1 - 0.7 * u) * smoothstep(0, 0.04, u) })
    } else if (pick < pB + pC) {
      // a slide through the corner: the rear tyres drifting to the outside, the fronts a little
      // inside them; now and then one that runs right out to the edge
      counts.slide++
      const len = 10 + r() * 38
      const line = carLine(s, len, out)
      const wide = r() < 0.2
      const drift = wide ? 3 + r() * 3.5 : 0.3 + r() * 2.6
      const a0 = age()
      const fronts = r() < 0.35
      const path = (x: number) => line(x) + out * drift * smoothstep(0, 1, x / len)
      for (const side of [-1, 1]) {
        lay({ s0: s, len, width: 0.26, broken: r() * 0.8, d: (x) => path(x) + side * AXLE, a: (u) => a0 * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.6 })
        if (fronts) {
          // the fronts run inside the rears by the slip angle's offset
          const off = -out * (0.25 + r() * 0.45)
          lay({ s0: s + 1.2, len: len * 0.8, width: 0.24, broken: r(), d: (x) => path(x + 1.2) + side * AXLE + off, a: (u) => a0 * 0.6 * Math.sin(Math.PI * u) })
        }
      }
    } else if (pick < pB + pC + pE) {
      // wheelspin out of the corner: dark where the power went down, fading; a wobble where the rear
      // stepped out and was caught
      counts.wheelspin++
      const len = 7 + r() * 26
      const path = carLine(s, len, out)
      const wob = r() < 0.5 ? 0.15 + r() * 0.45 : 0
      const lam = 6 + r() * 8
      const a0 = age()
      for (const side of [-1, 1])
        lay({ s0: s, len, width: 0.27, broken: r() * 0.4, d: (x) => path(x) + wob * Math.sin((x / lam) * 2 * Math.PI) * (1 - x / len) + side * AXLE, a: (u) => a0 * (1 - u) ** 1.3 })
    } else {
      // the straights: weaving to warm the tyres, a lock-up, wheelspin, a moment
      counts.straight++
      const kind = r()
      const a0 = age() * 0.8
      if (kind < 0.45) {
        // (a driver's weave is not a clean sine: two of them, of different swings)
        const len = 40 + r() * 90
        const amp = 1.2 + r() * 2.3
        const lam = 28 + r() * 30,
          lam2 = 9 + r() * 9,
          ph = r() * 6.28
        const o0 = (r() - 0.5) * 4
        for (const side of [-1, 1])
          lay({ s0: s, len, width: 0.24, broken: 0.3 + r() * 0.6, d: (x) => racing(s + x) * 0.3 + o0 + amp * Math.sin((x / lam) * 2 * Math.PI) + 0.25 * amp * Math.sin((x / lam2) * 2 * Math.PI + ph) + side * AXLE, a: (u) => a0 * 0.55 * Math.sin(Math.PI * u) })
      } else {
        const len = 5 + r() * 20
        const o0 = (r() - 0.5) * 7
        const dir = (r() - 0.5) * 0.08
        for (const side of r() < 0.5 ? [-1, 1] : [r() < 0.5 ? -1 : 1])
          lay({ s0: s, len, width: 0.25, broken: r() * 0.5, d: (x) => racing(s + x) * 0.5 + o0 + dir * x + side * AXLE, a: (u) => a0 * (1 - 0.8 * u) })
      }
    }
  }

  const data = new Uint8Array(rows * SKID_COLS)
  for (let j = 0; j < acc.length; j++) data[j] = Math.round(clamp(acc[j], 0, 1) * 255)
  return { data, rows, rowLen, counts, tracks, offLine }
}
