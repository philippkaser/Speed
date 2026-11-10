// The hero car's shadow map (src/render/sunShadow.ts): fitted around the car, stable as it moves.
import { expect, test } from 'bun:test'
import * as THREE from 'three/webgpu'
import { HERO_LAYER, heroShadowLight, setShadowHero, updateHeroShadow } from '../src/render/sunShadow'

function car() {
  const root = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 1.2, 4.6))
  body.position.y = 0.6
  body.castShadow = true
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.4, 1.5))
  glass.castShadow = false
  root.add(body, glass)
  root.updateMatrixWorld(true)
  return { root, body, glass }
}
const sun = new THREE.Vector3(0.55, 0.74, 0.38).normalize()

test('the hero map contains the whole car and its shadow casters are on the hero layer', () => {
  const { root, body, glass } = car()
  root.position.set(120, 3, -40)
  root.rotation.y = 0.7
  root.updateMatrixWorld(true)
  setShadowHero(root)
  expect(body.layers.isEnabled(HERO_LAYER)).toBe(true)
  expect(body.layers.isEnabled(0)).toBe(false)
  // glass casts no shadow: it stays where every camera sees it, out of the map
  expect(glass.layers.isEnabled(0)).toBe(true)
  updateHeroShadow(sun, 2048)
  const cam = heroShadowLight.shadow.camera as THREE.OrthographicCamera
  heroShadowLight.shadow.updateMatrices(heroShadowLight)
  const box = new THREE.Box3().setFromObject(body)
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const p = new THREE.Vector3(x, y, z).applyMatrix4(cam.matrixWorldInverse)
        expect(p.x).toBeGreaterThan(cam.left)
        expect(p.x).toBeLessThan(cam.right)
        expect(p.y).toBeGreaterThan(cam.bottom)
        expect(p.y).toBeLessThan(cam.top)
        expect(-p.z).toBeGreaterThan(cam.near)
        expect(-p.z).toBeLessThan(cam.far)
      }
  // the ground under the car, where its shadow falls, is inside the depth range too
  const ground = new THREE.Vector3(120, 0, -40).applyMatrix4(cam.matrixWorldInverse)
  expect(-ground.z).toBeLessThan(cam.far)
  setShadowHero(null)
  expect(body.layers.isEnabled(0)).toBe(true)
})

test('the map is fitted where the car is, even if its world matrix was stale when it became the hero', () => {
  const { root } = car()
  // moved and turned, matrices not yet refreshed (as the cars are posed before the frame renders)
  root.position.set(-485, 0.3, 1.4)
  root.rotation.y = -1.6
  setShadowHero(root)
  updateHeroShadow(sun, 2048)
  const target = heroShadowLight.target.position
  expect(Math.hypot(target.x + 485, target.z - 1.4)).toBeLessThan(1.5)
  setShadowHero(null)
})

test('the map moves in whole texels: a car moving smoothly does not make its shadow shimmer', () => {
  const { root } = car()
  setShadowHero(root)
  const cam = heroShadowLight.shadow.camera as THREE.OrthographicCamera
  let prev: THREE.Vector3 | null = null
  for (let i = 0; i < 40; i++) {
    root.position.set(i * 0.0123, 0, i * 0.0071)
    root.updateMatrixWorld(true)
    updateHeroShadow(sun, 2048)
    cam.updateMatrixWorld()
    const texel = (cam.right - cam.left) / 2048
    // the camera's position across the light direction, in texels: always a whole number apart
    const p = cam.position.clone()
    if (prev) {
      const d = p.clone().sub(prev).applyMatrix4(new THREE.Matrix4().extractRotation(cam.matrixWorldInverse))
      expect(Math.abs(d.x / texel - Math.round(d.x / texel))).toBeLessThan(1e-3)
      expect(Math.abs(d.y / texel - Math.round(d.y / texel))).toBeLessThan(1e-3)
    }
    prev = p
  }
  setShadowHero(null)
})

test("distant trees' shadows land away from the sun, h / tan(elevation) from the trunk", async () => {
  const { setTreeShadows } = await import('../src/render/sunShadow')
  const elev = (40 * Math.PI) / 180
  const sun = new THREE.Vector3(Math.cos(elev), Math.sin(elev), 0) // sun in the +x direction
  const bounds: [number, number, number, number] = [-512, -512, 512, 512]
  const T = setTreeShadows([{ x: 0, y: 0, z: 0, radius: 4, height: 10 }], sun, bounds, 400)
  const N = 2048
  const at = (x: number, z: number) => T[Math.floor(((z + 512) / 1024) * N) * N + Math.floor(((x + 512) / 1024) * N)]
  const off = 10 / Math.tan(elev)
  // darkest where the crown's centre projects, towards -x; nothing on the sunny side of the trunk
  expect(at(-off, 0)).toBeLessThan(0.35)
  expect(at(off, 0)).toBe(1)
  expect(at(0, 0)).toBeGreaterThan(at(-off, 0))
  // stretched along the sun's azimuth: reaches further along x than across
  expect(at(-off - 4.5, 0)).toBeLessThan(1)
  expect(at(-off, 4.5)).toBe(1)
})

test('cascades always render: a cascade cloned while the probes had paused the shadows comes back', async () => {
  const { cascadesWithoutHero } = await import('../src/render/sunShadow')
  // the reflection probes pause shadow updates while they render; CSM clones its cascades from the
  // sun's shadow on the first material build, which can happen inside a probe render
  const sun = new THREE.DirectionalLight()
  sun.shadow.autoUpdate = false
  const cascades = [0, 1, 2].map(() => ({ shadow: sun.shadow.clone() }))
  expect(cascades.every((c) => c.shadow.autoUpdate === false)).toBe(true)
  cascadesWithoutHero({ lights: cascades })
  // every cascade renders every frame, the farthest too (cars move metres per frame: a cascade
  // that skips frames leaves their shadows behind, then jumps)
  const far = [0, 1, 2, 3].map(() => (cascadesWithoutHero({ lights: cascades }), cascades.every((c) => c.shadow.autoUpdate === true)))
  expect(far.every(Boolean)).toBe(true)
  // and the cascades never draw the hero car's layer
  expect(cascades.every((c) => !c.shadow.camera.layers.isEnabled(HERO_LAYER) && c.shadow.camera.layers.isEnabled(0))).toBe(true)
})
