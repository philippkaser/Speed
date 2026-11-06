// The sun's shadow, in parts multiplied together (SunShadowNode), the last being the screen-space
// contact shadows (contactShadows.ts):
//  - three's cascaded shadow maps for the world and every car but one;
//  - a dedicated shadow map for the car in focus (the "hero": the player in the chase and cockpit
//    views, the framed car in TV shots, the same car that gets the high-resolution reflection probe):
//    an orthographic map fitted tightly to the car's bounding sphere, a few millimetres per texel.
//    The car shadows itself in detail (mirrors on the doors, the wing on the deck, the wheels in their
//    arches, the roll cage in the cockpit) and casts a crisp contact shadow on the road, at any
//    distance: through a TV camera's long lens the car is 100 m away, where the cascades' texels are
//    decimetres and the car would lose all of that. Its own shadow on the road lies inside the same
//    footprint seen from the sun, so the map covers it too.
//  - beyond the cascades' range (400 m on High, 650 m on Ultra), where the forests stand in the
//    distance, the shadows of the trees on the ground: every tree's crown projected along the sun's
//    direction onto the ground as a soft ellipse (a crown of radius r whose centre is h above the
//    ground lands h / tan(elevation) away from the trunk, away from the sun, stretched by
//    1 / sin(elevation) along the sun's azimuth), splatted once into a ground-level transmittance map
//    over the whole circuit (setTreeShadows). No per-frame cost, perfectly stable, and inside a forest
//    the trees shade each other.
// The hero is drawn only on HERO_LAYER (enabled on the main and probe cameras): the cascades leave it
// out, so its coarse cascade shadow cannot blur the fine one. The map is rendered by three's own shadow
// machinery (a light that is never added to the scene: bias, filtering and coordinates as for any
// shadow), and its centre is snapped to the map's texel grid so it does not shimmer as the car moves.
import * as THREE from 'three/webgpu'
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js'
import { float, positionView, positionWorld, shadow, smoothstep, texture, uniform } from 'three/tsl'
import { contactShadowNode } from './contactShadows'

type N = any

export const HERO_LAYER = 5

/** Where the cascaded shadow maps end (m) for a shadow quality (Settings: 1 low .. 3 ultra). */
export const cascadesFar = (quality: number) => (quality >= 3 ? 650 : 400)
/** Cascade cameras: layer 0 plus one that nothing else uses (three lets a layer-0-only shadow camera
 *  inherit the main camera's layers, which would bring the hero back in). */
const CASCADE_MASK = 1 | (1 << 6)
/**
 * Layers of shadow casters limited to the near cascades: an object on NEAR_CASTER_LAYERS[k] casts into
 * cascades 0..k only (castInNearCascades). The main and probe cameras see them all (seeHero).
 */
const NEAR_CASTER_LAYERS = [7, 8, 9, 10]
const cascadeMask = (i: number) => NEAR_CASTER_LAYERS.reduce((m, l, k) => (k >= i ? m | (1 << l) : m), CASCADE_MASK)

/**
 * Small casters (posts, boards, cones, tyre stacks, crowd): beyond the near cascades a shadow texel is
 * 10 cm (cascade 2, 38-130 m on High) to 35 cm (cascade 3), where their shadows are a texel or two,
 * but each still costs a draw and its triangles in every cascade that covers it. This keeps `o` (and
 * its children) out of the cascades after `last` (0: first 12 m, 1: 38 m, 2: 130 m on High).
 */
export function castInNearCascades(o: THREE.Object3D, last = 1) {
  const layer = NEAR_CASTER_LAYERS[Math.max(0, Math.min(NEAR_CASTER_LAYERS.length - 1, last))]
  o.traverse((x) => {
    x.layers.disable(0)
    for (const l of NEAR_CASTER_LAYERS) x.layers.disable(l)
    x.layers.enable(layer)
  })
}

const heroLight = new THREE.DirectionalLight(0xffffff, 1)
heroLight.name = 'hero shadow'
heroLight.castShadow = true
heroLight.shadow.camera = new THREE.OrthographicCamera(-3, 3, 3, -3, 1, 200)
heroLight.shadow.camera.layers.set(HERO_LAYER)
heroLight.shadow.bias = -0.0004
heroLight.shadow.normalBias = 0.004
heroLight.shadow.mapSize.set(2048, 2048)

/** The hero map's shadow (the reflection probes keep it as the main pass left it). */
export const heroShadow = heroLight.shadow
/** (tests) the light whose shadow camera is fitted to the hero */
export const heroShadowLight = heroLight

/** The hero map's shadow term (1 outside its footprint). */
const heroShadowNode: N = shadow(heroLight as N)

// ------------------------------------------------------------------------------- distant trees

const FAR_SIZE = 2048
/** Ground-level transmittance of the trees' shadows over the circuit (1: no tree shadow). */
const farData = new Uint8Array(FAR_SIZE * FAR_SIZE).fill(255)
const farMap = new THREE.DataTexture(farData, FAR_SIZE, FAR_SIZE, THREE.RedFormat, THREE.UnsignedByteType)
farMap.minFilter = farMap.magFilter = THREE.LinearFilter
farMap.generateMipmaps = false
farMap.needsUpdate = true
const farU = {
  /** world x/z -> map uv: (xz - min) * scale */
  min: uniform(new THREE.Vector2(0, 0)),
  scale: uniform(new THREE.Vector2(0, 0)),
  /** view depth over which the cascades hand over to the map (m) */
  from: uniform(1e6),
  to: uniform(1e6 + 1),
}
/**
 * Gives a material its own factor on the sun's shadow (applied once, in SunShadowNode): e.g. a grass
 * canopy shading itself, or the distant trees' shadows for the far receivers.
 */
export function setSunShadowTerm(material: THREE.Material, term: N) {
  ;(material as { sunShadowNode?: N }).sunShadowNode = term
}

/** The distant trees' shadow at this fragment (1 within the cascades' range): for far receivers. */
export const farTreeShadow = (): N => farShadowNode
const farShadowNode: N = (() => {
  const uvw = positionWorld.xz.sub(farU.min).mul(farU.scale)
  const t = texture(farMap, uvw).r
  const inside = uvw.x.greaterThan(0).and(uvw.x.lessThan(1)).and(uvw.y.greaterThan(0)).and(uvw.y.lessThan(1))
  const w = smoothstep(farU.from, farU.to, positionView.z.negate())
  return float(1).sub(w.mul(float(1).sub(t)).mul(inside.select(float(1), float(0))))
})()

export interface TreeShadowCaster {
  x: number
  /** height of the ground at the trunk */
  y: number
  z: number
  /** crown radius and its centre's height above the ground (m) */
  radius: number
  height: number
}

/** Opacity of a crown to the sun at its centre (leaves let some light through). */
const CROWN_OPACITY = 0.72

/**
 * Splats the trees' ground shadows for the sun direction `sunDir` (towards the sun) into the far map
 * over `bounds` [minX, minZ, maxX, maxZ]. `cascadesFar` is where the cascaded maps end.
 */
export function setTreeShadows(trees: Iterable<TreeShadowCaster>, sunDir: THREE.Vector3, bounds: [number, number, number, number], cascadesFar: number) {
  const [x0, z0, x1, z1] = bounds
  const N = FAR_SIZE
  const sx = N / (x1 - x0),
    sz = N / (z1 - z0)
  const T = new Float32Array(N * N).fill(1)
  const elev = Math.max(0.08, Math.asin(Math.min(1, Math.max(-1, sunDir.y))))
  const hx = sunDir.x,
    hz = sunDir.z
  const hl = Math.hypot(hx, hz) || 1
  // unit vector away from the sun on the ground, and across
  const ax = -hx / hl,
    az = -hz / hl
  const stretch = 1 / Math.sin(elev)
  const reach = 1 / Math.tan(elev)
  for (const t of trees) {
    const cx = t.x + ax * t.height * reach,
      cz = t.z + az * t.height * reach
    const ra = t.radius * stretch,
      rb = t.radius
    const R = Math.max(ra, rb)
    const i0 = Math.max(0, Math.floor((cx - R - x0) * sx)),
      i1 = Math.min(N - 1, Math.ceil((cx + R - x0) * sx))
    const j0 = Math.max(0, Math.floor((cz - R - z0) * sz)),
      j1 = Math.min(N - 1, Math.ceil((cz + R - z0) * sz))
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) / sz - cz
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) / sx - cx
        const along = (px * ax + pz * az) / ra
        const across = (-px * az + pz * ax) / rb
        const d2 = along * along + across * across
        if (d2 >= 1) continue
        const f = (1 - d2) * (1 - d2)
        T[j * N + i] *= 1 - CROWN_OPACITY * f
      }
    }
  }
  for (let k = 0; k < N * N; k++) farData[k] = Math.round(T[k] * 255)
  farMap.needsUpdate = true
  farU.min.value.set(x0, z0)
  farU.scale.value.set(1 / (x1 - x0), 1 / (z1 - z0))
  // the cascades fade out over their last 15%; the map takes over over the same stretch
  farU.from.value = cascadesFar * 0.82
  farU.to.value = cascadesFar * 0.97
  return T
}

/**
 * CSM for the world, times the hero car's own map, times the screen-space contact shadows
 * (contactShadows.ts). The far receivers add the distant trees' shadows (farTreeShadow).
 */
export class SunShadowNode extends CSMShadowNode {
  setup(builder: N) {
    const csm = super.setup(builder) as N
    // (the distant trees' map is not here: only the far receivers sample it, see farTreeShadow; every
    // texture here is bound in every lit material, and WebGPU allows 16 per shader stage)
    let all = csm.mul(heroShadowNode).mul(contactShadowNode)
    // the material's own sun shadow term, once (materials' receivedShadowNode would be applied by
    // every cascade and by the hero map, i.e. several times over)
    const own = (builder.material as { sunShadowNode?: N } | null)?.sunShadowNode
    if (own) all = all.mul(own)
    if (!SHADOW_DEBUG) return all
    // debug (?vegdebug, window.__sunShadow.mode.value): 1 hero map only, 2 cascades only, 3 contact
    // only, 4 everything but the contact shadows
    const m = shadowDebugMode
    const noContact = own ? csm.mul(heroShadowNode).mul(own) : csm.mul(heroShadowNode)
    return m.equal(1).select(heroShadowNode, m.equal(2).select(csm, m.equal(3).select(contactShadowNode, m.equal(4).select(noContact, all))))
  }
}

const SHADOW_DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('vegdebug')
const shadowDebugMode: N = uniform(0)

const state = {
  root: null as THREE.Object3D | null,
  /** bounding sphere of the hero in its own frame */
  centre: new THREE.Vector3(),
  radius: 3,
}
if (SHADOW_DEBUG) (globalThis as unknown as { __sunShadow?: object }).__sunShadow = { mode: shadowDebugMode, heroLight, state }

const _c = new THREE.Vector3()
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()
const _f = new THREE.Vector3()
const _box = new THREE.Box3()
const _sphere = new THREE.Sphere()

function setLayer(root: THREE.Object3D, hero: boolean) {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    // transparent parts (glass) cast no shadow and stay on the default layer
    if (!m.isMesh || !m.castShadow) return
    if (hero) m.layers.set(HERO_LAYER)
    else m.layers.set(0)
  })
}

/** Makes `root` the hero (null: none). */
export function setShadowHero(root: THREE.Object3D | null) {
  if (root === state.root) return
  if (state.root) setLayer(state.root, false)
  state.root = root
  if (!root) return
  setLayer(root, true)
  // bounding sphere in the car's own frame (computed once per car)
  let s = root.userData.heroSphere as { c: THREE.Vector3; r: number } | undefined
  if (!s) {
    // (the car's world matrices first: a stale root matrix put the sphere hundreds of metres off)
    root.updateMatrixWorld(true)
    const inv = root.matrixWorld.clone().invert()
    _box.makeEmpty()
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh || !m.geometry) return
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
      const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld).applyMatrix4(inv)
      _box.union(b)
    })
    _box.getBoundingSphere(_sphere)
    s = { c: _sphere.center.clone(), r: Math.max(1.5, Math.min(4.5, _sphere.radius)) }
    root.userData.heroSphere = s
  }
  state.centre.copy(s.c)
  state.radius = s.r
}

const _p = new THREE.Vector3()
let heroId: string | null = null

/**
 * Picks the hero among the cars (biggest on screen, as for the reflection probes; the current hero
 * keeps it unless another car is clearly bigger). `cars` maps ids to their root and position.
 */
export function pickHero(cars: Iterable<[string, { pos: THREE.Vector3; root?: THREE.Object3D }]>, camera: THREE.PerspectiveCamera) {
  const t = Math.tan((camera.fov * Math.PI) / 360) / (camera.zoom || 1)
  camera.getWorldPosition(_p)
  let best: string | null = null,
    bestS = 0,
    curS = 0,
    bestRoot: THREE.Object3D | null = null,
    curRoot: THREE.Object3D | null = null
  for (const [id, c] of cars) {
    if (!c.root) continue
    const s = 1 / (Math.max(0.5, c.pos.distanceTo(_p)) * t)
    if (s > bestS) {
      bestS = s
      best = id
      bestRoot = c.root
    }
    if (id === heroId) {
      curS = s
      curRoot = c.root
    }
  }
  if (curRoot && curS * 1.25 >= bestS) setShadowHero(curRoot)
  else {
    heroId = best
    setShadowHero(bestRoot)
  }
}

/** Cameras that see the scene: the hero's layer and the near-cascade casters' layers too. */
export function seeHero(camera: THREE.Camera) {
  camera.layers.enable(HERO_LAYER)
  for (const l of NEAR_CASTER_LAYERS) camera.layers.enable(l)
}

/**
 * Keeps the cascades' cameras off the hero's layer, and the cascades rendering every frame (they are
 * clones of the sun's shadow, and a clone made while something had paused it would stay paused).
 */
export function cascadesWithoutHero(csm: CascadeSource | null, sunDir?: THREE.Vector3) {
  const lights = csm?.lights ?? []
  cascadeFrame++
  tagCascadeDepths(csm, sunDir)
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i]
    const mask = cascadeMask(i)
    if (l.shadow.camera.layers.mask !== mask) l.shadow.camera.layers.mask = mask
    // The farthest cascade (130 m and beyond) renders every other frame: its lookup matrix is only
    // recomputed when it renders, so the map and the matrix always belong together, and a frame's
    // lag at that distance does not show. A quarter of the shadow passes' cost saved.
    l.shadow.autoUpdate = lights.length < 3 || i < lights.length - 1 || cascadeFrame % 2 === 0
  }
  heroLight.shadow.autoUpdate = true
}
let cascadeFrame = 0

interface CascadeSource {
  lights?: { shadow: { camera: THREE.Camera; autoUpdate: boolean } }[]
  maxFar?: number
  camera?: THREE.Camera | null
  _cascades?: THREE.Vector2[]
}

/** How far a car's shadow can reach from its centre (half its length plus its height's shadow). */
const casterReach = (sunDir: THREE.Vector3 | undefined) => 3 + 1.4 / Math.max(0.1, Math.tan(Math.asin(Math.min(1, Math.max(0, sunDir?.y ?? 0.5)))))

/**
 * Tags every cascade camera with the main camera's view depths (m) whose shadows it holds
 * (`userData.cascadeDepth`, CSM's fade margins included), widened by how far a car's shadow reaches:
 * a car outside that range casts nothing any receiver looks up in that cascade (gltfCars.ts CarLOD
 * leaves it out of that cascade's pass).
 */
function tagCascadeDepths(csm: CascadeSource | null, sunDir?: THREE.Vector3) {
  const cs = csm?._cascades
  const lights = csm?.lights ?? []
  const cam = csm?.camera as THREE.PerspectiveCamera | null | undefined
  if (!cs || !cam || cs.length !== lights.length) return
  const near = cam.near
  const far = Math.min(csm!.maxFar ?? cam.far, cam.far)
  const reach = casterReach(sunDir)
  for (let i = 0; i < lights.length; i++) {
    const { x, y } = cs[i]
    // as CSMShadowNode's fade: the cascade covers [x - m(x) / 2, y + m(y) / 2], m(e) = e^2 / 4 (linear depth)
    const x0 = Math.max(0, x - (0.25 * x * x) / 2)
    const y1 = i === lights.length - 1 ? y : y + (0.25 * y * y) / 2
    const ud = lights[i].shadow.camera.userData as { cascadeDepth?: [number, number] }
    const r = (ud.cascadeDepth ??= [0, 0])
    r[0] = near + x0 * (far - near) - reach
    r[1] = near + y1 * (far - near) + reach
  }
}

/**
 * Fits the hero map to the hero car for this frame: `sunDir` points to the sun, `size` is the map's
 * resolution. Call after the cars have moved, before rendering.
 */
export function updateHeroShadow(sunDir: THREE.Vector3, size: number) {
  // (three resizes the map from mapSize when it renders it)
  if (heroLight.shadow.mapSize.x !== size) heroLight.shadow.mapSize.set(size, size)
  const root = state.root
  const cam = heroLight.shadow.camera as THREE.OrthographicCamera
  if (!root) {
    // nothing on the hero layer: the map stays empty (lit); park it out of the way
    heroLight.position.set(0, -1e5, 0)
    heroLight.target.position.set(0, -1e5 - 1, 0)
  } else {
    // this frame's pose (the cars have moved; their world matrices are refreshed only at render)
    root.updateWorldMatrix(true, false)
    _c.copy(state.centre).applyMatrix4(root.matrixWorld)
    const r = state.radius * 1.04
    // light-space axes (as lookAt builds them, up = +y) and the centre snapped to the texel grid
    _f.copy(sunDir).negate().normalize()
    _r.crossVectors(_f, THREE.Object3D.DEFAULT_UP)
    if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0)
    _r.normalize()
    _u.crossVectors(_r, _f).normalize()
    const texel = (2 * r) / size
    const a = _c.dot(_r),
      b = _c.dot(_u)
    _c.addScaledVector(_r, Math.round(a / texel) * texel - a).addScaledVector(_u, Math.round(b / texel) * texel - b)
    const back = 60
    heroLight.position.copy(_c).addScaledVector(sunDir, back)
    heroLight.target.position.copy(_c)
    cam.left = cam.bottom = -r
    cam.right = cam.top = r
    cam.near = back - r - 2
    // reaches the ground below the car along the sun's direction
    cam.far = back + r + 40
    cam.updateProjectionMatrix()
  }
  heroLight.updateMatrixWorld()
  heroLight.target.updateMatrixWorld()
}
