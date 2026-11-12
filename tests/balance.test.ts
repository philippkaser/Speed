// GT3 balance ladder: runs the physics audit harness (scripts/physics-audit.ts --quick, ~5 s, headless)
// and checks the steady-state lateral grip, understeer gradient and limit steering on four radii, and
// that 200 km/h lift-off, trail-brake and lane change do not spin the car.
import { expect, test } from 'bun:test'

const out = Bun.spawnSync(['bun', 'scripts/physics-audit.ts', 'vanta-gt3', '--quick'], { cwd: `${import.meta.dir}/..` }).stdout.toString()
const line = (start: string) => out.split('\n').find((l) => l.startsWith(start)) ?? ''
const circle = (R: number) => {
  const m = line(`R=${R} m max lateral`).match(/([\d.]+) g @ ([\d.]+) km\/h, delta@98% ([-\d.]+) deg \(L\/R [\d.]+\), K ([-\d.]+) deg\/g/)
  if (!m) throw new Error(`no audit row for R=${R}:\n${out}`)
  return { g: +m[1], kmh: +m[2], steer: +m[3], K: +m[4], geo: (Math.atan(2.72 / R) * 180) / Math.PI }
}

test('lateral g ladder: downforce adds grip with speed', () => {
  const ladder = [
    [18, 1.5],
    [57, 1.58],
    [126, 1.7],
    [250, 2.05],
  ] as const
  for (const [R, g] of ladder) expect(circle(R).g).toBeGreaterThan(g)
  expect(circle(250).g).toBeGreaterThan(circle(126).g + 0.2)
})

test('mild understeer from 60 to 250 km/h, a few degrees of lock at the limit', () => {
  for (const R of [18, 57, 126, 250]) {
    const c = circle(R)
    expect(c.K).toBeGreaterThan(-0.1)
    expect(c.K).toBeLessThan(1.2)
    // steering where 98 % of the limit is held, against the geometric angle L/R (the 250 m circle
    // gets 3x: at 0.6 deg geometric the tyres' own slip difference dominates)
    if (R > 18) expect(c.steer).toBeLessThan(c.geo * (R === 250 ? 3 : 2.6))
  }
})

test('200 km/h lift-off, trail brake and lane change do not snap', () => {
  for (const row of ['lift-off R=250 m @ 200 km/h', 'trail brake R=250 m @ 200 km/h']) {
    const l = line(row)
    expect(l).toContain('spun false')
    expect(+(l.match(/r\/r0\s+([-\d.]+) deg/)?.[1] ?? NaN)).toBeLessThan(3)
  }
  const lc = line('lane change 200 km/h')
  expect(lc).toContain('spun false')
  expect(+(lc.match(/beta max ([\d.]+) deg/)?.[1] ?? NaN)).toBeLessThan(2.5)
}, 30000)
