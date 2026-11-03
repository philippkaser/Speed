// Detailed GT3 car models (public/models, built by scripts/build-car-models.ts) as CarModel instances.
//
// Each car clones the shared template (geometry and most materials are shared between all cars) and
// gets its own livery material: the model's livery texture is recoloured in the shader to the team's
// colours (navy base -> team colour, red accents -> team accent), keeping logos, numbers and shading.
// Levels of detail: the full model near the camera, a simplified one (no interior) further away and
// for the shadow passes. Wheels are separate pivots (spin, steer, suspension travel, camber).
import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { abs, float, Fn, min, mix, pow, smoothstep, step, texture, uniform, uv, vec3, vec4 } from 'three/tsl'
import type { CarSpec } from '../physics/spec'
import type { Vehicle } from '../physics/vehicle'
import type { CarModel } from './carModel'

export const GLTF_CARS = [
  { id: 'ferrari-296-gt3', name: 'Ferrari 296 GT3' },
  { id: 'amg-gt3', name: 'Mercedes-AMG GT3' },
] as const
export type GltfCarId = (typeof GLTF_CARS)[number]['id']

interface Meta {
  id: string
  name: string
  livery: string
  paint: { baseHue: number; baseV: number; accentHue: number; accentV: number }
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
 * on screen as one 15 m away through a normal one.
 */
const LOD_DISTANCES = [0, 24, 80]
const REF_TAN = Math.tan((50 * Math.PI) / 360)

class ScreenLOD extends THREE.LOD {
  private _camPos = new THREE.Vector3()
  private _objPos = new THREE.Vector3()
  update(camera: THREE.Camera) {
    const levels = this.levels
    if (levels.length < 2) return
    this._camPos.setFromMatrixPosition(camera.matrixWorld)
    this._objPos.setFromMatrixPosition(this.matrixWorld)
    let d = this._camPos.distanceTo(this._objPos)
    const pc = camera as THREE.PerspectiveCamera
    if (pc.isPerspectiveCamera) d *= Math.tan((pc.fov * Math.PI) / 360) / REF_TAN / pc.zoom
    let i = 1
    for (; i < levels.length; i++) {
      let ld = levels[i].distance
      if (levels[i].object.visible) ld -= ld * levels[i].hysteresis
      if (d < ld) break
    }
    for (let k = 0; k < levels.length; k++) levels[k].object.visible = k === i - 1
    ;(this as unknown as { _currentLevel: number })._currentLevel = i - 1
  }
}

export function loadCarModels(): Promise<void> {
  if (loading) return loading
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
  loading = Promise.all(
    GLTF_CARS.map(async ({ id }) => {
      const t0 = performance.now()
      const gltf = await loader.loadAsync(`${base}models/${id}.glb`)
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
        }
      })
      const box = new THREE.Box3().setFromObject(car.getObjectByName('body_lod0') ?? car)
      templates.set(id, { meta, car, zFront: box.max.z, zRear: box.min.z })
      console.info(`[car] ${meta.name} model loaded in ${(performance.now() - t0).toFixed(0)} ms`)
    }),
  )
    .then(() => {
      gltfState.ready = true
    })
    .catch((e) => {
      gltfState.failed = String(e?.message ?? e)
      console.warn('[car] detailed car models unavailable, using procedural bodies:', e)
    })
    .finally(() => {
      for (const l of listeners) l()
    })
  return loading
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
 * Livery recolouring: the model's paint scheme (a navy base with red accents) is remapped to the
 * team's colours by hue, saturation and value, so sponsor logos, numbers and baked shading survive.
 */
function liveryMaterial(src: THREE.MeshPhysicalMaterial, paint: Meta['paint'], primary: THREE.Color, accent: THREE.Color) {
  const m = new THREE.MeshPhysicalNodeMaterial()
  m.name = src.name + ':team'
  for (const k of ['roughness', 'metalness', 'roughnessMap', 'metalnessMap', 'normalMap', 'normalScale', 'clearcoat', 'clearcoatRoughness', 'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'clearcoatNormalScale', 'specularIntensity', 'specularColor', 'specularIntensityMap', 'specularColorMap', 'aoMap', 'aoMapIntensity', 'side', 'envMapIntensity'] as const) {
    const v = (src as unknown as Record<string, unknown>)[k]
    if (v === undefined) continue
    const cur = (m as unknown as Record<string, unknown>)[k]
    if (cur && typeof (cur as { copy?: unknown }).copy === 'function' && v && typeof v === 'object' && !(v as THREE.Texture).isTexture) (cur as { copy: (x: unknown) => void }).copy(v)
    else (m as unknown as Record<string, unknown>)[k] = v
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
    const shadeA = pow(v.div(paint.baseV).clamp(0.15, 1.25), float(2.2))
    const shadeB = pow(v.div(paint.accentV).clamp(0.35, 1.15), float(2.2))
    let col: any = lin.mul(base)
    col = mix(col, (teamA as any).mul(shadeA), baseW)
    col = mix(col, (teamB as any).mul(shadeB), accW)
    m.colorNode = col
  } else m.color.copy(src.color)
  return { material: m, teamA, teamB }
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
  /** this car gets its own copies of all materials (the player's car takes the reflection probe) */
  uniqueMaterials?: boolean
  driverColor?: string
}

export function buildGltfCar(id: GltfCarId, spec: CarSpec, opts: GltfCarOptions): CarModel {
  const tpl = templates.get(id)!
  const meta = tpl.meta
  const primary = new THREE.Color(opts.color)
  const accent = new THREE.Color(opts.accent)
  const root = new THREE.Group()
  root.name = 'car:' + id
  const bodyGroup = new THREE.Group()
  root.add(bodyGroup)

  // per-car materials: livery, brake lights, discs (plus everything when unique)
  const own = new Map<THREE.Material, THREE.Material>()
  const disposables: THREE.Material[] = []
  let livery: ReturnType<typeof liveryMaterial> | null = null
  const rearLights: THREE.MeshStandardMaterial[] = []
  const discs: THREE.MeshStandardMaterial[] = []
  const swap = (mat: THREE.Material): THREE.Material => {
    const hit = own.get(mat)
    if (hit) return hit
    let out: THREE.Material = mat
    const name = mat.name ?? ''
    if (name === meta.livery && (mat as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
      livery = liveryMaterial(mat as THREE.MeshPhysicalMaterial, meta.paint, primary, accent)
      out = livery.material
    } else if (/Light_Rear|Lights$/i.test(name) || /Disc/i.test(name) || opts.uniqueMaterials) {
      out = mat.clone()
      if (/Light_Rear|Lights$/i.test(name)) rearLights.push(out as THREE.MeshStandardMaterial)
      if (/Disc/i.test(name)) discs.push(out as THREE.MeshStandardMaterial)
    }
    if (out !== mat) disposables.push(out)
    own.set(mat, out)
    return out
  }
  const adopt = (o: THREE.Object3D) => {
    o.traverse((x) => {
      const m = x as THREE.Mesh
      if (!m.isMesh) return
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material)
    })
    return o
  }

  const bodyLod = new ScreenLOD()
  LOD_DISTANCES.forEach((d, i) => {
    const o = tpl.car.getObjectByName(`body_lod${i}`)
    if (o) bodyLod.addLevel(adopt(o.clone(true)), d, 0.1)
  })
  bodyGroup.add(bodyLod)

  // wheels
  const corners = ['FL', 'FR', 'RL', 'RR'] as const
  const physIndex = { FL: 0, FR: 1, RL: 2, RR: 3 } // vehicle.wheels: 0 FL, 1 FR, 2 RL, 3 RR (left = +x)
  const wheels = corners.map((k) => {
    const node = tpl.car.getObjectByName(`wheel_${k}`)!
    const pivot = new THREE.Group()
    const spin = new THREE.Group()
    pivot.add(spin)
    const lod = new ScreenLOD()
    LOD_DISTANCES.forEach((d, i) => {
      const o = node.getObjectByName(`wheel_${k}_spin_lod${i}`)
      if (o) lod.addLevel(adopt(o.clone(true)), d, 0.1)
    })
    lod.position.set(0, 0, 0)
    spin.add(lod)
    const fixed = node.getObjectByName(`wheel_${k}_fixed`)
    if (fixed) {
      const f = adopt(fixed.clone(true))
      f.position.set(0, 0, 0)
      pivot.add(f)
    }
    root.add(pivot)
    return { k, pivot, spin, x: meta.wheels[k].centre[0], index: physIndex[k] }
  })

  // steering wheel: turns about its own column axis
  const steerTpl = tpl.car.getObjectByName('steering')
  const steering = steerTpl ? adopt(steerTpl.clone(true)) : null
  const steerAxis = new THREE.Vector3(...(meta.steeringAxis ?? [0, 0.35, -0.94])).normalize()
  const steerRest = steering ? steering.quaternion.clone() : null
  const _sq = new THREE.Quaternion()
  if (steering) bodyGroup.add(steering)

  // driver: suit in the team colour, helmet in the accent
  const driver = new THREE.Group()
  // seated behind the steering wheel (the seat meshes can include the passenger side), head kept
  // clear of the roof lining (measured: ~0.46 m above the wheel centre on both models)
  const sw = meta.steeringWheel ?? [0.33, 0.66, 0.36]
  const helmetPos = new THREE.Vector3(sw[0], sw[1] + 0.27, sw[2] - 0.45)
  const suit = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(opts.driverColor ?? opts.color).multiplyScalar(0.7), roughness: 0.85 })
  const helmetMat = new THREE.MeshPhysicalNodeMaterial({ color: accent, roughness: 0.22, clearcoat: 1, metalness: 0.1 })
  const visorMat = new THREE.MeshPhysicalNodeMaterial({ color: 0x050505, roughness: 0.05, metalness: 0.9 })
  disposables.push(suit, helmetMat, visorMat)
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.3, 6, 12), suit)
  torso.position.set(helmetPos.x, helmetPos.y - 0.4, helmetPos.z - 0.08)
  torso.rotation.x = -0.3
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 24, 16), helmetMat)
  helmet.position.copy(helmetPos)
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.137, 24, 12, -0.9, 1.8, 1.1, 0.7), visorMat)
  visor.position.copy(helmetPos)
  for (const m of [torso, helmet, visor]) {
    m.castShadow = true
    driver.add(m)
  }
  bodyGroup.add(driver)

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
      m.emissiveIntensity = 0.6 + v.brake * 7
    }
    const glow = brakeGlow(maxBrake, heat)
    for (const m of discs) {
      m.emissive.copy(heat)
      m.emissiveIntensity = glow
    }
  }

  const setVisibleParts = (o: { body?: boolean; interior?: boolean; driver?: boolean }) => {
    if (o.body !== undefined) bodyLod.visible = o.body
    if (o.driver !== undefined) driver.visible = o.driver
  }

  const dispose = () => {
    for (const m of disposables) m.dispose()
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
