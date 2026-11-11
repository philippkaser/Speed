// The cars' shadow atlas (src/render/carShadowAtlas.ts): slots, the car-locked fit, slot assignment.
import { expect, test } from 'bun:test'
import * as THREE from 'three/webgpu'
import { assignSlots, atlasSlots, fitCarSlot, MAX_SHADOW_CARS, type SlotFit } from '../src/render/carShadowAtlas'

const sun = new THREE.Vector3(0.55, 0.74, 0.38).normalize()
const fit = (): SlotFit => ({ render: new THREE.Matrix4(), receive: new THREE.Matrix4(), texel: 0, depthRange: 0 })

test('the atlas is tiled by slots of four sizes that do not overlap', () => {
  const W = 4096
  const slots = atlasSlots(W)
  expect(slots.length).toBe(MAX_SHADOW_CARS)
  expect(slots.map((s) => s.size).filter((s, i, a) => a.indexOf(s) === i)).toEqual([2048, 1024, 512, 256])
  let area = 0
  slots.forEach((a, i) => {
    expect(a.x).toBeGreaterThanOrEqual(0)
    expect(a.y).toBeGreaterThanOrEqual(0)
    expect(a.x + a.size).toBeLessThanOrEqual(W)
    expect(a.y + a.size).toBeLessThanOrEqual(W / 2)
    area += a.size * a.size
    for (const b of slots.slice(i + 1)) expect(a.x + a.size <= b.x || b.x + b.size <= a.x || a.y + a.size <= b.y || b.y + b.size <= a.y).toBe(true)
  })
  expect(area).toBe(W * (W / 2))
})

test("a slot holds the car's whole bounding sphere and the ground its shadow falls on", () => {
  const W = 4096,
    H = 2048
  for (const slot of [atlasSlots(W)[0], atlasSlots(W)[2], atlasSlots(W)[22]]) {
    const centre = new THREE.Vector3(120, 3.6, -40)
    const r = 2.7
    const f = fitCarSlot(centre, r, new THREE.Vector3(0.6, 0, 0.8), sun, 4.4, slot, W, H, false, fit())
    for (let k = 0; k < 200; k++) {
      const d = new THREE.Vector3(Math.sin(k * 1.7), Math.cos(k * 0.9), Math.sin(k * 2.3 + 1)).normalize().multiplyScalar(r * 0.999)
      const p = centre.clone().add(d).applyMatrix4(f.receive)
      expect(p.x * W).toBeGreaterThanOrEqual(slot.x)
      expect(p.x * W).toBeLessThanOrEqual(slot.x + slot.size)
      expect(p.y * H).toBeGreaterThanOrEqual(slot.y)
      expect(p.y * H).toBeLessThanOrEqual(slot.y + slot.size)
      expect(p.z).toBeGreaterThan(0)
      expect(p.z).toBeLessThan(1)
    }
    // the road under the car, where the shadow of its roof lands (along the sun's ray)
    const ground = centre.clone().addScaledVector(sun, -(0.6 + 1.3) / sun.y)
    expect(ground.applyMatrix4(f.receive).z).toBeLessThan(1)
    // the car's centre is the slot's centre, a texel is the sphere's diameter over the slot's size
    const c = centre.clone().applyMatrix4(f.receive)
    expect(c.x * W).toBeCloseTo(slot.x + slot.size / 2, 6)
    expect(c.y * H).toBeCloseTo(slot.y + slot.size / 2, 6)
    expect(f.texel).toBeCloseTo((2 * r) / slot.size, 9)
    // what the casters are drawn with and what the receivers look up with agree (clip -> uv, v down)
    const q = new THREE.Vector3(121, 3, -41)
    const a = q.clone().applyMatrix4(f.render)
    const b = q.clone().applyMatrix4(f.receive)
    expect(b.x).toBeCloseTo(a.x * 0.5 + 0.5, 9)
    expect(b.y).toBeCloseTo(0.5 - a.y * 0.5, 9)
    expect(b.z).toBeCloseTo(a.z, 9)
    // WebGL's clip space has depth -1..1
    const g = fitCarSlot(centre, r, new THREE.Vector3(0.6, 0, 0.8), sun, 4.4, slot, W, H, true, fit())
    expect(q.clone().applyMatrix4(g.receive).z).toBeCloseTo(b.z, 6)
  }
})

test('the map is locked to the car: its texel grid moves and turns with the car, so the shadow cannot crawl', () => {
  const W = 4096,
    H = 2048
  const slot = atlasSlots(W)[3]
  const r = 2.7
  // a point fixed on the car (its mirror), in the car's frame
  const local = new THREE.Vector3(1.05, 0.4, 0.6)
  const texelOf = (pos: THREE.Vector3, q: THREE.Quaternion) => {
    const centre = new THREE.Vector3(0, 0.6, 0).applyQuaternion(q).add(pos)
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    const f = fitCarSlot(centre, r, forward, sun, 4.4, slot, W, H, false, fit())
    const p = local.clone().add(new THREE.Vector3(0, 0.6, 0)).applyQuaternion(q).add(pos).applyMatrix4(f.receive)
    return new THREE.Vector2(p.x * W, p.y * H)
  }
  const q0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7)
  const ref = texelOf(new THREE.Vector3(0, 0, 0), q0)
  // driving on at 250 km/h, in steps that are no multiple of anything: the same texel, to a thousandth
  // (a map snapped to a world-fixed grid would be up to half a texel off, differently every frame)
  for (let i = 1; i < 50; i++) {
    const p = texelOf(new THREE.Vector3(i * 1.15741, i * 0.0131, i * -0.77712), q0)
    expect(p.distanceTo(ref)).toBeLessThan(1e-3)
  }
  // turned about the sun's direction, the map turns with the car
  for (const a of [0.3, 1.1, 2.9]) {
    const q = new THREE.Quaternion().setFromAxisAngle(sun, a).multiply(q0)
    expect(texelOf(new THREE.Vector3(40, 0, 7), q).distanceTo(ref)).toBeLessThan(1e-3)
  }
})

test('slots go to the cars biggest on screen, and two cars of about the same size do not swap every frame', () => {
  const held = [-1, -1, -1, -1]
  assignSlots([0.1, 0.5, 0.3, 0], held, 23)
  expect(held).toEqual([2, 0, 1, -1])
  // car 2 grows a little bigger than car 1: the big slot stays where it is
  assignSlots([0.1, 0.5, 0.55, 0], held, 23)
  expect(held[1]).toBe(0)
  // clearly bigger: now it moves
  assignSlots([0.1, 0.5, 0.7, 0], held, 23)
  expect(held[2]).toBe(0)
  expect(held[1]).toBe(1)
  // more cars than slots: the smallest go without
  const many = Array.from({ length: 30 }, (_, i) => 1 / (i + 1))
  const h = assignSlots(many, many.map(() => -1), 23)
  expect(h.filter((s) => s >= 0).length).toBe(23)
  expect(h[29]).toBe(-1)
  expect(h[0]).toBe(0)
})
