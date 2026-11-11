// Rigid-body invariants found by scripts/physics-audit.ts
import { expect, test } from 'bun:test'
import { FlatGround } from '../src/physics/ground'
import { V3 } from '../src/physics/math'
import { CARS } from '../src/physics/spec'
import { Vehicle } from '../src/physics/vehicle'
import { obbOverlap, PhysicsWorld, PHYSICS_DT } from '../src/physics/world'

const ground = new FlatGround()

test('the unsprung mass moves with the body horizontally (whole car mass across the strut axis)', () => {
  for (const spec of CARS) {
    const v = new Vehicle(spec)
    v.reset(0, 0, 0, ground)
    v.vel.set(0, 0, 0)
    v.w.set(0, 0, 0)
    v.applyImpulse(new V3(0, 0, 0), new V3(0, 0, 1000))
    // forward: total mass; vertical: sprung mass only (each corner has its own travel)
    expect(Math.abs(v.vel.z - 1000 / v.totalMass)).toBeLessThan(1e-3 * v.vel.z)
    v.vel.set(0, 0, 0)
    v.applyImpulse(new V3(0, 0, 0), new V3(0, 1000, 0))
    expect(Math.abs(v.vel.y - 1000 / v.mass)).toBeLessThan(2e-3 * v.vel.y)
  }
})

test('braking and cornering are limited by the whole car mass (no 10% bonus from unsprung mass)', () => {
  const world = new PhysicsWorld(ground)
  const v = new Vehicle(CARS[0])
  Object.assign(v.assists, { abs: true, tc: 0, steering: 0, autoGear: true })
  v.reset(0, 0, 0, ground)
  const car = world.addCar('a', v)
  v.setVelocityForward(100 / 3.6)
  v.gear = 3
  for (let i = 0; i < 180; i++) world.stepOnce(PHYSICS_DT)
  const z0 = v.pos.z,
    v0 = v.speed
  car.input.brake = 1
  for (let i = 0; i < 6000 && v.speed > 0.3; i++) world.stepOnce(PHYSICS_DT)
  const mean = (v0 * v0) / (2 * (v.pos.z - z0)) / 9.81
  console.log(`100-0: ${(v.pos.z - z0).toFixed(1)} m, mean ${mean.toFixed(2)} g`)
  // slicks at ~3-5 kN: mu ~1.6-1.75 with load transfer; 1.8 g at 100 km/h meant missing mass
  expect(mean).toBeLessThan(1.75)
  expect(mean).toBeGreaterThan(1.4)
})

test('a car at rest does not creep (rolling resistance holds a free wheel)', () => {
  for (const spec of CARS) {
    const world = new PhysicsWorld(ground)
    const v = new Vehicle(spec)
    v.reset(0, 0, 0, ground)
    world.addCar('a', v)
    for (let i = 0; i < 1800; i++) world.stepOnce(PHYSICS_DT)
    const x0 = v.pos.x,
      z0 = v.pos.z
    for (let i = 0; i < 6000; i++) world.stepOnce(PHYSICS_DT)
    const drift = Math.hypot(v.pos.x - x0, v.pos.z - z0) / 10
    console.log(`[${spec.name}] creep at rest: ${(drift * 1000).toFixed(4)} mm/s`)
    expect(drift).toBeLessThan(1e-4)
  }
})

test('a square rear-end tap pushes the car ahead without spinning either car or welding them', () => {
  const spec = CARS[0]
  const world = new PhysicsWorld(ground)
  const a = new Vehicle(spec),
    b = new Vehicle(spec)
  a.reset(0, 0, 0, ground)
  b.reset(0, spec.length + 0.6, 0, ground)
  a.setVelocityForward(25)
  b.setVelocityForward(20)
  const A = world.addCar('a', a),
    B = world.addCar('b', b)
  A.input.clutch = B.input.clutch = 1
  let overlapSteps = 0,
    maxYaw = 0
  for (let i = 0; i < 600; i++) {
    world.stepOnce(PHYSICS_DT)
    if (obbOverlap(a.pos.x, a.pos.z, a.fwd.x, a.fwd.z, spec.length / 2, spec.width / 2, b.pos.x, b.pos.z, b.fwd.x, b.fwd.z, spec.length / 2, spec.width / 2)) overlapSteps++
    maxYaw = Math.max(maxYaw, Math.abs(Math.atan2(a.fwd.x, a.fwd.z)), Math.abs(Math.atan2(b.fwd.x, b.fwd.z)))
  }
  console.log(`rear-end 5 m/s: overlap ${overlapSteps} steps, max yaw ${((maxYaw * 180) / Math.PI).toFixed(2)} deg, speeds ${a.speed.toFixed(1)}/${b.speed.toFixed(1)} m/s`)
  expect(world.events.some((e) => e.kind === 'car')).toBe(true)
  expect(overlapSteps).toBeLessThan(30)
  expect(maxYaw).toBeLessThan((1 * Math.PI) / 180)
  expect(b.speed).toBeGreaterThan(a.speed) // pushed ahead, separating
})

test('a full-throttle start slips the clutch at launch revs and is traction limited (no bog, no clutch drop)', () => {
  for (const spec of CARS) {
    const world = new PhysicsWorld(ground)
    const v = new Vehicle(spec)
    Object.assign(v.assists, { abs: true, tc: 3, steering: 0, autoGear: true })
    v.reset(0, 0, 0, ground)
    const car = world.addCar('a', v)
    car.input.throttle = 1
    let minEngage = 1,
      minRpm = 1e9
    for (let i = 0; i < 600; i++) {
      world.stepOnce(PHYSICS_DT)
      if (i > 300) {
        minEngage = Math.min(minEngage, v.clutchEngage)
        minRpm = Math.min(minRpm, v.rpm)
      }
    }
    const kmh = v.speed * 3.6
    console.log(`[${spec.name}] launch: ${kmh.toFixed(1)} km/h after 1 s, min clutch ${minEngage.toFixed(2)}, min rpm ${minRpm.toFixed(0)}`)
    // 0.5 g average over the first second was a bog at ~2000 rpm below the turbo's spool
    expect(kmh).toBeGreaterThan(spec.id === 'vanta-gt3' ? 28 : 18)
    expect(minEngage).toBeGreaterThan(0.3)
    expect(minRpm).toBeGreaterThan(spec.engine.idleRpm + 1500)
  }
})
