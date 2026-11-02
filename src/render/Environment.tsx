// Sky, sun, image based lighting and aerial perspective.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three/webgpu'
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import { cameraPosition, dot, exp, float, Fn, length, max, mix, output, positionWorld, pow, uniform, vec3, vec4 } from 'three/tsl'
import { useSettings } from '../state/settings'
import { debugFlag } from '../util/debug'
import { setTrackTemp } from '../physics/tyre'

export interface SunState {
  dir: THREE.Vector3
  color: THREE.Color
  intensity: number
  elevation: number
}

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

export function Environment({ hour, focus }: { hour: number; focus?: React.RefObject<THREE.Vector3> }) {
  const { scene, gl, camera } = useThree()
  const renderer = gl as unknown as THREE.WebGPURenderer
  const shadowsQ = useSettings((s) => s.graphics.shadows)
  const sun = useMemo(() => computeSun(hour), [hour])
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
    }
    return () => {
      light.shadow.map?.dispose()
      ;(light.shadow as any).shadowNode = null
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
      const col = mix(fogU.color, fogU.sunColor, sunAmt.mul(0.75))
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
  }, [scene, fogU])

  // apply sun + environment (PMREM of the sky)
  useEffect(() => {
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
  }, [sun, sky, light, renderer, scene, fogU])

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
      {!debugFlag('nosky') && <primitive object={sky} />}
      <primitive object={light} />
      <primitive object={light.target} />
    </>
  )
}
