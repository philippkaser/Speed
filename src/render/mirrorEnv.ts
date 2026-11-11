// The mirror lobes of a car (the paint's clear coat) read the car's cube probe itself, at its full
// resolution, instead of the GGX-prefiltered copy every other lobe uses.
//
//  - three clamps every roughness to 0.045 and maps it onto the prefiltered mips, so a clear coat
//    never saw the probe's top level: at 512 px it read between the 512 and the 256 px levels, about
//    0.3 degrees of blur where a 1080p pixel covers 0.05. And a prefilter sharp enough for a mirror
//    is unaffordable: 256 GGX samples per texel per level, two billion texture fetches for a 1024 px
//    probe, every refresh.
//  - A mirror needs no prefilter. It samples the cube with the hardware's own trilinear filter (the
//    cube carries a mip chain, so reflections stay stable where curved panels minify them), and the
//    prefiltered copy for the rough lobes can then be small and refreshed a few times a second.
//  - Reflection rays that go down hit the road a metre away, not at infinity: they are intersected
//    with the ground plane under the car and looked up towards the hit point as the probe saw it
//    from where it was captured. The road, its lines and the kerbs then mirror where they are, and
//    they stay put in the world between two refreshes of the probe instead of stepping with it.
import * as THREE from 'three/webgpu'
import { cameraViewMatrix, cubeTexture, materialEnvIntensity, positionViewDirection, positionWorld, uniform } from 'three/tsl'

type Node = ReturnType<typeof uniform>

export interface MirrorEnv {
  /** the probe's cube (created with the first one: a material's shader is built around it) */
  cube: ReturnType<typeof cubeTexture> | null
  /** where the cube was captured from (world) */
  origin: Node
  /** the ground under the car: xyz normal, w offset (n.p + w = 0 on the plane) */
  ground: Node
  /** 1: ground-plane parallax (the car's own probe); 0: the cube as if at infinity (a shared probe) */
  parallax: Node
  /** the materials that mirror this probe */
  materials: MirrorMaterial[]
}

/** A material with a mirror lobe: `mirrorNode` set, its clear coat reflects that instead of the PMREM. */
export interface MirrorMaterial extends THREE.Material {
  mirrorNode: unknown
  /** builds the mirror node for this material from the env (null: none) and rebuilds its shader */
  setMirror(env: MirrorEnv | null): void
}

export function makeMirrorEnv(): MirrorEnv {
  return { cube: null, origin: uniform(new THREE.Vector3()), ground: uniform(new THREE.Vector4(0, 1, 0, 0)), parallax: uniform(0), materials: [] }
}

/** The radiance a mirror with this view-space normal reflects (the env's cube must exist). */
export function mirrorRadiance(env: MirrorEnv, normalView: unknown) {
  const r = (positionViewDirection as any).negate().reflect(normalView).transformDirection(cameraViewMatrix)
  const g = env.ground as any
  // 1 / distance to the ground along the ray (0 for rays that never reach it): the lookup direction
  // is the hit point seen from the probe, hit - origin = (p - origin) + t r, scaled by 1 / t
  const height = (positionWorld as any).dot(g.xyz).add(g.w).max(0.03)
  const invT = r.dot(g.xyz).negate().max(0).div(height).mul(env.parallax)
  const dir = r.add((positionWorld as any).sub(env.origin).mul(invT))
  return (env.cube as any).sample(dir).rgb.mul(materialEnvIntensity)
}

/** Points a car's mirror lobes at a cube (null: back to the prefiltered environment). */
export function setMirrorCube(env: MirrorEnv, tex: THREE.CubeTexture | null) {
  if (tex && env.cube) {
    if (env.cube.value !== tex) env.cube.value = tex
    return
  }
  if (!tex && !env.cube) return
  env.cube = tex ? cubeTexture(tex) : null
  for (const m of env.materials) m.setMirror(tex ? env : null)
}

/** The ground plane under a car at `pos` (its origin is on the road) with orientation `quat`. */
export function setMirrorGround(env: MirrorEnv, pos: THREE.Vector3, quat: THREE.Quaternion) {
  const v = env.ground.value as THREE.Vector4
  _n.set(0, 1, 0).applyQuaternion(quat)
  v.set(_n.x, _n.y, _n.z, -_n.dot(pos))
}
const _n = new THREE.Vector3()
