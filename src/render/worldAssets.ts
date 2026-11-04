// Runtime side of scripts/build-world-assets.ts: the photographic sky, the photo-scanned ground
// textures and the vegetation meshes (public/world). Textures are handed out at once and fill in when
// their image arrives; loadWorldAssets() resolves when everything is in (the boot screen waits on it).
import * as THREE from 'three/webgpu'

const base = () => ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/') + 'world/'

const pending: Promise<unknown>[] = []
const loader = new THREE.TextureLoader()
/** texture -> its image has arrived */
const arrived = new WeakMap<THREE.Texture, Promise<void>>()

function tex(path: string, srgb: boolean, opts: { flipY?: boolean; anisotropy?: number; mips?: boolean } = {}) {
  let done = () => {}
  const ready = new Promise<void>((res) => (done = res))
  pending.push(ready)
  const t = loader.load(
    base() + path,
    () => done(),
    undefined,
    (e) => {
      console.warn('[world] texture failed', path, e)
      done()
    },
  )
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.flipY = opts.flipY ?? true
  t.anisotropy = opts.anisotropy ?? 8
  t.generateMipmaps = opts.mips ?? true
  t.minFilter = t.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  arrived.set(t, ready)
  return t
}

// ------------------------------------------------------------------------------------------ sky

export interface SkyMeta {
  width: number
  height: number
  elevMin: number
  elevMax: number
  logMin: number
  logMax: number
  sunDir: [number, number, number]
  sunIrradiance: [number, number, number]
  skyIrradiance: [number, number, number]
  source: { title: string; author: string; license: string; url: string }
}

/** Measured from public/world/sky/sky.json at build time (the json is still read to stay in sync). */
export const skyMeta: SkyMeta = {
  width: 4096,
  height: 1152,
  elevMin: -11.25,
  elevMax: 90,
  logMin: -6,
  logMax: 16,
  sunDir: [0.55428, 0.7418, 0.37749],
  sunIrradiance: [4.3138, 4.3386, 3.9472],
  skyIrradiance: [1.4026, 1.6015, 2.2697],
  source: { title: 'Kloofendal 48d Partly Cloudy (Pure Sky)', author: 'Poly Haven', license: 'CC0', url: 'https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky' },
}

let skyTex: { colour: THREE.Texture; gain: THREE.Texture } | null = null
let skyArrived: Promise<void> | null = null
/** Resolves when the sky's images and metadata are in (the environment map is captured from them). */
export function skyReady() {
  skyTextures()
  return skyArrived!
}
export function skyTextures() {
  if (!skyTex) {
    // the sky is magnified on screen at any field of view: no mipmaps needed for the dome itself, but
    // the aerial perspective reads a blurred level
    skyTex = { colour: tex('sky/sky-colour.webp', true, { flipY: false, anisotropy: 1 }), gain: tex('sky/sky-gain.webp', false, { flipY: false, anisotropy: 1 }) }
    skyTex.gain.wrapT = skyTex.colour.wrapT = THREE.ClampToEdgeWrapping
    const meta = fetch(base() + 'sky/sky.json')
      .then((r) => r.json())
      .then((m: SkyMeta) => void Object.assign(skyMeta, m))
      .catch(() => {})
    pending.push(meta)
    skyArrived = Promise.all([arrived.get(skyTex.colour), arrived.get(skyTex.gain), meta]).then(() => undefined)
  }
  return skyTex
}

// ------------------------------------------------------------------------------------------ ground

export interface GroundSet {
  colour: THREE.Texture
  /** r, g: tangent-space normal x/y (OpenGL), b: roughness */
  data: THREE.Texture
}

const ground = new Map<string, GroundSet>()
/** Photo-scanned PBR set: 'asphalt' | 'pitlane' | 'grass' | 'leafy'. */
export function groundSet(id: 'asphalt' | 'pitlane' | 'grass' | 'leafy'): GroundSet {
  let g = ground.get(id)
  if (!g) {
    g = { colour: tex(`ground/${id}-colour.jpg`, true, { anisotropy: 16 }), data: tex(`ground/${id}-data.jpg`, false, { anisotropy: 16 }) }
    ground.set(id, g)
  }
  return g
}

// ------------------------------------------------------------------------------------------ vegetation

interface AttrLayout {
  offset: number
  count: number
  itemSize: number
  type: 'f32' | 'u16' | 'u32'
}

export interface VegMeshInfo {
  id: string
  bin: string
  atlas: string
  layout: Record<'position' | 'normal' | 'uv' | 'wind' | 'index', AttrLayout>
  bounds: { min: [number, number, number]; max: [number, number, number] }
  vertices: number
  triangles: number
  credit?: { title: string; author: string; license: string; source: string }
}

export interface VegMesh {
  info: VegMeshInfo
  geometry: THREE.BufferGeometry
  atlas: THREE.Texture
}

let veg: Promise<Map<string, VegMesh>> | null = null
export const vegState = { ready: false, meshes: new Map<string, VegMesh>(), credits: [] as NonNullable<VegMeshInfo['credit']>[] }

function attr(buf: ArrayBuffer, l: AttrLayout) {
  const n = l.count * l.itemSize
  return l.type === 'f32' ? new Float32Array(buf, l.offset, n) : l.type === 'u32' ? new Uint32Array(buf, l.offset, n) : new Uint16Array(buf, l.offset, n)
}

/** Vegetation meshes: one geometry and one atlas texture each (one material, one draw call). */
export function loadVegetation() {
  if (veg) return veg
  veg = fetch(base() + 'veg/vegetation.json')
    .then((r) => r.json())
    .then(async (manifest: Record<string, VegMeshInfo>) => {
      const out = new Map<string, VegMesh>()
      await Promise.all(
        Object.values(manifest).map(async (info) => {
          const buf = await (await fetch(base() + 'veg/' + info.bin)).arrayBuffer()
          const g = new THREE.BufferGeometry()
          g.setAttribute('position', new THREE.BufferAttribute(attr(buf, info.layout.position), 3))
          g.setAttribute('normal', new THREE.BufferAttribute(attr(buf, info.layout.normal), 3))
          g.setAttribute('uv', new THREE.BufferAttribute(attr(buf, info.layout.uv), 2))
          g.setAttribute('wind', new THREE.BufferAttribute(attr(buf, info.layout.wind), 2))
          g.setIndex(new THREE.BufferAttribute(attr(buf, info.layout.index), 1))
          g.boundingBox = new THREE.Box3(new THREE.Vector3(...info.bounds.min), new THREE.Vector3(...info.bounds.max))
          g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere())
          // atlas uvs follow the glTF convention (v down from the top of the image)
          const atlas = tex('veg/' + info.atlas, true, { flipY: false, anisotropy: 4 })
          atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping
          // the impostors are baked from these: wait for the image
          await arrived.get(atlas)
          out.set(info.id, { info, geometry: g, atlas })
          if (info.credit) vegState.credits.push(info.credit)
        }),
      )
      vegState.meshes = out
      vegState.ready = true
      return out
    })
    .catch((e) => {
      console.warn('[world] vegetation unavailable:', e)
      return new Map<string, VegMesh>()
    })
  pending.push(veg)
  return veg
}

/** Resolves when every world asset requested so far (and the vegetation) has arrived. */
export function loadWorldAssets(): Promise<void> {
  skyTextures()
  for (const id of ['asphalt', 'pitlane', 'grass', 'leafy'] as const) groundSet(id)
  loadVegetation()
  return Promise.all(pending).then(() => undefined)
}

/** Credits for the photographic sky and the vegetation models (Settings). */
export function worldCredits() {
  return [{ title: skyMeta.source.title, author: skyMeta.source.author, license: skyMeta.source.license, source: skyMeta.source.url }, ...vegState.credits]
}
