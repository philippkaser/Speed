// Lane lines (two cars side by side) and the attack's commit test.
import { expect, test } from 'bun:test'
import { AIDriver } from '../src/ai/aiDriver'
import { CARS } from '../src/physics/spec'
import { Vehicle } from '../src/physics/vehicle'
import { LANE_SEP, Track } from '../src/track/track'
import { TRACKS } from '../src/track/trackDef'

const track = new Track(TRACKS[0])
const ai = new AIDriver(new Vehicle(CARS[0]), track, 1)

test('lane lines stay inside the usable width and >= 2.4 m apart where two lanes exist', () => {
  let two = 0
  for (let i = 0; i < track.n; i++) {
    for (const a of [track.laneL[i], track.laneR[i]]) {
      expect(a).toBeGreaterThanOrEqual(track.lineLo[i] - 1e-3)
      expect(a).toBeLessThanOrEqual(track.lineHi[i] + 1e-3)
    }
    if (track.laneTwo[i]) {
      two++
      expect(track.laneL[i] - track.laneR[i]).toBeGreaterThanOrEqual(2.4)
    }
  }
  expect(two / track.n).toBeGreaterThan(0.9)
  expect(LANE_SEP).toBeGreaterThanOrEqual(2.4)
  // each lane has its own, slower plan, within a few seconds of the ideal line's
  const ideal = track.lapTime(ai.profile)
  for (const p of [ai.profL, ai.profR]) {
    expect(track.lapTime(p)).toBeGreaterThan(ideal)
    expect(track.lapTime(p)).toBeLessThan(ideal + 6)
  }
})

test('an attacker never commits to a lane whose plan it cannot meet', () => {
  // the hardest braking zone: the sample where the lane plan drops most over the next 150 m
  let best = 0, at = 0
  for (let i = 0; i < track.n; i += 5) {
    const drop = ai.profL[i] - ai.profL[track.idx(i * (track.length / track.n) + 150)]
    if (drop > best) { best = drop; at = i }
  }
  const before = track.idx(at * (track.length / track.n) + 100)
  // well under the plan it can be met; at the braking point's speed 100 m later, with the braking
  // margin, it cannot (the commit happens before the braking zone)
  expect(ai.canMeet(ai.profL, at, ai.profL[at] * 0.6)).toBe(true)
  expect(ai.canMeet(ai.profL, before, ai.profL[at])).toBe(false)
})

// A clearly faster car (about 1 s a lap) behind a slower one: it closes in the slipstream on a straight,
// pulls out for the inside of a braking zone, out-brakes it and is given the corner. Whether the first
// attempt works is decided by centimetres (one side-by-side corner that does not come off costs ~10 m),
// so one starting gap says little: started 25 m apart the pass came at 110 s with one build and at
// 228 s with a slightly different brake controller, and from other gaps the same build never got by.
// Three starting gaps, about three and a half laps each: the fast car must attack every time, never
// touch, and get by in at least two.
// OB_F / OB_S set the two skills, OB_DEBUG=1 traces the pair (OB_EVERY: frames between lines).
test('a faster car behind a slower one attacks and gets by within a few laps, without contact', async () => {
  const { PhysicsWorld, PHYSICS_DT } = await import('../src/physics/world')
  const { makeInput } = await import('../src/physics/vehicle')
  const duel = (gap: number) => {
    const world = new PhysicsWorld(track)
    const mk = (id: string, s0: number, skill: number) => {
      const v = new Vehicle(CARS[0])
      const p = track.pointAt(s0, track.racing[track.idx(s0)], { x: 0, y: 0, z: 0 })
      v.reset(p.x, p.z, track.headingAt(s0), track)
      const sim = world.addCar(id, v)
      const d = new AIDriver(v, track, skill)
      d.id = id
      d.attack = 1
      return { d, sim, inp: makeInput(), laps: 0, last: s0 }
    }
    // slower car ahead (6 % down on the corners and the brakes)
    const cars = [mk('fast', -40, +(process.env.OB_F ?? 0.98)), mk('slow', -40 + gap, +(process.env.OB_S ?? 0.94))]
    const traffic = cars.map((c) => ({ s: 0, d: 0, speed: 0, id: c.d.id }))
    const prog = (c: (typeof cars)[0]) => c.laps * track.length + c.d.s
    let t = 0, passedAt = -1, attacked = false, contacts = 0, seen = 0
    while (t < 320) {
      cars.forEach((c, k) => Object.assign(traffic[k], { s: c.d.s, d: c.d.d, speed: c.d.vehicle.speed }))
      for (const c of cars) {
        c.d.drive(1 / 60, c.inp, traffic, true)
        Object.assign(c.sim.input, c.inp)
      }
      for (let i = 0; i < Math.round(1 / 60 / PHYSICS_DT); i++) world.stepOnce(PHYSICS_DT)
      world.updateWakes(1 / 60) // the slipstream (world.update does this in the game)
      t += 1 / 60
      for (const c of cars) {
        if (c.last > track.length - 200 && c.d.s < 200) c.laps++
        c.last = c.d.s
      }
      for (; seen < world.events.length; seen++) if (world.events[seen].kind === 'car') contacts++
      if (cars[0].d.attackId === 'slow') attacked = true
      if (process.env.OB_DEBUG && Math.round(t * 60) % +(process.env.OB_EVERY ?? 60) === 0) console.log(t.toFixed(0), (prog(cars[1]) - prog(cars[0])).toFixed(1), cars[0].d.s.toFixed(0), "m" + cars[0].d.mode, "g" + cars[0].d.gate, "w" + cars[0].d.w.toFixed(2), "l" + cars[0].d.lane, cars[0].d.held ? "H" : "", (cars[0].d.vehicle.speed * 3.6).toFixed(0), (cars[1].d.vehicle.speed * 3.6).toFixed(0), "slow m" + cars[1].d.mode + " w" + cars[1].d.w.toFixed(2), cars[0].d.yieldId ? "fast yields" : "", cars[1].d.yieldId ? "slow yields" : "")
      if (passedAt < 0 && t > 5 && prog(cars[0]) > prog(cars[1]) + 10) passedAt = t
      if (passedAt > 0 && t > passedAt + 10) break
    }
    console.log(`[out-brake] ${gap} m apart: attacked ${attacked}, passed at ${passedAt.toFixed(1)} s, contacts ${contacts}`)
    return { attacked, passedAt, contacts }
  }
  const runs = [18, 25, 40].map(duel)
  for (const r of runs) {
    expect(r.attacked).toBe(true)
    expect(r.contacts).toBe(0)
  }
  expect(runs.filter((r) => r.passedAt > 0).length).toBeGreaterThanOrEqual(2)
}, 120_000)
