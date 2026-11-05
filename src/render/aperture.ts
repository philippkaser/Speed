// The lens's iris and what it does to a point of light.
//
// Far from focus every point of light is spread by the lens's point-spread function. Its sharp,
// direction-dependent part is diffraction at the iris: in the far field (Fraunhofer) the pattern is
// the power spectrum of the aperture, |FFT(aperture)|^2. A polygonal iris throws a spike
// perpendicular to each blade edge: an odd number of blades gives twice as many spikes (7 blades:
// the 14-pointed sunstar of a stopped-down lens). Each wavelength scales the pattern by lambda, so
// the spikes come out with faint spectral fringes along their length.
//
// Computed once at load (~0.2 s): the iris is rasterised with anti-aliased, slightly irregular blade
// edges (perfectly straight edges give perfectly clean, synthetic-looking spikes; real blades are not
// perfect), transformed by a 1024 x 1024 FFT, summed over 16 wavelengths with the CIE 1931 colour
// matching functions into linear Rec.709, and split: the radially symmetric part (Airy core, rings,
// the halo) is left to the lens scatter, which already spreads every light (lens.ts); what remains
// are the spikes. The texture holds their energy per texel, normalised to a mean of 1, with mipmaps:
// the sun is a disc, not a point, so its star is the spikes convolved with the disc, which the shader
// approximates by reading the mip level that matches the sun's size on screen.
import * as THREE from 'three/webgpu'

export interface Iris {
  blades: number
  /** 0: straight blade edges, 1: a circle */
  roundness: number
  /** orientation of the blades, radians */
  rotation: number
  /** relative irregularity of the blade edges */
  roughness: number
}

export const IRIS: Iris = { blades: 7, roundness: 0.05, rotation: 0.3, roughness: 0.01 }

/** Size of the star texture (texels per side) and the field it covers, in image heights per side. */
export const STAR_SIZE = 512
export const STAR_EXTENT = 1.0

const N = 1024
/** iris radius in FFT samples: sets the spike width (Airy radius ~0.61 N / R ~ 3 samples) */
const R = 208

/** In-place iterative radix-2 FFT of n complex values at re/im[off + k * stride]. */
function fft(re: Float32Array, im: Float32Array, n: number, off: number, stride: number) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const a = off + i * stride,
        b = off + j * stride
      let t = re[a]
      re[a] = re[b]
      re[b] = t
      t = im[a]
      im[a] = im[b]
      im[b] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang),
      wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0
      for (let k = 0; k < half; k++) {
        const a = off + (i + k) * stride,
          b = off + (i + k + half) * stride
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

/** In-place transpose of an N x N matrix. */
function transpose(a: Float32Array) {
  for (let y = 0; y < N; y++)
    for (let x = y + 1; x < N; x++) {
      const i = y * N + x,
        j = x * N + y
      const t = a[i]
      a[i] = a[j]
      a[j] = t
    }
}

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Smooth random edge displacement around the iris (low-pass filtered noise, unit-ish amplitude). */
function edgeNoise(n: number, seed: number) {
  const r = rng(seed)
  const re = new Float32Array(n),
    im = new Float32Array(n)
  for (let i = 0; i < n; i++) re[i] = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
  fft(re, im, n, 0, 1)
  for (let i = 0; i < n; i++) {
    const f = Math.min(i, n - i)
    const g = f === 0 ? 0 : 1 / (1 + (f / 60) ** 2)
    re[i] *= g
    im[i] *= -g // conjugate: the inverse transform via the forward one
  }
  fft(re, im, n, 0, 1)
  let s = 0
  for (let i = 0; i < n; i++) s += re[i] * re[i]
  const k = 1 / (3 * Math.sqrt(s / n))
  for (let i = 0; i < n; i++) re[i] *= k
  return re
}

/** CIE 1931 2-degree colour matching functions, multi-lobe Gaussian fit (Wyman, Sloan, Shirley 2013). */
function cmf(l: number): [number, number, number] {
  const g = (x: number, mu: number, s1: number, s2: number) => {
    const t = (x - mu) * (x < mu ? s1 : s2)
    return Math.exp(-0.5 * t * t)
  }
  const x = 0.362 * g(l, 442.0, 0.0624, 0.0374) + 1.056 * g(l, 599.8, 0.0264, 0.0323) - 0.065 * g(l, 501.1, 0.049, 0.0382)
  const y = 0.821 * g(l, 568.8, 0.0213, 0.0247) + 0.286 * g(l, 530.9, 0.0613, 0.0322)
  const z = 1.217 * g(l, 437.0, 0.0845, 0.0278) + 0.681 * g(l, 459.0, 0.0385, 0.0725)
  return [x, y, z]
}
const XYZ_TO_709 = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057]

/**
 * The spikes of the iris's diffraction pattern: STAR_SIZE^2 RGB texels (energy per texel, mean 1 over
 * the texture) covering STAR_EXTENT image heights per side, centred on the light.
 */
export function computeStar(iris: Iris = IRIS): Float32Array {
  // 1. the iris
  const re = new Float32Array(N * N),
    im = new Float32Array(N * N)
  const noise = edgeNoise(8192, 7)
  const seg = (2 * Math.PI) / iris.blades
  const cosHalf = Math.cos(Math.PI / iris.blades)
  for (let y = 0; y < N; y++) {
    const dy = y - N / 2 + 0.5
    if (Math.abs(dy) > R * 1.1) continue
    for (let x = 0; x < N; x++) {
      const dx = x - N / 2 + 0.5
      const r = Math.hypot(dx, dy)
      if (r > R * 1.1) continue
      const th = Math.atan2(dy, dx) - iris.rotation
      const a = (((th % seg) + seg) % seg) - seg / 2
      const polyR = cosHalf / Math.cos(a)
      const ni = Math.floor((((th / (2 * Math.PI)) % 1) + 1) * 8192) % 8192
      const Rt = R * (polyR * (1 - iris.roundness) + iris.roundness) * (1 + iris.roughness * noise[ni])
      re[y * N + x] = Math.min(1, Math.max(0, Rt - r + 0.5))
    }
  }
  // 2. far field: 2D FFT (rows, transpose, rows: contiguous memory) and its power spectrum, centred
  //    (DC at N / 2). Rows outside the iris are zero and stay zero.
  for (let y = 0; y < N; y++) if (Math.abs(y - N / 2 + 0.5) <= R * 1.1) fft(re, im, N, y * N, 1)
  transpose(re)
  transpose(im)
  for (let y = 0; y < N; y++) fft(re, im, N, y * N, 1)
  const pw = new Float32Array(N * N)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x
      pw[((y + N / 2) % N) * N + ((x + N / 2) % N)] = re[i] * re[i] + im[i] * im[i]
    }
  //    resampled to STAR_SIZE^2 texels with a tent of 3 x 3 bins centred on each texel: texel t sits at
  //    bin 2t + 1, so texel t and its mirror S - 1 - t see mirrored bins (the far field of a real
  //    aperture is point symmetric, and so is the texture, centred on uv 0.5)
  const S = STAR_SIZE
  const P = new Float32Array(S * S)
  const TW = [0.25, 0.5, 0.25]
  for (let ty = 0; ty < S; ty++)
    for (let tx = 0; tx < S; tx++) {
      let acc = 0
      for (let j = -1; j <= 1; j++) {
        const by = 2 * ty + 1 + j
        if (by >= N) continue
        for (let k = -1; k <= 1; k++) {
          const bx = 2 * tx + 1 + k
          if (bx >= N) continue
          acc += pw[by * N + bx] * TW[j + 1] * TW[k + 1]
        }
      }
      P[ty * S + tx] = acc
    }
  // 3. sum over the spectrum: each wavelength scales the pattern by lambda / lambda_ref
  const LREF = 560
  const NL = 16
  const rgb = new Float32Array(S * S * 3)
  const white = [0, 0, 0]
  const at = (u: number, v: number) => {
    // bilinear, zero outside
    const fx = u - 0.5,
      fy = v - 0.5
    const x0 = Math.floor(fx),
      y0 = Math.floor(fy)
    if (x0 < 0 || y0 < 0 || x0 >= S - 1 || y0 >= S - 1) return 0
    const tx = fx - x0,
      ty = fy - y0
    const i = y0 * S + x0
    return (P[i] * (1 - tx) + P[i + 1] * tx) * (1 - ty) + (P[i + S] * (1 - tx) + P[i + S + 1] * tx) * ty
  }
  for (let li = 0; li < NL; li++) {
    const l = 400 + (300 * (li + 0.5)) / NL
    const [X, Y, Z] = cmf(l)
    const c = [0, 1, 2].map((k) => XYZ_TO_709[k * 3] * X + XYZ_TO_709[k * 3 + 1] * Y + XYZ_TO_709[k * 3 + 2] * Z)
    for (let k = 0; k < 3; k++) white[k] += c[k]
    const s = LREF / l
    for (let y = 0; y < S; y++) {
      const v = (y + 0.5 - S / 2) * s + S / 2
      for (let x = 0; x < S; x++) {
        const p = at((x + 0.5 - S / 2) * s + S / 2, v) * s * s
        if (p <= 0) continue
        const o = (y * S + x) * 3
        rgb[o] += p * c[0]
        rgb[o + 1] += p * c[1]
        rgb[o + 2] += p * c[2]
      }
    }
  }
  for (let i = 0; i < S * S * 3; i++) rgb[i] = Math.max(0, rgb[i] / white[i % 3])
  // 4. keep the spikes: per ring of equal radius, what rises above its 60th percentile; the core
  //    (hidden in the light itself) fades out
  const rings: number[][] = []
  const lum = new Float32Array(S * S)
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x
      lum[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]
      const r = Math.round(Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2))
      ;(rings[r] ??= []).push(lum[i])
    }
  const base = rings.map((v) => (v ? v.sort((a, b) => a - b)[Math.floor(v.length * 0.6)] : 0))
  let total = 0
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x
      const r = Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2)
      const b = base[Math.round(r)]
      const core = Math.min(1, Math.max(0, (r - 2) / 4))
      const k = lum[i] > 1e-30 ? (Math.max(0, lum[i] - b) / lum[i]) * core * core : 0
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] *= k
      total += lum[i] * k
    }
  const norm = (S * S) / Math.max(total, 1e-30)
  for (let i = 0; i < rgb.length; i++) rgb[i] *= norm
  return rgb
}

let _starTexture: THREE.DataTexture | null = null

/** Box-filtered mip chain of an RGB float image, as half-float RGBA levels (in place when `into` is given). */
function fillMips(rgb: Float32Array | null, into: { data: Uint16Array; width: number; height: number }[]) {
  let level = rgb
  let s = STAR_SIZE
  for (let m = 0; m < into.length; m++, s >>= 1) {
    const out = into[m].data
    const n = s * s
    for (let i = 0; i < n; i++) {
      out[i * 4] = THREE.DataUtils.toHalfFloat(level ? Math.min(level[i * 3], 65000) : 0)
      out[i * 4 + 1] = THREE.DataUtils.toHalfFloat(level ? Math.min(level[i * 3 + 1], 65000) : 0)
      out[i * 4 + 2] = THREE.DataUtils.toHalfFloat(level ? Math.min(level[i * 3 + 2], 65000) : 0)
      out[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1)
    }
    if (!level || s === 1) continue
    const h = s >> 1
    const next = new Float32Array(h * h * 3)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < h; x++)
        for (let c = 0; c < 3; c++) {
          const i = (y * 2 * s + x * 2) * 3 + c
          next[(y * h + x) * 3 + c] = 0.25 * (level[i] + level[i + 3] + level[i + s * 3] + level[i + s * 3 + 3])
        }
    level = next
  }
}

/**
 * The star as a half-float texture with a box-filtered mip chain. Created at once (black, so the sun
 * simply has no star for a moment) and filled in when a worker has computed it, off the main thread.
 */
export function starTexture(): THREE.DataTexture {
  if (_starTexture) return _starTexture
  const S = STAR_SIZE
  const mipmaps: { data: Uint16Array; width: number; height: number }[] = []
  for (let s = S; s >= 1; s >>= 1) mipmaps.push({ data: new Uint16Array(s * s * 4), width: s, height: s })
  fillMips(null, mipmaps)
  const t = new THREE.DataTexture(mipmaps[0].data, S, S, THREE.RGBAFormat, THREE.HalfFloatType)
  t.mipmaps = mipmaps as unknown as THREE.DataTexture['mipmaps']
  t.generateMipmaps = false
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.colorSpace = THREE.NoColorSpace
  t.needsUpdate = true
  _starTexture = t
  const fill = (rgb: Float32Array) => {
    fillMips(rgb, mipmaps)
    t.needsUpdate = true
  }
  try {
    const w = new Worker(new URL('./starWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<Float32Array>) => {
      fill(e.data)
      w.terminate()
    }
    w.onerror = () => {
      w.terminate()
      setTimeout(() => fill(computeStar()), 0)
    }
    w.postMessage(null)
  } catch {
    setTimeout(() => fill(computeStar()), 0)
  }
  return t
}
