// Detailed GT3 car models (public/models, built by scripts/build-car-models.ts) as CarModel instances.
//
// Each car clones the shared template (geometry and most materials are shared between all cars) and
// gets its own livery material: the model's livery texture is recoloured in the shader to the team's
// colours (navy base -> team colour, red accents -> team accent), keeping logos, numbers and shading.
// Levels of detail (CarLOD): the full model near the camera; further away a simplified one (no
// interior; the livery keeps its material, everything else is baked into vertex attributes: a handful
// of draws); far away two draws. One decision per car switches the body, the wheels, the calipers, the
// steering wheel and the driver together. Shadow maps draw the simplified level at most (the car in
// focus included: its own map is a few millimetres per texel, where the simplified level's 4 mm
// tolerance does not show), reflection probes the far one. Wheels are separate pivots (spin, steer,
// suspension travel, camber).
import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { abs, attribute, BRDF_GGX, clamp, clearcoatNormalView, diffuseColor, dot, float, Fn, interleavedGradientNoise, materialColor, materialMetalness, max, min, mix, normalize, normalLocal, normalView, normalViewGeometry, output, positionLocal, positionViewDirection, pow, screenCoordinate, smoothstep, step, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import { makeMirrorEnv, mirrorRadiance, type MirrorEnv, type MirrorMaterial } from '../render/mirrorEnv'
import { HERO_LAYER } from '../render/sunShadow'
import { bumpView } from '../render/materials'
import { triMap } from '../render/surfaceDetail'
import { detailMaps } from '../render/worldAssets'
import type { CarSpec } from '../physics/spec'
import type { Vehicle } from '../physics/vehicle'
import type { CarModel } from './carModel'
import { discMaterial, fixBakedWheel, hubMaterial, rimMaterial, tyreMaterial, wheelGeometry, wheelOcclusion } from './wheelMaterials'

export const GLTF_CARS = [
  { id: 'ferrari-296-gt3', name: 'Ferrari 296 GT3' },
  { id: 'amg-gt3', name: 'Mercedes-AMG GT3' },
  { id: 'mustang-gt3', name: 'Ford Mustang GT3' },
] as const
export type GltfCarId = (typeof GLTF_CARS)[number]['id']

interface Meta {
  id: string
  name: string
  livery: string
  /** hiHue/hiV: lighter stripes of the base colour (they become a lighter shade of the team colour) */
  paint: { baseHue: number; baseV: number; accentHue: number; accentV: number; hiHue?: number; hiV?: number }
  wheels: Record<'FL' | 'FR' | 'RL' | 'RR', { centre: [number, number, number]; radius: number }>
  seat: [number, number, number] | null
  steeringWheel: [number, number, number] | null
  steeringAxis: [number, number, number] | null
  credit: { title: string; author: string; license: string; source: string }
}

interface Template {
  meta: Meta
  car: THREE.Object3D
  /** body extent along the car (model space, origin between the axles) */
  zFront: number
  zRear: number
}

const templates = new Map<GltfCarId, Template>()
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()
export const gltfState = { ready: false, failed: '' }

/**
 * Level-of-detail switch distances (m) for a 50 degree field of view. The TV cameras use very long
 * lenses, so the distance is scaled by the lens: a car 150 m away through a 5 degree lens is as big
 * on screen as one 15 m away through a normal one. The far level (simplified sloppily to two draws)
 * is darker than the others, its black parts merged over the livery: on screen only where a car is
 * ~50 px long at 1080p (it came in at 80 m, ~140 px, and popped); the simplified level (~100k
 * triangles, 10 draws) carries the cars out to there.
 */
const LOD_DISTANCES = [0, 30, 220]
const REF_TAN = Math.tan((50 * Math.PI) / 360)

/**
 * Level changes cross-fade instead of popping: for FADE_MS both levels draw, each where the screen's
 * dither (interleaved gradient noise, shifted every frame) falls inside its window, the incoming
 * level's window growing from nothing to everything and the outgoing one's shrinking in step, so every
 * pixel shows exactly one of them; the temporal AA blends the dither into a smooth fade. Windows are
 * per mesh (userData.lodWin, set by CarLOD for the camera that picks the levels); every other camera
 * (shadow maps, reflection probes) draws its single level whole.
 */
const FADE_MS = 300
const FULL = new THREE.Vector2(0, 2)
const lodWindow = uniform(new THREE.Vector2(0, 2)).onObjectUpdate((frame: { object: THREE.Object3D | null; camera: THREE.Camera | null }) => {
  const w = frame.object?.userData.lodWin as THREE.Vector2 | undefined
  const cam = frame.camera as THREE.PerspectiveCamera | null
  return w && w.isVector2 && cam && cam.isPerspectiveCamera && !cam.userData.probe ? w : FULL
})
const _shift = new THREE.Vector2()
const lodShift = uniform(new THREE.Vector2()).onFrameUpdate((frame: { frameId: number }) => _shift.set((frame.frameId * 5.588238) % 64, (frame.frameId * 3.183099) % 64))
const lodDither = interleavedGradientNoise(screenCoordinate.xy.add(lodShift))
const lodMask = lodDither.greaterThanEqual(lodWindow.x).and(lodDither.lessThan(lodWindow.y))

/** The node material the renderer would make of a plain one (NodeLibrary.fromMaterial), so that it can
 *  take nodes (the cross-fade's mask, realMetals' metalness). */
function toNodeMaterial(m: THREE.Material): THREE.Material {
  if ((m as unknown as { isNodeMaterial?: boolean }).isNodeMaterial) return m
  const s = m as THREE.MeshPhysicalMaterial
  const nm = s.isMeshPhysicalMaterial ? new THREE.MeshPhysicalNodeMaterial() : s.isMeshStandardMaterial ? new THREE.MeshStandardNodeMaterial() : (m as THREE.MeshBasicMaterial).isMeshBasicMaterial ? new THREE.MeshBasicNodeMaterial() : null
  if (!nm) return m
  for (const key in m) (nm as unknown as Record<string, unknown>)[key] = (m as unknown as Record<string, unknown>)[key]
  return nm
}
/** A car material that can take part in a level cross-fade (in place where it already is a node material). */
function fadeable(m: THREE.Material) {
  const nm = toNodeMaterial(m) as THREE.Material & { maskNode?: unknown; isNodeMaterial?: boolean }
  if (nm.isNodeMaterial && !nm.maskNode) nm.maskNode = lodMask
  return nm
}

/**
 * One level-of-detail decision per car, applied to all of its parts (the body, wheels, calipers,
 * steering wheel and driver switch together: a wheel never shows a different level from the body it
 * hangs on). Called by the renderer for every camera that draws the car:
 *  - the main camera: by the car's size on screen, with hysteresis (remembered as the car's level);
 *  - shadow cameras (orthographic): the car's level, but never the full model (the shadow of the
 *    simplified one is indistinguishable, and the full one is dozens of draws per shadow map);
 *  - reflection probes: the far level.
 * It carries the hero's layer as well, so the hero's own shadow map (which draws nothing else) updates
 * it too.
 */
const _fwd = new THREE.Vector3()
const _rel = new THREE.Vector3()

class CarLOD extends THREE.LOD {
  /** the level the main camera picked, and the car's depth in its view (m) */
  mainLevel = 0
  depth = 0
  /** the main camera's level and, while a change fades, the level fading out (-1: none) */
  private target = -1
  private from = -1
  private fadeStart = 0
  private shown = ''
  private wins: THREE.Vector2[]
  private _camPos = new THREE.Vector3()
  private _objPos = new THREE.Vector3()
  constructor(private parts: THREE.Object3D[][]) {
    super()
    this.layers.enable(HERO_LAYER)
    this.wins = parts.map((list) => {
      const w = new THREE.Vector2(0, 2)
      for (const o of list) o.traverse((x) => (x.userData.lodWin = w))
      return w
    })
    this.show(0, -1)
  }
  /** shows level a (and level b, fading), hides the rest */
  private show(a: number, b: number) {
    const key = a + ':' + b
    if (key === this.shown) return
    this.shown = key
    this.parts.forEach((list, k) => {
      for (const o of list) o.visible = k === a || k === b
    })
    ;(this as unknown as { _currentLevel: number })._currentLevel = a
  }
  update(camera: THREE.Camera) {
    const last = this.parts.length - 1
    if (camera.userData.probe) return this.show(last, -1)
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      // a cascade whose receivers this car's shadow cannot reach (sunShadow.ts tagCascadeDepths)
      const r = camera.userData.cascadeDepth as [number, number] | undefined
      if (r && (this.depth < r[0] || this.depth > r[1])) return this.show(-1, -1)
      // cascades whose texels are coarser than the far level's tolerance (8 cm) draw that
      const far = ((camera.userData.cascadeTexel as number | undefined) ?? 0) > 0.08 ? last : 1
      return this.show(Math.min(last, Math.max(this.mainLevel, far)), -1)
    }
    this._camPos.setFromMatrixPosition(camera.matrixWorld)
    this._objPos.setFromMatrixPosition(this.matrixWorld)
    // view depth (for the cascades), then the distance scaled by the lens
    this.depth = _fwd.set(0, 0, -1).transformDirection(camera.matrixWorld).dot(_rel.subVectors(this._objPos, this._camPos))
    let d = this._camPos.distanceTo(this._objPos)
    const pc = camera as THREE.PerspectiveCamera
    if (pc.isPerspectiveCamera) d *= Math.tan((pc.fov * Math.PI) / 360) / REF_TAN / pc.zoom
    let level = 0
    // switch to a coarser level beyond its distance, back to a finer one 10% inside it
    while (level < last && d >= LOD_DISTANCES[level + 1] * (level + 1 <= this.mainLevel ? 0.9 : 1)) level++
    this.mainLevel = level
    const now = performance.now()
    if (this.target < 0) this.target = level
    else if (level !== this.target) {
      if (level === this.from) {
        // back to the level that was fading out: reverse the fade from where it stands
        const t = Math.min(1, (now - this.fadeStart) / FADE_MS)
        this.fadeStart = now - (1 - t) * FADE_MS
      } else this.fadeStart = now
      this.from = this.target
      this.target = level
    }
    let t = this.from >= 0 ? (now - this.fadeStart) / FADE_MS : 1
    if (t >= 1) this.from = -1
    // debug (window.__lodMix = { from, to, t }): every car held part way through a fade, to look at it
    const mix = (globalThis as unknown as { __lodMix?: { from: number; to: number; t: number } }).__lodMix
    if (mix) {
      this.from = Math.min(last, mix.from)
      this.target = Math.min(last, mix.to)
      t = mix.t
    }
    for (const w of this.wins) w.copy(FULL)
    if (this.from >= 0) {
      this.wins[this.target].set(0, t)
      this.wins[this.from].set(t, 2)
    }
    this.show(this.target, this.from)
  }
}

/** Models the cars on the track use (requestCarModel): they load first. */
const wanted = new Set<GltfCarId>()
const loads = new Map<GltfCarId, Promise<void>>()
const failed = new Set<GltfCarId>()
let loader: GLTFLoader | null = null

/** A car uses this model (the session, CarVisual): it starts loading now, before the others. */
export function requestCarModel(id: GltfCarId) {
  wanted.add(id)
  loadModel(id)
}

function loadModel(id: GltfCarId): Promise<void> {
  let p = loads.get(id)
  if (p) return p
  if (!loader) {
    loader = new GLTFLoader()
    // geometry decodes in workers, off the main thread
    ;(MeshoptDecoder as unknown as { useWorkers?: (n: number) => void }).useWorkers?.(2)
    loader.setMeshoptDecoder(MeshoptDecoder)
  }
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
  const t0 = performance.now()
  p = loader
    .loadAsync(`${base}models/${id}.glb`)
    .then((gltf) => {
      const car = gltf.scene.getObjectByName('car') ?? gltf.scene
      const meta = car.userData as Meta
      car.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        m.castShadow = true
        m.receiveShadow = true
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          const s = mat as THREE.MeshStandardMaterial
          // keep the glass and decals out of the shadow maps' alpha blending trouble
          if (s.transparent) m.castShadow = false
          // Double-sided transparent materials draw twice (back faces, then front faces) so that the far
          // side of a glass shape shows through the near one. Decals, stickers and grilles lie on a
          // surface whose back nobody sees: one pass (glass and lamps keep both).
          if (s.transparent && s.side === THREE.DoubleSide && !/glass|window|windshield|lamp|light/i.test(s.name ?? '')) s.forceSinglePass = true
        }
      })
      const box = new THREE.Box3().setFromObject(car.getObjectByName('body_lod0') ?? car)
      splitLights(car, box)
      // the simplified levels' wheels: the same material corrections as the full model's (wheelMaterials.ts)
      for (const k of ['FL', 'FR', 'RL', 'RR'] as const) {
        car.getObjectByName(`wheel_${k}`)?.traverse((o) => {
          const g = (o as THREE.Mesh).isMesh && /_lod[12]/.test(o.name + (o.parent?.name ?? '')) ? (o as THREE.Mesh).geometry : null
          if (g) fixBakedWheel(g, () => true)
        })
      }
      const ws = Object.values(meta.wheels)
      car.getObjectByName('body_lod2')?.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return
        fixBakedWheel((o as THREE.Mesh).geometry, (x, y, z) => ws.some((w) => Math.abs(x - w.centre[0]) < 0.2 && Math.hypot(y - w.centre[1], z - w.centre[2]) < w.radius + 0.01))
      })
      templates.set(id, { meta, car, zFront: box.max.z, zRear: box.min.z })
      console.info(`[car] ${meta.name} model loaded in ${(performance.now() - t0).toFixed(0)} ms`)
    })
    .catch((e) => {
      gltfState.failed = String(e?.message ?? e)
      failed.add(id)
      console.warn(`[car] detailed car model ${id} unavailable (its cars take another model):`, e)
      // the others, for its cars to take
      for (const c of GLTF_CARS) if (c.id !== id) loadModel(c.id)
    })
    .finally(() => {
      for (const l of listeners) l()
    })
  loads.set(id, p)
  return p
}

/**
 * Loads the detailed car models. Resolves once the models the cars on the track use are in (all of
 * them if none was requested yet); the others load after them, in the background (a practice
 * session waits for one model instead of three).
 */
export function loadCarModels(): Promise<void> {
  if (loading) return loading
  const all = GLTF_CARS.map((c) => c.id)
  const now = all.filter((id) => wanted.has(id))
  loading = Promise.all((now.length ? now : all).map(loadModel)).then(() => undefined)
  loading
    .then(() => Promise.all(all.map(loadModel)))
    .then(() => {
      gltfState.ready = true
      for (const l of listeners) l()
    })
  return loading
}

/**
 * Some models (the Mercedes) light the headlights and the tail lights with one material ("...Lights").
 * The brake lights glow through the tail lights' material, so such a material is split where the
 * model loads: triangles in the rear quarter of the car get a rear-light copy of it ("...:Light_Rear",
 * which lights up with the brakes), the rest a plain copy (the headlights stay as modelled).
 * Materials with nothing in the rear quarter (the cockpit's button lights) are left alone.
 */
function splitLights(car: THREE.Object3D, box: THREE.Box3) {
  car.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(car.matrixWorld).invert()
  const carBox = box.clone().applyMatrix4(inv)
  const zCut = carBox.min.z + (carBox.max.z - carBox.min.z) * 0.25
  const copies = new Map<THREE.Material, [THREE.Material, THREE.Material]>()
  const rel = new THREE.Matrix4()
  const v = new THREE.Vector3()
  car.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || Array.isArray(m.material) || !/Lights$/i.test(m.material.name ?? '')) return
    const g = m.geometry
    const pos = g.getAttribute('position')
    const index = g.getIndex()
    const n = index ? index.count : pos.count
    const at = (i: number) => (index ? index.getX(i) : i)
    rel.multiplyMatrices(inv, m.matrixWorld)
    const rear: number[] = []
    const front: number[] = []
    for (let t = 0; t + 2 < n; t += 3) {
      let z = 0
      for (let k = 0; k < 3; k++) z += v.fromBufferAttribute(pos, at(t + k)).applyMatrix4(rel).z
      ;(z / 3 < zCut ? rear : front).push(at(t), at(t + 1), at(t + 2))
    }
    if (!rear.length) return
    let pair = copies.get(m.material)
    if (!pair) {
      const f = m.material.clone()
      f.name = m.material.name + ':front'
      const r = m.material.clone()
      r.name = m.material.name + ':Light_Rear'
      pair = [f, r]
      copies.set(m.material, pair)
    }
    const all = rear.concat(front)
    g.setIndex(new THREE.BufferAttribute(pos.count > 65535 ? new Uint32Array(all) : new Uint16Array(all), 1))
    g.clearGroups()
    g.addGroup(0, rear.length, 1)
    if (front.length) g.addGroup(rear.length, front.length, 0)
    m.material = pair
  })
}

export function onCarModels(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function gltfCarCredits() {
  return [...templates.values()].map((t) => t.meta.credit)
}

export function hasGltfCar(id: GltfCarId | undefined): id is GltfCarId {
  return !!id && templates.has(id)
}

/** A detailed model that has arrived, for a car whose own model is unavailable (failed to load). */
export function anyGltfCar(): GltfCarId | undefined {
  return templates.keys().next().value
}

/** The model a car shows: its own once it has arrived; another one if its own failed to load; none while it loads. */
export function modelFor(id: GltfCarId | undefined): GltfCarId | undefined {
  if (hasGltfCar(id)) return id
  if (!id || failed.has(id)) return anyGltfCar()
  return undefined
}

// ------------------------------------------------------------------------------------------------ livery

const rgb2hsv = Fn(([c]: [any]) => {
  const K = vec4(0, -1 / 3, 2 / 3, -1)
  const p = mix(vec4(c.b, c.g, K.w, K.z), vec4(c.g, c.b, K.x, K.y), step(c.b, c.g))
  const q = mix(vec4(p.x, p.y, p.w, c.r), vec4(c.r, p.y, p.z, p.x), step(p.x, c.r))
  const d = q.x.sub(min(q.w, q.y))
  return vec3(abs(q.z.add(q.w.sub(q.y).div(d.mul(6).add(1e-6)))), d.div(q.x.add(1e-6)), q.x)
})

const hueDist = (h: any, h0: number) => {
  const d = abs(h.sub(h0))
  return min(d, float(1).sub(d))
}

/**
 * Car paint: a physical material whose clear coat mirrors the car's cube probe itself, at its full
 * resolution (mirrorEnv.ts), instead of the prefiltered environment.
 */
/** the sun's angular radius (0.27 deg) as GGX alpha: the sharpest the clear coat's sun glint can be */
const SUN_ALPHA = 0.0047
/** tail lamps' lens radiance (always on): about a sunlit white panel, so they read lit in daylight */
const TAIL_LAMP = 1.2
/** added by full braking: an LED brake lamp is several times a sunlit panel and glares a little */
const BRAKE_LAMP = 16
/** albedo scale of the model's livery texture for white / for saturated colours (display colours -> pigment) */
const LIVERY_WHITE = 0.85
const LIVERY_SATURATED = 0.68
/** how many pixels a curved panel spreads the sun's glint over (its energy kept), so the TAA keeps it */
const GLINT_PX = 2

class CarPaintMaterial extends THREE.MeshPhysicalNodeMaterial implements MirrorMaterial {
  /** (an own node property: part of the material's shader cache key) */
  mirrorNode: unknown = null
  /** ?chromecars: the whole surface is the mirror (what the probe holds, through the same lookup) */
  chrome = false
  /** window glass: how much of what is behind it the pane hides (its alpha) */
  cover: any = null
  setMirror(env: MirrorEnv | null) {
    let node = env ? mirrorRadiance(env, this.chrome ? normalView : clearcoatNormalView) : null
    // (blending scales the pane's own light by its alpha: the reflection is not part of the tint)
    if (node && this.cover) node = node.div(this.cover)
    this.mirrorNode = node
    if (this.chrome) this.emissiveNode = this.mirrorNode as typeof this.emissiveNode
    this.needsUpdate = true
  }
  setupLightingModel() {
    const model = super.setupLightingModel() as any
    const mirror = this.mirrorNode
    if (model.clearcoat === true && !this.cover) {
      // The sun in the clear coat. three's own lobe adds the normal's change across the pixel to the
      // roughness (r + dn, so alpha = (r + dn)^2 ~ dn^2): on a curved panel the sun's reflection stays
      // a sub-pixel speck of ~5000 that the temporal AA's tonemapped average turns into a grey smear.
      // Here alpha^2 = alpha_coat^2 + alpha_sun^2 + (GLINT_PX dn)^2: on flat panels the sun's image at
      // its true size and brightness (thousands, it blooms), on curved ones the same energy spread over
      // ~GLINT_PX pixels, enough to survive the TAA as a stable glint instead of popping.
      const direct = model.direct
      model.direct = function (data: { lightDirection: any; lightColor: any }, builder: unknown) {
        this.clearcoat = false
        direct.call(this, data, builder)
        this.clearcoat = true
        const n = clearcoatNormalView as any
        const dn = n.dFdx().length().max(n.dFdy().length())
        const a2 = dn.mul(GLINT_PX).pow2().add(SUN_ALPHA * SUN_ALPHA + 0.03 ** 4)
        const r = a2.sqrt().sqrt() // BRDF_GGX takes r, alpha = r^2
        const nl = n.dot(data.lightDirection).clamp()
        this.clearcoatSpecularDirect.addAssign(data.lightColor.mul(nl).mul(BRDF_GGX({ lightDirection: data.lightDirection, f0: vec3(0.04), f90: float(1), roughness: r, normalView: n } as any)))
      }
    }
    if (mirror && model.clearcoat === true) {
      // the lighting model adds the clear coat's environment term from `clearcoatRadiance`, which the
      // environment node filled from the PMREM at the clamped roughness: hand it the mirror instead
      const indirectSpecular = model.indirectSpecular
      model.indirectSpecular = function (b: unknown) {
        const prefiltered = this.clearcoatRadiance
        this.clearcoatRadiance = mirror
        indirectSpecular.call(this, b)
        this.clearcoatRadiance = prefiltered
      }
    }
    return model
  }
}

/**
 * Livery recolouring: the model's paint scheme (a navy base with red accents) is remapped to the
 * team's colours by hue, saturation and value, so sponsor logos, numbers and baked shading survive.
 */
function liveryMaterial(src: THREE.MeshPhysicalMaterial, paint: Meta['paint'], primary: THREE.Color, accent: THREE.Color, mirror: MirrorEnv, wear?: Wear) {
  const m = new CarPaintMaterial()
  mirror.materials.push(m)
  m.name = src.name + ':team'
  // (the base coat's own maps are not carried over: it has no specular lobe to shape, see below)
  for (const k of ['clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'clearcoatNormalScale', 'aoMap', 'aoMapIntensity', 'side', 'envMapIntensity'] as const) {
    const v = (src as unknown as Record<string, unknown>)[k]
    if (v === undefined) continue
    const cur = (m as unknown as Record<string, unknown>)[k]
    if (cur && typeof (cur as { copy?: unknown }).copy === 'function' && v && typeof v === 'object' && !(v as THREE.Texture).isTexture) (cur as { copy: (x: unknown) => void }).copy(v)
    else (m as unknown as Record<string, unknown>)[k] = v
  }
  // Solid race paint, as it is built: a pigmented base coat under a clear coat. The clear coat's
  // resin and the base coat's binder have nearly the same refractive index, so there is no optical
  // interface between them and the base coat has no specular lobe of its own: it is a diffuse colour
  // seen through the clear coat, and all the gloss is the clear coat's mirror reflection (4% head-on,
  // rising to 100% at grazing angles). A base lobe (it used to be F0 4% + 12% metal at roughness
  // 0.42) mirrors a 30-degree blur of the sky and a wide white sun highlight over every panel: a
  // milky veil that hid the clear coat's reflection and washed red out to pink.
  m.metalness = 0
  m.roughness = 1
  m.specularIntensity = 0
  m.clearcoat = 1
  m.clearcoatRoughness = 0.03
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('blackpaint')) {
    // ?blackpaint: gloss black under the same clear coat, to look at the clear coat's reflections alone
    m.colorNode = vec3(0.01, 0.01, 0.01)
    return { material: m, teamA: uniform(primary.clone()), teamB: uniform(accent.clone()) }
  }
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('chromecars')) {
    // ?chromecars: a perfect mirror, to look at what the reflection probes hold and how sharp they are
    m.clearcoat = 0
    m.chrome = true
    m.colorNode = vec3(0, 0, 0)
    return { material: m, teamA: uniform(primary.clone()), teamB: uniform(accent.clone()) }
  }
  const map = src.map
  const base = uniform(src.color.clone())
  const teamA = uniform(primary.clone())
  const teamB = uniform(accent.clone())
  if (map) {
    const lin = texture(map, uv()).rgb
    // classify in (approximately) sRGB, the space the livery was painted in
    const srgb = pow(lin.max(0), vec3(1 / 2.2))
    const hsv = rgb2hsv(srgb)
    const h = hsv.x,
      s = hsv.y,
      v = hsv.z
    const baseW = float(1)
      .sub(smoothstep(0.035, 0.08, hueDist(h, paint.baseHue)))
      .mul(smoothstep(0.42, 0.65, s))
      .mul(float(1).sub(smoothstep(0.48, 0.62, v)))
    const accW = float(1)
      .sub(smoothstep(0.035, 0.085, hueDist(h, paint.accentHue)))
      .mul(smoothstep(0.5, 0.7, s))
      .mul(smoothstep(0.22, 0.38, v))
    // shading relative to the reference value of each paint (gradients, panel shadows)
    // (each at most its team colour: lifting the model's lighter-than-reference pixels by up to
    // 1.6x made the red's albedo 0.93, brighter than any real pigment, and the clear coat's 4% mirror
    // vanished against it)
    const shadeA = pow(v.div(paint.baseV).clamp(0.15, 1.0), float(2.2))
    const shadeB = pow(v.div(paint.accentV).clamp(0.35, 1.0), float(2.2))
    // the model's own livery is painted as display colours (its reds ~0.85 linear, whiter than any
    // pigment): real paint reflects at most ~0.6 in its strongest channel when saturated, ~0.8 when
    // white, so the texture is scaled by saturation between the two (its own contrast kept). The team
    // colours below are pigment values already and are not scaled.
    let col: any = lin.mul(base).mul(mix(float(LIVERY_WHITE), float(LIVERY_SATURATED), s))
    col = mix(col, (teamA as any).mul(shadeA), baseW)
    if (paint.hiHue !== undefined && paint.hiV !== undefined) {
      // lighter stripes of the base colour: a lifted shade of the team colour
      const hiW = float(1)
        .sub(smoothstep(0.02, 0.045, hueDist(h, paint.hiHue)))
        .mul(smoothstep(0.42, 0.62, s))
        .mul(smoothstep(0.45, 0.58, v))
      const shadeH = pow(v.div(paint.hiV).clamp(0.4, 1.0), float(2.2))
      col = mix(col, mix(teamA as any, vec3(1), 0.32).mul(shadeH), hiW)
    }
    col = mix(col, (teamB as any).mul(shadeB), accW)
    // (black: see DARKEST)
    col = max(col, vec3(DARKEST))
    m.colorNode = wear ? raceWear(m, col, wear) : col
  } else {
    m.color.copy(src.color)
    if (wear) m.colorNode = raceWear(m, vec3(src.color.r, src.color.g, src.color.b), wear)
  }
  return { material: m, teamA, teamB }
}

/** The drawn mesh's transform to its model's space (adopt sets it per mesh: userData.toModel). */
const _id4 = new THREE.Matrix4()
const _id3 = new THREE.Matrix3()
const modelMatrix: any = uniform(new THREE.Matrix4()).onObjectUpdate((frame: { object: THREE.Object3D | null }) => (frame.object?.userData.toModel as THREE.Matrix4 | undefined) ?? _id4)
const modelNormal: any = uniform(new THREE.Matrix3()).onObjectUpdate((frame: { object: THREE.Object3D | null }) => (frame.object?.userData.toModelN as THREE.Matrix3 | undefined) ?? _id3)

/** What a car's paint has picked up (raceWear): where its wheels are, and how dirty it is. */
interface Wear {
  wheels: Meta['wheels']
  /** the nose (model space z) */
  zFront: number
  /** 0..1: this car's share of dirt; and an offset so no two cars carry the same marks */
  dirt: number
  seed: number
}

/**
 * A race car after some laps, on its paint (model space: the models are baked to metres, +z forward,
 * ground at y = 0): road grime on the lower body, thickest on the sills and behind the wheels, ragged
 * at its top; brake dust around the wheel arches; marbles (rubber the tyres picked up) peppering the
 * panels behind each wheel; flies and stone chips on the nose. The dirt sits on the clear coat: matte
 * where it lies. The clear coat itself is not a perfect mirror: orange peel (a few microns over ~4 mm,
 * the reflections ripple), swirl marks and fine scratches from washing, smears where it was wiped.
 * Returns the base colour; sets the clear coat's strength, roughness and normal.
 */
function raceWear(m: THREE.MeshPhysicalNodeMaterial, col: any, w: Wear): any {
  // (the meshes' positions are stored quantized, scaled back by their nodes: each mesh's own transform
  // to the model's space, set as it is drawn)
  const pos: any = modelMatrix.mul(vec4(positionLocal, 1)).xyz
  const nl: any = normalize(modelNormal.mul(normalLocal))
  const p: any = pos.add(vec3(w.seed * 3.7, 0, w.seed * 1.3))
  const fine = triMap('a', p, nl, 4) // grain, mottle, scratch
  const peel = triMap('c', p, nl, 4).b
  const coarse = triMap('b', p, nl, 1) // streaks, smudges, chips
  const spots = triMap('c', p, nl, 1.5) // pits: marbles, chips, flies
  const ax = abs(pos.x)
  // road grime: the lower body, more on dirtier cars, its top ragged
  const grimeTop = float(0.2 + 0.18 * w.dirt).add(coarse.r.sub(0.5).mul(0.2))
  const grime = float(1).sub(smoothstep(float(0.06), grimeTop, pos.y)).mul(mix(float(0.6), float(1), coarse.r)).mul(0.75 + 0.25 * w.dirt)
  let brake: any = float(0),
    marbles: any = float(0)
  for (const k of ['FL', 'FR', 'RL', 'RR'] as const) {
    const [wx, wy, wz] = w.wheels[k].centre
    const r = w.wheels[k].radius
    const dy = pos.y.sub(wy),
      dz = pos.z.sub(wz)
    const d = dy.mul(dy).add(dz.mul(dz)).sqrt()
    // the panels beside the wheel: the body's sides around the arch (facing outward, out at the
    // wheel's width; the bonnet above the wheel is not beside it), more behind it (the wheel throws it back)
    const side = smoothstep(Math.abs(wx) - 0.3, Math.abs(wx) - 0.05, ax).mul(smoothstep(0.35, 0.75, abs(nl.x)))
    const behind = smoothstep(0.1, -0.3, dz)
    brake = max(brake, smoothstep(r + 0.3, r + 0.02, d).mul(side).mul(mix(float(0.4), float(1), behind)))
    const zone = smoothstep(0.0, -0.12, dz.add(r)).mul(smoothstep(-0.95, -0.5, dz.add(r))).mul(smoothstep(wy + 0.2, wy - 0.08, pos.y)).mul(side)
    marbles = max(marbles, zone.mul(smoothstep(0.26, 0.48, spots.r)))
  }
  // the dust trails back along the flow in streaks (fine across, long along the car: the streak map
  // with its axes swapped, on the sides where the dust lies)
  const flow = texture(detailMaps().b, vec2(pos.y.mul(7), pos.z.mul(0.3)).add(w.seed)).r
  brake = brake.mul(mix(float(0.35), float(1.2), smoothstep(0.3, 0.75, flow))).clamp(0, 1).mul(0.85 + 0.15 * w.dirt)
  const nose = smoothstep(w.zFront - 0.5, w.zFront - 0.05, pos.z).mul(smoothstep(0.15, 0.6, nl.z))
  const chips = nose.mul(smoothstep(0.5, 0.72, spots.r))
  const flies = nose.mul(smoothstep(0.78, 0.95, spots.g)).mul(step(0.65, coarse.g.add(spots.b)))
  let c: any = col
  // (bright paint sits in the camera's highlight shoulder: a film has to take most of its colour to show)
  c = mix(c, vec3(0.13, 0.115, 0.095), grime.mul(0.85))
  c = mix(c, vec3(0.04, 0.033, 0.026), brake.mul(0.92))
  c = mix(c, vec3(0.5, 0.5, 0.49), chips.mul(0.85))
  c = mix(c, vec3(0.04, 0.035, 0.02), flies.mul(0.8))
  c = mix(c, vec3(0.02, 0.02, 0.022), marbles)
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('weardebug')) {
    // ?weardebug: the masks in loud colours (grime red, brake dust green, marbles blue, nose yellow)
    return vec3(grime, brake, marbles).add(vec3(nose, nose, 0).mul(0.5)).mul(2).add(col.mul(0.15))
  }
  const covered = clamp(grime.add(brake).add(marbles).add(flies), 0, 1)
  m.clearcoatNode = float(1).sub(covered.mul(0.95))
  m.clearcoatRoughnessNode = mix(float(0.028), float(0.1), fine.b.mul(0.8))
    .add(coarse.g.mul(0.04))
    .mul(mix(float(0.88), float(1.12), fine.r))
    .add(covered.mul(0.5))
  m.clearcoatNormalNode = bumpView(peel.sub(0.5).mul(0.00002).sub(fine.b.mul(0.000003)).add(marbles.mul(0.0006)), normalViewGeometry)
  return c
}

/**
 * A window pane as the dielectric surface it is. Its only reflection is the mirror at the surface
 * (the clear-coat lobe: 4% head-on, everything at grazing angles), which reads the car's cube probe
 * at full resolution like the paint's clear coat; behind it a neutral tint. What the pane lets
 * through falls as its reflection rises, so a window seen along its surface is a mirror, not a hole.
 */
function windowGlass(src: THREE.MeshPhysicalMaterial, mirror: MirrorEnv) {
  const g = new CarPaintMaterial()
  g.name = src.name
  g.color.setRGB(0, 0, 0)
  g.metalness = 0
  g.roughness = 1
  g.specularIntensity = 0
  g.clearcoat = 1
  g.clearcoatRoughness = 0
  g.transparent = true
  g.side = src.side
  g.depthWrite = src.depthWrite
  // GT3 side and rear windows are near-clear polycarbonate: at most 30% tint
  const tint = Math.min(src.opacity, 0.3)
  const nv = normalView.dot(positionViewDirection).abs().clamp(0, 1)
  const fresnel = float(0.04).add(float(0.96).mul(pow(float(1).sub(nv), 5)))
  let cover: any = float(1).sub(float(1).sub(fresnel).mul(1 - tint))
  if (!(typeof location !== 'undefined' && new URLSearchParams(location.search).has('nowear'))) {
    // a race car's glass is not clean: flies on the windscreen (front-facing panes in the front half;
    // model space, as the paint's race wear), a film of smears that blurs the reflection a little
    const pos: any = modelMatrix.mul(vec4(positionLocal, 1)).xyz
    const nl: any = normalize(modelNormal.mul(normalLocal))
    const front = smoothstep(0.3, 0.6, nl.z).mul(step(0, pos.z))
    const flies = smoothstep(0.55, 0.8, triMap('c', pos, nl, 0.8).r).mul(front)
    const film = smoothstep(0.4, 0.85, triMap('b', pos, nl, 1.2).g)
    cover = max(cover.add(film.mul(0.05)), flies.mul(0.85))
    g.colorNode = mix(vec3(0, 0, 0), vec3(0.05, 0.04, 0.02), flies)
    g.clearcoatRoughnessNode = film.mul(0.08).add(flies.mul(0.4))
  }
  g.opacityNode = cover
  g.cover = cover
  mirror.materials.push(g)
  return g
}

/**
 * Physically plausible glass and carbon. The source models' glass is metallic (metalness ~1) and on
 * one car rough (0.39): real glass is a smooth dielectric whose reflection rises with the angle.
 * Exterior carbon fibre is clear-coated.
 */
function normaliseMaterial(mat: THREE.Material, mirror?: MirrorEnv) {
  const m = mat as THREE.MeshPhysicalMaterial
  const name = mat.name ?? ''
  if (!m.isMeshStandardMaterial) return mat
  if (mirror && /glass|window/i.test(name) && m.transparent && !m.map && !/light|lamp|emissive|sticker/i.test(name)) {
    const glass = windowGlass(m, mirror)
    m.dispose()
    return glass
  }
  if (/glass|window/i.test(name) && m.transparent) {
    m.metalness = 0
    m.roughness = Math.min(m.roughness, 0.03)
    // Window glass has no diffuse colour: it reflects (Fresnel) and transmits. The sources' colours
    // were meant for metallic glass, where they only tint the reflection; on the dielectric they
    // became a diffuse layer lit by the sun (the Ferrari's windows, base colour (0, 0.16, 0) at 50%,
    // glowed green). Untextured window glass is black, so it only darkens what is behind it a little
    // and reflects; GT3 side and rear windows are near-clear polycarbonate, at most 30% here.
    // (Headlight glass and stickers keep their textures.)
    if (!m.map && !/light|lamp|emissive|sticker/i.test(name)) {
      m.color.setRGB(0, 0, 0)
      m.opacity = Math.min(m.opacity, 0.3)
    }
    // alpha blending scales the reflection by the opacity; real glass reflects the same however clear
    // it is: compensate, so the windscreen mirrors the sky as it should
    m.envMapIntensity = 1 / Math.max(0.25, m.opacity)
  }
  if (/carbon/i.test(name) && m.isMeshPhysicalMaterial && m.clearcoat > 0) {
    m.clearcoat = 1
    m.clearcoatRoughness = Math.min(m.clearcoatRoughness, 0.06)
  }
  if (m.metalness > 0 && !m.transparent && !/mirror/i.test(name)) return realMetals(m)
  return toNodeMaterial(mat)
}

/**
 * A bare metal reflects at least about half the light head-on (iron 0.53, chrome 0.55, titanium 0.54,
 * aluminium 0.91): its base colour is that reflectance. The source models mark nearly every material
 * as metal: black plastic, carbon fibre, rubber seals and painted parts alike, with base colours of
 * 1-10 %. Rendered as metals they were dark tinted mirrors with no diffuse light at all, so a splitter,
 * a sill or a diffuser had no shading in the sun and read as flat black plastic whatever it was. Per
 * texel (the textures are atlases: chrome and black plastic share one): a "metal" darker than any
 * real metal is the dielectric it really is (paint, plastic, resin), with its colour as albedo; bright
 * texels stay metal. The simplified levels apply the same rule per vertex (bakedMaterial).
 */
export const METAL_MIN: [number, number] = [0.08, 0.2]
/**
 * The darkest albedo a car's surface has: black paint, carbon fibre under its resin, black plastic
 * and rubber reflect 2.5-5 % diffusely. The sources paint their blacks at 0.2-0.5 % (the Ferrari's
 * livery, which covers its diffuser, splitter and wing: sRGB 1 on the diffuser in the shade, darker
 * than anything lit by a sky), and at 1-2 % on the AMG's carbon; with nothing to shade, such a part is a
 * black cut-out without form. (The tyres keep their own value, 2.1 %: wheelMaterials.ts.)
 */
export const DARKEST = 0.025
const realMetalness = (base: any) => smoothstep(METAL_MIN[0], METAL_MIN[1], dot(base, vec3(0.2126, 0.7152, 0.0722)))
function realMetals(m: THREE.MeshStandardMaterial) {
  // the conversion the renderer itself does for a plain material (NodeLibrary.fromMaterial), so that a
  // metalness node can be added
  const nm = (m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial()
  for (const key in m) (nm as unknown as Record<string, unknown>)[key] = (m as unknown as Record<string, unknown>)[key]
  nm.colorNode = vec4(max(materialColor.rgb, vec3(DARKEST)), 1)
  nm.metalnessNode = materialMetalness.mul(realMetalness(diffuseColor.rgb))
  return nm
}

/** Emission in the baked levels is stored over this scale (scripts/build-car-models.ts EMIT_SCALE). */
const EMIT_SCALE = 8

/**
 * The simplified levels' material (scripts/build-car-models.ts bakes every material but the livery and
 * the decals into vertex attributes): colour and opacity, roughness, metalness, emission, and the
 * brake-light and brake-disc masks, lit by this car's brakes. Glass is alpha blended in one pass,
 * its reflection kept at full strength (blending scales it by the opacity: the stored compensation).
 */
function bakedMaterial(glass: boolean, u: { brake: any; heat: any }) {
  const m = new THREE.MeshStandardNodeMaterial()
  m.name = glass ? 'lod:glass:car' : 'lod:opaque:car'
  const col = attribute('color', 'vec4')
  const pbr = attribute('_pbr', 'vec4')
  m.colorNode = glass ? col.rgb : max(col.rgb, vec3(DARKEST))
  m.roughnessNode = pbr.x
  // (realMetals: a "metal" darker than any metal is a dielectric; the brake discs keep theirs)
  m.metalnessNode = glass ? pbr.y : pbr.y.mul(max(realMetalness(col.rgb), step(0.5, pbr.w)))
  const emit = attribute('_emit', 'vec3').mul(EMIT_SCALE)
  if (glass) {
    m.emissiveNode = emit
    m.transparent = true
    m.depthWrite = false
    m.side = THREE.DoubleSide
    m.forceSinglePass = true
    m.opacityNode = col.a
    m.outputNode = vec4(output.rgb.div(pbr.w.max(0.25)), output.a)
  } else m.emissiveNode = emit.add(vec3(u.brake).mul(pbr.z)).add(vec3(u.heat).mul(pbr.w))
  return m
}

/** The driver for the simplified level: one low-poly mesh with baked attributes (see bakedMaterial). */
function lowDriverGeometry(torso: THREE.Mesh, helmet: THREE.Mesh, visor: THREE.Mesh, suit: THREE.Color, helmetColour: THREE.Color) {
  const part = (g: THREE.BufferGeometry, from: THREE.Object3D, c: THREE.Color, rough: number, metal: number) => {
    from.updateMatrix()
    g.applyMatrix4(from.matrix)
    g.deleteAttribute('uv')
    const n = g.getAttribute('position').count
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4).map((_, i) => [c.r, c.g, c.b, 1][i % 4]), 4))
    g.setAttribute('_pbr', new THREE.BufferAttribute(new Float32Array(n * 4).map((_, i) => [rough, metal, 0, 0][i % 4]), 4))
    g.setAttribute('_emit', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
    return g
  }
  const merged = mergeGeometries([
    part(new THREE.CapsuleGeometry(0.17, 0.3, 2, 8), torso, suit, 0.85, 0),
    part(new THREE.SphereGeometry(0.135, 10, 7), helmet, helmetColour, 0.22, 0.1),
    part(new THREE.SphereGeometry(0.137, 6, 3, -0.9, 1.8, 1.1, 0.7), visor, new THREE.Color(0x050505), 0.05, 0.9),
  ])
  return merged
}

// ------------------------------------------------------------------------------------------------ cars

const heat = new THREE.Color()

/** Disc glow from the brake temperature (dull red from ~450 C to orange-white at 900 C). */
function brakeGlow(t: number, out: THREE.Color) {
  const x = THREE.MathUtils.clamp((t - 420) / 480, 0, 1)
  out.setRGB(1, 0.18 + 0.5 * x * x, 0.05 * x * x * x)
  return x * x * 3.2
}

export interface GltfCarOptions {
  color: string
  accent: string
  /** this car gets its own copies of all materials (default: every car does, each carries its own reflection probe) */
  uniqueMaterials?: boolean
  driverColor?: string
  /** a showroom car: no race dirt */
  clean?: boolean
}

let carSerial = 0

export function buildGltfCar(id: GltfCarId, spec: CarSpec, opts: GltfCarOptions): CarModel {
  const tpl = templates.get(id)!
  const meta = tpl.meta
  const primary = new THREE.Color(opts.color)
  const accent = new THREE.Color(opts.accent)
  const root = new THREE.Group()
  root.name = 'car:' + id
  // what the car's mirror lobes reflect (Reflections.tsx points it at the car's probe)
  const mirror = makeMirrorEnv()
  root.userData.mirror = mirror
  const bodyGroup = new THREE.Group()
  root.add(bodyGroup)
  // what this car's paint has picked up (raceWear): a share of dirt and marks of its own
  const seed = (carSerial++ * 0.618034) % 1
  const noWear = opts.clean || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nowear'))
  const wear: Wear | undefined = noWear ? undefined : { wheels: meta.wheels, zFront: tpl.zFront, dirt: 0.35 + 0.65 * ((seed * 7.31) % 1), seed }

  // per-car materials: livery, brake lights, discs (plus everything when unique)
  const own = new Map<THREE.Material, THREE.Material>()
  const disposables: THREE.Material[] = []
  let livery: ReturnType<typeof liveryMaterial> | null = null
  const rearLights: THREE.MeshStandardMaterial[] = []
  const discs: THREE.MeshStandardMaterial[] = []
  // the simplified levels' brake lights and discs (bakedMaterial)
  const bakedU = { brake: uniform(new THREE.Color(0, 0, 0)), heat: uniform(new THREE.Color(0, 0, 0)) }
  const swap = (mat: THREE.Material): THREE.Material => {
    const hit = own.get(mat)
    if (hit) return hit
    let out: THREE.Material = mat
    const name = mat.name ?? ''
    if (name === meta.livery && (mat as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
      livery = liveryMaterial(mat as THREE.MeshPhysicalMaterial, meta.paint, primary, accent, mirror, wear)
      out = livery.material
    } else if (name === 'lod:opaque' || name === 'lod:glass') {
      out = bakedMaterial(name === 'lod:glass', bakedU)
    } else if (/Light_Rear/i.test(name) || /Disc/i.test(name) || opts.uniqueMaterials !== false) {
      // every car its own materials: each car carries its own reflection probe
      out = normaliseMaterial(mat.clone(), mirror)
      // the brake lights (rear lights only: see splitLights)
      if (/Light_Rear/i.test(name)) rearLights.push(out as THREE.MeshStandardMaterial)
      if (/Disc/i.test(name)) discs.push(out as THREE.MeshStandardMaterial)
    }
    out = fadeable(out)
    if (out !== mat) disposables.push(out)
    own.set(mat, out)
    return out
  }
  // the wheels' own materials (wheelMaterials.ts): physical rubber, paint and iron, and the light lost
  // in the arch and the rim's barrel; the simplified levels' wheels take the same occlusion
  const bakedWheel = bakedMaterial(false, bakedU)
  bakedWheel.aoNode = wheelOcclusion
  disposables.push(bakedWheel)
  const wheelOwn = new Map<THREE.Material, THREE.Material>()
  const wheelSwap = (mat: THREE.Material): THREE.Material => {
    const hit = wheelOwn.get(mat)
    if (hit) return hit
    const name = mat.name ?? ''
    const s = mat as THREE.MeshStandardMaterial
    let out: THREE.Material
    if (name === 'lod:opaque') out = bakedWheel
    else if (!s.isMeshStandardMaterial || s.transparent) out = swap(mat)
    else {
      if (/tyre|tire/i.test(name)) out = tyreMaterial(s)
      else if (/disc/i.test(name)) discs.push((out = discMaterial(s)) as unknown as THREE.MeshStandardMaterial)
      else if (/(^|_)rim/i.test(name)) out = rimMaterial(s)
      else out = hubMaterial(s)
      disposables.push(out)
    }
    out = fadeable(out)
    wheelOwn.set(mat, out)
    return out
  }
  const adoptWheel = (o: THREE.Object3D, geo: THREE.Vector4) => {
    o.traverse((x) => {
      const m = x as THREE.Mesh
      if (!m.isMesh) return
      m.material = Array.isArray(m.material) ? m.material.map(wheelSwap) : wheelSwap(m.material)
      m.userData.wheelGeo = geo
    })
    return o
  }
  const adopt = (o: THREE.Object3D) => {
    // each mesh's transform to the model's space (the level's node down to the mesh: the positions
    // are quantized, their nodes scale them back), for the paint's race wear
    o.updateMatrixWorld(true)
    o.traverse((x) => {
      const m = x as THREE.Mesh
      if (!m.isMesh) return
      m.userData.toModel = m.matrixWorld.clone()
      m.userData.toModelN = new THREE.Matrix3().getNormalMatrix(m.matrixWorld)
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material)
    })
    return o
  }

  // levels of detail: what each level shows (CarLOD switches them together)
  const levels: THREE.Object3D[][] = LOD_DISTANCES.map(() => [])
  // the body's levels and the steering wheel (setVisibleParts hides them all)
  const bodyParts = new THREE.Group()
  bodyGroup.add(bodyParts)
  LOD_DISTANCES.forEach((_, i) => {
    const o = tpl.car.getObjectByName(`body_lod${i}`)
    if (!o) return
    const c = adopt(o.clone(true))
    bodyParts.add(c)
    levels[i].push(c)
  })

  // wheels
  const corners = ['FL', 'FR', 'RL', 'RR'] as const
  const physIndex = { FL: 0, FR: 1, RL: 2, RR: 3 } // vehicle.wheels: 0 FL, 1 FR, 2 RL, 3 RR (left = +x)
  const wheels = corners.map((k) => {
    const node = tpl.car.getObjectByName(`wheel_${k}`)!
    const pivot = new THREE.Group()
    const spin = new THREE.Group()
    pivot.add(spin)
    // the wheel's frame for its occlusion: outward along x, the tyre's radius, the rim face's offset
    const side = Math.sign(meta.wheels[k].centre[0]) || 1
    const full = node.getObjectByName(`wheel_${k}_spin_lod0`)
    const bb = full ? new THREE.Box3().setFromObject(full.clone(true)) : null
    const geo = wheelGeometry(side, meta.wheels[k].radius, bb ? (side > 0 ? bb.max.x : -bb.min.x) : 0.15)
    // (the far level has the wheels merged into the body)
    LOD_DISTANCES.forEach((_, i) => {
      const o = node.getObjectByName(`wheel_${k}_spin_lod${i}`)
      if (!o) return
      const c = adoptWheel(o.clone(true), geo)
      spin.add(c)
      levels[i].push(c)
    })
    // calipers: steer, do not spin; full model only
    const fixed = node.getObjectByName(`wheel_${k}_fixed`)
    if (fixed) {
      const f = adoptWheel(fixed.clone(true), geo)
      pivot.add(f)
      levels[0].push(f)
    }
    root.add(pivot)
    return { k, pivot, spin, x: meta.wheels[k].centre[0], index: physIndex[k] }
  })

  // steering wheel: turns about its own column axis (full model only)
  const steerTpl = tpl.car.getObjectByName('steering')
  const steering = steerTpl ? adopt(steerTpl.clone(true)) : null
  const steerAxis = new THREE.Vector3(...(meta.steeringAxis ?? [0, 0.35, -0.94])).normalize()
  const steerRest = steering ? steering.quaternion.clone() : null
  const _sq = new THREE.Quaternion()
  if (steering) {
    bodyParts.add(steering)
    levels[0].push(steering)
  }

  // driver: suit in the team colour, helmet in the accent
  const driver = new THREE.Group()
  // seated behind the steering wheel (the seat meshes can include the passenger side), head kept
  // clear of the roof lining (measured: ~0.46 m above the wheel centre on both models)
  const sw = meta.steeringWheel ?? [0.33, 0.66, 0.36]
  const helmetPos = new THREE.Vector3(sw[0], sw[1] + 0.27, sw[2] - 0.45)
  const suit = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(opts.driverColor ?? opts.color).multiplyScalar(0.7), roughness: 0.85 })
  const helmetMat = new THREE.MeshPhysicalNodeMaterial({ color: accent, roughness: 0.22, clearcoat: 1, metalness: 0.1 })
  const visorMat = new THREE.MeshPhysicalNodeMaterial({ color: 0x050505, roughness: 0.05, metalness: 0.9 })
  for (const m of [suit, helmetMat, visorMat]) fadeable(m)
  disposables.push(suit, helmetMat, visorMat)
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.3, 6, 12), suit)
  torso.position.set(helmetPos.x, helmetPos.y - 0.4, helmetPos.z - 0.08)
  torso.rotation.x = -0.3
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 24, 16), helmetMat)
  helmet.position.copy(helmetPos)
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.137, 24, 12, -0.9, 1.8, 1.1, 0.7), visorMat)
  visor.position.copy(helmetPos)
  const driverFull = new THREE.Group()
  for (const m of [torso, helmet, visor]) {
    m.castShadow = true
    driverFull.add(m)
  }
  driver.add(driverFull)
  levels[0].push(driverFull)
  // the simplified level's driver: one low-poly mesh in the baked material (the far level has opaque
  // windows and no driver)
  const lowOpaque = [...own.values()].find((m) => m.name === 'lod:opaque:car')
  const driverLow = lowOpaque ? new THREE.Mesh(lowDriverGeometry(torso, helmet, visor, suit.color, accent), lowOpaque) : null
  if (driverLow) {
    driverLow.castShadow = true
    driverLow.receiveShadow = true
    driver.add(driverLow)
    levels[1].push(driverLow)
  }
  bodyGroup.add(driver)
  // the level of detail is decided once per car, before its parts are drawn (first child)
  const carLod = new CarLOD(levels)
  // the per-car shadow map draws the same levels (carShadowAtlas.ts)
  root.userData.shadowCasters = { levels, lod: carLod }
  // the tyres' crease on the road (carGrounding.ts)
  root.userData.tyres = { halfTrack: Math.abs(meta.wheels.FL.centre[0]), zFront: meta.wheels.FL.centre[2], zRear: meta.wheels.RL.centre[2] }
  root.add(carLod)
  root.children.unshift(root.children.pop()!)

  const bodyOffset = new THREE.Vector3()
  const cockpitEye = new THREE.Vector3()
  let calibrated = false

  const update = (v: Vehicle) => {
    if (!calibrated) {
      // the model's front wheel centre sits at the physics static hub height; origin between the axles
      bodyOffset.set(0, v.wheels[0].yHubStatic - meta.wheels.FL.centre[1], (v.a - v.b) / 2)
      bodyGroup.position.copy(bodyOffset)
      cockpitEye.copy(helmetPos).add(bodyOffset).add(new THREE.Vector3(0, 0.02, 0.06))
      calibrated = true
    }
    let maxBrake = 0
    for (const w of wheels) {
      const wh = v.wheels[w.index]
      w.pivot.position.set(w.x, wh.yHubStatic + (wh.c - wh.cStatic), wh.z)
      w.pivot.rotation.set(0, wh.steer, wh.left ? -wh.camberStatic : wh.camberStatic)
      w.spin.rotation.x = wh.spin
      maxBrake = Math.max(maxBrake, wh.brakeTemp)
    }
    if (steering && steerRest) steering.quaternion.copy(steerRest).multiply(_sq.setFromAxisAngle(steerAxis, v.steerInput * 2.2))
    for (const m of rearLights) {
      m.emissive.setRGB(1, 0.02, 0.02)
      m.emissiveIntensity = TAIL_LAMP + v.brake * BRAKE_LAMP
    }
    const glow = brakeGlow(maxBrake, heat)
    for (const m of discs) {
      m.emissive.copy(heat)
      m.emissiveIntensity = glow
    }
    ;(bakedU.brake.value as THREE.Color).setRGB(1, 0.02, 0.02).multiplyScalar(TAIL_LAMP + v.brake * BRAKE_LAMP)
    ;(bakedU.heat.value as THREE.Color).copy(heat).multiplyScalar(glow)
  }

  const setVisibleParts = (o: { body?: boolean; interior?: boolean; driver?: boolean }) => {
    if (o.body !== undefined) bodyParts.visible = o.body
    if (o.driver !== undefined) driver.visible = o.driver
  }

  const dispose = () => {
    for (const m of disposables) m.dispose()
    driverLow?.geometry.dispose()
    torso.geometry.dispose()
    helmet.geometry.dispose()
    visor.geometry.dispose()
  }

  void livery
  return {
    root,
    body: { zFront: tpl.zFront, zRear: tpl.zRear },
    spec,
    update,
    dispose,
    cockpitEye,
    bodyOffset,
    setVisibleParts,
    wheels: wheels.map((w) => ({ pivot: w.pivot, spin: w.spin, radius: meta.wheels[w.k].radius, index: w.index })),
  } as unknown as CarModel
}
