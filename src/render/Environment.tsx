// Sky, sun, image based lighting and aerial perspective.
//
// Two skies: the photographic one (default; an HDRI, src/render/photoSky.ts) whose sun, light colour
// and strength come from the photograph, and the procedural one (SkyMesh) that follows the time of day.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three/webgpu'
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import { cameraPosition, dot, exp, float, Fn, length, max, mix, output, positionWorld, pow, uniform, vec3, vec4 } from 'three/tsl'
import { useSettings } from '../state/settings'
import { debugFlag } from '../util/debug'
import { setTrackTemp } from '../physics/tyre'
import { postUniforms } from './PostFX'
import { makeEnvScene, makeSkyDome, photoRotationFor, photoSkyHorizon, photoSkyU, photoSunDir } from './photoSky'
import { skyMeta, skyReady } from './worldAssets'

export interface SunState {
  dir: THREE.Vector3
  color: THREE.Color
  intensity: number
  elevation: number
}

/** The cascaded shadow maps of the sun (vegetation sizes its shadow draws by the cascades' ranges). */
export const csmState: { csm: CSMShadowNode | null } = { csm: null }

export const sunState: SunState = { dir: new THREE.Vector3(0.3, 0.4, 0.2).normalize(), color: new THREE.Color(1, 0.9, 0.8), intensity: 3, elevation: 0.3 }

export function computeSun(hour: number): SunState {
  const t = (hour - 5.8) / 14.4
  const elevation = Math.max(-0.1, Math.sin(Math.PI * t)) * (60 * Math.PI) / 180
  const az = THREE.MathUtils.lerp(-2.0, 2.0, t) // radians from south, + towards west
  // world: north = -z, east = +x, south = +z, west = -x
  const dir = new THREE.Vector3(-Math.sin(az) * Math.cos(elevation), Math.sin(elevation), Math.cos(az) * Math.cos(elevation)).normalize()
  const e = elevation
  const warm = THREE.MathUtils.smoothstep(e, 0.02, 0.6)
  const color = new THREE.Color().setRGB(1.0, THREE.MathUtils.lerp(0.62, 0.96, warm), THREE.MathUtils.lerp(0.36, 0.9, warm))
  const intensity = 6.5 * THREE.MathUtils.smoothstep(e, -0.02, 0.12)
  return { dir, color, intensity, elevation }
}

/** Sun light strength (scene units) for a high sun; the photographic sky is scaled to match it. */
const SUN_INTENSITY = 6.5

/** Whether the photographic sky is in use (Settings, `?procsky` forces the procedural one). */
export function usePhotoSky() {
  const mode = useSettings((s) => s.graphics.sky ?? 'photo')
  return mode === 'photo' && !debugFlag('procsky')
}

/**
 * The photographic sky's sun. The photograph fixes its elevation (48 degrees); it is turned so the sun
 * stands where the clock would put a sun that high in the afternoon, and its light is measured from the
 * disc in the HDRI (colour and irradiance), the sky's brightness scaled to keep the same ratio.
 */
export function photoSun(): SunState & { rot: number; scale: number } {
  const elevation = Math.asin(skyMeta.sunDir[1])
  // the afternoon hour with this elevation
  let hour = 16
  for (let h = 13; h <= 20; h += 0.01) {
    if (computeSun(h).elevation <= elevation) {
      hour = h
      break
    }
  }
  const ref = computeSun(hour).dir
  const rot = photoRotationFor(Math.atan2(ref.z, ref.x))
  const [r, g, b] = skyMeta.sunIrradiance
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const scale = SUN_INTENSITY / lum
  return { dir: photoSunDir(rot), color: new THREE.Color(r / lum, g / lum, b / lum), intensity: SUN_INTENSITY, elevation, rot, scale }
}

export function Environment({ hour, focus }: { hour: number; focus?: React.RefObject<THREE.Vector3> }) {
  const { scene, gl, camera } = useThree()
  const renderer = gl as unknown as THREE.WebGPURenderer
  const shadowsQ = useSettings((s) => s.graphics.shadows)
  const photo = usePhotoSky()
  const sun = useMemo(() => (photo ? photoSun() : computeSun(hour)), [hour, photo])
  Object.assign(sunState, sun)
  // asphalt temperature follows the sun (feeds the tyre thermal model)
  useEffect(() => setTrackTemp(24 + 26 * Math.max(0, Math.sin(sun.elevation))), [sun])

  const sky = useMemo(() => {
    const s = new SkyMesh()
    s.scale.setScalar(9000)
    s.turbidity.value = 3.2
    s.rayleigh.value = 1.4
    s.mieCoefficient.value = 0.004
    s.mieDirectionalG.value = 0.82
    s.cloudCoverage.value = 0.32
    s.cloudDensity.value = 0.45
    s.cloudElevation.value = 0.6
    s.frustumCulled = false
    return s
  }, [])

  const dome = useMemo(() => makeSkyDome(), [])
  useEffect(() => () => dome.geometry.dispose(), [dome])
  // the environment map is captured from the photograph: (re)capture once its images are in
  const [skyIn, setSkyIn] = useState(false)
  useEffect(() => {
    let alive = true
    if (photo) skyReady().then(() => alive && setSkyIn(true))
    return () => {
      alive = false
    }
  }, [photo])

  const light = useMemo(() => {
    const l = new THREE.DirectionalLight(0xffffff, 3)
    l.castShadow = true
    return l
  }, [])

  // shadows: cascaded shadow maps around the camera
  useEffect(() => {
    const size = shadowsQ >= 3 ? 4096 : shadowsQ === 2 ? 2048 : 1024
    light.castShadow = shadowsQ > 0 && !debugFlag('noshadow')
    light.shadow.mapSize.set(size, size)
    light.shadow.camera.near = 1
    light.shadow.camera.far = 3000
    light.shadow.camera.left = -400
    light.shadow.camera.right = 400
    light.shadow.camera.top = 400
    light.shadow.camera.bottom = -400
    light.shadow.bias = -0.0002
    light.shadow.normalBias = 0.02
    if (shadowsQ > 0 && !debugFlag('noshadow') && !debugFlag('nocsm')) {
      const csm = new CSMShadowNode(light, { cascades: shadowsQ >= 2 ? 4 : 3, maxFar: shadowsQ >= 3 ? 650 : 400, mode: 'practical', lightMargin: 250 })
      // note: CSM picks up the camera itself on first build (setting it early skips its init)
      light.shadow.shadowNode = csm
      ;(light as any).__csm = csm
      csmState.csm = csm
    }
    return () => {
      light.shadow.map?.dispose()
      ;(light.shadow as any).shadowNode = null
      csmState.csm = null
    }
  }, [light, shadowsQ, camera])

  // fog / aerial perspective
  const fogU = useMemo(
    () => ({
      color: uniform(new THREE.Color(0.55, 0.65, 0.8)),
      sunColor: uniform(new THREE.Color(1, 0.8, 0.6)),
      sunDir: uniform(new THREE.Vector3(0, 1, 0)),
      density: uniform(0.00019),
      heightFalloff: uniform(0.012),
    }),
    [],
  )
  useEffect(() => {
    if (debugFlag('nofog')) return
    const fogNode = Fn(() => {
      const toFrag = positionWorld.sub(cameraPosition)
      const dist = length(toFrag)
      const dir = toFrag.div(max(dist, 0.001))
      const sunAmt = pow(max(dot(dir, fogU.sunDir), 0), float(7))
      // photographic sky: distant terrain fades into the sky's own horizon behind it
      const col = photo ? photoSkyHorizon(dir).mul(0.85) : mix(fogU.color, fogU.sunColor, sunAmt.mul(0.75))
      // height attenuated exponential fog (denser in valleys)
      const h = max(positionWorld.y.add(20), 0)
      const dens = fogU.density.mul(exp(h.mul(fogU.heightFalloff).negate()).mul(0.7).add(0.3))
      const f = float(1).sub(exp(dist.mul(dens).negate()))
      return vec4(mix(output.rgb, col, f.clamp(0, 0.92)), output.a)
    })()
    scene.fogNode = fogNode
    return () => {
      scene.fogNode = null
    }
  }, [scene, fogU, photo])

  // apply sun + environment (PMREM of the sky)
  useEffect(() => {
    // base exposure follows the light on the ground, like a camera operator: a high sun puts about
    // twice the light on the track of an evening sun. Calibrated to leave 18:18 (24 degrees) as is;
    // the auto exposure only adapts relative to this.
    postUniforms.exposure.value = THREE.MathUtils.clamp((Math.sin(0.42) + 0.15) / (Math.sin(Math.max(sun.elevation, 0)) + 0.15), 0.5, 1.35)
    const sunPos = sun.dir.clone().multiplyScalar(1000)
    sky.sunPosition.value.copy(sun.dir)
    light.color.copy(sun.color)
    light.intensity = sun.intensity
    fogU.sunDir.value.copy(sun.dir)
    const e = sun.elevation
    // aerial perspective tint: cool blue haze, warmer when the sun is low
    const horizon = new THREE.Color().setRGB(THREE.MathUtils.lerp(0.62, 0.42, Math.min(1, e * 2)), THREE.MathUtils.lerp(0.6, 0.54, Math.min(1, e * 2)), THREE.MathUtils.lerp(0.62, 0.72, Math.min(1, e * 2)))
    fogU.color.value.copy(horizon)
    fogU.sunColor.value.copy(sun.color).multiplyScalar(1.1)
    light.position.copy(sunPos)

    // clear alpine air under the photographic sky (its bright, hazy horizon is the in-scatter colour)
    fogU.density.value = photo ? 0.00012 : 0.00019
    if (photo) {
      const ps = sun as ReturnType<typeof photoSun>
      photoSkyU.rot.value = ps.rot
      photoSkyU.scale.value = ps.scale
      // grass-green ground under the sun and sky (albedo ~0.13): what the lower half reflects
      const [sr, sg, sb] = skyMeta.skyIrradiance
      const e = (Math.sin(sun.elevation) * SUN_INTENSITY + ps.scale * (0.2126 * sr + 0.7152 * sg + 0.0722 * sb)) / Math.PI
      photoSkyU.ground.value.setRGB(0.1 * e, 0.125 * e, 0.075 * e)
      if (debugFlag('noenv') || !skyIn) return
      const env = makeEnvScene()
      const pmrem = new THREE.PMREMGenerator(renderer)
      const rt = pmrem.fromScene(env.scene as any, 0, 0.1, 2000)
      scene.environment = rt.texture
      scene.environmentIntensity = 1
      pmrem.dispose()
      env.dispose()
      return () => {
        rt.dispose()
      }
    }

    // environment map from a dedicated sky scene
    const envScene = new THREE.Scene()
    const envSky = new SkyMesh()
    envSky.scale.setScalar(1000)
    envSky.turbidity.value = sky.turbidity.value
    envSky.rayleigh.value = sky.rayleigh.value
    envSky.mieCoefficient.value = sky.mieCoefficient.value
    envSky.mieDirectionalG.value = sky.mieDirectionalG.value
    envSky.cloudCoverage.value = sky.cloudCoverage.value
    envSky.showSunDisc.value = 0
    envSky.sunPosition.value.copy(sun.dir)
    envScene.add(envSky)
    // a dark ground hemisphere so reflections of the lower half are not sky coloured
    const ground = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.05, 0.06, 0.035).multiplyScalar(0.6 + e), side: THREE.BackSide }))
    envScene.add(ground)
    if (debugFlag('noenv')) return
    const pmrem = new THREE.PMREMGenerator(renderer)
    const rt = pmrem.fromScene(envScene as any, 0, 0.1, 2000)
    scene.environment = rt.texture
    scene.environmentIntensity = 0.7
    pmrem.dispose()
    envSky.geometry.dispose()
    return () => {
      rt.dispose()
    }
  }, [sun, sky, light, renderer, scene, fogU, photo, skyIn])

  // the photographic dome rides with the camera: after the camera rigs and the reflection probes (which
  // move it to their own cameras), before the frame and its motion history
  useFrame(() => {
    // debug (window.__lookSun = true): turn the camera to the sun, to look at the lens' glare
    if ((window as unknown as { __lookSun?: boolean }).__lookSun) {
      camera.lookAt(camera.position.clone().add(sunState.dir.clone().multiplyScalar(10)).add(new THREE.Vector3(0, -2.5, 0)))
      camera.updateMatrixWorld()
    }
    if (!photo) return
    dome.position.copy(camera.position)
    dome.scale.setScalar(8000)
    dome.updateMatrixWorld()
  }, 0.8)

  const target = useRef(new THREE.Vector3())
  useFrame(() => {
    // keep the light pointing along the sun direction relative to the focus point
    const f = focus?.current ?? target.current.copy(camera.position)
    light.target.position.copy(f)
    light.position.copy(f).addScaledVector(sun.dir, 1200)
    light.target.updateMatrixWorld()
    const csm = (light as any).__csm as CSMShadowNode | undefined
    if (csm && csm.camera && csm.camera !== camera) {
      csm.camera = camera
      csm.updateFrustums()
    }
  }, -3)

  return (
    <>
      {!debugFlag('nosky') && <primitive object={photo ? dome : sky} />}
      <primitive object={light} />
      <primitive object={light.target} />
    </>
  )
}
