// The photographic sky: Poly Haven's "Kloofendal 48d Partly Cloudy" HDRI as the visible sky, the
// image-based light and the colour of the aerial perspective, with the sun's direction, colour and
// strength measured from the photograph (scripts/build-world-assets.ts).
//
// The HDRI is stored as an 8-bit colour image and an 8-bit log2 gain map (radiance = colour * 2^gain),
// ~600 KB instead of 75 MB, and decoded in the shader. Its sun disc stays in the visible sky; the
// directional light carries the sun's energy, so the environment map leaves the disc out.
import * as THREE from 'three/webgpu'
import { asin, atan, clamp, cos, exp2, float, Fn, max, min, mix, normalize, positionLocal, sin, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl'
import { skyMeta, skyTextures } from './worldAssets'

type N = any

export const photoSkyU = {
  /** rotation of the photograph about +y (image frame -> world) */
  rot: uniform(0),
  /** radiance scale: photograph units -> scene units */
  scale: uniform(1),
  /** radiance of the ground below the horizon (environment map only) */
  ground: uniform(new THREE.Color(0.2, 0.22, 0.15)),
}

/** World direction -> image frame of the photograph. */
const toImage = (d: N) => {
  const c = cos(photoSkyU.rot),
    s = sin(photoSkyU.rot)
  return vec3(d.x.mul(c).add(d.z.mul(s)), d.y, d.z.mul(c).sub(d.x.mul(s)))
}

/** Sky radiance (scene units) towards a world direction, read at an explicit mip level. */
export const photoSkyRadiance = (dir: N, level: number | N = 0, maxRadiance = 30000): N => {
  const t = skyTextures()
  const d = toImage(dir)
  const u = atan(d.z, d.x).div(Math.PI * 2).add(0.5)
  const el = asin(clamp(d.y, -1, 1)).mul(180 / Math.PI)
  const v = float(skyMeta.elevMax).sub(el).div(skyMeta.elevMax - skyMeta.elevMin).clamp(0.0005, 0.9995)
  const uvv = vec2(u, v)
  const col = texture(t.colour, uvv).level(level).rgb
  const g = texture(t.gain, uvv).level(level).r
  const gain = exp2(g.mul(skyMeta.logMax - skyMeta.logMin).add(skyMeta.logMin))
  return min(col.mul(gain), float(maxRadiance)).mul(photoSkyU.scale)
}

/** The sky's radiance near the horizon behind a point: what distant terrain fades into. */
export const photoSkyHorizon = (dir: N): N => photoSkyRadiance(normalize(vec3(dir.x, max(dir.y, 0.0).mul(0.6).add(0.04), dir.z)), 6, 40)

/** Sun direction in the world for a rotation of the photograph. */
export function photoSunDir(rot: number, out = new THREE.Vector3()) {
  const [x, y, z] = skyMeta.sunDir
  return out.set(x * Math.cos(rot) - z * Math.sin(rot), y, x * Math.sin(rot) + z * Math.cos(rot)).normalize()
}

/** Rotation that puts the photograph's sun at the given azimuth (atan2(z, x) of the horizontal direction). */
export function photoRotationFor(azimuth: number) {
  return azimuth - Math.atan2(skyMeta.sunDir[2], skyMeta.sunDir[0])
}

/** The visible sky: a dome that rides with the camera (no parallax, no motion from translation). */
export function makeSkyDome(radius = 8000) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false })
  m.fog = false
  // the sun disc stays far brighter than anything else (it blinds to white and glows through the
  // bloom), capped so its glare does not wash out the whole frame
  m.colorNode = photoSkyRadiance(normalize(positionLocal), 0, 8000)
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), m)
  dome.scale.setScalar(radius)
  dome.frustumCulled = false
  // after the opaque scene: only pixels nothing else covered pay for the sky
  dome.renderOrder = 10
  dome.name = 'sky'
  return dome
}

/**
 * The scene the environment map (PMREM) is captured from: the sky without the sun disc (the
 * directional light is the sun) and lit ground below the horizon.
 */
export function makeEnvScene() {
  const scene = new THREE.Scene()
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false })
  m.fog = false
  m.colorNode = Fn(() => {
    const d = normalize(positionLocal)
    const sky = photoSkyRadiance(vec3(d.x, max(d.y, 0.01), d.z), 1, 150)
    return mix(photoSkyU.ground, sky, smoothstep(-0.06, 0.02, d.y))
  })()
  const dome = new THREE.Mesh(new THREE.SphereGeometry(100, 96, 48), m)
  scene.add(dome)
  return { scene, dispose: () => (dome.geometry.dispose(), m.dispose()) }
}
