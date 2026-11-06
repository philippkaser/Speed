// Car reflections: dynamic, car-centred cubemaps, the way the best-looking racing games do it.
//
//  - Gran Turismo Sport / 7 (in race) give every car the same detailed environment cubemap; Forza
//    Horizon renders dynamic cubemaps for the cars and adds ray-traced / screen-space detail on top;
//    Assetto Corsa renders a cubemap around the car, a few of its six faces per frame.
//  - Here the car the camera is on (the "hero": the player in the chase and cockpit views, the framed
//    car in TV shots) gets a high-resolution probe: 256 to 1024 px per face by quality, two or three
//    faces rendered per frame (a full refresh every two or three frames), then GGX-prefiltered in
//    place (PMREM) so every roughness reads its own blur: the clear coat a crisp mirror, the base coat
//    and the tyres soft. The next most visible cars get probes of their own from a small pool at a
//    lower resolution, refreshed round-robin; every other car shares the hero's probe (as Gran Turismo
//    does for all of them).
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
import { heroShadow, seeHero } from './sunShadow'

/** quality: hero face size, faces per frame, pool size, pool face size, pool faces per frame */
const QUALITY = [
  null,
  { hero: 256, heroFaces: 1, pool: 0, poolSize: 128, poolFaces: 0 },
  { hero: 512, heroFaces: 2, pool: 2, poolSize: 128, poolFaces: 1 },
  { hero: 1024, heroFaces: 3, pool: 4, poolSize: 256, poolFaces: 2 },
] as const

/** Objects flagged `userData.noProbe` (small props) are hidden in probe renders. */
export const PROBE_HIDDEN = 'noProbe'

interface Probe {
  size: number
  rt: THREE.CubeRenderTarget
  cam: THREE.CubeCamera
  pmrem: THREE.CubeRenderTarget | null
  generator: THREE.PMREMGenerator
  /** next face to render, faces rendered since the last prefilter */
  face: number
  pending: number
  owner: string | null
  /** faces rendered since the owner was assigned (a probe is used once all six are in) */
  fresh: number
}

function makeProbe(size: number, generator: THREE.PMREMGenerator): Probe {
  const rt = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
  const cam = new THREE.CubeCamera(0.3, 2600, rt)
  // the car in focus is drawn on its own layer (sunShadow.ts)
  for (const c of cam.children) seeHero(c as THREE.Camera)
  for (const c of cam.children) c.userData.probe = true
  return { size, rt, cam, pmrem: null, generator, face: 0, pending: 0, owner: null, fresh: 0 }
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
    const heroGen = new THREE.PMREMGenerator(renderer)
    const poolGen = new THREE.PMREMGenerator(renderer)
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
        p.rt.dispose()
        p.pmrem?.dispose()
      }
      sys.heroGen.dispose()
      sys.poolGen.dispose()
      // cars fall back to the scene's environment
      for (const id of sys.cars) setEnv(id, null)
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
    if (heroId !== sys.hero.owner) {
      sys.hero.owner = heroId
      sys.hero.fresh = 0
    }
    const wanted = ranked.filter((r) => r.id !== heroId && r.s > 0.09).slice(0, sys.pool.length).map((r) => r.id)
    // keep pool probes on cars that still want one, hand the rest to the newcomers
    for (const p of sys.pool) if (p.owner && !wanted.includes(p.owner)) p.owner = null
    for (const id of wanted) {
      if (sys.pool.some((p) => p.owner === id)) continue
      const free = sys.pool.find((p) => !p.owner)
      if (free) {
        free.owner = id
        free.fresh = 0
      }
    }

    // ---- render: a new owner gets all six faces at once, then faces per frame round-robin
    const work: { p: Probe; faces: number }[] = []
    const h = sys.hero
    work.push({ p: h, faces: h.fresh < 6 ? 6 : cfg!.heroFaces })
    let poolBudget = cfg!.poolFaces
    let burst = 1 // at most one pool probe refreshes completely per frame
    for (const p of sys.pool) {
      if (!p.owner) continue
      if (p.fresh < 6 && burst > 0) {
        work.push({ p, faces: 6 })
        burst--
      }
    }
    // the rest of the pool shares its face budget in turn
    const active = sys.pool.filter((p) => p.owner && p.fresh >= 6)
    for (let k = 0; k < active.length && poolBudget > 0; k++) {
      const p = active[(Math.floor(clock.elapsedTime * 60) + k) % active.length]
      work.push({ p, faces: 1 })
      poolBudget--
    }
    if (work.length) renderProbes(work)

    // ---- every car's materials carry the probe it should reflect
    for (const r of ranked) {
      const own = r.id === heroId ? h : sys.pool.find((p) => p.owner === r.id && p.fresh >= 6)
      const probe = own && own.pmrem ? own : h
      const tex = probe.pmrem ? probe.pmrem.texture : null
      const root = carPoses.get(r.id)?.model?.root
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
        if (o.userData[PROBE_HIDDEN]) sys.hidden.push(o)
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
        cam.position.copy(pose.pos)
        cam.position.y += 0.7
        cam.updateMatrixWorld(true)
        const vis = root.visible
        root.visible = false
        for (let k = 0; k < faces; k++) {
          renderer.setRenderTarget(p.rt, p.face)
          renderer.render(scene, cam.children[p.face] as THREE.Camera)
          p.face = (p.face + 1) % 6
          p.pending++
          p.fresh++
        }
        root.visible = vis
        // GGX prefilter once all six faces are new
        if (p.pending >= 6 || !p.pmrem) {
          p.pmrem = p.generator.fromCubemap(p.rt.texture, p.pmrem)
          p.pending = 0
        }
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
