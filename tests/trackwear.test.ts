import { expect, test } from 'bun:test'
import { makeSample } from '../src/physics/ground'
import { RUBBER_CELL, RUBBER_COLS, RUBBER_HALF, RUBBER_ROW, RUBBER_START, Track } from '../src/track/track'
import { TRACKS } from '../src/track/trackDef'

const track = new Track(TRACKS[0])
const cell = (s: number, d: number) => Math.floor(s / RUBBER_ROW) * RUBBER_COLS + Math.floor((d + RUBBER_HALF) / RUBBER_CELL)
const onLine = (i: number) => {
  // the most rubbered cell across the track at sample i
  let best = 0
  for (let d = -6; d <= 6; d += RUBBER_CELL) best = Math.max(best, track.rubber[cell(i, d)])
  return best
}

test('a session starts with the rubber where the tyres work: braking zones and corners, not the straights', () => {
  track.resetRubber(RUBBER_START)
  const brake: number[] = [],
    straight: number[] = []
  for (let i = 0; i < track.n; i += 2) {
    if (track.brakeZone[i] > 0.6) brake.push(onLine(i))
    else if (Math.abs(track.racingCurv[i]) < 1 / 2000 && track.brakeZone[i] < 0.02 && track.speed[i] > 60) straight.push(onLine(i))
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  console.log(`seeded line: braking zones ${mean(brake).toFixed(2)}, straights ${mean(straight).toFixed(2)}`)
  expect(brake.length).toBeGreaterThan(20)
  expect(straight.length).toBeGreaterThan(20)
  expect(mean(brake)).toBeGreaterThan(mean(straight) + 0.3)
})

test('tyres lay rubber where they slide, shed marbles to the outside of the corner and sweep them off the line', () => {
  track.resetRubber(RUBBER_START)
  const s = 2001,
    d = 0.3
  const ref = makeSample()
  ref.s = s
  ref.d = d
  const r0 = track.rubber[cell(s, d)]
  const outside = cell(s, d - 2) // a tyre turning left slides to the right (-d)
  const m0 = track.marbles[outside]
  // a field's worth of tyres cornering hard through the same metre: 40 kW for 0.05 s each
  for (let k = 0; k < 200; k++) for (let j = 0; j < 30; j++) track.layRubber(ref, 40000 / 600, -1, 0.9, 1 / 600)
  expect(track.rubber[cell(s, d)]).toBeGreaterThan(r0 + 0.2)
  expect(track.marbles[outside]).toBeGreaterThan(m0 + 0.3)
  // on the line itself the tyres sweep the marbles away
  expect(track.marbles[cell(s, d)]).toBeLessThan(0.05)
  // and the grip follows: more on the rubbered line, less on the marbles
  const grip = (dd: number) => track.gripAt(track.idx(s), s, dd)
  expect(grip(d)).toBeGreaterThan(1)
  expect(grip(d - 2)).toBeLessThan(grip(d) - 0.04)
  // cars driving over the marbles sweep them on: each tyre (0.05 s on the cell) a third, a few cars
  // most of them
  const sweep = makeSample()
  sweep.s = s
  sweep.d = d - 2
  const before = track.marbles[outside]
  const pass = () => {
    for (let j = 0; j < 30; j++) track.layRubber(sweep, 0, 1, 0, 1 / 600)
  }
  pass()
  expect(track.marbles[outside]).toBeLessThan(before * 0.75)
  for (let k = 0; k < 7; k++) pass()
  expect(track.marbles[outside]).toBeLessThan(before * 0.1)
  track.resetRubber(RUBBER_START)
})
