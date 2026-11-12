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
