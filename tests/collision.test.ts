import { expect, test } from 'bun:test'
import { makeSample } from '../src/physics/ground'
import { CARS } from '../src/physics/spec'
import { Vehicle } from '../src/physics/vehicle'
import { PhysicsWorld, PHYSICS_DT } from '../src/physics/world'
import { Track } from '../src/track/track'
import { TRACKS } from '../src/track/trackDef'

const track = new Track(TRACKS[0])

test('high-speed barrier impact stays contained and finite', () => {
  const world = new PhysicsWorld(track)
  const v = new Vehicle(CARS[0])
  // on the main straight, aimed 30 degrees towards the left barrier
  const s = 200
  const p = track.pointAt(s, 0, { x: 0, y: 0, z: 0 })
  v.reset(p.x, p.z, track.headingAt(s) + 0.52, track)
  v.setVelocityForward(60)
  world.addCar('crash', v)
  const sm = makeSample()
  let maxOut = -Infinity
  for (let i = 0; i < 600 * 4; i++) {
    world.stepOnce(PHYSICS_DT)
    track.sample(v.pos.x, v.pos.z, sm)
    maxOut = Math.max(maxOut, sm.d - sm.wallLeft)
    expect(v.isFinite()).toBe(true)
  }
  const hits = world.events.filter((e) => e.kind === 'wall')
  console.log(`barrier impact: ${hits.length} contacts, max penetration ${maxOut.toFixed(2)} m, final speed ${(v.speed * 3.6).toFixed(0)} km/h`)
  expect(hits.length).toBeGreaterThan(0)
  // the CoG never ends up beyond the barrier line
  expect(maxOut).toBeLessThan(0.2)
  expect(v.speed).toBeLessThan(60)
})

test('car-to-car contact pushes cars apart without blow-ups', () => {
  const world = new PhysicsWorld(track)
  const a = new Vehicle(CARS[0])
  const b = new Vehicle(CARS[1])
  const s = 150
  const pa = track.pointAt(s, 0, { x: 0, y: 0, z: 0 })
  const pb = track.pointAt(s + 12, 0.6, { x: 0, y: 0, z: 0 })
  a.reset(pa.x, pa.z, track.headingAt(s), track)
  b.reset(pb.x, pb.z, track.headingAt(s), track)
  a.setVelocityForward(40)
  b.setVelocityForward(15)
  world.addCar('a', a)
  world.addCar('b', b)
  for (let i = 0; i < 600 * 2; i++) world.stepOnce(PHYSICS_DT)
  const gap = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)
  const carHits = world.events.filter((e) => e.kind === 'car').length
  console.log(`rear-end: ${carHits} contacts, final gap ${gap.toFixed(2)} m, speeds ${(a.speed * 3.6).toFixed(0)}/${(b.speed * 3.6).toFixed(0)} km/h`)
  expect(carHits).toBeGreaterThan(0)
  expect(a.isFinite() && b.isFinite()).toBe(true)
  expect(gap).toBeGreaterThan(2.0) // not interpenetrating
  expect(b.speed).toBeGreaterThan(15 / 3.6 * 0.5)
})
