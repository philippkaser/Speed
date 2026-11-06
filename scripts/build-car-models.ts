// Builds the game's car models from the source GLBs in src/car/*/source (and "new assets/").
//
//   bun scripts/build-car-models.ts            -> public/models/<id>.glb
//   bun scripts/build-car-models.ts mustang-gt3 (one model)
//
// A source can also be a .zip holding the GLB (GitHub refuses files over 100 MB; the Mustang's GLB is
// 122 MB unpacked, 86 MB zipped).
//
// For each model:
//  - bakes every node transform and normalises the car: metres, facing +z, +x to the left, ground at
//    y = 0, origin midway between the axles, uniformly scaled to the physics wheelbase
//  - splits the wheels into four corners (tyre, rim and disc spin; calipers only steer), each with
//    its pivot at the wheel centre
//  - merges geometry by material (a few dozen draw calls instead of hundreds of nodes)
//  - adds two simplified levels of detail (interior removed; ~20% and ~5% of the triangles) for cars
//    that are small on screen, for the shadow passes and the reflection probes. They are built for
//    draw calls: the livery keeps its material (the team colours are applied to its texture), every
//    other material is baked into vertex attributes (colour and opacity, roughness, metalness,
//    emission, brake-light and brake-disc masks) and merged into one opaque and one glass primitive;
//    each wheel is one primitive. Alpha-blended decals stay textured on the middle level. The far
//    level is two draws: the livery and everything else, the windows opaque, the wheels merged in.
//    (A car at the middle level is at most ~220 px long at 1080p, the far one ~70 px: texture detail
//    other than the livery's is a few pixels there; filtered vertex colours do not shimmer.)
//  - every mesh sits on a leaf node of its own: the quantization below puts its dequantization
//    transform on the mesh's node, which must not be a pivot the game moves (steering wheel, calipers)
//  - stores textures as WebP: the livery up to 4K, surface data (normal, roughness / metalness, clear
//    coat) at the source's resolution (near-lossless, or lossy at high quality where the data is
//    noise-like), colour maps at 1K; and compresses the
//    geometry with meshopt
// Per-model metadata (wheel centres and radii, steering wheel, seat, livery material, source credit)
// goes into the root node's extras.
import { Document, type Material, NodeIO, type Primitive, type Texture, type TextureInfo } from '@gltf-transform/core'
import { ALL_EXTENSIONS, type Clearcoat, type EmissiveStrength, type Specular, type Transmission } from '@gltf-transform/extensions'
import { listTextureSlots, meshopt, prune, textureCompress } from '@gltf-transform/functions'
import { mkdirSync, readFileSync, statSync } from 'fs'
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js'

/** Material slots holding surface data rather than colour: kept at the source's resolution. */
const DATA_SLOTS = /^(normalTexture|metallicRoughnessTexture|clearcoatTexture|clearcoatRoughnessTexture|clearcoatNormalTexture|specularTexture|sheenRoughnessTexture|anisotropyTexture)$/

/** physics wheelbase of the GT3 class (src/physics/spec.ts, vanta-gt3) */
const TARGET_WHEELBASE = 2.72

/** Baked levels of detail: emission is stored over this scale (attributes are normalised to 0..1). */
const EMIT_SCALE = 8
/** Texture resolution the baked vertex attributes are sampled from (a box-filtered copy). */
const BAKE_SIZE = 64
/** Simplification of the levels of detail: target share of the triangles, and the error allowed (m). */
const LOD1 = { body: 0.07, wheel: 0.15, error: 0.008 }
const LOD2 = { body: 0.02, wheel: 0.04, error: 0.05, bakedTris: 8000 }
/** Alpha-blended decals smaller than this (m^2, one side) are left out of the middle level. */
const DECAL_MIN_AREA = 0.01

interface ModelDef {
  id: string
  name: string
  src: string
  /** rotation about +y applied before anything else, so that the car faces +z */
  yaw: number
  livery: RegExp
  /** spinning wheel parts (by material) */
  spin: RegExp
  /** steering-only wheel parts (by material or node path) */
  fixed: RegExp
  /** parts to leave out (by material or node path) */
  drop: RegExp
  seat: RegExp
  steer: RegExp
  /** the steering wheel as a separately turning part (by node path or material) */
  steeringWheel: RegExp
  /**
   * livery colours the recolouring maps from (sRGB hue 0..1, value); `hiHue`/`hiV`: lighter stripes
   * of the base colour, recoloured to a lighter shade of the team colour
   */
  paint: { baseHue: number; baseV: number; accentHue: number; accentV: number; hiHue?: number; hiV?: number }
}

const MODELS: ModelDef[] = [
  {
    id: 'ferrari-296-gt3',
    name: 'Ferrari 296 GT3',
    src: 'src/car/ferrari-296-gt3-verstappencom-racing 1/source/ferrari_296_gt3_verstappen__www_vecarz_com.glb',
    yaw: 0,
    livery: /^EXT_Carpaint_Inst$/,
    spin: /^(MI_Tyre_Flex_Dry_L|EXT_RIM|EXT_Disc)$/,
    fixed: /CALIPER/,
    drop: /RIM_BLUR|STEER_LR|^WorldGridMaterial$/,
    seat: /^SEAT_ALCANTARA$/,
    steer: /^INT_Steer$/,
    steeringWheel: /STEER_HR/,
    paint: { baseHue: 0.62, baseV: 0.28, accentHue: 0.995, accentV: 0.86 },
  },
  {
    id: 'amg-gt3',
    name: 'Mercedes-AMG GT3',
    src: 'src/car/mercedes-amg-gt3-red-bull-racing 2/source/mercedes_benz_amg_gt3_red_bull.glb',
    yaw: -Math.PI / 2,
    livery: /_Livery$/,
    spin: /(Tyre_Inst|Rim_Inst|Brake_Disc_Inst)$/,
    fixed: /Caliper_Inst$/,
    drop: /^WorldGridMaterial$/,
    seat: /Interior_Seat$/,
    steer: /Steering_Wheel_Inst$/,
    steeringWheel: /Steering_Wheel/,
    paint: { baseHue: 0.635, baseV: 0.28, accentHue: 0.967, accentV: 0.8 },
  },
  {
    id: 'mustang-gt3',
    name: 'Ford Mustang GT3',
    src: 'new assets/ford-mustang-gt3-2024/source/ford_mustang_gt3_2024__www_vecarz_com.zip',
    yaw: 0,
    livery: /^EXT_Carpaint_Inst$/,
    spin: /^(MI_Tyre_Flex_Dry_L|EXT_RIM|EXT_Disc)$/,
    fixed: /Caliper/i,
    // motion-blurred rim cards, the low-detail steering wheel and the unbuckled belts (a driver sits in)
    drop: /RIM_BLUR|STEER_LR|belt_off|^WorldGridMaterial$/i,
    seat: /^INT_ALCANTARA$/,
    steer: /^INT_Steer$/,
    steeringWheel: /STEER_HR/,
    paint: { baseHue: 0.625, baseV: 0.27, accentHue: 0.0, accentV: 0.54, hiHue: 0.59, hiV: 0.68 },
  },
]

type V3 = [number, number, number]
type Mat4 = number[]

interface Part {
  material: Material | null
  /** 'body' or a corner: 'FL' | 'FR' | 'RL' | 'RR' plus ':spin' / ':fixed' */
  group: string
  sig: string
  attrs: Record<string, { size: number; data: Float32Array }>
  indices: Uint32Array
  min: V3
  max: V3
}

const CORNERS = ['FL', 'FR', 'RL', 'RR'] as const
const cornerOf = (x: number, z: number) => (z > 0 ? 'F' : 'R') + (x > 0 ? 'L' : 'R')

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}
const xform = (m: Mat4, v: V3, w = 1): V3 => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * w, m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * w, m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * w]
const det3 = (m: Mat4) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
const yawMat = (a: number): Mat4 => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1]

function nodePath(node: any) {
  const names: string[] = []
  let p = node
  while (p) {
    names.unshift(p.getName())
    p = p.listParents().find((x: any) => x.propertyType === 'Node')
  }
  return names.join('/')
}

function readAttr(prim: Primitive, sem: string) {
  const acc = prim.getAttribute(sem)!
  const size = acc.getElementSize()
  const n = acc.getCount()
  const out = new Float32Array(n * size)
  const el: number[] = []
  for (let i = 0; i < n; i++) {
    acc.getElement(i, el)
    for (let k = 0; k < size; k++) out[i * size + k] = el[k]
  }
  return { size, data: out }
}

/** Every primitive of the scene with its world matrix. */
function listPrims(doc: Document) {
  const out: { prim: Primitive; world: Mat4; path: string }[] = []
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const world = node.getWorldMatrix() as unknown as Mat4
    const path = nodePath(node)
    for (const prim of mesh.listPrimitives()) out.push({ prim, world: [...world], path })
  }
  return out
}

/** Keep only the vertices used by `tris` (indices into the source), remapped. */
function compact(attrs: Record<string, { size: number; data: Float32Array }>, tris: number[]): Pick<Part, 'attrs' | 'indices'> {
  const remap = new Map<number, number>()
  const order: number[] = []
  const indices = new Uint32Array(tris.length)
  for (let i = 0; i < tris.length; i++) {
    let r = remap.get(tris[i])
    if (r === undefined) {
      r = order.length
      remap.set(tris[i], r)
      order.push(tris[i])
    }
    indices[i] = r
  }
  const out: Part['attrs'] = {}
  for (const [sem, a] of Object.entries(attrs)) {
    const d = new Float32Array(order.length * a.size)
    for (let i = 0; i < order.length; i++) for (let k = 0; k < a.size; k++) d[i * a.size + k] = a.data[order[i] * a.size + k]
    out[sem] = { size: a.size, data: d }
  }
  return { attrs: out, indices }
}

function bounds(pos: Float32Array): [V3, V3] {
  const mn: V3 = [Infinity, Infinity, Infinity],
    mx: V3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], pos[i + k])
      mx[k] = Math.max(mx[k], pos[i + k])
    }
  return [mn, mx]
}

function merge(parts: Part[]): Part {
  const first = parts[0]
  const attrs: Part['attrs'] = {}
  let vtx = 0,
    idx = 0
  for (const p of parts) {
    vtx += p.attrs.POSITION.data.length / 3
    idx += p.indices.length
  }
  for (const [sem, a] of Object.entries(first.attrs)) attrs[sem] = { size: a.size, data: new Float32Array(vtx * a.size) }
  const indices = new Uint32Array(idx)
  let vo = 0,
    io = 0
  for (const p of parts) {
    const n = p.attrs.POSITION.data.length / 3
    for (const [sem, a] of Object.entries(p.attrs)) attrs[sem].data.set(a.data, vo * a.size)
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + vo
    vo += n
    io += p.indices.length
  }
  const [min, max] = bounds(attrs.POSITION.data)
  return { material: first.material, group: first.group, sig: first.sig, attrs, indices, min, max }
}

/**
 * Simplifies a part to `ratio` of its triangles, within `error`: metres when `absolute` (what a level
 * of detail can afford: a fraction of a pixel where it is used), else relative to the part's size.
 */
function simplifyPart(p: Part, ratio: number, error: number, lockBorder = true, absolute = false): Part | null {
  const target = Math.max(3, Math.floor((p.indices.length * ratio) / 3) * 3)
  const flags: ('LockBorder' | 'ErrorAbsolute' | 'Prune')[] = []
  if (lockBorder) flags.push('LockBorder')
  if (absolute) flags.push('ErrorAbsolute', 'Prune')
  const [ind] = MeshoptSimplifier.simplify(p.indices, p.attrs.POSITION.data, 3, target, error, flags)
  if (ind.length < 3) return null
  const c = compact(p.attrs, Array.from(ind))
  const [min, max] = bounds(c.attrs.POSITION.data)
  return { ...p, ...c, min, max }
}

/**
 * Sloppy simplification (topology ignored: parts merge, small ones vanish) to a triangle budget within
 * `error` metres: the far level, where the car is a few dozen pixels long.
 */
function sloppy(p: Part, targetTris: number, error: number): Part {
  if (p.indices.length / 3 <= targetTris) return p
  const scale = MeshoptSimplifier.getScale(p.attrs.POSITION.data, 3)
  const [ind] = MeshoptSimplifier.simplifySloppy(p.indices, p.attrs.POSITION.data, 3, null, targetTris * 3, error / scale)
  if (ind.length < 3) return p
  const c = compact(p.attrs, Array.from(ind))
  const [min, max] = bounds(c.attrs.POSITION.data)
  return { ...p, ...c, min, max }
}

// ------------------------------------------------------------------------------ texture budget

/**
 * Finest texel density (texels per metre) any camera resolves, by where a part is: the exterior is
 * seen from 1 m at the closest (hood and bumper cameras: ~0.5 mm per pixel at 4K), the cabin from
 * 0.5 m (the cockpit camera), the steering wheel from 0.35 m. Texels finer than that are only ever
 * seen through a coarser mip level: the texture is resized to match, which changes no pixel.
 */
const DENSITY = { exterior: 2048, cabin: 4096, steering: 6000 }

/** A texture's slots on a material (or its extensions) and the uv set each slot reads. */
function textureUses(doc: Document) {
  const uses = new Map<Texture, { mat: Material; uv: number }[]>()
  for (const mat of doc.getRoot().listMaterials()) {
    const infos: [Texture | null, TextureInfo | null][] = [
      [mat.getBaseColorTexture(), mat.getBaseColorTextureInfo()],
      [mat.getMetallicRoughnessTexture(), mat.getMetallicRoughnessTextureInfo()],
      [mat.getNormalTexture(), mat.getNormalTextureInfo()],
      [mat.getOcclusionTexture(), mat.getOcclusionTextureInfo()],
      [mat.getEmissiveTexture(), mat.getEmissiveTextureInfo()],
    ]
    const cc = mat.getExtension('KHR_materials_clearcoat') as Clearcoat | null
    if (cc) infos.push([cc.getClearcoatTexture(), cc.getClearcoatTextureInfo()], [cc.getClearcoatRoughnessTexture(), cc.getClearcoatRoughnessTextureInfo()], [cc.getClearcoatNormalTexture(), cc.getClearcoatNormalTextureInfo()])
    const sp = mat.getExtension('KHR_materials_specular') as Specular | null
    if (sp) infos.push([sp.getSpecularTexture(), sp.getSpecularTextureInfo()], [sp.getSpecularColorTexture(), sp.getSpecularColorTextureInfo()])
    const tr = mat.getExtension('KHR_materials_transmission') as Transmission | null
    if (tr) infos.push([tr.getTransmissionTexture(), tr.getTransmissionTextureInfo()])
    for (const [t, info] of infos) if (t) uses.set(t, [...(uses.get(t) ?? []), { mat, uv: info?.getTexCoord() ?? 0 }])
  }
  return uses
}

/** Single-colour images (the sources carry 2048^2 ones) as the factors they amount to. */
async function constantTextures(doc: Document) {
  let freed = 0
  for (const t of doc.getRoot().listTextures()) {
    const img = t.getImage()
    if (!img) continue
    const st = await sharp(Buffer.from(img)).stats()
    if (!st.channels.every((c) => c.max - c.min <= 1)) continue
    const c = st.channels.map((ch) => ch.mean / 255)
    const [r, g, b] = c
    const a = c[3] ?? 1
    const lin = (x: number) => srgb2lin(x)
    let handled = true
    for (const slot of listTextureSlots(t)) {
      for (const mat of doc.getRoot().listMaterials()) {
        if (slot === 'baseColorTexture' && mat.getBaseColorTexture() === t) {
          const f = mat.getBaseColorFactor()
          mat.setBaseColorFactor([f[0] * lin(r), f[1] * lin(g), f[2] * lin(b), f[3] * a]).setBaseColorTexture(null)
        } else if (slot === 'metallicRoughnessTexture' && mat.getMetallicRoughnessTexture() === t) {
          mat.setRoughnessFactor(mat.getRoughnessFactor() * g).setMetallicFactor(mat.getMetallicFactor() * b).setMetallicRoughnessTexture(null)
        } else if (slot === 'emissiveTexture' && mat.getEmissiveTexture() === t) {
          const f = mat.getEmissiveFactor()
          mat.setEmissiveFactor([f[0] * lin(r), f[1] * lin(g), f[2] * lin(b)]).setEmissiveTexture(null)
        } else if (slot === 'occlusionTexture' && mat.getOcclusionTexture() === t) {
          if (r > 0.99) mat.setOcclusionTexture(null)
          else handled = false
        } else if (slot === 'normalTexture' && mat.getNormalTexture() === t) {
          if (Math.abs(r - 0.5) < 0.01 && Math.abs(g - 0.5) < 0.01) mat.setNormalTexture(null)
          else handled = false
        } else {
          const sp = mat.getExtension('KHR_materials_specular') as Specular | null
          const cc = mat.getExtension('KHR_materials_clearcoat') as Clearcoat | null
          if (slot === 'specularTexture' && sp?.getSpecularTexture() === t) sp.setSpecularFactor(sp.getSpecularFactor() * a).setSpecularTexture(null)
          else if (slot === 'specularColorTexture' && sp?.getSpecularColorTexture() === t) {
            const f = sp.getSpecularColorFactor()
            sp.setSpecularColorFactor([f[0] * lin(r), f[1] * lin(g), f[2] * lin(b)]).setSpecularColorTexture(null)
          } else if (slot === 'clearcoatTexture' && cc?.getClearcoatTexture() === t) cc.setClearcoatFactor(cc.getClearcoatFactor() * r).setClearcoatTexture(null)
          else if (slot === 'clearcoatRoughnessTexture' && cc?.getClearcoatRoughnessTexture() === t) cc.setClearcoatRoughnessFactor(cc.getClearcoatRoughnessFactor() * g).setClearcoatRoughnessTexture(null)
          else if (slot === 'clearcoatNormalTexture' && cc?.getClearcoatNormalTexture() === t) {
            if (Math.abs(r - 0.5) < 0.01 && Math.abs(g - 0.5) < 0.01) cc.setClearcoatNormalTexture(null)
            else handled = false
          }
        }
      }
    }
    if (handled && t.listParents().every((p) => p.propertyType === 'Root')) {
      const m = await sharp(Buffer.from(img)).metadata()
      freed += ((m.width ?? 0) * (m.height ?? 0) * 16) / 3
      t.dispose()
    }
  }
  if (freed) console.log(`  single-colour textures replaced by factors: ${(freed / 1e6).toFixed(0)} MB of GPU memory`)
}

/**
 * Resizes every texture to the finest texel density a camera resolves on the parts that use it
 * (DENSITY): from the parts' surface areas in the world and in the texture (tiling included).
 */
async function textureBudget(doc: Document) {
  const uses = textureUses(doc)
  // per material: world area and uv area per uv set, and the most demanding place it is used
  const stats = new Map<Material, { A: number; a: number[]; density: number }>()
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const steer = /steering/.test(node.getName())
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial()
      const pos = prim.getAttribute('POSITION')
      const idx = prim.getIndices()
      if (!mat || !pos || !idx) continue
      const I = idx.getArray()!
      const P = pos.getArray()! as Float32Array
      const uvs = [prim.getAttribute('TEXCOORD_0')?.getArray() as Float32Array | undefined, prim.getAttribute('TEXCOORD_1')?.getArray() as Float32Array | undefined]
      const st = stats.get(mat) ?? { A: 0, a: [0, 0], density: 0 }
      const mn = pos.getMin([]),
        mx = pos.getMax([])
      const inCabin = mn[0] > -0.78 && mx[0] < 0.78 && mn[1] > 0.1 && mx[1] < 1.02 && mn[2] > -1.05 && mx[2] < 0.8
      st.density = Math.max(st.density, steer ? DENSITY.steering : inCabin ? DENSITY.cabin : DENSITY.exterior)
      for (let t = 0; t < I.length; t += 3) {
        const i0 = I[t],
          i1 = I[t + 1],
          i2 = I[t + 2]
        const ux = P[i1 * 3] - P[i0 * 3],
          uy = P[i1 * 3 + 1] - P[i0 * 3 + 1],
          uz = P[i1 * 3 + 2] - P[i0 * 3 + 2]
        const vx = P[i2 * 3] - P[i0 * 3],
          vy = P[i2 * 3 + 1] - P[i0 * 3 + 1],
          vz = P[i2 * 3 + 2] - P[i0 * 3 + 2]
        st.A += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        for (let k = 0; k < 2; k++) {
          const U = uvs[k]
          if (!U) continue
          st.a[k] += 0.5 * Math.abs((U[i1 * 2] - U[i0 * 2]) * (U[i2 * 2 + 1] - U[i0 * 2 + 1]) - (U[i2 * 2] - U[i0 * 2]) * (U[i1 * 2 + 1] - U[i0 * 2 + 1]))
        }
      }
      stats.set(mat, st)
    }
  }
  let before = 0,
    after = 0
  const changed: string[] = []
  for (const [tex, list] of uses) {
    const img = tex.getImage()
    if (!img) continue
    const meta = await sharp(Buffer.from(img)).metadata()
    const W = meta.width ?? 0,
      H = meta.height ?? 0
    // the size the most demanding use needs: density * sqrt(world area / uv area)
    let need = 0
    for (const { mat, uv } of list) {
      const st = stats.get(mat)
      if (!st || st.A <= 0) continue
      const a = st.a[uv] ?? 0
      need = Math.max(need, a > 1e-9 ? st.density * Math.sqrt(st.A / a) : Infinity)
    }
    const S = Math.max(W, H)
    let target = S
    if (need > 0 && need < S) target = Math.max(256, Math.min(S, 2 ** Math.ceil(Math.log2(need))))
    before += (W * H * 16) / 3
    if (target < S) {
      const w = Math.max(1, Math.round((W * target) / S)),
        h = Math.max(1, Math.round((H * target) / S))
      tex.setImage(new Uint8Array(await sharp(Buffer.from(img)).resize(w, h, { kernel: 'lanczos3' }).png().toBuffer())).setMimeType('image/png')
      changed.push(`${list[0].mat.getName()} ${W}x${H}->${w}x${h}`)
      after += (w * h * 16) / 3
    } else after += (W * H * 16) / 3
  }
  console.log(`  texture budget: GPU memory ${(before / 1e6).toFixed(0)} -> ${(after / 1e6).toFixed(0)} MB (${changed.length} resized${changed.length ? ': ' + changed.join(', ') : ''})`)
}

// ------------------------------------------------------------------------------ baked levels of detail

interface Raw {
  w: number
  h: number
  data: Uint8Array
  wrapS: number
  wrapT: number
}
const rawCache = new Map<Texture, Promise<Raw>>()

/** A texture as a small box-filtered RGBA copy (what a vertex far away averages over). */
function rawTexture(tex: Texture, info: TextureInfo | null): Promise<Raw> {
  let r = rawCache.get(tex)
  if (!r) {
    r = sharp(Buffer.from(tex.getImage()!))
      .resize(BAKE_SIZE, BAKE_SIZE, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(({ data, info: i }) => ({ w: i.width, h: i.height, data: new Uint8Array(data), wrapS: info?.getWrapS() ?? 10497, wrapT: info?.getWrapT() ?? 10497 }))
    rawCache.set(tex, r)
  }
  return r
}

const wrap = (x: number, n: number, mode: number) => {
  if (mode === 33071) return Math.min(n - 1, Math.max(0, x))
  if (mode === 33648) {
    const p = ((x % (2 * n)) + 2 * n) % (2 * n)
    return p < n ? p : 2 * n - 1 - p
  }
  return ((x % n) + n) % n
}

/** Bilinear sample (0..1 per channel) at a glTF uv (v down from the top of the image). */
function sampleRaw(r: Raw, u: number, v: number, out: number[]) {
  const x = u * r.w - 0.5,
    y = v * r.h - 0.5
  const x0 = Math.floor(x),
    y0 = Math.floor(y)
  const fx = x - x0,
    fy = y - y0
  for (let c = 0; c < 4; c++) out[c] = 0
  for (const [dx, dy, w] of [
    [0, 0, (1 - fx) * (1 - fy)],
    [1, 0, fx * (1 - fy)],
    [0, 1, (1 - fx) * fy],
    [1, 1, fx * fy],
  ]) {
    const i = (wrap(y0 + dy, r.h, r.wrapT) * r.w + wrap(x0 + dx, r.w, r.wrapS)) * 4
    for (let c = 0; c < 4; c++) out[c] += (w * r.data[i + c]) / 255
  }
  return out
}

const srgb2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

interface BakeSource {
  mat: Material | null
  name: string
  blend: boolean
  base: Raw | null
  baseUV: string
  mr: Raw | null
  mrUV: string
  em: Raw | null
  emUV: string
}

async function bakeSource(mat: Material | null): Promise<BakeSource> {
  const tex = async (t: Texture | null, info: TextureInfo | null) => (t ? rawTexture(t, info) : null)
  return {
    mat,
    name: mat?.getName() ?? '',
    blend: mat?.getAlphaMode() === 'BLEND',
    base: await tex(mat?.getBaseColorTexture() ?? null, mat?.getBaseColorTextureInfo() ?? null),
    baseUV: `TEXCOORD_${mat?.getBaseColorTextureInfo()?.getTexCoord() ?? 0}`,
    mr: await tex(mat?.getMetallicRoughnessTexture() ?? null, mat?.getMetallicRoughnessTextureInfo() ?? null),
    mrUV: `TEXCOORD_${mat?.getMetallicRoughnessTextureInfo()?.getTexCoord() ?? 0}`,
    em: await tex(mat?.getEmissiveTexture() ?? null, mat?.getEmissiveTextureInfo() ?? null),
    emUV: `TEXCOORD_${mat?.getEmissiveTextureInfo()?.getTexCoord() ?? 0}`,
  }
}

/** Window glass (as the game normalises it: a smooth dielectric, see gltfCars.ts normaliseMaterial). */
const isWindow = (name: string) => /glass|window|windshield/i.test(name) && !/light|lamp|emissive/i.test(name)
const isLight = (name: string) => /light|lamp/i.test(name)

/**
 * How a material is drawn at the simplified levels: the livery with its own material, blended decals
 * with theirs (middle level), glass and everything else baked into vertex attributes.
 */
function routeOf(src: BakeSource, livery: string): 'livery' | 'decal' | 'glass' | 'opaque' {
  if (src.name === livery) return 'livery'
  if (src.blend) return /glass|window|windshield/i.test(src.name) || !src.base ? 'glass' : 'decal'
  return 'opaque'
}

/**
 * Bakes a part's material into vertex attributes:
 *   COLOR_0  linear base colour, opacity
 *   _PBR     roughness, metalness, brake-light mask, brake-disc mask (opaque) or the glass's
 *            reflection compensation as an opacity (glass: alpha blending scales the reflection by the
 *            opacity, the game divides by it)
 *   _EMIT    emission / EMIT_SCALE (linear)
 * `mode` 'opaqueGlass': windows drawn opaque (far level). `rearZ`: triangles behind it light up with the
 * brakes, for materials that light the head and tail lights together (see gltfCars.ts splitLights).
 */
function bake(p: Part, src: BakeSource, mode: 'opaque' | 'glass' | 'opaqueGlass', rearZ: number): Part {
  const m = src.mat
  const n = p.attrs.POSITION.data.length / 3
  const col = new Float32Array(n * 4),
    pbr = new Float32Array(n * 4),
    emit = new Float32Array(n * 3)
  const bf = m?.getBaseColorFactor() ?? [1, 1, 1, 1]
  const rough0 = m?.getRoughnessFactor() ?? 1,
    metal0 = m?.getMetallicFactor() ?? 1
  const strength = (m?.getExtension('KHR_materials_emissive_strength') as EmissiveStrength | null)?.getEmissiveStrength() ?? 1
  const ef = (m?.getEmissiveFactor() ?? [0, 0, 0]).map((x) => x * strength)
  const name = src.name
  const rearAll = /Light_Rear/i.test(name)
  const rearSplit = /Lights$/i.test(name)
  const disc = /Disc/i.test(name) ? 1 : 0
  const window = isWindow(name) && src.blend
  const blackWindow = window && !src.base && !/sticker/i.test(name)
  const t = [0, 0, 0, 0]
  const uvOf = (sem: string) => p.attrs[sem]?.data ?? p.attrs.TEXCOORD_0?.data
  const bUV = uvOf(src.baseUV),
    mUV = uvOf(src.mrUV),
    eUV = uvOf(src.emUV)
  const P = p.attrs.POSITION.data
  for (let i = 0; i < n; i++) {
    let r = bf[0],
      g = bf[1],
      b = bf[2],
      a = src.blend ? bf[3] : 1
    if (src.base && bUV) {
      sampleRaw(src.base, bUV[i * 2], bUV[i * 2 + 1], t)
      r *= srgb2lin(t[0])
      g *= srgb2lin(t[1])
      b *= srgb2lin(t[2])
      if (src.blend) a *= t[3]
    }
    let rough = rough0,
      metal = metal0
    if (src.mr && mUV) {
      sampleRaw(src.mr, mUV[i * 2], mUV[i * 2 + 1], t)
      rough *= t[1]
      metal *= t[2]
    }
    let er = ef[0],
      eg = ef[1],
      eb = ef[2]
    if (src.em && eUV && (er || eg || eb || rearAll || rearSplit)) {
      sampleRaw(src.em, eUV[i * 2], eUV[i * 2 + 1], t)
      er *= srgb2lin(t[0])
      eg *= srgb2lin(t[1])
      eb *= srgb2lin(t[2])
    }
    // brake lights: the game sets their emission (red, brighter with the brakes) over the emissive map
    let rear = 0
    if (rearAll || (rearSplit && P[i * 3 + 2] < rearZ)) {
      rear = src.em && eUV ? Math.max(t[0], t[1], t[2]) : 1
      er = eg = eb = 0
    }
    if (window) {
      metal = 0
      rough = Math.min(rough, 0.03)
      if (blackWindow) {
        r = g = b = 0
        a = Math.min(a, 0.3)
      }
    }
    if (mode !== 'glass') a = 1
    col.set([r, g, b, a].map((x) => Math.min(1, Math.max(0, x))), i * 4)
    const w = mode === 'glass' ? (blackWindow ? Math.max(0.25, a) : 1) : disc
    pbr.set([Math.min(1, Math.max(0.02, rough)), Math.min(1, Math.max(0, metal)), rear, w], i * 4)
    emit.set([er, eg, eb].map((x) => Math.min(1, Math.max(0, x / EMIT_SCALE))), i * 3)
  }
  const normal = p.attrs.NORMAL ?? { size: 3, data: new Float32Array(n * 3).map((_, k) => (k % 3 === 1 ? 1 : 0)) }
  return {
    material: null,
    group: p.group,
    sig: 'baked',
    attrs: { POSITION: p.attrs.POSITION, NORMAL: normal, COLOR_0: { size: 4, data: col }, _PBR: { size: 4, data: pbr }, _EMIT: { size: 3, data: emit } },
    indices: p.indices,
    min: p.min,
    max: p.max,
  }
}

/** A part moved by `d` (wheel parts are stored relative to their wheel's centre). */
function translated(p: Part, d: V3): Part {
  const P = p.attrs.POSITION.data.slice()
  for (let i = 0; i < P.length; i += 3) {
    P[i] += d[0]
    P[i + 1] += d[1]
    P[i + 2] += d[2]
  }
  const [min, max] = bounds(P)
  return { ...p, attrs: { ...p.attrs, POSITION: { size: 3, data: P } }, min, max }
}

/** Surface area of a part (m^2). */
function area(p: Part) {
  const P = p.attrs.POSITION.data,
    I = p.indices
  let s = 0
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3,
      b = I[t + 1] * 3,
      c = I[t + 2] * 3
    const ux = P[b] - P[a],
      uy = P[b + 1] - P[a + 1],
      uz = P[b + 2] - P[a + 2]
    const vx = P[c] - P[a],
      vy = P[c + 1] - P[a + 1],
      vz = P[c + 2] - P[a + 2]
    s += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
  }
  return s
}

/** Merges parts that share a vertex layout (one primitive each layout), with the given material. */
function mergeBySig(parts: Part[], material?: Material | null): Part[] {
  const by = new Map<string, Part[]>()
  const ids = new Map<Material | null, number>()
  for (const p of parts) {
    if (!ids.has(p.material)) ids.set(p.material, ids.size)
    const key = p.sig + '|' + (material === undefined ? ids.get(p.material) : '')
    by.set(key, [...(by.get(key) ?? []), p])
  }
  return [...by.values()].map((l) => ({ ...merge(l), material: material === undefined ? l[0].material : material }))
}

async function build(def: ModelDef) {
  const t0 = performance.now()
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
  let doc: Document
  if (def.src.endsWith('.zip')) {
    const files = unzipSync(new Uint8Array(readFileSync(def.src)))
    const glb = Object.keys(files).find((f) => f.toLowerCase().endsWith('.glb'))
    if (!glb) throw new Error(`${def.src}: no .glb inside`)
    doc = await io.readBinary(files[glb])
  } else doc = await io.read(def.src)
  const prims = listPrims(doc)
  const Y = yawMat(def.yaw)

  // ---- pass 1: wheel centres -> scale and origin
  const tyreBox = new Map<string, { mn: V3; mx: V3 }>()
  for (const { prim, world } of prims) {
    const mat = prim.getMaterial()?.getName() ?? ''
    if (!def.spin.test(mat) || !/tyre|tire/i.test(mat)) continue
    const M = mul(Y, world)
    const pos = readAttr(prim, 'POSITION').data
    for (let i = 0; i < pos.length; i += 3) {
      const p = xform(M, [pos[i], pos[i + 1], pos[i + 2]])
      const k = cornerOf(p[0], p[2])
      const b = tyreBox.get(k) ?? { mn: [Infinity, Infinity, Infinity] as V3, mx: [-Infinity, -Infinity, -Infinity] as V3 }
      for (let a = 0; a < 3; a++) {
        b.mn[a] = Math.min(b.mn[a], p[a])
        b.mx[a] = Math.max(b.mx[a], p[a])
      }
      tyreBox.set(k, b)
    }
  }
  const centre = (k: string): V3 => {
    const b = tyreBox.get(k)!
    return [(b.mn[0] + b.mx[0]) / 2, (b.mn[1] + b.mx[1]) / 2, (b.mn[2] + b.mx[2]) / 2]
  }
  const zF = (centre('FL')[2] + centre('FR')[2]) / 2,
    zR = (centre('RL')[2] + centre('RR')[2]) / 2
  const x0 = CORNERS.reduce((a, k) => a + centre(k)[0], 0) / 4
  const ground = Math.min(...CORNERS.map((k) => tyreBox.get(k)!.mn[1]))
  const scale = TARGET_WHEELBASE / (zF - zR)
  const origin: V3 = [x0, ground, (zF + zR) / 2]
  // N = S * T(-origin) * Y
  const N: Mat4 = mul([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, -origin[0] * scale, -origin[1] * scale, -origin[2] * scale, 1], Y)
  const wheel: Record<string, { centre: V3; radius: number }> = {}
  for (const k of CORNERS) {
    const b = tyreBox.get(k)!
    const c = centre(k)
    wheel[k] = { centre: [(c[0] - origin[0]) * scale, (c[1] - origin[1]) * scale, (c[2] - origin[2]) * scale], radius: ((b.mx[1] - b.mn[1]) / 2) * scale }
  }

  // ---- pass 2: bake, classify, split the wheels
  const parts: Part[] = []
  let liveryMat = ''
  const seatBox: [V3, V3][] = [],
    steerBox: [V3, V3][] = []
  for (const { prim, world, path } of prims) {
    const material = prim.getMaterial()
    const mat = material?.getName() ?? ''
    if (def.drop.test(mat) || def.drop.test(path)) continue
    if (prim.getMode() !== 4) continue // triangles only
    if (def.livery.test(mat)) liveryMat = mat
    const M = mul(N, world)
    const flip = det3(M) < 0
    const sems = prim.listSemantics().filter((s) => /^(POSITION|NORMAL|TANGENT|TEXCOORD_[01]|COLOR_0)$/.test(s))
    const attrs: Part['attrs'] = {}
    for (const s of sems) attrs[s] = readAttr(prim, s)
    const P = attrs.POSITION.data
    for (let i = 0; i < P.length; i += 3) {
      const p = xform(M, [P[i], P[i + 1], P[i + 2]])
      P[i] = p[0]
      P[i + 1] = p[1]
      P[i + 2] = p[2]
    }
    for (const s of ['NORMAL', 'TANGENT']) {
      const a = attrs[s]
      if (!a) continue
      for (let i = 0; i < a.data.length; i += a.size) {
        const n = xform(M, [a.data[i], a.data[i + 1], a.data[i + 2]], 0)
        const l = Math.hypot(n[0], n[1], n[2]) || 1
        a.data[i] = n[0] / l
        a.data[i + 1] = n[1] / l
        a.data[i + 2] = n[2] / l
        if (s === 'TANGENT' && flip) a.data[i + 3] *= -1
      }
    }
    const idxAcc = prim.getIndices()
    let tris: number[] = idxAcc ? Array.from(idxAcc.getArray()!) : Array.from({ length: P.length / 3 }, (_, i) => i)
    if (flip) for (let i = 0; i < tris.length; i += 3) [tris[i + 1], tris[i + 2]] = [tris[i + 2], tris[i + 1]]
    const sig = sems.join(',')
    const [mn, mx] = bounds(P)
    if (def.seat.test(mat)) seatBox.push([mn, mx])
    if (def.steer.test(mat)) steerBox.push([mn, mx])

    const kind = def.spin.test(mat) ? 'spin' : def.fixed.test(mat) || def.fixed.test(path) ? 'fixed' : def.steeringWheel.test(path) || def.steeringWheel.test(mat) ? 'steer' : 'body'
    if (kind === 'steer') {
      parts.push({ material, group: 'steer', sig, ...compact(attrs, tris), min: mn, max: mx })
      continue
    }
    if (kind === 'body') {
      parts.push({ material, group: 'body', sig, ...compact(attrs, tris), min: mn, max: mx })
      continue
    }
    // wheel parts: by the corner each triangle belongs to, relative to that wheel's centre
    const byCorner = new Map<string, number[]>()
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3,
        b = tris[t + 1] * 3,
        c = tris[t + 2] * 3
      const k = cornerOf((P[a] + P[b] + P[c]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3)
      const l = byCorner.get(k) ?? []
      l.push(tris[t], tris[t + 1], tris[t + 2])
      byCorner.set(k, l)
    }
    for (const [k, list] of byCorner) {
      const c = compact(attrs, list)
      const wc = wheel[k].centre
      const p = c.attrs.POSITION.data
      for (let i = 0; i < p.length; i += 3) {
        p[i] -= wc[0]
        p[i + 1] -= wc[1]
        p[i + 2] -= wc[2]
      }
      const [a, b] = bounds(p)
      parts.push({ material, group: `${k}:${kind}`, sig, ...c, min: a, max: b })
    }
  }

  // ---- steering wheel pivot and axis
  let steering: { pivot: V3; axis: V3 } | null = null
  const steerParts = parts.filter((p) => p.group === 'steer')
  if (steerParts.length) {
    const mn: V3 = [Infinity, Infinity, Infinity],
      mx: V3 = [-Infinity, -Infinity, -Infinity]
    for (const p of steerParts)
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], p.min[k])
        mx[k] = Math.max(mx[k], p.max[k])
      }
    // the wheel is the rearmost part of the group (the column runs forward from it)
    const zCut = mn[2] + 0.4 * (mx[2] - mn[2])
    const wmn: V3 = [Infinity, Infinity, Infinity],
      wmx: V3 = [-Infinity, -Infinity, -Infinity]
    for (const p of steerParts) {
      const P = p.attrs.POSITION.data
      for (let i = 0; i < P.length; i += 3) {
        if (P[i + 2] > zCut) continue
        for (let k = 0; k < 3; k++) {
          wmn[k] = Math.min(wmn[k], P[i + k])
          wmx[k] = Math.max(wmx[k], P[i + k])
        }
      }
    }
    const c: V3 = [(wmn[0] + wmx[0]) / 2, (wmn[1] + wmx[1]) / 2, (wmn[2] + wmx[2]) / 2]
    // covariance of the wheel's vertices, then the eigenvector of the smallest eigenvalue (Jacobi)
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0]
    let n = 0
    for (const p of steerParts) {
      const P = p.attrs.POSITION.data
      for (let i = 0; i < P.length; i += 3) {
        if (P[i + 2] > zCut) continue
        const d = [P[i] - c[0], P[i + 1] - c[1], P[i + 2] - c[2]]
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b] += d[a] * d[b]
        n++
      }
    }
    const A = C.map((x) => x / n)
    const V = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    for (let sweep = 0; sweep < 30; sweep++)
      for (const [p, q] of [
        [0, 1],
        [0, 2],
        [1, 2],
      ]) {
        const apq = A[p * 3 + q]
        if (Math.abs(apq) < 1e-12) continue
        const th = 0.5 * Math.atan2(2 * apq, A[q * 3 + q] - A[p * 3 + p])
        const cs = Math.cos(th),
          sn = Math.sin(th)
        for (let k = 0; k < 3; k++) {
          const akp = A[k * 3 + p],
            akq = A[k * 3 + q]
          A[k * 3 + p] = cs * akp - sn * akq
          A[k * 3 + q] = sn * akp + cs * akq
        }
        for (let k = 0; k < 3; k++) {
          const apk = A[p * 3 + k],
            aqk = A[q * 3 + k]
          A[p * 3 + k] = cs * apk - sn * aqk
          A[q * 3 + k] = sn * apk + cs * aqk
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k * 3 + p],
            vkq = V[k * 3 + q]
          V[k * 3 + p] = cs * vkp - sn * vkq
          V[k * 3 + q] = sn * vkp + cs * vkq
        }
      }
    const ev = [A[0], A[4], A[8]]
    const j = ev.indexOf(Math.min(...ev))
    let axis: V3 = [V[j], V[3 + j], V[6 + j]]
    // point it backwards (towards the driver), as a column would
    if (axis[2] > 0) axis = [-axis[0], -axis[1], -axis[2]]
    steering = { pivot: c, axis }
    for (const p of steerParts) {
      const P = p.attrs.POSITION.data
      for (let i = 0; i < P.length; i += 3) {
        P[i] -= c[0]
        P[i + 1] -= c[1]
        P[i + 2] -= c[2]
      }
    }
  }

  // ---- merge by group and material, build the levels of detail
  const groups = new Map<string, Part[]>()
  for (const p of parts) {
    const key = `${p.group}|${p.material?.getName() ?? ''}|${doc.getRoot().listMaterials().indexOf(p.material!)}|${p.sig}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  const cabin = (p: Part) => p.min[0] > -0.78 && p.max[0] < 0.78 && p.min[1] > 0.1 && p.max[1] < 1.02 && p.min[2] > -1.05 && p.max[2] < 0.8
  const tiny = (p: Part) => Math.hypot(p.max[0] - p.min[0], p.max[1] - p.min[1], p.max[2] - p.min[2]) < 0.05
  const small = (p: Part) => Math.hypot(p.max[0] - p.min[0], p.max[1] - p.min[1], p.max[2] - p.min[2]) < 0.2
  // what the baked levels sample (decoded once per texture)
  const srcs = new Map<Material | null, BakeSource>()
  for (const p of parts) if (!srcs.has(p.material)) srcs.set(p.material, await bakeSource(p.material))
  // the brake lights of materials that light the head and tail lights together: the rear quarter
  let zMin = Infinity,
    zMax = -Infinity
  for (const p of parts)
    if (p.group === 'body') {
      zMin = Math.min(zMin, p.min[2])
      zMax = Math.max(zMax, p.max[2])
    }
  const rearZ = zMin + 0.25 * (zMax - zMin)
  const lodOpaque = doc.createMaterial('lod:opaque').setMetallicFactor(0).setRoughnessFactor(1)
  const lodGlass = doc.createMaterial('lod:glass').setAlphaMode('BLEND').setDoubleSided(true).setMetallicFactor(0).setRoughnessFactor(0.05)
  const lod0 = new Map<string, Part[]>()
  const lod1 = { livery: [] as Part[], opaque: [] as Part[], glass: [] as Part[], decals: [] as Part[], wheels: new Map<string, Part[]>() }
  const lod2 = { livery: [] as Part[], opaque: [] as Part[] }
  const dropped: string[] = []
  for (const list of groups.values()) {
    const g = list[0].group
    const m0 = merge(list)
    lod0.set(g, [...(lod0.get(g) ?? []), m0])
    if (g.endsWith(':fixed') || g === 'steer') continue // calipers and the steering wheel vanish at a distance
    const src = srcs.get(list[0].material)!
    const route = routeOf(src, liveryMat)
    const body = g === 'body'
    const corner = body ? '' : g.split(':')[0]
    const keep1 = body ? list.filter((p) => !cabin(p) && !tiny(p)) : list
    if (keep1.length) {
      // (from 24 m at a 50 degree lens: a pixel is 2 cm at 1080p, 1 cm at 4K)
      const s1 = simplifyPart(merge(keep1), body ? LOD1.body : LOD1.wheel, LOD1.error, true, true)
      if (s1 && !body) lod1.wheels.set(corner, [...(lod1.wheels.get(corner) ?? []), bake(s1, src, 'opaque', rearZ)])
      else if (s1 && route === 'livery') lod1.livery.push(s1)
      else if (s1 && route === 'decal') {
        if (area(s1) >= DECAL_MIN_AREA) lod1.decals.push(s1)
        else dropped.push(`${src.name} (${area(s1).toFixed(3)} m2)`)
      } else if (s1) (route === 'glass' ? lod1.glass : lod1.opaque).push(bake(s1, src, route === 'glass' ? 'glass' : 'opaque', rearZ))
    }
    // far level: silhouette and paint only (the windows opaque, the wheels merged in, no decals)
    const keep2 = body ? list.filter((p) => !cabin(p) && !small(p)) : list
    if (keep2.length) {
      // (from 80 m: a pixel is 7 cm at 1080p; the probes' faces are coarser still)
      const s2 = simplifyPart(merge(keep2), body ? LOD2.body : LOD2.wheel, LOD2.error, false, true)
      if (!s2) continue
      if (!body) lod2.opaque.push(bake(translated(s2, wheel[corner].centre), src, 'opaque', rearZ))
      else if (route === 'livery') lod2.livery.push(s2)
      // lights keep their place (opaque); glass over them goes, so they show
      else if (route === 'decal') {
        if (isLight(src.name)) lod2.opaque.push(bake(s2, src, 'opaque', rearZ))
      } else if (route === 'glass') {
        if (isWindow(src.name)) lod2.opaque.push(bake(s2, src, 'opaqueGlass', rearZ))
      } else lod2.opaque.push(bake(s2, src, 'opaque', rearZ))
    }
  }
  if (dropped.length) console.log(`  middle level leaves out the decals ${dropped.join(', ')}`)
  // the merged opaque part once more as a whole (its material seams no longer limit it)
  const again = (p: Part) => simplifyPart(p, 0.4, LOD1.error, true, true) ?? p
  const body1 = [...mergeBySig(lod1.livery), ...mergeBySig(lod1.opaque, lodOpaque).map(again), ...mergeBySig(lod1.glass, lodGlass), ...mergeBySig(lod1.decals)]
  const body2 = [...mergeBySig(lod2.livery), ...mergeBySig(lod2.opaque, lodOpaque).map((p) => sloppy(p, LOD2.bakedTris, LOD2.error))]
  const wheels1 = new Map([...lod1.wheels].map(([k, l]) => [k, mergeBySig(l, lodOpaque)]))
  const tris = (l: Part[]) => l.reduce((s, p) => s + p.indices.length / 3, 0)
  const tris0 = [...lod0.values()].reduce((s, l) => s + tris(l), 0)
  const tris1 = tris(body1) + [...wheels1.values()].reduce((s, l) => s + tris(l), 0)
  const tris2 = tris(body2)
  console.log(`  primitives: LOD0 body ${lod0.get('body')!.length}, steering ${lod0.get('steer')?.length ?? 0}; LOD1 body ${body1.length} (${body1.map((p) => `${p.material?.getName()} ${p.indices.length / 3}`).join(', ')}), wheels 1 each (${tris(wheels1.get('FL') ?? [])}); LOD2 body ${body2.length} (${body2.map((p) => p.indices.length / 3).join(', ')}), wheels merged in`)

  // ---- new scene
  const root = doc.getRoot()
  const buffer = root.listBuffers()[0] ?? doc.createBuffer()
  const scene = root.listScenes()[0]
  for (const n of scene.listChildren()) scene.removeChild(n)
  const makeMesh = (name: string, list: Part[]) => {
    const mesh = doc.createMesh(name)
    for (const p of list) {
      const prim = doc.createPrimitive().setMaterial(p.material)
      for (const [sem, a] of Object.entries(p.attrs)) {
        const type = a.size === 2 ? 'VEC2' : a.size === 3 ? 'VEC3' : 'VEC4'
        prim.setAttribute(sem, doc.createAccessor().setType(type).setArray(a.data as Float32Array<ArrayBuffer>).setBuffer(buffer))
      }
      prim.setIndices(doc.createAccessor().setType("SCALAR").setArray(p.indices as Uint32Array<ArrayBuffer>).setBuffer(buffer))
      mesh.addPrimitive(prim)
    }
    return mesh
  }
  // a transform node with its mesh on a leaf node of its own (see the header: quantization)
  const pivotNode = (name: string, list: Part[]) => doc.createNode(name).addChild(doc.createNode(name + '_mesh').setMesh(makeMesh(name, list)))
  const top = doc.createNode('car')
  scene.addChild(top)
  top.addChild(doc.createNode('body_lod0').setMesh(makeMesh('body_lod0', lod0.get('body')!)))
  top.addChild(doc.createNode('body_lod1').setMesh(makeMesh('body_lod1', body1)))
  top.addChild(doc.createNode('body_lod2').setMesh(makeMesh('body_lod2', body2)))
  if (steering && lod0.get('steer')) top.addChild(pivotNode('steering', lod0.get('steer')!).setTranslation(steering.pivot))
  for (const k of CORNERS) {
    const w = doc.createNode(`wheel_${k}`).setTranslation(wheel[k].centre)
    top.addChild(w)
    const spin0 = lod0.get(`${k}:spin`)
    if (spin0) w.addChild(doc.createNode(`wheel_${k}_spin_lod0`).setMesh(makeMesh(`wheel_${k}_spin_lod0`, spin0)))
    const spin1 = wheels1.get(k)
    if (spin1) w.addChild(doc.createNode(`wheel_${k}_spin_lod1`).setMesh(makeMesh(`wheel_${k}_spin_lod1`, spin1)))
    const fixed = lod0.get(`${k}:fixed`)
    if (fixed) w.addChild(pivotNode(`wheel_${k}_fixed`, fixed))
  }
  const boxCentre = (bs: [V3, V3][]): V3 | null => {
    if (!bs.length) return null
    const mn = [0, 1, 2].map((k) => Math.min(...bs.map((b) => b[0][k]))),
      mx = [0, 1, 2].map((k) => Math.max(...bs.map((b) => b[1][k])))
    return [0, 1, 2].map((k) => +((mn[k] + mx[k]) / 2).toFixed(4)) as V3
  }
  const asset = root.getAsset() as { extras?: Record<string, string> }
  top.setExtras({
    id: def.id,
    name: def.name,
    livery: liveryMat,
    paint: def.paint,
    wheels: Object.fromEntries(CORNERS.map((k) => [k, { centre: wheel[k].centre.map((x) => +x.toFixed(4)), radius: +wheel[k].radius.toFixed(4) }])),
    seat: boxCentre(seatBox),
    steeringWheel: steering ? steering.pivot.map((x) => +x.toFixed(4)) : boxCentre(steerBox),
    steeringAxis: steering ? steering.axis.map((x) => +x.toFixed(4)) : null,
    credit: { title: asset.extras?.title ?? '', author: asset.extras?.author ?? '', license: asset.extras?.license ?? '', source: asset.extras?.source ?? '' },
  })
  await doc.transform(prune())

  // ---- textures: single-colour images become factors, the rest are sized to the finest detail a
  //      camera can see on the parts that use them
  await constantTextures(doc)
  await textureBudget(doc)

  // ---- textures: name them by use. The livery stays sharp; surface data (normals, roughness and
  //      metalness, clear coat) keeps the source's resolution, in near-lossless WebP (lossy WebP
  //      halves the chroma resolution, and a normal map's x and y are its colour); colour maps
  //      (base colour, emissive, occlusion) can be smaller.
  const liveryTex = root.listMaterials().find((m) => m.getName() === liveryMat)?.getBaseColorTexture()
  root.listTextures().forEach((t, i) => t.setName(t === liveryTex ? 'livery' : listTextureSlots(t).some((slot) => DATA_SLOTS.test(slot)) ? `data${i}` : `tex${i}`))
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [4096, 4096], quality: 90, pattern: /^livery$/ }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [4096, 4096], nearLossless: true, quality: 80, pattern: /^data\d+$/ }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85, pattern: /^tex\d+$/ }),
  )
  // noise-like data (metallic flake, orange peel) barely compresses without loss: above ~0.5 bytes per
  // texel it is stored lossy instead (quality 82: the error is indistinguishable from the noise itself)
  for (const t of root.listTextures()) {
    const img = t.getImage()
    if (!/^data\d+$/.test(t.getName()) || !img) continue
    const meta = await sharp(Buffer.from(img)).metadata()
    if (img.byteLength > 0.5 * (meta.width ?? 1) * (meta.height ?? 1)) t.setName(t.getName().replace('data', 'noisy'))
  }
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 82, pattern: /^noisy\d+$/ }),
    // (the baked levels' linear vertex colours in 12 bits: 8 bits band the dark paints)
    meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizeColor: 12 }),
  )
  mkdirSync('public/models', { recursive: true })
  const out = `public/models/${def.id}.glb`
  await io.write(out, doc)
  console.log(`${def.id}: scale ${scale.toFixed(4)}, wheelbase ${TARGET_WHEELBASE} m, radii F ${wheel.FL.radius.toFixed(3)} R ${wheel.RL.radius.toFixed(3)}, track F ${(wheel.FL.centre[0] - wheel.FR.centre[0]).toFixed(3)} R ${(wheel.RL.centre[0] - wheel.RR.centre[0]).toFixed(3)}`)
  console.log(`  livery material "${liveryMat}", LOD0 ${Math.round(tris0)} tris, LOD1 ${Math.round(tris1)}, LOD2 ${Math.round(tris2)}, ${root.listMaterials().length} materials, ${root.listTextures().length} textures`)
  console.log(`  ${out}: ${(statSync(out).size / 1e6).toFixed(1)} MB (source ${(statSync(def.src).size / 1e6).toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}

await MeshoptEncoder.ready
await MeshoptSimplifier.ready
const only = process.argv[2]
for (const def of MODELS) if (!only || def.id === only) await build(def)
