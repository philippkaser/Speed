// The player's driving cameras (DriveCamera in src/render/CameraRig.tsx), headlessly: springs that
// move the same at any frame rate, cuts, the shake kept off the camera's path (motion blur), the
// field of view at speed, and the jitter scripts/feel/camera.ts measures against the old camera.
import { expect, test } from 'bun:test'
import * as THREE from 'three/webgpu'
import { DriveCamera, makeDriveCarState, Spring } from '../src/render/CameraRig'
import { current, kerbRun, lapRun, legacy } from '../scripts/feel/camera'

test('springs: the same motion at 30, 60 and 144 fps, ramps followed without lag', () => {
  const at = (fps: number) => {
    const s = new Spring()
    for (let i = 0; i < 0.5 * fps; i++) s.step(1, 6, 1 / fps)
    return s.x
  }
  expect(Math.abs(at(30) - at(144))).toBeLessThan(1e-9)
  expect(Math.abs(at(60) - at(144))).toBeLessThan(1e-9)
  // critically damped: never past the target
  const s = new Spring()
  for (let i = 0; i < 600; i++) expect(s.step(1, 9, 1 / 60)).toBeLessThanOrEqual(1 + 1e-12)
  // a target moving at a steady 2 m/s, with its speed fed forward: no lag once settled
  const r = new Spring()
  for (let i = 1; i <= 240; i++) r.step(2 * (i / 60), 4, 1 / 60, 2)
  expect(Math.abs(r.x - 8)).toBeLessThan(1e-6)
})

function car(speed: number, kerb = 0) {
  const c = makeDriveCarState()
  c.vel.set(0, 0, speed)
  c.speed = speed
  c.kerb = kerb
  return c
}

test('a new view is a cut; the shake moves the camera but stays off its path and never rotates it', () => {
  const cam = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 12000)
  const d = new DriveCamera()
  const c = car(40, 1)
  const opts = { mode: 'chase' as const, fov: 58, shake: 1, lookBack: false, side: 0 }
  expect(d.update(cam, c, 1 / 60, opts).cut).toBe(true)
  let shaken = 0
  for (let i = 0; i < 60; i++) {
    c.pos.z += 40 / 60
    const r = d.update(cam, c, 1 / 60, opts)
    expect(r.cut).toBe(false)
    shaken = Math.max(shaken, cam.position.distanceTo(d.pathPos))
    // the view direction is the path's: the aim is fixed by the car, the shake only translates
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion)
    expect(f.z).toBeGreaterThan(0.95)
  }
  expect(shaken).toBeGreaterThan(1e-4)
  expect(shaken).toBeLessThan(0.01)
  expect(d.update(cam, c, 1 / 60, { ...opts, mode: 'cockpit' }).cut).toBe(true)
  expect(d.update(cam, c, 1 / 60, { ...opts, mode: 'cockpit', lookBack: true }).cut).toBe(true)
})

test('the field of view opens only a little with speed', () => {
  const cam = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 12000)
  const d = new DriveCamera()
  const c = car(300 / 3.6)
  for (let i = 0; i < 300; i++) {
    c.pos.z += c.speed / 60
    d.update(cam, c, 1 / 60, { mode: 'chase', fov: 58, shake: 0, lookBack: false, side: 0 })
  }
  expect(cam.fov).toBeGreaterThan(60)
  expect(cam.fov).toBeLessThan(63)
})

test('chase camera on the circuit: steadier than the old one, the car kept still on screen', () => {
  const now = lapRun(current(), 'chase', 60, 20)
  const old = lapRun(legacy(), 'chase', 60, 20)
  expect(now['frame bob mm']).toBeLessThan(old['frame bob mm'] * 0.5)
  expect(now['car jitter px']).toBeLessThan(old['car jitter px'] * 1.1)
  expect(now['frame jitter deg']).toBeLessThan(old['frame jitter deg'] * 1.1)
  expect(now['max fov deg']).toBeLessThan(63)
  // the same at uneven frame times
  const uneven = lapRun(current(), 'chase', 60, 20, 0.35)
  expect(uneven['car jitter px']).toBeLessThan(now['car jitter px'] * 1.5 + 0.02)
  // a kerb strike: the frame does not jolt
  const kn = kerbRun(current(), 'chase'),
    ko = kerbRun(legacy(), 'chase')
  expect(kn['frame bob mm']).toBeLessThan(ko['frame bob mm'] * 0.5)
  expect(kn['car jitter px']).toBeLessThan(0.25)
})
