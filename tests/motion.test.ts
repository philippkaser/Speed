// Motion history for TAA and the motion blur (src/render/motionHistory.ts): what the velocity
// target is computed from, per object and per wheel.
import { expect, test } from 'bun:test'
import * as THREE from 'three/webgpu'
import { velocity } from 'three/tsl'
import { beginMotionFrame, markCameraPath, motionCamera, registerWheels, wheelUniforms } from '../src/render/motionHistory'

type VelocityUniforms = {
  update(frame: { object: THREE.Object3D; camera: THREE.Camera }): void
  previousModelWorldMatrix: { value: THREE.Matrix4 }
  previousCameraViewMatrix: { value: THREE.Matrix4 }
}
const vel = velocity as unknown as VelocityUniforms

function setup() {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000)
  camera.position.set(0, 1, 6)
  camera.lookAt(0, 0.5, 0)
  scene.add(camera)
  return { scene, camera }
}
const frame = (scene: THREE.Scene, camera: THREE.Camera, cut = false) => beginMotionFrame(scene, camera, { cut, exposure: 0.01, dt: 1 / 60 })
const box = () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial())
const expectMatrix = (a: THREE.Matrix4, b: THREE.Matrix4) => a.elements.forEach((x, i) => expect(x).toBeCloseTo(b.elements[i], 6))

test('previous matrices advance once per frame, also for objects that were hidden', () => {
  const { scene, camera } = setup()
  const m = box()
  scene.add(m)
  frame(scene, camera)
  const before = m.matrixWorld.clone()
  m.position.x = 2
  frame(scene, camera)
  // drawn several times (one draw per material group): every draw sees last frame's matrix
  vel.update({ object: m, camera })
  vel.update({ object: m, camera })
  expectMatrix(vel.previousModelWorldMatrix.value, before)
  // hidden for a frame (an LOD level switched out) while moving: history stays continuous
  m.visible = false
  m.position.x = 3
  frame(scene, camera)
  const hidden = m.matrixWorld.clone()
  m.visible = true
  m.position.x = 4
  frame(scene, camera)
  vel.update({ object: m, camera })
  expectMatrix(vel.previousModelWorldMatrix.value, hidden)
})

test('a camera cut drops the camera motion of that frame', () => {
  const { scene, camera } = setup()
  scene.add(box())
  frame(scene, camera)
  const view0 = camera.matrixWorldInverse.clone()
  camera.position.x = 0.5
  frame(scene, camera)
  vel.update({ object: scene.children[1], camera })
  expectMatrix(vel.previousCameraViewMatrix.value, view0)
  camera.position.x = 40
  frame(scene, camera, true)
  vel.update({ object: scene.children[1], camera })
  expectMatrix(vel.previousCameraViewMatrix.value, camera.matrixWorldInverse)
})

function wheel(scene: THREE.Scene, x: number, omega: number) {
  const pivot = new THREE.Group()
  pivot.position.set(x, 0.35, 0)
  const spin = new THREE.Group()
  pivot.add(spin)
  const tyre = box()
  spin.add(tyre)
  const caliper = box()
  pivot.add(caliper)
  scene.add(pivot)
  const off = registerWheels([{ pivot, spin, radius: 0.34, omega: () => omega }])
  return { pivot, spin, tyre, caliper, off }
}

test('wheels get a slot with their screw motion: hub, axle and the angle swept by the shutter', () => {
  const { scene, camera } = setup()
  const w = wheel(scene, 0, 150)
  frame(scene, camera)
  w.pivot.position.z += 1
  frame(scene, camera)
  const slot = w.tyre.userData.mbSlot as number
  expect(slot).toBeGreaterThan(0)
  // the caliper rides with the wheel but does not spin
  expect(w.caliper.userData.mbSlot).toBe(-slot)
  const hub = wheelUniforms.hub.array[slot] as THREE.Vector4
  const axle = wheelUniforms.axle.array[slot] as THREE.Vector4
  const motion = wheelUniforms.motion.array[slot] as THREE.Vector4
  // 150 rad/s during a 10 ms exposure
  expect(hub.w).toBeCloseTo(1.5, 6)
  // hub in view space: in front of the camera
  const p = new THREE.Vector3(0, 0.35, 1).applyMatrix4(camera.matrixWorldInverse)
  expect(hub.x).toBeCloseTo(p.x, 5)
  expect(hub.y).toBeCloseTo(p.y, 5)
  expect(hub.z).toBeCloseTo(p.z, 5)
  // axle: the pivot's +x in view space
  const a = new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorldInverse)
  expect(axle.x).toBeCloseTo(a.x, 5)
  expect(axle.z).toBeCloseTo(a.z, 5)
  expect(axle.w).toBeCloseTo(0.34, 6)
  // the hub moved towards the camera and down the screen: NDC motion matches a projection
  const ndc = (v: THREE.Vector3) => v.clone().applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix)
  const d = ndc(new THREE.Vector3(0, 0.35, 1)).sub(ndc(new THREE.Vector3(0, 0.35, 0)))
  expect(motion.x).toBeCloseTo(d.x, 5)
  expect(motion.y).toBeCloseTo(d.y, 5)
  w.off()
  expect(w.tyre.userData.mbSlot).toBe(0)
})

test('a spinning part without a slot reports the motion of its hub, not the chord of its rotation', () => {
  const { scene, camera } = setup()
  // behind the camera: no slot
  const w = wheel(scene, 0, 150)
  w.pivot.position.z = 20
  frame(scene, camera)
  const hubBefore = w.pivot.matrixWorld.clone()
  w.pivot.position.x += 0.2
  w.spin.rotation.x = 2.6
  frame(scene, camera)
  expect(w.tyre.userData.mbSlot ?? 0).toBe(0)
  vel.update({ object: w.tyre, camera })
  // previous = last frame's hub with this frame's rotation
  const expected = hubBefore.clone().multiply(w.pivot.matrixWorld.clone().invert()).multiply(w.tyre.matrixWorld)
  expectMatrix(vel.previousModelWorldMatrix.value, expected)
  w.off()
})

test('the nearest wheels keep their slots from frame to frame', () => {
  const { scene, camera } = setup()
  const a = wheel(scene, -1, 50)
  const b = wheel(scene, 1, 50)
  frame(scene, camera)
  const sa = a.tyre.userData.mbSlot,
    sb = b.tyre.userData.mbSlot
  expect(sa).toBeGreaterThan(0)
  expect(sb).toBeGreaterThan(0)
  expect(sa).not.toBe(sb)
  camera.position.x = 0.8
  frame(scene, camera)
  expect(a.tyre.userData.mbSlot).toBe(sa)
  expect(b.tyre.userData.mbSlot).toBe(sb)
  a.off()
  b.off()
})

/** Screen motion (NDC per frame) of a world point as the true camera and as the blur's camera see it. */
function blurMotion(camera: THREE.PerspectiveCamera, world: THREE.Vector3, prevWorld = world) {
  const cur = world.clone().applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix)
  // the velocity target: true previous camera, previous position; the blur swaps in its own camera
  const viewNow = world.clone().applyMatrix4(camera.matrixWorldInverse)
  const prevOf = (m: THREE.Matrix4, p: THREE.Vector3) => {
    const c = new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(m)
    return new THREE.Vector2(c.x / c.w, c.y / c.w)
  }
  const viewPrev = prevWorld.clone().applyMatrix4(camera.matrixWorldInverse)
  const pT = prevOf(motionCamera.toPrevTrue.value as THREE.Matrix4, viewPrev)
  const trueMotion = new THREE.Vector2(cur.x - pT.x, cur.y - pT.y)
  const corr = prevOf(motionCamera.toPrevTrue.value as THREE.Matrix4, viewNow).sub(prevOf(motionCamera.toPrevBlur.value as THREE.Matrix4, viewNow))
  return { trueMotion, blur: trueMotion.clone().add(corr) }
}

test('camera shake never blurs; the camera path, pans and zooms do', () => {
  const point = new THREE.Vector3(0, 0, -20)
  // what the path alone gives: the pan without shake
  const ref = setup()
  for (let i = 0; i < 20; i++) {
    ref.camera.position.set(i, 1, 6)
    ref.camera.lookAt(i, 0.5, 0)
    ref.camera.updateMatrixWorld()
    frame(ref.scene, ref.camera)
  }
  const path = blurMotion(ref.camera, point).trueMotion
  const { scene, camera } = setup()
  // the same pan with alternating shake of 3 cm on top
  for (let i = 0; i < 20; i++) {
    camera.position.set(i, 1, 6)
    camera.lookAt(i, 0.5, 0)
    markCameraPath(camera)
    camera.position.x += i % 2 ? 0.03 : -0.03
    camera.updateMatrixWorld()
    frame(scene, camera)
  }
  let m = blurMotion(camera, point)
  expect(m.trueMotion.distanceTo(path)).toBeGreaterThan(1e-3) // the frames do shake
  expect(m.blur.distanceTo(path)).toBeLessThan(1e-5) // the blur does not
  // a lens zoom is real motion (the camera holds its shaken position, as the rig reports it)
  camera.position.set(19, 1, 6)
  camera.lookAt(19, 0.5, 0)
  markCameraPath(camera)
  camera.position.x += 0.03
  camera.fov = 40
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  frame(scene, camera)
  m = blurMotion(camera, new THREE.Vector3(3, 1.5, -20))
  expect(m.blur.length()).toBeGreaterThan(0.01)
  expect(m.blur.distanceTo(m.trueMotion)).toBeLessThan(1e-5)
})

test('a car the camera follows gets no blur, however the camera accelerates and turns', () => {
  const { scene } = setup()
  const camera = new THREE.PerspectiveCamera(13, 16 / 9, 0.5, 12000)
  scene.add(camera)
  const camPos = new THREE.Vector3(-60, 58, 75)
  let prevCar = new THREE.Vector3()
  let worst = 0
  for (let i = 0; i < 90; i++) {
    const t = i / 60
    // accelerating and turning, followed by a lagging helicopter that keeps it centred
    const car = new THREE.Vector3(40 * t + 40 * t * t, 0, 3 * t * t * t)
    camPos.lerp(car.clone().add(new THREE.Vector3(-60, 58, 75)), 1.2 / 60)
    camera.position.copy(camPos)
    camera.lookAt(car)
    camera.updateMatrixWorld()
    frame(scene, camera)
    if (i > 2) worst = Math.max(worst, blurMotion(camera, car, prevCar).blur.length() * 960)
    prevCar = car
  }
  expect(worst).toBeLessThan(0.01) // pixels (1920 wide)
})
