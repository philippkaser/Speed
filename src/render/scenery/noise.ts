// Fast CPU noise for build-time procedural geometry (mountains, placement): 2D gradient noise with
// a permutation table, fBm, ridged multifractal and a seeded random generator.

export function mulberry(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PERM = new Uint8Array(512)
const GX = new Float32Array(256)
const GY = new Float32Array(256)
{
  const r = mulberry(1234567)
  const p = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[p[i], p[j]] = [p[j], p[i]]
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2 + 0.37
    GX[i] = Math.cos(a)
    GY[i] = Math.sin(a)
  }
}

/** 2D gradient (Perlin) noise, about -0.7..0.7. */
export function perlin2(x: number, y: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y)
  const fx = x - ix,
    fy = y - iy
  const X = ix & 255,
    Y = iy & 255
  const a = PERM[X] + Y,
    b = PERM[X + 1] + Y
  const g00 = PERM[a],
    g01 = PERM[a + 1],
    g10 = PERM[b],
    g11 = PERM[b + 1]
  const n00 = GX[g00] * fx + GY[g00] * fy
  const n10 = GX[g10] * (fx - 1) + GY[g10] * fy
  const n01 = GX[g01] * fx + GY[g01] * (fy - 1)
  const n11 = GX[g11] * (fx - 1) + GY[g11] * (fy - 1)
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const nx0 = n00 + (n10 - n00) * u
  const nx1 = n01 + (n11 - n01) * u
  return nx0 + (nx1 - nx0) * v
}

/** fBm of perlin2, about -1..1. */
export function fbm2(x: number, y: number, octaves = 4, lac = 2.03, gain = 0.5) {
  let s = 0,
    a = 1,
    n = 0
  for (let o = 0; o < octaves; o++) {
    s += perlin2(x, y) * a
    n += a
    a *= gain
    // rotate between octaves (less axis-aligned structure)
    const nx = (x * 0.8 - y * 0.6) * lac + 17.1,
      ny = (x * 0.6 + y * 0.8) * lac - 9.3
    x = nx
    y = ny
  }
  return (s / n) * 1.6
}

/**
 * Ridged multifractal (Musgrave): sharp crests, octaves weighted by the signal below them so valleys
 * stay smooth and the detail gathers on the ridges, like eroded rock. ~0..1.
 */
export function ridged2(x: number, y: number, octaves = 8, lac = 2.05, gain = 2.1, H = 0.92) {
  let signal = 0.9 - Math.abs(perlin2(x, y) * 1.4)
  signal *= signal
  let result = signal,
    weight = 1,
    freq = 1,
    norm = 1
  for (let o = 1; o < octaves; o++) {
    const nx = (x * 0.8 - y * 0.6) * lac + 31.7,
      ny = (x * 0.6 + y * 0.8) * lac - 12.9
    x = nx
    y = ny
    freq *= lac
    weight = Math.min(1, Math.max(0, signal * gain))
    signal = 0.9 - Math.abs(perlin2(x, y) * 1.4)
    signal *= signal * weight
    const w = Math.pow(freq, -H)
    result += signal * w
    norm += w * 0.55
  }
  return result / norm
}

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
