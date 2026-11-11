// Every car's own sun shadow map, in one atlas.
//
// The cascaded maps are fitted to the camera and snapped to their own texel grid, which stands still
// in the world: a moving car's shadow crawls across that grid in texel steps (1 cm near the camera,
// 3 cm to 38 m, 9 cm to 130 m, 30 cm beyond, on High), so its outline shimmers and steps, and a car
// 100 m away is a blob. Here each car has an orthographic map of its own, fitted to its bounding
// sphere and LOCKED to the car: centred on it (not snapped to anything in the world) and turned with
// it (the map's up axis is the car's forward axis seen from the sun). The car is rasterised into the
// same texels every frame, so its shadow moves rigidly with it, with no crawl at any speed or
// distance, and a texel is millimetres (2048 texels across 5.6 m for the car biggest on screen, a
// quarter of that for the smallest slots): every car shadows itself in detail (mirrors on the doors,
// the wing on the deck, wheels in their arches) and casts a crisp shadow on the road and on the cars
// beside it.
//
// One depth texture holds them all (WebGPU allows 16 textures per shader stage, and the lit materials
// are close to it): 4096 x 2048 on High and Ultra, with one slot of 2048, two of 1024, four of 512 and
// sixteen of 256, handed out by the cars' size on screen (with hysteresis). The casters are drawn in
// ONE render pass by a material whose vertex stage takes each car's "world to its slot" matrix (the
// simplified level of detail: a handful of draws per car, once, instead of once per cascade that
// covers it). The receivers loop over the cars: a sphere test first (one dot product per car; it
// fails for nearly every pixel), then the car's matrix, and only inside its footprint the filter
// (compare samples on a rotated disc). The cascades hold the static world only.
import * as THREE from 'three/webgpu'
import * as tsl from 'three/tsl'

type N = any

const { Fn, If, Loop, cos, dot, float, int, interleavedGradientNoise, modelWorldMatrix, normalWorldGeometry, positionLocal, positionWorld, screenCoordinate, sin, texture, uniform, uniformArray, vec2, vec4 } = tsl as N

export const MAX_SHADOW_CARS = 23
/** Filter taps per shaded point inside a car's footprint, and the disc's radius in texels. */
const TAPS = 8
const FILTER_TEXELS = 1.4

export interface Slot {
  x: number
  y: number
  size: number
}

/** The slots of an atlas `width` x `width / 2` (pixels, origin top left), largest first. */
export function atlasSlots(width: number): Slot[] {
  const s = width / 2
  const slots: Slot[] = [{ x: 0, y: 0, size: s }]
  for (let i = 0; i < 2; i++) slots.push({ x: s + i * (s / 2), y: 0, size: s / 2 })
  for (let i = 0; i < 4; i++) slots.push({ x: s + i * (s / 4), y: s / 2, size: s / 4 })
  for (let j = 0; j < 2; j++) for (let i = 0; i < 8; i++) slots.push({ x: s + i * (s / 8), y: (s * 3) / 4 + j * (s / 8), size: s / 8 })
  return slots
}

/** Tier of a slot (0: the largest ... 3), by its place in atlasSlots(). */
const tierOf = (slot: number) => (slot < 0 ? 4 : slot < 1 ? 0 : slot < 3 ? 1 : slot < 7 ? 2 : 3)

export interface SlotFit {
  /** world -> the atlas' clip space (what the casters' vertex stage applies) */
  render: THREE.Matrix4
  /** world -> atlas uv (v down) and depth in 0..1 (what the receivers apply) */
  receive: THREE.Matrix4
  /** metres per texel, and the metres of depth the slot spans */
  texel: number
  depthRange: number
}

const _cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100)
const _up = new THREE.Vector3()
const _m = new THREE.Matrix4()

/**
 * Fits a slot to a car: `centre` and `radius` are its bounding sphere (world), `forward` its forward
 * axis, `sunDir` points to the sun, `reach` is how far below the sphere (along the sun's ray) the map
 * must still hold receivers (the ground the shadow falls on). The light-space frame is the car's:
 * centred on the car, up = the car's forward axis as the sun sees it.
 */
export function fitCarSlot(centre: THREE.Vector3, radius: number, forward: THREE.Vector3, sunDir: THREE.Vector3, reach: number, slot: Slot, width: number, height: number, webgl: boolean, out: SlotFit) {
  // the car's forward axis across the sun's direction (a car pointing at the sun: any axis will do)
  _up.copy(forward).addScaledVector(sunDir, -forward.dot(sunDir))
  if (_up.lengthSq() < 1e-6) _up.set(1, 0, 0).addScaledVector(sunDir, -sunDir.x)
  _up.normalize()
  const back = radius + 10
  _cam.position.copy(centre).addScaledVector(sunDir, back)
  _cam.up.copy(_up)
  _cam.lookAt(centre)
  _cam.left = _cam.bottom = -radius
  _cam.right = _cam.top = radius
  _cam.near = back - radius - 0.5
  _cam.far = back + radius + reach
  _cam.coordinateSystem = webgl ? THREE.WebGLCoordinateSystem : THREE.WebGPUCoordinateSystem
  _cam.updateProjectionMatrix()
  _cam.updateMatrixWorld(true)
  // the slot's place in the atlas' clip space (x right, y up; pixel rows count from the top)
  const sx = slot.size / width,
    sy = slot.size / height
  const ox = (2 * slot.x + slot.size) / width - 1,
    oy = 1 - (2 * slot.y + slot.size) / height
  out.render.set(sx, 0, 0, ox, 0, sy, 0, oy, 0, 0, 1, 0, 0, 0, 0, 1).multiply(_cam.projectionMatrix).multiply(_cam.matrixWorldInverse)
  // clip -> uv (v down, as the texture is addressed) and depth 0..1
  _m.set(0.5, 0, 0, 0.5, 0, -0.5, 0, 0.5, 0, 0, webgl ? 0.5 : 1, webgl ? 0.5 : 0, 0, 0, 0, 1)
  out.receive.copy(_m).multiply(out.render)
  out.texel = (2 * radius) / slot.size
  out.depthRange = _cam.far - _cam.near
  return out
}

/**
 * Hands the slots out by score (the cars' size on screen), largest first; `current[i]` is the slot car
 * i holds (-1: none) and is updated. A car keeps its tier unless another is clearly bigger (a quarter
 * per tier), so two cars of about the same size do not swap resolutions every frame.
 */
export function assignSlots(scores: number[], current: number[], slots: number) {
  const order = scores.map((_, i) => i)
  const boosted = scores.map((s, i) => s * Math.pow(1.25, 4 - tierOf(current[i])))
  order.sort((a, b) => boosted[b] - boosted[a] || a - b)
  order.forEach((car, rank) => {
    current[car] = rank < slots && scores[car] > 0 ? rank : -1
  })
  return current
}

// ---------------------------------------------------------------------------------------- uniforms

const mats: N = uniformArray(Array.from({ length: MAX_SHADOW_CARS }, () => new THREE.Matrix4()), 'mat4')
/** the slot's rectangle in atlas uv, inset by the filter's reach: (u0, v0, u1, v1) */
const rects: N = uniformArray(Array.from({ length: MAX_SHADOW_CARS }, () => new THREE.Vector4()), 'vec4')
/** x: the receiver's offset along its normal (m), y: depth bias (0..1), zw: the filter disc's radius in uv */
const params: N = uniformArray(Array.from({ length: MAX_SHADOW_CARS }, () => new THREE.Vector4()), 'vec4')
/** xyz: centre, w: squared radius of the sphere around everything the car can shadow */
const spheres: N = uniformArray(Array.from({ length: MAX_SHADOW_CARS }, () => new THREE.Vector4(0, -1e5, 0, 0)), 'vec4')
const count: N = uniform(0, 'int')

let atlas: THREE.RenderTarget | null = null
let slots: Slot[] = []
const depthTexture = new THREE.DepthTexture(4, 2)
depthTexture.name = 'CarShadowAtlas'
depthTexture.compareFunction = THREE.LessEqualCompare
depthTexture.minFilter = depthTexture.magFilter = THREE.LinearFilter

/** The cars' shadow on the surface being shaded (1: lit). */
export const carShadowNode: N = Fn(() => {
  const lit = float(1).toVar()
  Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
    const s = spheres.element(i)
    const d = positionWorld.sub(s.xyz)
    If(dot(d, d).lessThan(s.w), () => {
      const prm = params.element(i)
      const c = mats
        .element(i)
        .mul(vec4(positionWorld.add(normalWorldGeometry.mul(prm.x)), 1))
        .xyz.toVar()
      const r = rects.element(i)
      If(c.x.greaterThan(r.x).and(c.x.lessThan(r.z)).and(c.y.greaterThan(r.y)).and(c.y.lessThan(r.w)).and(c.z.greaterThan(0)).and(c.z.lessThan(1)), () => {
        const z = c.z.sub(prm.y)
        // a disc of taps, turned by a different angle at every pixel (each tap is the hardware's
        // 2 x 2 comparison): the texel grid dissolves into fine noise, which the temporal AA removes
        const phi = interleavedGradientNoise(screenCoordinate.xy).mul(6.28318530718)
        let sum: N = float(0)
        for (let k = 0; k < TAPS; k++) {
          const a = phi.add(k * 2.39996323)
          const o = vec2(cos(a), sin(a)).mul(Math.sqrt((k + 0.5) / TAPS)).mul(prm.zw)
          sum = sum.add(texture(depthTexture, c.xy.add(o)).compare(z))
        }
        lit.mulAssign(sum.div(TAPS))
      })
    })
  })
  return lit
})()

// ----------------------------------------------------------------------------------------- casters

/** A car's shadow casters by level of detail (gltfCars.ts sets it; other models: every caster). */
export interface ShadowCasters {
  levels: THREE.Object3D[][]
  lod?: { mainLevel: number }
}

interface Proxy {
  src: THREE.Mesh
  mesh: THREE.Mesh
}
interface Car {
  root: THREE.Object3D
  /** proxies per level of detail */
  levels: Proxy[][]
  lod?: { mainLevel: number }
  /** bounding sphere in the root's frame */
  centre: THREE.Vector3
  radius: number
  /** this car's "world to its slot" matrix, read by the casters' vertex stage */
  matrix: THREE.Matrix4
  seen: number
}

const casterScene = new THREE.Scene()
casterScene.matrixWorldAutoUpdate = false
const casterCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const cars = new Map<THREE.Object3D, Car>()
const slotMatrix: N = uniform(new THREE.Matrix4()).onObjectUpdate(({ object }: { object?: THREE.Object3D }) => (object?.userData.atlasMatrix as THREE.Matrix4 | undefined) ?? _identity)
const _identity = new THREE.Matrix4()
const casterMaterials = new Map<number, THREE.Material>()
function casterMaterial(side: THREE.Side) {
  let m = casterMaterials.get(side)
  if (!m) {
    const mat = new THREE.MeshBasicNodeMaterial()
    mat.name = 'CarShadowCaster'
    // straight into the car's slot: no camera, the matrix holds the slot's view and projection
    mat.vertexNode = slotMatrix.mul(modelWorldMatrix.mul(vec4(positionLocal, 1)))
    mat.side = side
    mat.colorWrite = false
    casterMaterials.set(side, (m = mat))
  }
  return m
}

/** The layer the cars' casters are on: seen by the main and probe cameras, not by the cascades. */
let carLayer = 5
export function setCarShadowLayer(layer: number) {
  carLayer = layer
}

const _box = new THREE.Box3()
const _b = new THREE.Box3()
const _inv = new THREE.Matrix4()
const _sphere = new THREE.Sphere()

function addCar(root: THREE.Object3D): Car {
  root.updateMatrixWorld(true)
  const sc = root.userData.shadowCasters as ShadowCasters | undefined
  const groups: THREE.Object3D[][] = sc ? sc.levels : [[root]]
  _inv.copy(root.matrixWorld).invert()
  _box.makeEmpty()
  const seen = new Set<THREE.Mesh>()
  const levels = groups.map((list, k) => {
    const out: Proxy[] = []
    for (const o of list)
      o.traverse((x) => {
        const src = x as THREE.Mesh
        if (!src.isMesh || !src.castShadow || !src.geometry || seen.has(src)) return
        seen.add(src)
        if (!src.geometry.boundingBox) src.geometry.computeBoundingBox()
        _box.union(_b.copy(src.geometry.boundingBox!).applyMatrix4(src.matrixWorld).applyMatrix4(_inv))
        // (the full model never casts when there is a simplified one: no proxies for it)
        if (k === 0 && groups.length > 1) return
        const mat = (Array.isArray(src.material) ? src.material[0] : src.material) as THREE.Material | undefined
        const mesh = new THREE.Mesh(src.geometry, casterMaterial(mat?.side ?? THREE.FrontSide))
        mesh.frustumCulled = false
        mesh.matrixAutoUpdate = false
        casterScene.add(mesh)
        out.push({ src, mesh })
      })
    return out
  })
  // the cascades leave the cars out (their layer): a car's shadow comes from its own map only
  root.traverse((x) => {
    const m = x as THREE.Mesh
    if (m.isMesh && m.castShadow) m.layers.set(carLayer)
  })
  _box.getBoundingSphere(_sphere)
  const car: Car = { root, levels, lod: sc?.lod, centre: _sphere.center.clone(), radius: Math.max(1, Math.min(6, _sphere.radius * 1.03)), matrix: new THREE.Matrix4(), seen: 0 }
  for (const l of levels) for (const p of l) p.mesh.userData.atlasMatrix = car.matrix
  cars.set(root, car)
  return car
}

function removeCar(car: Car) {
  for (const l of car.levels) for (const p of l) casterScene.remove(p.mesh)
  car.root.traverse((x) => {
    const m = x as THREE.Mesh
    if (m.isMesh && m.castShadow) m.layers.set(0)
  })
  cars.delete(car.root)
}

// ------------------------------------------------------------------------------------- per frame

const _fit: SlotFit = { render: new THREE.Matrix4(), receive: new THREE.Matrix4(), texel: 0, depthRange: 1 }
const _c = new THREE.Vector3()
const _f = new THREE.Vector3()
const _p = new THREE.Vector3()
const _d = new THREE.Vector3()
const _view = new THREE.Vector3()
let frame = 0
let _state: any
const order: Car[] = []
const scores: number[] = []
const held = new Map<Car, number>()
const current: number[] = []
export const carShadowStats = { cars: 0, draws: 0, width: 0, height: 0 }

/**
 * Creates the atlas (`width` x `width / 2`). Called before any material that samples it is built: the
 * materials hold the texture, so it is sized once and never resized under them.
 */
export function initCarShadowAtlas(width: number) {
  if (atlas) return
  atlas = new THREE.RenderTarget(width, width / 2, { depthBuffer: true, format: THREE.RedFormat, type: THREE.UnsignedByteType })
  atlas.texture.name = 'CarShadowAtlas.color'
  depthTexture.image.width = width
  depthTexture.image.height = width / 2
  atlas.depthTexture = depthTexture
  slots = atlasSlots(width)
  carShadowStats.width = width
  carShadowStats.height = width / 2
}

/**
 * Renders this frame's car shadow maps: after the cars and the camera have moved, before anything
 * that shades with them renders (the reflection probes, the frame). `quality` is the shadow setting
 * (0: off).
 */
export function updateCarShadows(renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3, roots: Iterable<THREE.Object3D | undefined>, quality: number) {
  frame++
  if (quality <= 0 || sunDir.y <= 0.02) {
    count.value = 0
    return
  }
  if (!atlas) initCarShadowAtlas(quality >= 2 ? 4096 : 2048)
  if (!atlas) return
  const W = atlas.width,
    H = atlas.height
  // this frame's cars
  order.length = 0
  for (const root of roots) {
    if (!root) continue
    const car = cars.get(root) ?? addCar(root)
    car.seen = frame
    order.push(car)
  }
  for (const car of [...cars.values()]) if (car.seen !== frame) (held.delete(car), removeCar(car))

  // their size on screen; cars that neither show nor can throw a shadow into the picture get no slot
  const t = Math.tan((camera.fov * Math.PI) / 360) / (camera.zoom || 1)
  camera.getWorldPosition(_p)
  camera.getWorldDirection(_view)
  const reach = Math.min(14, 1 + 2.5 / Math.max(0.15, sunDir.y))
  scores.length = current.length = order.length
  order.forEach((car, i) => {
    car.root.updateMatrixWorld(true)
    _c.copy(car.centre).applyMatrix4(car.root.matrixWorld)
    _d.subVectors(_c, _p)
    const dist = _d.length()
    const along = _d.dot(_view)
    const off = Math.sqrt(Math.max(0, dist * dist - along * along))
    const margin = car.radius + reach
    const inView = dist < margin + 2 || (along > -margin && off < Math.max(0, along) * t * 2.4 + margin)
    scores[i] = inView ? 1 / (Math.max(0.5, dist) * t) : dist < 60 ? 1e-4 / Math.max(0.5, dist) : 0
    current[i] = held.get(car) ?? -1
  })
  assignSlots(scores, current, Math.min(slots.length, MAX_SHADOW_CARS))

  const webgl = (renderer as unknown as { coordinateSystem: number }).coordinateSystem === THREE.WebGLCoordinateSystem
  let n = 0
  let draws = 0
  order.forEach((car, i) => {
    const slot = current[i]
    held.set(car, slot)
    const last = car.levels.length - 1
    // never the full model (the simplified level's shadow is indistinguishable, a handful of draws)
    const level = slot < 0 ? -1 : Math.min(last, Math.max(car.lod?.mainLevel ?? 0, Math.min(1, last)))
    car.levels.forEach((l, k) => {
      for (const p of l) {
        p.mesh.visible = k === level
        if (k === level) {
          p.mesh.matrixWorld.copy(p.src.matrixWorld)
          draws++
        }
      }
    })
    if (slot < 0) return
    const s = slots[slot]
    _c.copy(car.centre).applyMatrix4(car.root.matrixWorld)
    _f.set(0, 0, 1).transformDirection(car.root.matrixWorld)
    fitCarSlot(_c, car.radius, _f, sunDir, reach, s, W, H, webgl, _fit)
    car.matrix.copy(_fit.render)
    ;(mats.array[n] as THREE.Matrix4).copy(_fit.receive)
    const pad = FILTER_TEXELS + 1.5
    ;(rects.array[n] as THREE.Vector4).set((s.x + pad) / W, (s.y + pad) / H, (s.x + s.size - pad) / W, (s.y + s.size - pad) / H)
    // (the casters are the simplified mesh, a few millimetres off the one that receives: a centimetre
    // of depth bias besides the texel's share)
    ;(params.array[n] as THREE.Vector4).set(1.5 * _fit.texel + 0.002, (0.5 * _fit.texel + 0.012) / _fit.depthRange, FILTER_TEXELS / W, FILTER_TEXELS / H)
    const R = car.radius + reach / 2 + 0.1
    _c.addScaledVector(sunDir, -reach / 2)
    ;(spheres.array[n] as THREE.Vector4).set(_c.x, _c.y, _c.z, R * R)
    n++
  })
  count.value = n
  carShadowStats.cars = n
  carShadowStats.draws = draws

  // one pass for all of them
  _state = THREE.RendererUtils.resetRendererState(renderer, _state)
  renderer.setRenderTarget(atlas)
  renderer.render(casterScene, casterCamera)
  THREE.RendererUtils.restoreRendererState(renderer, _state)
}
