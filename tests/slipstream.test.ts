// Slipstream and dirty air: a car close behind another, on its line, has less drag and less
// front downforce; off its line, or ahead of it, nothing changes.
import { expect, test } from 'bun:test'
import { FlatGround } from '../src/physics/ground'
import { V3 } from '../src/physics/math'
import { CARS } from '../src/physics/spec'
import { Vehicle } from '../src/physics/vehicle'
import { PhysicsWorld, PHYSICS_DT } from '../src/physics/world'

function run(gap: number, lat = 0, seconds = 10) {
  const g = new FlatGround()
  const world = new PhysicsWorld(g)
  const v = new Vehicle(CARS[0])
  Object.assign(v.assists, { abs: true, tc: 3, steering: 0, autoGear: true, stability: false })
  v.reset(0, 0, 0, g)
  const car = world.addCar('a', v)
  car.input.throttle = 1
  const body = { id: 'lead', pos: new V3(), vel: new V3(), fwd: new V3(), halfLength: 2.3, halfWidth: 1, active: gap !== 0 }
  world.kinematics.push(body)
  const t = new V3()
  for (let i = 0; i < seconds / PHYSICS_DT; i++) {
    body.fwd.copy(v.fwd)
    body.pos.copy(v.pos).add(t.copy(v.fwd).scale(gap + 4.6)).add(t.set(v.fwd.z, 0, -v.fwd.x).scale(lat))
    body.vel.copy(v.vel)
    world.updateWakes(PHYSICS_DT)
    world.stepOnce(PHYSICS_DT)
  }
  return { speed: v.speed, drag: car.dragCut, wash: car.frontWash }
}

test('slipstream: less drag and front downforce close behind, fading with distance, nothing off line or ahead', () => {
  const free = run(0)
  const at10 = run(10),
    at40 = run(40)
  expect(at10.drag).toBeGreaterThan(0.18)
  expect(at10.drag).toBeLessThan(0.32)
  expect(at40.drag).toBeGreaterThan(0.05)
  expect(at40.drag).toBeLessThan(at10.drag)
  expect(at10.wash).toBeGreaterThan(0.04)
  expect(at40.wash).toBeLessThan(0.02)
  expect(at10.speed - free.speed).toBeGreaterThan(2 / 3.6)
  // a car width and a half to the side: out of the wake
  expect(run(10, 3.5).drag).toBe(0)
  // the other car behind us: no tow
  expect(run(-20).drag).toBe(0)
  // deterministic
  expect(run(10)).toEqual(at10)
}, 60_000)
