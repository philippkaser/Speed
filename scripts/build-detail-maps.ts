// Surface detail maps for the procedural materials (render/surfaceDetail.ts): tileable data textures
// that every man-made surface samples for its small imperfections, instead of evaluating noise per
// pixel. One tile is meant for about a metre of surface (1 px ~ 1 mm).
//
//   bun scripts/build-detail-maps.ts     -> public/world/detail/detail-{a,b,c}.webp
//
// RGB only, near-lossless: a WebP encoder drops the colour under transparent pixels and browsers may
// premultiply the alpha, so no data goes in an alpha channel; a lossy WebP's colour conversion and
// chroma subsampling would mix the channels.
// detail-a (linear data)
//   R grain    fine multi-octave noise, 1-30 mm: pores, the grain of a cast or rolled surface
//   G mottle   broad noise, 5-60 cm: uneven wear, cure, paint thickness
//   B scratch  thin scratches of every length and weight, mostly along two directions (cleaning, wiping,
//              things dragged along), a faint field of finer ones
// detail-b
//   R streaks  rain streaks: noise stretched vertically (v is up on a wall)
//   G smudges  soft blots: fingerprints, splashes, wiped dirt
//   B chips    a ridged field: thresholded higher and higher it gives the chipped and worn areas of a
//              surface for more and more wear (paint chips, exposed primer and metal)
// detail-c
//   R pits     pores, pinholes and the odd larger air void (depth)
//   G spangle  galvanising crystals: a value per crystal (5-25 mm cells)
//   B peel     smooth round bumps (~16 px): the orange peel of paint when sampled at a few mm per bump
import { mkdirSync } from 'fs'
import sharp from 'sharp'

const S = 1024
const OUT = 'public/world/detail'

/** Seeded PRNG (mulberry32). */
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

/** Gradient noise periodic in `px` x `py` lattice cells (tiles exactly). */
function periodicNoise(seed: number, px: number, py: number) {
  const r = rng(seed)
  const gx = new Float32Array(px * py),
    gy = new Float32Array(px * py)
  for (let i = 0; i < px * py; i++) {
    const a = r() * Math.PI * 2
    gx[i] = Math.cos(a)
    gy[i] = Math.sin(a)
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  return (x: number, y: number) => {
    // x, y in lattice units
    const x0 = Math.floor(x),
      y0 = Math.floor(y)
    const fx = x - x0,
      fy = y - y0
    const ix0 = ((x0 % px) + px) % px,
      iy0 = ((y0 % py) + py) % py
    const ix1 = (ix0 + 1) % px,
      iy1 = (iy0 + 1) % py
    const d = (ix: number, iy: number, dx: number, dy: number) => gx[iy * px + ix] * dx + gy[iy * px + ix] * dy
    const u = fade(fx),
      v = fade(fy)
    const a = d(ix0, iy0, fx, fy) + u * (d(ix1, iy0, fx - 1, fy) - d(ix0, iy0, fx, fy))
    const b = d(ix0, iy1, fx, fy - 1) + u * (d(ix1, iy1, fx - 1, fy - 1) - d(ix0, iy1, fx, fy - 1))
    return a + v * (b - a)
  }
}

/** fBm over periodic octaves: `cells` lattice cells across the tile at the first octave. */
function fbm(seed: number, cells: number, octaves: number, gain = 0.5, stretchY = 1) {
  const oct = Array.from({ length: octaves }, (_, o) => {
    const c = cells << o
    const cy = Math.max(1, Math.round(c / stretchY))
    return { n: periodicNoise(seed + o * 101, c, cy), c, cy, w: gain ** o }
  })
  const wsum = oct.reduce((s, o) => s + o.w, 0)
  return (u: number, v: number) => {
    let s = 0
    for (const o of oct) s += o.n(u * o.c, v * o.cy) * o.w
    return s / wsum
  }
}

const buf = () => new Float32Array(S * S)

/** Normalise a field to mean 0.5 and the given standard deviation, clamped to 0..1. */
function normalise(f: Float32Array, sd: number) {
  let m = 0
  for (const x of f) m += x
  m /= f.length
  let v = 0
  for (const x of f) v += (x - m) ** 2
  const k = sd / Math.sqrt(v / f.length)
  for (let i = 0; i < f.length; i++) f[i] = Math.min(1, Math.max(0, 0.5 + (f[i] - m) * k))
  return f
}

function field(fn: (u: number, v: number) => number) {
  const f = buf()
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) f[y * S + x] = fn(x / S, y / S)
  return f
}

/** Adds an anti-aliased line (wrapping around the tile) of value `a` and half-width `w` px. */
function line(f: Float32Array, x0: number, y0: number, x1: number, y1: number, w: number, a: number, taper = true) {
  const len = Math.hypot(x1 - x0, y1 - y0)
  const steps = Math.ceil(len * 2)
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const cx = x0 + (x1 - x0) * t,
      cy = y0 + (y1 - y0) * t
    // a scratch is deepest in its middle and runs out at its ends
    const amp = taper ? a * Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.4 : a
    const r = Math.ceil(w + 1)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const px = Math.floor(cx) + dx,
          py = Math.floor(cy) + dy
        const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy)
        const c = Math.min(1, Math.max(0, w + 0.5 - d))
        if (c <= 0) continue
        const i = (((py % S) + S) % S) * S + (((px % S) + S) % S)
        f[i] = Math.max(f[i], amp * c)
      }
  }
}

/** Soft round dent of depth `a` and radius `rad` px, wrapping. */
function dent(f: Float32Array, cx: number, cy: number, rad: number, a: number) {
  const r = Math.ceil(rad + 1)
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy) / rad
      if (d >= 1) continue
      const i = (((Math.floor(cy) + dy) % S + S) % S) * S + (((Math.floor(cx) + dx) % S + S) % S)
      f[i] = Math.max(f[i], a * (1 - d * d))
    }
}

/** Voronoi cells (wrapping): a random value per cell, `n` cells across the tile. */
function voronoiValue(seed: number, n: number) {
  const r = rng(seed)
  const pts: { x: number; y: number; v: number }[] = []
  const grid = n
  for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) pts.push({ x: (i + r()) / grid, y: (j + r()) / grid, v: r() })
  const f = buf()
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S,
        v = y / S
      const ci = Math.floor(u * grid),
        cj = Math.floor(v * grid)
      let best = 1e9,
        val = 0
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = (ci + di + grid) % grid,
            jj = (cj + dj + grid) % grid
          const p = pts[jj * grid + ii]
          // the point's copy nearest this pixel (wrapping)
          let dx = p.x - u,
            dy = p.y - v
          dx -= Math.round(dx)
          dy -= Math.round(dy)
          const d = dx * dx + dy * dy
          if (d < best) {
            best = d
            val = p.v
          }
        }
      f[y * S + x] = val
    }
  return f
}

async function save(name: string, ch: Float32Array[]) {
  const px = new Uint8Array(S * S * 3)
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) px[i * 3 + c] = Math.round(Math.min(1, Math.max(0, ch[c][i])) * 255)
  const file = `${OUT}/${name}.webp`
  await sharp(Buffer.from(px), { raw: { width: S, height: S, channels: 3 } })
    .webp({ nearLossless: true, quality: 60, effort: 4 })
    .toFile(file)
  const { size } = Bun.file(file)
  console.log(`${file}: ${(size / 1024).toFixed(0)} kB`)
}

mkdirSync(OUT, { recursive: true })
const t0 = performance.now()

// ---- detail-a
const grain = normalise(
  (() => {
    const a = fbm(11, 32, 5, 0.62)
    return field((u, v) => a(u, v))
  })(),
  0.17,
)
const mottle = normalise(
  (() => {
    const a = fbm(23, 2, 4, 0.55)
    return field((u, v) => a(u, v))
  })(),
  0.17,
)
const scratch = buf()
{
  const r = rng(37)
  // the dominant directions of the wiping and dragging, and a spread around them
  const dirs = [0.35, 0.35 + Math.PI / 2 + 0.2]
  for (let k = 0; k < 900; k++) {
    const len = 8 + r() ** 2.2 * 260
    const base = r() < 0.75 ? dirs[k % 2] + (r() - 0.5) * 0.5 : r() * Math.PI
    const x0 = r() * S,
      y0 = r() * S
    const bend = (r() - 0.5) * 0.15
    const a = 0.25 + r() ** 1.5 * 0.75
    const w = r() < 0.85 ? 0.35 + r() * 0.4 : 0.8 + r() * 0.8
    // a slight curve: two segments
    const xm = x0 + (Math.cos(base) * len) / 2,
      ym = y0 + (Math.sin(base) * len) / 2
    line(scratch, x0, y0, xm, ym, w, a)
    line(scratch, xm, ym, xm + (Math.cos(base + bend) * len) / 2, ym + (Math.sin(base + bend) * len) / 2, w, a)
  }
  // the faint field of finer ones
  for (let k = 0; k < 2400; k++) {
    const len = 4 + r() * 40,
      th = r() * Math.PI
    const x0 = r() * S,
      y0 = r() * S
    line(scratch, x0, y0, x0 + Math.cos(th) * len, y0 + Math.sin(th) * len, 0.3, 0.12 + r() * 0.15)
  }
}
const pits = buf()
{
  const r = rng(53)
  for (let k = 0; k < 5200; k++) dent(pits, r() * S, r() * S, 0.8 + r() ** 2 * 3, 0.3 + r() * 0.7)
  // the odd larger air void
  for (let k = 0; k < 90; k++) dent(pits, r() * S, r() * S, 4 + r() * 7, 0.6 + r() * 0.4)
}
await save('detail-a', [grain, mottle, scratch])

// ---- detail-b
const streaks = normalise(
  (() => {
    // fine across, long down the wall
    const a = fbm(71, 24, 4, 0.6, 24)
    const b = fbm(73, 3, 3, 0.5)
    return field((u, v) => a(u, v) * 0.75 + b(u, v) * 0.25)
  })(),
  0.2,
)
const smudges = (() => {
  const a = fbm(83, 6, 4, 0.55)
  const f = field((u, v) => a(u, v))
  normalise(f, 0.2)
  // soft blots: only the upper part of the field
  for (let i = 0; i < f.length; i++) f[i] = Math.min(1, Math.max(0, (f[i] - 0.55) / 0.3)) ** 1.3
  return f
})()
const chips = normalise(
  (() => {
    const a = fbm(97, 8, 5, 0.58)
    const b = fbm(99, 40, 2, 0.5)
    // ridged: sharp-edged islands
    return field((u, v) => 1 - Math.abs(a(u, v) * 1.6) + b(u, v) * 0.25)
  })(),
  0.2,
)
await save('detail-b', [streaks, smudges, chips])
const spangle = voronoiValue(131, 64)
const peel = normalise(
  (() => {
    const a = fbm(151, 64, 2, 0.3)
    return field((u, v) => a(u, v))
  })(),
  0.18,
)
await save('detail-c', [pits, spangle, peel])

console.log(`detail maps in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
