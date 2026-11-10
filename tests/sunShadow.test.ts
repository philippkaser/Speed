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

test("a cascade's depth bias is a few centimetres along the sun's ray, whatever its camera's depth range", async () => {
  const { cascadeBias } = await import('../src/render/sunShadow')
  // the four cascades on High: ~0.9 cm, 3 cm, 9 cm and 30 cm per texel; the shadow cameras span 3 km
  for (const texel of [0.009, 0.03, 0.09, 0.3]) {
    const b = cascadeBias(texel, 2999)
    const metres = -b.bias * 2999
    // (three applies the bias to normalised depth: -0.0002 was 0.6 m here, and no kerb, post or
    // distant car cast a shadow)
    expect(metres).toBeGreaterThan(0.005)
    expect(metres).toBeLessThan(texel + 0.02)
    // level ground under a 48 degree sun, read up to two texels beside the receiver: moving the
    // receiver along its normal by n lifts it n / sin(elevation) clear of the stored depth
    const elev = (48 * Math.PI) / 180
    const margin = b.normalBias / Math.sin(elev) + metres
    expect(margin).toBeGreaterThan((2 * texel) / Math.tan(elev))
    // and the shadow starts no further than two texels from its caster
    expect(b.normalBias).toBeLessThan(2 * texel)
  }
})

test('the car in focus is one the camera sees: a car close behind the chase camera does not take the map', async () => {
  const { pickHero } = await import('../src/render/sunShadow')
  const player = car()
  const chaser = car()
  const cam = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 1000)
  // chase view: the camera 6.5 m behind the player, looking along +z; the chaser 1 m behind the camera
  cam.position.set(0, 2.4, -6.5)
  cam.lookAt(0, 0.8, 0)
  cam.updateMatrixWorld(true)
  const cars: [string, { pos: THREE.Vector3; root?: THREE.Object3D }][] = [
    ['player', { pos: new THREE.Vector3(0, 0, 0), root: player.root }],
    ['ai', { pos: new THREE.Vector3(0.5, 0, -7.5), root: chaser.root }],
  ]
  pickHero(cars, cam)
  expect(player.body.layers.isEnabled(HERO_LAYER)).toBe(true)
  expect(chaser.body.layers.isEnabled(HERO_LAYER)).toBe(false)
  // alongside and in view, nearer to the camera by more than the hysteresis: now it is the bigger car
  cars[1][1].pos.set(1.5, 0, -3.5)
  pickHero(cars, cam)
  expect(chaser.body.layers.isEnabled(HERO_LAYER)).toBe(true)
  // cockpit view: the camera sits in the player's car, whose centre is beside or behind it
  cam.position.set(0.3, 1.0, -0.2)
  cam.lookAt(0.3, 1.0, 10)
  cam.updateMatrixWorld(true)
  cars[1][1].pos.set(0, 0, -6)
  pickHero(cars, cam)
  expect(player.body.layers.isEnabled(HERO_LAYER)).toBe(true)
  setShadowHero(null)
})

test("grounding: a car's box takes the sky from the road as a wall and a ceiling of its size would", async () => {
  const { boxOcclusionAt, groundBox } = await import('../src/render/carGrounding')
  const g = groundBox(new THREE.Box3(new THREE.Vector3(-1, 0, -2.3), new THREE.Vector3(1, 1.25, 2.3)))
  // the floor is a few centimetres above the road, the box ends at the beltline
  expect(g.centre.y - g.half.y).toBeGreaterThan(0.04)
  expect(g.centre.y - g.half.y).toBeLessThan(0.12)
  expect(g.centre.y + g.half.y).toBeLessThan(1)
  const up = new THREE.Vector3(0, 1, 0)
  const at = (x: number, z = 0) => boxOcclusionAt(new THREE.Vector3(x, -g.centre.y, z), up, g.half)
  // under the middle of the car nearly all of the sky is gone
  expect(at(0)).toBeGreaterThan(0.93)
  expect(at(0)).toBeLessThanOrEqual(1)
  // beside it: an infinitely long wall of height H at distance d covers (1 - d / hypot(d, H)) / 2;
  // the car is a little less (finite length, the gap under the floor)
  const H = g.centre.y + g.half.y
  for (const d of [0.1, 0.3, 1, 2]) {
    const wall = (1 - d / Math.hypot(d, H)) / 2
    const o = at(g.half.x + d)
    expect(o).toBeLessThan(wall + 0.01)
    expect(o).toBeGreaterThan(wall * 0.55)
  }
  // falls off monotonically, and is symmetric
  expect(at(g.half.x + 0.2)).toBeGreaterThan(at(g.half.x + 0.6))
  expect(at(g.half.x + 0.6)).toBeGreaterThan(at(g.half.x + 1.5))
  expect(at(-g.half.x - 0.6)).toBeCloseTo(at(g.half.x + 0.6), 6)
  expect(at(g.half.x + 2.5)).toBeLessThan(0.04)
})
