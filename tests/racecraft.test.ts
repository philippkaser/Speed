// Racecraft from the headless race audit (scripts/race-audit.ts): a 12-car team race from a
// standing start, seeded so it replays identically.
import { expect, test } from 'bun:test'
import { raceAudit } from '../scripts/race-audit'

test('a 3-lap 12-car race: few contacts, no hard rear-ends, nobody stuck, overtakes happen', () => {
  const a = raceAudit(3, { quiet: true, seed: 1000 })
  console.log(`[race] contacts ${a.contacts} (nose-to-tail ${a.rearEnds}, max closing ${(a.maxClosing * 3.6).toFixed(0)} km/h) offs ${a.offs} spins ${a.spins} stuck ${a.stuck} overtakes ${a.overtakes}/${a.cleanOvertakes} clean`)
  expect(a.contacts / (a.cars * a.laps)).toBeLessThan(0.3)
  expect(a.maxClosing).toBeLessThan(25 / 3.6)
  expect(a.stuck).toBeLessThanOrEqual(1)
  expect(a.overtakes).toBeGreaterThan(0)
}, 180000)

test('a slow, weaving, early-braking car mid-pack is passed, not rammed', () => {
  const a = raceAudit(3, { quiet: true, seed: 1001, slowPlayer: true })
  console.log(`[slow player] hit from behind ${a.slowHitFromBehind}x, max closing ${(a.slowMaxClosing * 3.6).toFixed(0)} km/h, contacts ${a.contacts}`)
  expect(a.slowMaxClosing).toBeLessThan(10 / 3.6)
  expect(a.slowHitFromBehind).toBeLessThanOrEqual(1)
  expect(a.stuck).toBeLessThanOrEqual(1)
}, 180000)

test('the same seed replays identically in one process (no state survives between races)', () => {
  const a = raceAudit(1, { quiet: true, seed: 1002 })
  const b = raceAudit(1, { quiet: true, seed: 1002 })
  expect(b).toEqual(a)
}, 120_000)
