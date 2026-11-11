// Procedural, tileable PBR textures generated at load time (no external assets).
import * as THREE from 'three/webgpu'

function mulberry(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Periodic value-noise fBm on a size x size grid. */
export function tileFbm(size: number, baseCells: number, octaves: number, seed: number, gain = 0.5) {
  const out = new Float32Array(size * size)
  let amp = 1,
    cells = baseCells,
    norm = 0
  const rnd = mulberry(seed)
  for (let o = 0; o < octaves; o++) {
    const lat = new Float32Array(cells * cells)
    for (let i = 0; i < lat.length; i++) lat[i] = rnd()
    const scale = cells / size
    for (let y = 0; y < size; y++) {
      const fy = y * scale
      const y0 = Math.floor(fy),
        ty = fy - y0
      const sy = ty * ty * (3 - 2 * ty)
      const r0 = (y0 % cells) * cells,
        r1 = ((y0 + 1) % cells) * cells
      for (let x = 0; x < size; x++) {
        const fx = x * scale
        const x0 = Math.floor(fx),
          tx = fx - x0
        const sx = tx * tx * (3 - 2 * tx)
        const c0 = x0 % cells,
          c1 = (x0 + 1) % cells
        const a = lat[r0 + c0],
          b = lat[r0 + c1],
          c = lat[r1 + c0],
          d = lat[r1 + c1]
        out[y * size + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy)
      }
    }
    norm += amp
    amp *= gain
    cells *= 2
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

function normalFromHeight(h: Float32Array, size: number, strength: number) {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size,
        xr = (x + 1) % size
      const yu = (y - 1 + size) % size,
        yd = (y + 1) % size
      const dx = (h[y * size + xr] - h[y * size + xl]) * strength
      const dy = (h[yd * size + x] - h[yu * size + x]) * strength
      let nx = -dx,
        ny = -dy,
        nz = 1
      const l = Math.hypot(nx, ny, nz)
      nx /= l
      ny /= l
      nz /= l
      const i = (y * size + x) * 4
      data[i] = (nx * 0.5 + 0.5) * 255
      data[i + 1] = (ny * 0.5 + 0.5) * 255
      data[i + 2] = (nz * 0.5 + 0.5) * 255
      data[i + 3] = 255
    }
  return data
}

function makeTex(data: Uint8Array, size: number, srgb: boolean, anisotropy = 16) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.anisotropy = anisotropy
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.needsUpdate = true
  return t
}

export interface PBRSet {
  map: THREE.Texture // rgb albedo (sRGB), a = roughness (linear-ish)
  normal: THREE.Texture
}

/** Dense-graded asphalt: aggregate stones in a bitumen matrix. 1 tile = 4 m at 1024 px (~4 mm/px). */
export function makeAsphalt(size = 1024, seed = 7): PBRSet {
  const rnd = mulberry(seed)
  const height = new Float32Array(size * size)
  const albedo = new Float32Array(size * size)
  const rough = new Float32Array(size * size)
  const base = tileFbm(size, 8, 6, seed + 1, 0.55)
  const fine = tileFbm(size, 64, 3, seed + 2, 0.5)
  for (let i = 0; i < size * size; i++) {
    albedo[i] = 0.075 + base[i] * 0.03 + (fine[i] - 0.5) * 0.02
    height[i] = fine[i] * 0.3
    rough[i] = 0.86 + (fine[i] - 0.5) * 0.08
  }
  // aggregate stones
  const stones = Math.floor(size * size * 0.06)
  for (let k = 0; k < stones; k++) {
    const cx = rnd() * size,
      cy = rnd() * size
    const r = 0.7 + Math.pow(rnd(), 2.6) * 2.6
    const tone = rnd()
    const bright = tone > 0.95 ? 0.22 + rnd() * 0.08 : tone > 0.45 ? 0.1 + rnd() * 0.06 : 0.045 + rnd() * 0.035
    const polish = 0.45 + rnd() * 0.3
    const ri = Math.ceil(r)
    for (let dy = -ri; dy <= ri; dy++)
      for (let dx = -ri; dx <= ri; dx++) {
        const d2 = (dx * dx + dy * dy) / (r * r)
        if (d2 > 1) continue
        const x = (Math.floor(cx) + dx + size) % size,
          y = (Math.floor(cy) + dy + size) % size
        const i = y * size + x
        const hgt = Math.sqrt(1 - d2) * r * 0.35
        if (hgt > height[i] - 0.15) {
          height[i] = Math.max(height[i], 0.3 + hgt)
          const edge = 1 - Math.pow(d2, 3) * 0.4
          albedo[i] = bright * edge
          rough[i] = polish + d2 * 0.2
        }
      }
  }
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const a = Math.min(1, Math.max(0, albedo[i]))
    // slightly warm grey
    const srgb = (v: number) => Math.round(Math.pow(v, 1 / 2.2) * 255)
    data[i * 4] = srgb(a * 1.0)
    data[i * 4 + 1] = srgb(a * 0.985)
    data[i * 4 + 2] = srgb(a * 0.96)
    data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, rough[i])) * 255)
  }
  const normal = normalFromHeight(height, size, 1.3)
  return { map: makeTex(data, size, true), normal: makeTex(normal, size, false) }
}

/** Mown grass seen from above: clumps, blades, dry patches. 1 tile = 8 m. */
export function makeGrass(size = 1024, seed = 11): PBRSet {
  const rnd = mulberry(seed)
  const macro = tileFbm(size, 4, 5, seed, 0.6)
  const mid = tileFbm(size, 32, 4, seed + 3, 0.55)
  const height = new Float32Array(size * size)
  const col = new Float32Array(size * size * 3)
  for (let i = 0; i < size * size; i++) {
    const dry = Math.max(0, macro[i] - 0.55) * 2.2
    const g = 0.6 + mid[i] * 0.6
    col[i * 3] = (0.07 + dry * 0.1) * g
    col[i * 3 + 1] = (0.12 + dry * 0.06) * g
    col[i * 3 + 2] = (0.035 + dry * 0.02) * g
    height[i] = mid[i] * 0.5
  }
  // blades: short strokes
  const blades = size * size * 0.12
  for (let k = 0; k < blades; k++) {
    let x = rnd() * size,
      y = rnd() * size
    const ang = rnd() * Math.PI * 2
    const len = 2 + rnd() * 6
    const dx = Math.cos(ang),
      dy = Math.sin(ang)
    const tint = 0.75 + rnd() * 0.7
    const yellow = rnd() < 0.08 ? 1 : 0
    for (let s = 0; s < len; s++) {
      const xi = (Math.floor(x) + size) % size,
        yi = (Math.floor(y) + size) % size
      const i = yi * size + xi
      const t = s / len
      col[i * 3] = col[i * 3] * 0.4 + (0.06 + yellow * 0.12) * tint * (0.6 + t * 0.6) * 0.6
      col[i * 3 + 1] = col[i * 3 + 1] * 0.4 + (0.14 + yellow * 0.05) * tint * (0.6 + t * 0.6) * 0.6
      col[i * 3 + 2] = col[i * 3 + 2] * 0.4 + 0.03 * tint * 0.6
      height[i] = Math.max(height[i], 0.4 + t * 0.6)
      x += dx
      y += dy
    }
  }
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(Math.pow(Math.min(1, col[i * 3 + c]), 1 / 2.2) * 255)
    data[i * 4 + 3] = Math.round((0.82 + height[i] * 0.12) * 255)
  }
  return { map: makeTex(data, size, true), normal: makeTex(normalFromHeight(height, size, 3), size, false) }
}

/** Loose gravel trap. 1 tile = 3 m. */
export function makeGravel(size = 512, seed = 23): PBRSet {
  const rnd = mulberry(seed)
  const height = new Float32Array(size * size)
  const col = new Float32Array(size * size * 3)
  const base = tileFbm(size, 8, 4, seed, 0.5)
  for (let i = 0; i < size * size; i++) {
    const b = 0.22 + base[i] * 0.08
    col[i * 3] = b * 0.95
    col[i * 3 + 1] = b * 0.85
    col[i * 3 + 2] = b * 0.68
  }
  const n = size * size * 0.08
  for (let k = 0; k < n; k++) {
    const cx = rnd() * size,
      cy = rnd() * size,
      r = 1.5 + rnd() * 3.5
    const t = 0.6 + rnd() * 0.7
    const ri = Math.ceil(r)
    for (let dy = -ri; dy <= ri; dy++)
      for (let dx = -ri; dx <= ri; dx++) {
        const d2 = (dx * dx + dy * dy) / (r * r)
        if (d2 > 1) continue
        const x = (Math.floor(cx) + dx + size) % size,
          y = (Math.floor(cy) + dy + size) % size
        const i = y * size + x
        const hh = Math.sqrt(1 - d2) * r
        if (hh > height[i]) {
          height[i] = hh
          const shade = (1 - d2 * 0.5) * t
          col[i * 3] = 0.3 * shade
          col[i * 3 + 1] = 0.26 * shade
          col[i * 3 + 2] = 0.2 * shade
        }
      }
  }
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(Math.pow(Math.min(1, col[i * 3 + c]), 1 / 2.2) * 255)
    data[i * 4 + 3] = Math.round(0.9 * 255)
  }
  return { map: makeTex(data, size, true), normal: makeTex(normalFromHeight(height, size, 0.6), size, false) }
}

/** Weathered concrete. 1 tile = 4 m. */
export function makeConcrete(size = 512, seed = 31): PBRSet {
  const a = tileFbm(size, 4, 6, seed, 0.55)
  const b = tileFbm(size, 48, 3, seed + 1, 0.5)
  const data = new Uint8Array(size * size * 4)
  const h = new Float32Array(size * size)
  for (let i = 0; i < size * size; i++) {
    const v = 0.42 + (a[i] - 0.5) * 0.18 + (b[i] - 0.5) * 0.06
    const g = Math.round(Math.pow(Math.max(0, v), 1 / 2.2) * 255)
    data[i * 4] = g
    data[i * 4 + 1] = g
    data[i * 4 + 2] = Math.round(g * 0.97)
    data[i * 4 + 3] = Math.round((0.8 + b[i] * 0.15) * 255)
    h[i] = b[i]
  }
  return { map: makeTex(data, size, true), normal: makeTex(normalFromHeight(h, size, 1.2), size, false) }
}

/** Canvas based texture helper (signage, billboards, sidewall lettering). */
export function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  draw(ctx)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = 16
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  return t
}

const makers = { asphalt: () => makeAsphalt(), grass: () => makeGrass(), gravel: () => makeGravel(), concrete: () => makeConcrete() }
const cache: Partial<Record<keyof typeof makers, PBRSet>> = {}
/** Procedural sets, each generated on first use (asphalt and grass are photo-scanned now: src/render/worldAssets.ts). */
export function getTextures(): Record<keyof typeof makers, PBRSet> {
  return new Proxy({} as Record<keyof typeof makers, PBRSet>, { get: (_, k: keyof typeof makers) => (cache[k] ??= makers[k]()) })
}
