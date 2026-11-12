import { expect, test } from 'bun:test'
import { AIDriver } from '../src/ai/aiDriver'
import { CARS } from '../src/physics/spec'
import { makeInput, Vehicle } from '../src/physics/vehicle'
import { PhysicsWorld, PHYSICS_DT } from '../src/physics/world'
import { Track } from '../src/track/track'
import { TRACKS } from '../src/track/trackDef'

const track = new Track(TRACKS[0])

for (const spec of CARS) {
  test(`AI laps ${spec.name}`, () => {
    const world = new PhysicsWorld(track)
    const v = new Vehicle(spec)
    const s0 = -20
    const p = track.pointAt(s0, 0, { x: 0, y: 0, z: 0 })
    v.reset(p.x, p.z, track.headingAt(s0), track)
    const car = world.addCar('ai', v)
    const ai = new AIDriver(v, track, 1.0)
    const inp = makeInput()
    let laps: number[] = []
    let lastS = ai.s
    let lapStart = 0
    let t = 0
    let offTrack = 0
    let walls = 0
    let maxTemp = 0
    let resets = 0
    const origReset = ai.reset.bind(ai)
    ai.reset = () => { resets++; origReset() }
    const frame = 1 / 60
    while (t < 300 && laps.length < 3) {
      ai.drive(frame, inp, [], true)
      Object.assign(car.input, inp)
      const steps = Math.round(frame / PHYSICS_DT)
      for (let i = 0; i < steps; i++) {
        world.stepOnce(PHYSICS_DT)
      }
      t += frame
      const s = ai.s
      if (lastS > track.length - 200 && s < 200) {
        if (t - lapStart > 20) laps.push(t - lapStart)
        lapStart = t
      }
      lastS = s
      if (!v.onTrackSurface) offTrack += frame
      maxTemp = Math.max(maxTemp, ...v.wheels.map((w) => w.tyre.surfTemp))
    }
    walls = world.events.filter((e) => e.kind === 'wall').length
    const temps = v.wheels.map((w) => `${w.tyre.surfTemp.toFixed(0)}/${w.tyre.coreTemp.toFixed(0)}`).join(' ')
    console.log(`[${spec.name}] laps: ${laps.map((l) => l.toFixed(2)).join(', ')}  offtrack ${offTrack.toFixed(1)}s  wallHits ${walls} resets ${resets}  tyres(surf/core) ${temps} max ${maxTemp.toFixed(0)}  est ${track.lapTime(ai.profile).toFixed(1)}s`)
    expect(laps.length).toBeGreaterThanOrEqual(2)
    expect(resets).toBe(0)
    if (spec.id === 'vanta-gt3') {
      // the race car at the limit: flying laps within 3 % of its own speed profile's estimate (the
      // minimum-curvature line's 150-230 km/h corners and S-bends cost the follower more than the old
      // inside line's slow corners did) and under 89 s (95.5 s on the old line), repeatable to 0.3 s,
      // never off the track or into a wall
      const est = track.lapTime(ai.profile)
      expect(laps[2]).toBeLessThan(est * 1.03)
      expect(laps[2]).toBeLessThan(89)
      expect(Math.abs(laps[2] - laps[1])).toBeLessThan(0.3)
      expect(offTrack).toBe(0)
      expect(walls).toBe(0)
    }
  }, 120000)
}
