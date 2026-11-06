// Drive feel with keyboard and pad through the game's input pipeline and the default assists
// (scripts/feel/probe.ts; `bun scripts/feel-probe.ts` prints the full table). The bounds sit just
// outside what the tuned input filters and steering assist give, and well inside what they gave
// before: a keyboard lane change at 120 km/h swung the car 15 m sideways and 7 degrees off line,
// a caught slide spun the other way, the pad's step steer overshot its yaw by 20 %.
import { expect, test } from 'bun:test'
import { braking, fullLock, hairpin, laneChange, powerExit, ramp, slideRecovery, stepSteer, sweeperKeyboard, tap } from '../scripts/feel/probe'

test('pad: quick, well damped yaw response in the linear range', () => {
  const m = stepSteer('pad').metrics
  expect(m['yaw t90 ms']).toBeLessThan(250)
  expect(m['yaw overshoot %']).toBeLessThan(10)
})

test('keyboard: a held key finds the limit without a yaw spike', () => {
  const m = stepSteer('keyboard').metrics
  expect(m['yaw t90 ms']).toBeLessThan(750)
  expect(m['yaw overshoot %']).toBeLessThan(25)
  expect(m['steady lat g']).toBeGreaterThan(1.6)
  expect(m.spin).toBe(0)
})

test('keyboard: a tap is a small correction that does not ring', () => {
  const m = tap().metrics
  expect(m['heading change deg']).toBeLessThan(1)
  expect(m['yaw rebound %']).toBeLessThan(12)
})

test('keyboard: a lane change at 120 km/h is a lane, and the car ends up straight', () => {
  const m = laneChange('keyboard').metrics
  expect(m['lateral m']).toBeGreaterThan(1.5)
  expect(m['lateral m']).toBeLessThan(7)
  expect(m['heading err deg']).toBeLessThan(3.5)
  expect(m['yaw flips']).toBe(0)
})

test('progressive limit: no cliff past the peak, the stick keeps resolution', () => {
  const m = ramp().metrics
  expect(m['stick at 90% g']).toBeGreaterThan(0.55)
  expect(m['g drop past peak %']).toBeLessThan(5)
  expect(m.spin).toBe(0)
})

test('full lock at 200 km/h keeps the front tyres near their peak and the car straight', () => {
  for (const d of ['keyboard', 'pad'] as const) {
    const m = fullLock(d).metrics
    expect(m['front slip deg']).toBeLessThan(9.5)
    expect(m['max beta deg']).toBeLessThan(8)
    expect(m.spin).toBe(0)
  }
})

test('trail braking into a hairpin and powering out do not spin', () => {
  for (const d of ['keyboard', 'pad'] as const) {
    expect(hairpin(d).metrics.spin).toBe(0)
    const e = powerExit(d).metrics
    expect(e.spin).toBe(0)
    expect(e['max beta deg']).toBeLessThan(10)
    expect(e['secondary slide deg']).toBeLessThan(6)
  }
})

test('a slide is caught with the keyboard and the pad, without a slide the other way', () => {
  const kb = slideRecovery('keyboard').metrics
  expect(kb.spin).toBe(0)
  expect(kb['frames to catch']).toBeLessThan(150)
  expect(kb['secondary slide deg']).toBeLessThan(6)
  const pad = slideRecovery('pad').metrics
  expect(pad.spin).toBe(0)
  expect(pad['frames to catch']).toBeLessThan(80)
  expect(pad['secondary slide deg']).toBeLessThan(4)
})

test('a fast sweeper can be held with the keyboard', () => {
  const m = sweeperKeyboard().metrics
  expect(m['yaw weave deg/s']).toBeLessThan(2.5)
  expect(m['taps per s']).toBeLessThan(4.5)
})

test('braking from 250 km/h is straight', () => {
  const m = braking().metrics
  expect(m['heading drift deg']).toBeLessThan(0.5)
  expect(m['distance m']).toBeLessThan(120)
})
