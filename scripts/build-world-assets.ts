// Builds the world's runtime assets from the source art in "new assets/".
//
//   bun scripts/build-world-assets.ts               -> everything
//   bun scripts/build-world-assets.ts sky ground trees grass   (any subset)
//
// sky    the Poly Haven HDRI (EXR, 75 MB) -> public/world/sky/: the sky above -11 degrees as an 8-bit
//        colour image plus an 8-bit logarithmic gain map (radiance = colour * 2^gain, the sun included),
//        and sky.json with the sun's direction and irradiance measured from the photograph
// ground photo-scanned PBR sets (asphalt, pit lane asphalt, grass) -> public/world/ground/: per set
//        a colour map (ambient occlusion baked in, 1024 px) and a data map (normal x/y + roughness at the scan's full resolution)
// trees  pine, broadleaf (Sketchfab, CC BY 4.0) -> public/world/veg/: one merged mesh per tree with a
//        single material: trunk and leaf textures packed into one atlas, so a whole forest of one tree
//        is a single instanced draw call. Leaf cards are flattened to quads, branches simplified
// grass  Poly Haven grass_medium_01 clumps, simplified and arranged into one patch mesh (one draw call
//        for all of the grass). The download has no alpha mask: it is derived from the black background
//
// Everything is plain data (JSON + binary attribute buffers + WebP/JPEG images), read by
// src/render/worldAssets.ts.
import { Document, NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'

const SRC = 'new assets'
const OUT = 'public/world'

type V3 = [number, number, number]

function mulberry(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const kb = (f: string) => `${(statSync(f).size / 1024).toFixed(0)} KB`
const srgbEncode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)
const srgbDecode = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))

// ============================================================================================ sky

async function buildSky() {
  const t0 = performance.now()
  const file = `${SRC}/kloofendal_48d_partly_cloudy_puresky_4k.exr`
  const buf = readFileSync(file)
  const exr = new EXRLoader().setDataType(THREE.FloatType).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) as unknown as { width: number; height: number; data: Float32Array }
  const { width: W, height: H, data } = exr
  const C = data.length / (W * H)
  // EXRLoader returns rows bottom-up (row 0 = nadir). Keep the sky from -11.25 degrees to the zenith:
  // 1152 of 2048 rows, written top-down (image row 0 = zenith).
  const elevMin = -11.25,
    elevMax = 90
  const rows = Math.round(((elevMax - elevMin) / 180) * H)
  const y0 = H - rows
  const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b
  // sun: the disc (everything above 300) is measured, its direction and irradiance go to the json
  const dA = ((2 * Math.PI) / W) * (Math.PI / H)
  const sunE: V3 = [0, 0, 0],
    skyE: V3 = [0, 0, 0],
    sunDir: V3 = [0, 0, 0]
  for (let y = 0; y < H; y++) {
    const el = -Math.PI / 2 + ((y + 0.5) / H) * Math.PI
    const w = Math.cos(el) * dA
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2]
      const l = lum(r, g, b)
      // azimuth convention of three's equirectUV: u = atan2(d.z, d.x) / 2pi + 0.5
      const az = ((x + 0.5) / W - 0.5) * 2 * Math.PI
      if (l > 300) {
        sunE[0] += r * w
        sunE[1] += g * w
        sunE[2] += b * w
        sunDir[0] += Math.cos(el) * Math.cos(az) * l * w
        sunDir[1] += Math.sin(el) * l * w
        sunDir[2] += Math.cos(el) * Math.sin(az) * l * w
      } else if (el > 0) {
        skyE[0] += r * w * Math.sin(el)
        skyE[1] += g * w * Math.sin(el)
        skyE[2] += b * w * Math.sin(el)
      }
    }
  }
  const sl = Math.hypot(...sunDir)
  for (let k = 0; k < 3; k++) sunDir[k] /= sl

  // log2 gain per pixel: the brightest channel, max-filtered and smoothed so the colour image can
  // carry the detail; quantised up so colour = radiance / gain stays <= 1
  const logMin = -6,
    logMax = 16
  const lg = new Float32Array(W * rows)
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < W; x++) {
      const i = ((H - 1 - y) * W + x) * C
      const m = Math.max(data[i], data[i + 1], data[i + 2], 2 ** logMin)
      lg[y * W + x] = Math.log2(Math.min(m, 2 ** logMax))
    }
  const tmp = new Float32Array(W * rows)
  // 3x3 max, then a 5-tap box blur twice (all in log2), wrapping in x
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < W; x++) {
      let m = -99
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(rows - 1, Math.max(0, y + dy))
        for (let dx = -1; dx <= 1; dx++) m = Math.max(m, lg[yy * W + ((x + dx + W) % W)])
      }
      tmp[y * W + x] = m
    }
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < W; x++) {
        let s = 0
        for (let dx = -2; dx <= 2; dx++) s += tmp[y * W + ((x + dx + W) % W)]
        lg[y * W + x] = s / 5
      }
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < W; x++) {
        let s = 0
        for (let dy = -2; dy <= 2; dy++) s += lg[Math.min(rows - 1, Math.max(0, y + dy)) * W + x]
        tmp[y * W + x] = s / 5
      }
  }
  const gain8 = new Uint8Array(W * rows)
  const rgb8 = new Uint8Array(W * rows * 3)
  let clipped = 0
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < W; x++) {
      const k = y * W + x
      // +0.35 stops of headroom over the smoothed maximum
      const q = Math.min(255, Math.max(0, Math.ceil(((tmp[k] + 0.35 - logMin) / (logMax - logMin)) * 255)))
      gain8[k] = q
      const G = 2 ** (logMin + (q / 255) * (logMax - logMin))
      const i = ((H - 1 - y) * W + x) * C
      for (let c = 0; c < 3; c++) {
        let v = Math.min(data[i + c], 2 ** logMax) / G
        if (v > 1) {
          clipped++
          v = 1
        }
        rgb8[k * 3 + c] = Math.round(srgbEncode(Math.max(0, v)) * 255)
      }
    }
  mkdirSync(`${OUT}/sky`, { recursive: true })
  await sharp(rgb8, { raw: { width: W, height: rows, channels: 3 } })
    .webp({ quality: 92, smartSubsample: true })
    .toFile(`${OUT}/sky/sky-colour.webp`)
  await sharp(gain8, { raw: { width: W, height: rows, channels: 1 } })
    .webp({ lossless: true })
    .toFile(`${OUT}/sky/sky-gain.webp`)
  const meta = {
    source: { title: 'Kloofendal 48d Partly Cloudy (Pure Sky)', author: 'Poly Haven', license: 'CC0', url: 'https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky' },
    width: W,
    height: rows,
    elevMin,
    elevMax,
    logMin,
    logMax,
    /** unit vector in the image frame (u = atan2(z, x) / 2pi + 0.5, y up) */
    sunDir: sunDir.map((x) => +x.toFixed(5)),
    /** irradiance of the sun disc on a surface facing it (linear rgb, image units) */
    sunIrradiance: sunE.map((x) => +x.toFixed(4)),
    /** irradiance of the sky (without the sun) on a horizontal surface */
    skyIrradiance: skyE.map((x) => +x.toFixed(4)),
  }
  writeFileSync(`${OUT}/sky/sky.json`, JSON.stringify(meta, null, 2))
  const el = (Math.asin(sunDir[1]) * 180) / Math.PI
  console.log(`sky: ${W}x${rows}, sun at ${el.toFixed(1)} deg, E_sun ${lum(...sunE).toFixed(2)}, E_sky ${lum(...skyE).toFixed(2)}, ${clipped} clipped samples`)
  console.log(`  colour ${kb(`${OUT}/sky/sky-colour.webp`)}, gain ${kb(`${OUT}/sky/sky-gain.webp`)} (source ${(statSync(file).size / 1e6).toFixed(0)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}

// ============================================================================================ ground

interface GroundDef {
  id: string
  dir: string
  /** size of the colour map; the data map (normal + roughness) keeps the scan's full resolution */
  colourSize: number
  /** strength of the baked ambient occlusion */
  ao: number
}

// The colour (albedo) can be smaller: what makes asphalt and grass read as real up close is the
// fine relief and the play of roughness in the light, so the normal and roughness data stay at the
// scan's native resolution and the colour is halved.
const GROUND: GroundDef[] = [
  { id: 'asphalt', dir: 'asphalt_track_2k.gltf/textures/asphalt_track', colourSize: 1024, ao: 0.7 },
  { id: 'pitlane', dir: 'asphalt_pit_lane_2k.gltf/textures/asphalt_pit_lane', colourSize: 1024, ao: 0.7 },
  { id: 'grass', dir: 'grass_ground_2k.gltf/textures/grass_ground', colourSize: 1024, ao: 0.6 },
  { id: 'leafy', dir: 'leafy_grass_2k.gltf/textures/leafy_grass', colourSize: 1024, ao: 0.6 },
]

async function rawRGB(file: string, size: number) {
  return (await sharp(file).resize(size, size, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer()) as Buffer
}

async function buildGround() {
  mkdirSync(`${OUT}/ground`, { recursive: true })
  for (const g of GROUND) {
    const base = `${SRC}/${g.dir}`
    // native size of the scan's normal map: the data map is never downscaled
    const S = (await sharp(`${base}_nor_gl_2k.jpg`).metadata()).width ?? 2048
    const C = Math.min(g.colourSize, S)
    const [diff, armC, arm, nor] = await Promise.all([rawRGB(`${base}_diff_2k.jpg`, C), rawRGB(`${base}_arm_2k.jpg`, C), rawRGB(`${base}_arm_2k.jpg`, S), rawRGB(`${base}_nor_gl_2k.jpg`, S)])
    const col = Buffer.alloc(C * C * 3)
    const dat = Buffer.alloc(S * S * 3)
    let roughSum = 0
    for (let i = 0; i < C * C; i++) {
      const ao = armC[i * 3] / 255
      const k = 1 - g.ao * (1 - ao)
      for (let c = 0; c < 3; c++) col[i * 3 + c] = Math.round(srgbEncode(srgbDecode(diff[i * 3 + c] / 255) * k) * 255)
    }
    for (let i = 0; i < S * S; i++) {
      dat[i * 3] = nor[i * 3]
      dat[i * 3 + 1] = nor[i * 3 + 1]
      dat[i * 3 + 2] = arm[i * 3 + 1]
      roughSum += arm[i * 3 + 1] / 255
    }
    const cf = `${OUT}/ground/${g.id}-colour.jpg`,
      df = `${OUT}/ground/${g.id}-data.jpg`
    await sharp(col, { raw: { width: C, height: C, channels: 3 } }).jpeg({ quality: 90, mozjpeg: true }).toFile(cf)
    // 4:4:4 so the normal's x and y keep their own detail
    await sharp(dat, { raw: { width: S, height: S, channels: 3 } }).jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(df)
    console.log(`ground ${g.id}: colour ${C}px, normal + roughness ${S}px, mean roughness ${(roughSum / (S * S)).toFixed(2)}, colour ${kb(cf)}, data ${kb(df)}`)
  }
}

// ============================================================================================ meshes

interface Soup {
  pos: number[]
  nrm: number[]
  uv: number[]
  idx: number[]
}

/** All triangles of a glTF, node transforms baked, grouped by material name. */
async function readModel(file: string) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const doc: Document = await io.read(file)
  const out = new Map<string, { prim: Primitive; world: number[]; node: string }[]>()
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    for (const prim of mesh.listPrimitives()) {
      const name = prim.getMaterial()?.getName() ?? ''
      const list = out.get(name) ?? []
      list.push({ prim, world: node.getWorldMatrix() as unknown as number[], node: node.getName() })
      out.set(name, list)
    }
  }
  return out
}

function bake(list: { prim: Primitive; world: number[] }[]): Soup {
  const s: Soup = { pos: [], nrm: [], uv: [], idx: [] }
  const e: number[] = []
  for (const { prim, world: M } of list) {
    const P = prim.getAttribute('POSITION')!,
      N = prim.getAttribute('NORMAL'),
      T = prim.getAttribute('TEXCOORD_0')
    const base = s.pos.length / 3
    const det = M[0] * (M[5] * M[10] - M[9] * M[6]) - M[4] * (M[1] * M[10] - M[9] * M[2]) + M[8] * (M[1] * M[6] - M[5] * M[2])
    for (let i = 0; i < P.getCount(); i++) {
      P.getElement(i, e)
      s.pos.push(M[0] * e[0] + M[4] * e[1] + M[8] * e[2] + M[12], M[1] * e[0] + M[5] * e[1] + M[9] * e[2] + M[13], M[2] * e[0] + M[6] * e[1] + M[10] * e[2] + M[14])
      if (N) {
        N.getElement(i, e)
        const n = [M[0] * e[0] + M[4] * e[1] + M[8] * e[2], M[1] * e[0] + M[5] * e[1] + M[9] * e[2], M[2] * e[0] + M[6] * e[1] + M[10] * e[2]]
        const l = Math.hypot(n[0], n[1], n[2]) || 1
        s.nrm.push(n[0] / l, n[1] / l, n[2] / l)
      } else s.nrm.push(0, 1, 0)
      if (T) {
        T.getElement(i, e)
        s.uv.push(e[0], e[1])
      } else s.uv.push(0, 0)
    }
    const I = prim.getIndices()
    const n = I ? I.getCount() : P.getCount()
    for (let t = 0; t < n; t += 3) {
      const a = I ? I.getScalar(t) : t,
        b = I ? I.getScalar(t + 1) : t + 1,
        c = I ? I.getScalar(t + 2) : t + 2
      if (det < 0) s.idx.push(base + a, base + c, base + b)
      else s.idx.push(base + a, base + b, base + c)
    }
  }
  return s
}

function boundsOf(pos: number[]) {
  const mn: V3 = [Infinity, Infinity, Infinity],
    mx: V3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], pos[i + k])
      mx[k] = Math.max(mx[k], pos[i + k])
    }
  return { mn, mx }
}

/** Keep only the vertices `idx` uses. */
function compactSoup(s: Soup): Soup {
  const map = new Map<number, number>()
  const o: Soup = { pos: [], nrm: [], uv: [], idx: [] }
  for (const v of s.idx) {
    let r = map.get(v)
    if (r === undefined) {
      r = o.pos.length / 3
      map.set(v, r)
      o.pos.push(s.pos[v * 3], s.pos[v * 3 + 1], s.pos[v * 3 + 2])
      o.nrm.push(s.nrm[v * 3], s.nrm[v * 3 + 1], s.nrm[v * 3 + 2])
      o.uv.push(s.uv[v * 2], s.uv[v * 2 + 1])
    }
    o.idx.push(r)
  }
  return o
}

/** Welds vertices with equal position, normal and uv (sources often split every triangle). */
function weld(s: Soup): Soup {
  const map = new Map<string, number>()
  const remap = new Int32Array(s.pos.length / 3)
  const o: Soup = { pos: [], nrm: [], uv: [], idx: [] }
  for (let i = 0; i < remap.length; i++) {
    const k = [s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]].map((x) => x.toFixed(5)).join() + '|' + [s.nrm[i * 3], s.nrm[i * 3 + 1], s.nrm[i * 3 + 2]].map((x) => x.toFixed(2)).join() + '|' + [s.uv[i * 2], s.uv[i * 2 + 1]].map((x) => x.toFixed(4)).join()
    let r = map.get(k)
    if (r === undefined) {
      r = o.pos.length / 3
      map.set(k, r)
      o.pos.push(s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2])
      o.nrm.push(s.nrm[i * 3], s.nrm[i * 3 + 1], s.nrm[i * 3 + 2])
      o.uv.push(s.uv[i * 2], s.uv[i * 2 + 1])
    }
    remap[i] = r
  }
  o.idx = s.idx.map((v) => remap[v])
  return o
}

/** Grid-based simplification: for meshes made of many small open parts (branches) the edge collapser stalls on. */
function simplifySloppy(s: Soup, ratio: number, error: number): Soup {
  const target = Math.max(3, Math.floor((s.idx.length * ratio) / 3) * 3)
  const pos = new Float32Array(s.pos)
  const remap = MeshoptSimplifier.generatePositionRemap(pos, 3)
  const [ind] = MeshoptSimplifier.simplifySloppy(new Uint32Array(s.idx.map((v) => remap[v])), pos, 3, null, target, error)
  return compactSoup({ ...s, idx: Array.from(ind) })
}

function simplifySoup(s: Soup, ratio: number, error: number, flags: ('LockBorder' | 'Prune')[] = []): Soup {
  const target = Math.max(3, Math.floor((s.idx.length * ratio) / 3) * 3)
  const attrs = new Float32Array(s.uv.length / 2 * 5)
  for (let i = 0; i < s.uv.length / 2; i++) attrs.set([s.nrm[i * 3], s.nrm[i * 3 + 1], s.nrm[i * 3 + 2], s.uv[i * 2], s.uv[i * 2 + 1]], i * 5)
  const [ind] = MeshoptSimplifier.simplifyWithAttributes(new Uint32Array(s.idx), new Float32Array(s.pos), 3, attrs, 5, [0.3, 0.3, 0.3, 1, 1], null, target, error, flags)
  return compactSoup({ ...s, idx: Array.from(ind) })
}

/** Connected components (by shared positions) as lists of triangle starts. */
function components(s: Soup) {
  const nv = s.pos.length / 3
  const key = new Map<string, number>()
  const canon = new Int32Array(nv)
  for (let i = 0; i < nv; i++) {
    const k = `${s.pos[i * 3].toFixed(5)},${s.pos[i * 3 + 1].toFixed(5)},${s.pos[i * 3 + 2].toFixed(5)}`
    const c = key.get(k)
    if (c === undefined) {
      key.set(k, i)
      canon[i] = i
    } else canon[i] = c
  }
  const parent = Int32Array.from({ length: nv }, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  for (let t = 0; t < s.idx.length; t += 3) {
    const a = find(canon[s.idx[t]])
    parent[find(canon[s.idx[t + 1]])] = a
    parent[find(canon[s.idx[t + 2]])] = a
  }
  const comps = new Map<number, number[]>()
  for (let t = 0; t < s.idx.length; t += 3) {
    const r = find(canon[s.idx[t]])
    const l = comps.get(r) ?? []
    l.push(t)
    comps.set(r, l)
  }
  return [...comps.values()]
}

/**
 * Leaf cards (each a small fan or strip of triangles) become a single quad through their four UV
 * corners: half the triangles, same footprint. `keep` thins the cards out (the rest grow to cover).
 */
function flattenCards(s: Soup, keep = 1, seed = 1): Soup {
  const r = mulberry(seed)
  const o: Soup = { pos: [], nrm: [], uv: [], idx: [] }
  const grow = 1 / Math.sqrt(keep)
  for (const tris of components(s)) {
    if (r() > keep) continue
    const verts = [...new Set(tris.flatMap((t) => [s.idx[t], s.idx[t + 1], s.idx[t + 2]]))]
    // the corners: extremes of u+v and u-v
    const pick = (f: (u: number, v: number) => number) => verts.reduce((a, b) => (f(s.uv[b * 2], s.uv[b * 2 + 1]) > f(s.uv[a * 2], s.uv[a * 2 + 1]) ? b : a))
    const c = [pick((u, v) => -u - v), pick((u, v) => u - v), pick((u, v) => u + v), pick((u, v) => v - u)]
    if (new Set(c).size < 4 || tris.length < 2) {
      // not a card: keep as is
      const base = o.pos.length / 3
      const m = new Map<number, number>()
      for (const v of verts) {
        m.set(v, o.pos.length / 3)
        o.pos.push(s.pos[v * 3], s.pos[v * 3 + 1], s.pos[v * 3 + 2])
        o.nrm.push(s.nrm[v * 3], s.nrm[v * 3 + 1], s.nrm[v * 3 + 2])
        o.uv.push(s.uv[v * 2], s.uv[v * 2 + 1])
      }
      void base
      for (const t of tris) o.idx.push(m.get(s.idx[t])!, m.get(s.idx[t + 1])!, m.get(s.idx[t + 2])!)
      continue
    }
    const cen: V3 = [0, 0, 0]
    const nAvg: V3 = [0, 0, 0]
    for (const v of verts) for (let k = 0; k < 3; k++) cen[k] += s.pos[v * 3 + k] / verts.length
    for (const v of verts) for (let k = 0; k < 3; k++) nAvg[k] += s.nrm[v * 3 + k]
    const base = o.pos.length / 3
    for (const v of c) {
      for (let k = 0; k < 3; k++) o.pos.push(cen[k] + (s.pos[v * 3 + k] - cen[k]) * grow)
      o.nrm.push(s.nrm[v * 3], s.nrm[v * 3 + 1], s.nrm[v * 3 + 2])
      o.uv.push(s.uv[v * 2], s.uv[v * 2 + 1])
    }
    // winding: the quad's face normal along the card's average normal
    const p = (i: number) => [o.pos[(base + i) * 3], o.pos[(base + i) * 3 + 1], o.pos[(base + i) * 3 + 2]]
    const a = p(0),
      b = p(1),
      cc = p(2)
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      e2 = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]]
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    if (fn[0] * nAvg[0] + fn[1] * nAvg[1] + fn[2] * nAvg[2] >= 0) o.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    else o.idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
  }
  return o
}

function transformSoup(s: Soup, f: (p: V3) => V3) {
  for (let i = 0; i < s.pos.length; i += 3) {
    const p = f([s.pos[i], s.pos[i + 1], s.pos[i + 2]])
    s.pos[i] = p[0]
    s.pos[i + 1] = p[1]
    s.pos[i + 2] = p[2]
  }
}

// ---------------------------------------------------------------------------------- atlases

interface Cell {
  file: string
  /** rect in the atlas (px) */
  x: number
  y: number
  w: number
  h: number
  /** alpha from the file (true) or derived from a black background ('black') or opaque */
  alpha: boolean | 'black'
}

/** Packs the cells into one RGBA image; transparent texels take their neighbours' colour (no dark fringes when mipmapped). */
async function atlas(W: number, H: number, cells: Cell[]) {
  const img = new Uint8Array(W * H * 4)
  for (const c of cells) {
    const px = (await sharp(c.file).resize(c.w, c.h, { kernel: 'lanczos3', fit: 'fill' }).ensureAlpha().raw().toBuffer()) as Buffer
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w; x++) {
        const s = (y * c.w + x) * 4,
          d = ((c.y + y) * W + c.x + x) * 4
        img[d] = px[s]
        img[d + 1] = px[s + 1]
        img[d + 2] = px[s + 2]
        let a = c.alpha === true ? px[s + 3] : 255
        if (c.alpha === 'black') {
          const m = Math.max(px[s], px[s + 1], px[s + 2]) / 255
          a = Math.round(255 * Math.min(1, Math.max(0, (m - 0.035) / 0.05)))
        }
        img[d + 3] = a
      }
  }
  bleed(img, W, H)
  return img
}

function bleed(img: Uint8Array, W: number, H: number) {
  // push colour from opaque texels into transparent ones, a ring at a time
  const known = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) known[i] = img[i * 4 + 3] > 96 ? 1 : 0
  for (let it = 0; it < 24; it++) {
    const next = known.slice()
    let changed = 0
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (known[i]) continue
        let r = 0,
          g = 0,
          b = 0,
          n = 0
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
        ]) {
          const xx = x + dx,
            yy = y + dy
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
          const j = yy * W + xx
          if (!known[j]) continue
          r += img[j * 4]
          g += img[j * 4 + 1]
          b += img[j * 4 + 2]
          n++
        }
        if (n) {
          img[i * 4] = r / n
          img[i * 4 + 1] = g / n
          img[i * 4 + 2] = b / n
          next[i] = 1
          changed++
        }
      }
    known.set(next)
    if (!changed) break
  }
}

// ---------------------------------------------------------------------------------- output

interface MeshOut {
  id: string
  /** vertex attributes: position, normal, uv, wind (x: height 0..1, y: leaf 0/1) */
  soup: Soup
  wind: number[]
  bounds: { min: V3; max: V3 }
  atlas: string
  credit?: { title: string; author: string; license: string; source: string }
}

function writeMesh(m: MeshOut) {
  const nv = m.soup.pos.length / 3
  const parts = [new Float32Array(m.soup.pos), new Float32Array(m.soup.nrm), new Float32Array(m.soup.uv), new Float32Array(m.wind), nv > 65535 ? new Uint32Array(m.soup.idx) : new Uint16Array(m.soup.idx)]
  const layout: Record<string, { offset: number; count: number; itemSize: number; type: string }> = {}
  const names = ['position', 'normal', 'uv', 'wind', 'index'],
    sizes = [3, 3, 2, 2, 1]
  let off = 0
  const chunks: Uint8Array[] = []
  parts.forEach((p, i) => {
    const bytes = new Uint8Array(p.buffer, p.byteOffset, p.byteLength)
    layout[names[i]] = { offset: off, count: p.length / sizes[i], itemSize: sizes[i], type: p instanceof Float32Array ? 'f32' : p instanceof Uint32Array ? 'u32' : 'u16' }
    chunks.push(bytes)
    off += bytes.byteLength
    const pad = (4 - (off % 4)) % 4
    if (pad) {
      chunks.push(new Uint8Array(pad))
      off += pad
    }
  })
  const bin = new Uint8Array(off)
  let o = 0
  for (const c of chunks) {
    bin.set(c, o)
    o += c.byteLength
  }
  writeFileSync(`${OUT}/veg/${m.id}.bin`, bin)
  return { id: m.id, bin: `${m.id}.bin`, atlas: m.atlas, layout, bounds: m.bounds, vertices: nv, triangles: m.soup.idx.length / 3, credit: m.credit }
}

function merge(list: { s: Soup; leaf: number }[], H: number) {
  const out: Soup = { pos: [], nrm: [], uv: [], idx: [] }
  const wind: number[] = []
  for (const { s, leaf } of list) {
    const base = out.pos.length / 3
    out.pos.push(...s.pos)
    out.nrm.push(...s.nrm)
    out.uv.push(...s.uv)
    for (const v of s.idx) out.idx.push(v + base)
    for (let i = 0; i < s.pos.length; i += 3) wind.push(Math.max(0, Math.min(1, s.pos[i + 1] / H)), leaf)
  }
  return { soup: out, wind }
}

/** Leaf normals bent away from the crown's centre: soft, volumetric shading of a card canopy. */
function bendNormals(s: Soup, centre: V3, radii: V3, amount: number) {
  for (let i = 0; i < s.pos.length; i += 3) {
    const d = [(s.pos[i] - centre[0]) / radii[0], (s.pos[i + 1] - centre[1]) / radii[1] + 0.25, (s.pos[i + 2] - centre[2]) / radii[2]]
    const l = Math.hypot(d[0], d[1], d[2]) || 1
    const n = [0, 1, 2].map((k) => s.nrm[i + k] * (1 - amount) + (d[k] / l) * amount)
    // card normals point either way; orient them outwards before blending
    if (s.nrm[i] * d[0] + s.nrm[i + 1] * d[1] + s.nrm[i + 2] * d[2] < 0) for (let k = 0; k < 3; k++) n[k] = -s.nrm[i + k] * (1 - amount) + (d[k] / l) * amount
    const nl = Math.hypot(n[0], n[1], n[2]) || 1
    for (let k = 0; k < 3; k++) s.nrm[i + k] = n[k] / nl
  }
}

function remapUV(s: Soup, c: Cell, W: number, H: number) {
  for (let i = 0; i < s.uv.length; i += 2) {
    s.uv[i] = (c.x + Math.min(1, Math.max(0, s.uv[i])) * c.w) / W
    s.uv[i + 1] = (c.y + Math.min(1, Math.max(0, s.uv[i + 1])) * c.h) / H
  }
}

async function writeAtlas(name: string, img: Uint8Array, W: number, H: number) {
  const f = `${OUT}/veg/${name}.webp`
  await sharp(img, { raw: { width: W, height: H, channels: 4 } }).webp({ quality: 90, alphaQuality: 100 }).toFile(f)
  return f
}

// ============================================================================================ trees

async function buildPine() {
  const dir = `${SRC}/pine_tree`
  const m = await readModel(`${dir}/scene.gltf`)
  const leaves = weld(bake(m.get('Leavs')!))
  const trunk = weld(bake(m.get('Trank')!))
  // the model stands on y = 0 and is ~3.1 units tall (centimetres in the source): to metres at 15 m
  const all = boundsOf([...leaves.pos, ...trunk.pos])
  const H = 15
  const k = H / all.mx[1]
  const tb = boundsOf(trunk.pos.filter((_, i) => i % 3 !== 1 || true))
  const cx = (tb.mn[0] + tb.mx[0]) / 2,
    cz = (tb.mn[2] + tb.mx[2]) / 2
  for (const s of [leaves, trunk]) transformSoup(s, ([x, y, z]) => [(x - cx) * k, y * k, (z - cz) * k])
  const lb = boundsOf(leaves.pos)
  bendNormals(leaves, [0, (lb.mn[1] + lb.mx[1]) / 2, 0], [(lb.mx[0] - lb.mn[0]) / 2, (lb.mx[1] - lb.mn[1]) / 2, (lb.mx[2] - lb.mn[2]) / 2], 0.55)
  // atlas: needles 1024 x 1024 (left), bark 512 x 1024 (right; the model only uses u < 0.15)
  const W = 1536,
    AH = 1024
  const cells: Cell[] = [
    { file: `${dir}/textures/Leavs_baseColor.png`, x: 0, y: 0, w: 1024, h: 1024, alpha: true },
    { file: `${dir}/textures/Trank_baseColor.png`, x: 1024, y: 0, w: 512, h: 1024, alpha: false },
  ]
  remapUV(leaves, cells[0], W, AH)
  remapUV(trunk, cells[1], W, AH)
  const img = await atlas(W, AH, cells)
  const f = await writeAtlas('pine', img, W, AH)
  const { soup, wind } = merge(
    [
      { s: trunk, leaf: 0 },
      { s: leaves, leaf: 1 },
    ],
    H,
  )
  const b = boundsOf(soup.pos)
  const out = writeMesh({ id: 'pine', soup, wind, bounds: { min: b.mn, max: b.mx }, atlas: 'pine.webp', credit: { title: 'Pine tree', author: 'Andriy Shekh', license: 'CC BY 4.0', source: 'https://sketchfab.com/3d-models/pine-tree-e52769d653cd4e52a4acff3041961e65' } })
  console.log(`tree pine: ${out.triangles} tris, ${out.vertices} verts, ${H} m, atlas ${kb(f)}`)
  return out
}

async function buildBroadleaf() {
  const dir = `${SRC}/realistic_tree`
  const m = await readModel(`${dir}/scene.gltf`)
  const leavesSrc = bake(m.get('normal_leaves')!)
  const trunkParts = m.get('trunk')!
  // trunk (solid) and branches (many separate limbs)
  const trunk = weld(bake(trunkParts.filter((p) => /trunk_low/.test(p.node))))
  const branches = weld(bake(trunkParts.filter((p) => !/trunk_low/.test(p.node))))
  const leaves = flattenCards(leavesSrc, 0.62, 7)
  const trunkS = simplifySoup(trunk, 0.45, 0.01)
  const branchS = simplifySloppy(branches, 0.16, 0.02)
  const all = boundsOf([...leaves.pos, ...trunkS.pos])
  const tb = boundsOf(trunkS.pos)
  const cx = (tb.mn[0] + tb.mx[0]) / 2,
    cz = (tb.mn[2] + tb.mx[2]) / 2
  // ~15.7 m in the source (metres already); the roots reach 0.3 m below the ground
  const H = all.mx[1]
  for (const s of [leaves, trunkS, branchS]) transformSoup(s, ([x, y, z]) => [x - cx, y, z - cz])
  const lb = boundsOf(leaves.pos)
  bendNormals(leaves, [0, (lb.mn[1] + lb.mx[1]) / 2, 0], [(lb.mx[0] - lb.mn[0]) / 2, (lb.mx[1] - lb.mn[1]) / 2, (lb.mx[2] - lb.mn[2]) / 2], 0.6)
  const W = 1536,
    AH = 1024
  const cells: Cell[] = [
    { file: `${dir}/textures/normal_leaves_diffuse.png`, x: 0, y: 0, w: 512, h: 512, alpha: true },
    { file: `${dir}/textures/trunk_diffuse.png`, x: 512, y: 0, w: 1024, h: 1024, alpha: false },
  ]
  remapUV(leaves, cells[0], W, AH)
  remapUV(trunkS, cells[1], W, AH)
  remapUV(branchS, cells[1], W, AH)
  const img = await atlas(W, AH, cells)
  const f = await writeAtlas('broadleaf', img, W, AH)
  const { soup, wind } = merge(
    [
      { s: trunkS, leaf: 0 },
      { s: branchS, leaf: 0.35 },
      { s: leaves, leaf: 1 },
    ],
    H,
  )
  const b = boundsOf(soup.pos)
  const out = writeMesh({ id: 'broadleaf', soup, wind, bounds: { min: b.mn, max: b.mx }, atlas: 'broadleaf.webp', credit: { title: 'Realistic Tree', author: 'Daniel', license: 'CC BY 4.0', source: 'https://sketchfab.com/3d-models/realistic-tree-d989c0f801d847b9a74992ec4ddcfdfc' } })
  console.log(`tree broadleaf: ${out.triangles} tris (leaves ${leaves.idx.length / 3}, trunk ${trunkS.idx.length / 3}, branches ${branchS.idx.length / 3}), ${out.vertices} verts, ${H.toFixed(1)} m, atlas ${kb(f)}`)
  return out
}

// ============================================================================================ grass

async function buildGrass() {
  const dir = `${SRC}/grass_medium_01_2k.gltf`
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const doc = await io.read(`${dir}/grass_medium_01_2k.gltf`)
  // every clump, centred on its own origin
  const clumps = new Map<string, Soup>()
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const s = weld(bake(mesh.listPrimitives().map((prim) => ({ prim, world: node.getWorldMatrix() as unknown as number[] }))))
    const b = boundsOf(s.pos)
    const cx = (b.mn[0] + b.mx[0]) / 2,
      cz = (b.mn[2] + b.mx[2]) / 2
    transformSoup(s, ([x, y, z]) => [x - cx, y, z - cz])
    clumps.set(node.getName().replace(/^grass_medium_01_|_LOD0$/g, ''), s)
  }
  // simplified clumps: blades keep their outline, fewer segments along them
  const simple = new Map<string, Soup>()
  const ratio = (k: string) => (k.startsWith('large') ? 0.05 : k.startsWith('mid') ? 0.08 : k.startsWith('tall') ? 0.16 : 0.15)
  for (const [k, s] of clumps) simple.set(k, s.idx.length > 60 ? simplifySoup(s, ratio(k), 0.1) : s)
  // a 1.6 m x 1.6 m patch of clumps: the instance of the grass layer
  const r = mulberry(42)
  const P = 1.4
  const pick = ['large_a', 'mid_a', 'tall_a', 'large_b', 'small_a', 'mid_b', 'tall_b', 'mid_c', 'large_c', 'small_b', 'tall_c', 'mid_a']
  const parts: Soup[] = []
  // jittered grid so the patch covers evenly
  const n = Math.ceil(Math.sqrt(pick.length))
  pick.forEach((name, i) => {
    const src = simple.get(name)!
    const gx = i % n,
      gz = Math.floor(i / n)
    const x = ((gx + 0.5 + (r() - 0.5) * 0.9) / n - 0.5) * P,
      z = ((gz + 0.5 + (r() - 0.5) * 0.9) / n - 0.5) * P
    const a = r() * Math.PI * 2,
      sc = 1.0 + r() * 0.45,
      sy = sc * (0.85 + r() * 0.3)
    const c = Math.cos(a),
      s = Math.sin(a)
    const o: Soup = { pos: [], nrm: [], uv: [...src.uv], idx: [...src.idx] }
    for (let k = 0; k < src.pos.length; k += 3) {
      const px = src.pos[k] * sc,
        pz = src.pos[k + 2] * sc
      o.pos.push(x + c * px - s * pz, src.pos[k + 1] * sy, z + s * px + c * pz)
      const nx = src.nrm[k],
        nz = src.nrm[k + 2]
      o.nrm.push(c * nx - s * nz, src.nrm[k + 1], s * nx + c * nz)
    }
    parts.push(o)
  })
  // grass is lit mostly from above: lean the normals up (avoids black blades seen edge-on)
  for (const p of parts)
    for (let i = 0; i < p.nrm.length; i += 3) {
      const nx = p.nrm[i] * 0.5,
        ny = p.nrm[i + 1] * 0.5 + 0.75,
        nz = p.nrm[i + 2] * 0.5
      const l = Math.hypot(nx, ny, nz)
      p.nrm[i] = nx / l
      p.nrm[i + 1] = ny / l
      p.nrm[i + 2] = nz / l
    }
  const H = Math.max(...parts.map((p) => boundsOf(p.pos).mx[1]))
  const { soup, wind } = merge(
    parts.map((s) => ({ s, leaf: 1 })),
    H,
  )
  const S = 1024
  const cells: Cell[] = [{ file: `${dir}/textures/grass_medium_01_diff_2k.jpg`, x: 0, y: 0, w: S, h: S, alpha: 'black' }]
  const img = await atlas(S, S, cells)
  const f = await writeAtlas('grass', img, S, S)
  const b = boundsOf(soup.pos)
  const out = writeMesh({ id: 'grass', soup, wind, bounds: { min: b.mn, max: b.mx }, atlas: 'grass.webp', credit: { title: 'Grass Medium 01', author: 'Poly Haven', license: 'CC0', source: 'https://polyhaven.com/a/grass_medium_01' } })
  const orig = [...clumps.values()].reduce((a, s) => a + s.idx.length / 3, 0)
  console.log(`grass patch ${P} m: ${pick.length} clumps, ${out.triangles} tris, ${out.vertices} verts, ${(H * 100).toFixed(0)} cm tall (source clumps ${orig} tris), atlas ${kb(f)}`)
  return out
}

// ============================================================================================ main

await MeshoptSimplifier.ready
const want = new Set(process.argv.slice(2))
const all = want.size === 0
mkdirSync(`${OUT}/veg`, { recursive: true })
if (all || want.has('sky')) await buildSky()
if (all || want.has('ground')) await buildGround()
if (all || want.has('trees') || want.has('grass')) {
  const manifestFile = `${OUT}/veg/vegetation.json`
  let manifest: Record<string, unknown> = {}
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  } catch {}
  if (all || want.has('trees')) {
    manifest.pine = await buildPine()
    manifest.broadleaf = await buildBroadleaf()
  }
  if (all || want.has('grass')) manifest.grass = await buildGrass()
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
}
