// Car reflections: dynamic, car-centred cubemaps, the way the best-looking racing games do it.
//
//  - Gran Turismo Sport / 7 (in race) give every car the same detailed environment cubemap; Forza
//    Horizon renders dynamic cubemaps for the cars and adds ray-traced / screen-space detail on top;
//    Assetto Corsa renders a cubemap around the car, a few of its six faces per frame.
//  - Here the car the camera is on (the "hero": the player in the chase and cockpit views, the framed
//    car in TV shots) gets a high-resolution probe: 512 or 1024 px per face by quality, one to three
//    faces rendered per frame. The next most visible cars get probes of their own from a small pool
//    at a lower resolution, refreshed round-robin; every other car shares the hero's probe (as Gran
//    Turismo does for all of them).
//  - A probe is two cubes. The back one is rendered a few faces a frame, all six from one point; when
//    it is complete it gets its mip chain and becomes the front one, which the cars read. So the six
//    faces always show the world from the same place (faces replaced one by one tear along the cube's
//    edges at speed: the car moves more than a metre a frame), and the cost per frame is constant.
//  - The mirror lobes (the paint's clear coat) sample the front cube itself (mirrorEnv.ts). Every
//    other lobe reads a GGX-prefiltered copy (PMREM) that is small (256 px) and refreshed a few times
//    a second: the prefilter takes 256 samples per texel and level, which at the probe's own size and
//    rate was the most expensive thing in the frame.
//  - The probe is captured from where the car will be halfway through the time its cube is shown,
//    so what it shows of the trackside is never more than a frame or so out of place.
//  - The probe scene is cheap: shadow maps are not re-rendered for the probe's cameras (three renders
//    them once per camera per frame, which made every probe update cost 24 shadow passes), other cars
//    take their simplest level of detail, grass and small props are left out, trees are near meshes
//    and impostors, and the sky dome follows the probe camera.
//  - Other cars are in the probes, so cars reflect each other.
// Screen-space reflections are not needed for the cars any more (they only reflect what is on screen,
// flicker at the edges and smear with roughness) and are off by default.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { game } from '../game/game'
import { useSettings } from '../state/settings'
import { carPoses } from './CarVisual'
import { csmState } from './Environment'
import { type MirrorEnv, setMirrorCube, setMirrorGround } from './mirrorEnv'
import { heroShadow, seeHero } from './sunShadow'

/** quality: hero face size, faces per frame, pool size, pool face size, pool faces per frame */
const QUALITY = [
  null,
  { hero: 512, heroFaces: 1, pool: 0, poolSize: 128, poolFaces: 0 },
  { hero: 1024, heroFaces: 2, pool: 2, poolSize: 128, poolFaces: 1 },
  { hero: 1024, heroFaces: 3, pool: 4, poolSize: 256, poolFaces: 2 },
] as const

/** Face size of the prefiltered copies (three's minimum: the rough lobes resolve no more). */
const PMREM_SIZE = 256
/** Frames between two prefilters of a probe: the hero's, a pool probe's. At most one a frame. */
const PMREM_EVERY = 8
const PMREM_EVERY_POOL = 20

/** Objects flagged `userData.noProbe` (small props) are hidden in probe renders. */
export const PROBE_HIDDEN = 'noProbe'

/**
 * Layer seen only by the probe cameras: coarse stand-ins for big meshes (terrain, mountains) whose
 * full versions are flagged noProbe.
 */
export const PROBE_LAYER = 11

interface Probe {
  size: number
  /** the complete cube the cars read, and the one being rendered */
  front: THREE.CubeRenderTarget
  back: THREE.CubeRenderTarget
  cam: THREE.CubeCamera
  pmrem: THREE.CubeRenderTarget | null
  generator: THREE.PMREMGenerator
  /** faces of the back cube rendered so far, and where they are rendered from */
  done: number
  capture: THREE.Vector3
  /** where the front cube was captured from */
  origin: THREE.Vector3
  owner: string | null
  /** the front cube is the owner's surroundings */
  ready: boolean
  /** frames since the prefilter */
  stale: number
  /** the owner's position a frame ago (its motion per frame leads the capture point) */
  last: THREE.Vector3
  tracked: boolean
}

function makeCube(size: number) {
  const rt = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter })
  // the mip chain is generated once per refresh, with the sixth face (renderProbes)
  rt.texture.mipmapsAutoUpdate = false
  return rt
}

function makeGenerator(renderer: THREE.WebGPURenderer) {
  const g = new THREE.PMREMGenerator(renderer)
  // three sizes a PMREM after its source cube; this one is for the rough lobes only (r187, private)
  const p = g as unknown as { _setSize(size: number): void }
  const setSize = p._setSize.bind(g)
  p._setSize = (size: number) => setSize(Math.min(size, PMREM_SIZE))
  return g
}

function makeProbe(size: number, generator: THREE.PMREMGenerator): Probe {
  const front = makeCube(size)
  const back = makeCube(size)
  const cam = new THREE.CubeCamera(0.3, 2600, back)
  // the car in focus is drawn on its own layer (sunShadow.ts)
  for (const c of cam.children) seeHero(c as THREE.Camera)
  for (const c of cam.children) {
    c.userData.probe = true
    c.layers.enable(PROBE_LAYER)
  }
  return { size, front, back, cam, pmrem: null, generator, done: 0, capture: new THREE.Vector3(), origin: new THREE.Vector3(), owner: null, ready: false, stale: Infinity, last: new THREE.Vector3(), tracked: false }
}

/** A probe goes to another car: its cube is rendered completely before it is used. */
function assign(p: Probe, owner: string) {
  p.owner = owner
  p.ready = false
  p.done = 0
  p.tracked = false
  p.stale = Infinity
}

const _v = new THREE.Vector3()
const _cp = new THREE.Vector3()

/** How big a car is on screen (half-length over distance, relative to the lens). */
function screenSize(pos: THREE.Vector3, camera: THREE.Camera) {
  const pc = camera as THREE.PerspectiveCamera
  const tanHalf = pc.isPerspectiveCamera ? Math.tan((pc.fov * Math.PI) / 360) / pc.zoom : 1
  _cp.setFromMatrixPosition(camera.matrixWorld)
  return 2.3 / Math.max(0.5, _v.copy(pos).sub(_cp).length()) / tanHalf
}

export function Reflections() {
  const { gl, scene } = useThree()
  const renderer = gl as unknown as THREE.WebGPURenderer
  const quality = useSettings((s) => s.graphics.reflections ?? (s.graphics.envProbe === false ? 0 : 2))
  const cfg = QUALITY[Math.max(0, Math.min(3, quality)) as 0 | 1 | 2 | 3]

  const sys = useMemo(() => {
    if (!cfg) return null
    const heroGen = makeGenerator(renderer)
    const poolGen = makeGenerator(renderer)
    return {
      hero: makeProbe(cfg.hero, heroGen),
      pool: Array.from({ length: cfg.pool }, () => makeProbe(cfg.poolSize, poolGen)),
      heroGen,
      poolGen,
      /** car model -> the env map its materials carry */
      assigned: new WeakMap<THREE.Object3D, THREE.Texture | null>(),
      cars: new Set<string>(),
      hidden: [] as THREE.Object3D[],
      hiddenAt: -1,
      version: -1,
    }
  }, [cfg, renderer])

  // ?refldebug: the probes for inspection (window.__refl)
  useEffect(() => {
    if (sys && typeof location !== 'undefined' && new URLSearchParams(location.search).has('refldebug')) (window as unknown as { __refl?: object }).__refl = { renderer, sys, carPoses }
  }, [sys, renderer])

  useEffect(
    () => () => {
      if (!sys) return
      for (const p of [sys.hero, ...sys.pool]) {
        p.front.dispose()
        p.back.dispose()
        p.pmrem?.dispose()
      }
      sys.heroGen.dispose()
      sys.poolGen.dispose()
      // cars fall back to the scene's environment
      for (const id of sys.cars) {
        const mirror = carPoses.get(id)?.model?.root.userData.mirror as MirrorEnv | undefined
        if (mirror) setMirrorCube(mirror, null)
        setEnv(id, null)
      }
    },
    [sys],
  )

  useFrame(({ camera, clock }) => {
    if (!sys || game.mode === 'attract' && !carPoses.size) return
    camera.updateMatrixWorld()

    // ---- rank the cars by size on screen: the biggest is the hero, the next ones get pool probes
    const ranked: { id: string; s: number; pos: THREE.Vector3 }[] = []
    for (const [id, pose] of carPoses) if (pose.model) ranked.push({ id, s: screenSize(pose.pos, camera), pos: pose.pos })
    if (!ranked.length) return
    ranked.sort((a, b) => b.s - a.s)
    // hysteresis: the current hero keeps the probe unless another car is clearly bigger
    const cur = ranked.find((r) => r.id === sys.hero.owner)
    const heroId = cur && cur.s * 1.25 >= ranked[0].s ? cur.id : ranked[0].id
    if (heroId !== sys.hero.owner) assign(sys.hero, heroId)
    const wanted = ranked.filter((r) => r.id !== heroId && r.s > 0.09).slice(0, sys.pool.length).map((r) => r.id)
    // keep pool probes on cars that still want one, hand the rest to the newcomers
    for (const p of sys.pool) if (p.owner && !wanted.includes(p.owner)) p.owner = null
    for (const id of wanted) {
      if (sys.pool.some((p) => p.owner === id)) continue
      const free = sys.pool.find((p) => !p.owner)
      if (free) assign(free, id)
    }

    // ---- render: a new owner gets all six faces at once, then faces per frame round-robin
    const work: { p: Probe; faces: number }[] = []
    const h = sys.hero
    work.push({ p: h, faces: h.ready ? cfg!.heroFaces : 6 })
    let poolBudget = cfg!.poolFaces
    let burst = 1 // at most one pool probe refreshes completely per frame
    for (const p of sys.pool) {
      if (!p.owner) continue
      if (!p.ready && burst > 0) {
        work.push({ p, faces: 6 })
        burst--
      }
    }
    // the rest of the pool shares its face budget in turn
    const active = sys.pool.filter((p) => p.owner && p.ready)
    for (let k = 0; k < active.length && poolBudget > 0; k++) {
      const p = active[(Math.floor(clock.elapsedTime * 60) + k) % active.length]
      work.push({ p, faces: 1 })
      poolBudget--
    }
    if (work.length) renderProbes(work)

    // ---- the prefiltered copies: the oldest one that is due, one a frame
    let due: Probe | null = null
    for (const p of [h, ...sys.pool]) {
      p.stale++
      if (!p.ready || (p.pmrem && p.stale < (p === h ? PMREM_EVERY : PMREM_EVERY_POOL))) continue
      if (!due || !p.pmrem || (due.pmrem && p.stale > due.stale)) due = p
    }
    if (due) {
      due.pmrem = due.generator.fromCubemap(due.front.texture, due.pmrem)
      due.stale = 0
    }

    // ---- every car's materials carry the probe it should reflect
    for (const r of ranked) {
      const own = r.id === heroId ? h : sys.pool.find((p) => p.owner === r.id && p.ready)
      const probe = own && own.pmrem ? own : h
      const tex = probe.pmrem ? probe.pmrem.texture : null
      const pose = carPoses.get(r.id)
      const root = pose?.model?.root
      const mirror = root?.userData.mirror as MirrorEnv | undefined
      if (pose && mirror && tex) {
        // the mirror lobes: the probe's front cube, with the road under the car where it is (a
        // shared probe is another car's: read as if at infinity)
        setMirrorCube(mirror, probe.front.texture)
        ;(mirror.origin.value as THREE.Vector3).copy(probe.origin)
        mirror.parallax.value = probe === own ? 1 : 0
        setMirrorGround(mirror, pose.pos, pose.quat)
      }
      if (root && sys.assigned.get(root) !== tex) {
        setEnv(r.id, tex)
        sys.assigned.set(root, tex)
        sys.cars.add(r.id)
      }
    }
  }, 0.7)

  function renderProbes(work: { p: Probe; faces: number }[]) {
    if (!sys) return
    // small props out of the probes (refreshed every few seconds and on session changes)
    if (sys.version !== game.version || performance.now() - sys.hiddenAt > 3000) {
      sys.hidden.length = 0
      scene.traverse((o) => {
        // (the grass layers have no instances within the probes' range, yet three still prepares
        // their render objects for every face: ~1.5 to 5 ms each)
        if (o.userData[PROBE_HIDDEN] || o.name.startsWith('veg:grass')) sys.hidden.push(o)
      })
      sys.hiddenAt = performance.now()
      sys.version = game.version
    }
    const hiddenState = sys.hidden.map((o) => o.visible)
    for (const o of sys.hidden) o.visible = false
    // the shadow maps stay as the main camera's pass left them. (Only the cascades' and the hero's
    // shadows are paused, never the sun's own: the cascades are created by cloning it, on the first
    // build of the materials, which can happen inside a probe render. Cloned while paused, they never
    // updated again, and the game had no sun shadows at all.)
    const shadows: THREE.LightShadow[] = []
    const csm = csmState.csm as unknown as { lights?: { shadow: THREE.LightShadow }[] } | null
    for (const l of csm?.lights ?? []) shadows.push(l.shadow)
    shadows.push(heroShadow)
    const shadowState = shadows.map((s) => s.autoUpdate)
    for (const s of shadows) s.autoUpdate = false
    const prevTarget = renderer.getRenderTarget()
    const prevFace = renderer.getActiveCubeFace()
    const prevMip = renderer.getActiveMipmapLevel()
    // the scene's world matrices once for all the faces (each render would traverse the whole scene
    // graph again: the largest part of a probe face's own cost)
    const autoMatrices = scene.matrixWorldAutoUpdate
    scene.updateMatrixWorld()
    scene.matrixWorldAutoUpdate = false
    try {
      for (const { p, faces } of work) {
        const pose = p.owner ? carPoses.get(p.owner) : undefined
        const root = pose?.model?.root
        if (!pose || !root) continue
        const cam = p.cam
        if (cam.coordinateSystem !== renderer.coordinateSystem) {
          cam.coordinateSystem = renderer.coordinateSystem
          cam.updateCoordinateSystem()
        }
        // the car's motion per frame (none across a reset or a new owner)
        _v.copy(pose.pos).sub(p.last)
        if (!p.tracked || _v.lengthSq() > 9) _v.set(0, 0, 0)
        p.last.copy(pose.pos)
        p.tracked = true
        const vis = root.visible
        root.visible = false
        for (let k = 0; k < faces; k++) {
          if (p.done === 0) {
            // all six faces from one point: where the car will be halfway through the frames this
            // cube is shown for (it is finished in `cycle` frames, then shown for as many)
            const cycle = Math.ceil(6 / faces)
            p.capture.copy(pose.pos).addScaledVector(_v, 1.5 * (cycle - 1))
            p.capture.y += 0.7
          }
          cam.position.copy(p.capture)
          cam.updateMatrixWorld(true)
          const last = p.done === 5
          p.back.texture.mipmapsAutoUpdate = last
          renderer.setRenderTarget(p.back, p.done)
          renderer.render(scene, cam.children[p.done] as THREE.Camera)
          p.back.texture.mipmapsAutoUpdate = false
          p.done++
          if (last) {
            const front = p.back
            p.back = p.front
            p.front = front
            p.origin.copy(p.capture)
            p.done = 0
            p.ready = true
          }
        }
        root.visible = vis
      }
    } finally {
      scene.matrixWorldAutoUpdate = autoMatrices
      renderer.setRenderTarget(prevTarget, prevFace, prevMip)
      sys.hidden.forEach((o, i) => (o.visible = hiddenState[i]))
      // back as they were; cascades created during the probes render in the main pass
      shadows.forEach((s, i) => (s.autoUpdate = shadowState[i]))
      for (const l of csm?.lights ?? []) if (!shadows.includes(l.shadow)) l.shadow.autoUpdate = true
    }
  }

  return null
}

const envState = new WeakMap<THREE.Material, true>()

/** Points every reflective material of a car at an env map (null: the scene's environment). */
function setEnv(carId: string, tex: THREE.Texture | null) {
  const root = carPoses.get(carId)?.model?.root
  root?.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined
    if (!m) return
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (!('envMap' in mat) || mat.side === THREE.BackSide) continue
      // a material switching between null and a map changes its shader; between maps it does not
      if ((mat.envMap === null) !== (tex === null)) mat.needsUpdate = true
      mat.envMap = tex
      envState.set(mat, true)
    }
  })
}
