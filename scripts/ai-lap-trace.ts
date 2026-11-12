// AI driving audit: one car alone, N laps. Per corner: entry/min speed vs the speed profile, time lost,
// body slip, steering saturation, exit throttle.  bun scripts/ai-lap-trace.ts [laps] [skill] [carId]
import { AIDriver } from '../src/ai/aiDriver'
import { CARS, getCar } from '../src/physics/spec'
import { makeInput, Vehicle } from '../src/physics/vehicle'
import { PhysicsWorld, PHYSICS_DT } from '../src/physics/world'
import { Track } from '../src/track/track'
import { TRACKS } from '../src/track/trackDef'

const laps = +(process.argv[2] ?? 3)
const skill = +(process.argv[3] ?? 1)
const spec = process.argv[4] ? getCar(process.argv[4]) : CARS[0]
const DEG = Math.PI / 180
const f = (x: number, d = 2) => x.toFixed(d)
const track = new Track(TRACKS[0])
const world = new PhysicsWorld(track)
const v = new Vehicle(spec)
const p0 = track.pointAt(-20, 0, { x: 0, y: 0, z: 0 })
v.reset(p0.x, p0.z, track.headingAt(-20), track)
const car = world.addCar('ai', v)
const ai = new AIDriver(v, track, skill)
const inp = makeInput()
const n = track.n
const ds = track.length / n
// corners = local minima of the profile below 0.93 of the neighbourhood max
const corners: number[] = []
for (let i = 0; i < n; i++) {
  let isMin = true
  for (let k = -60; k <= 60 && isMin; k++) if (ai.profile[(i + k + n) % n] < ai.profile[i] || (k < 0 && ai.profile[(i + k + n) % n] === ai.profile[i])) isMin = false
  if (isMin && ai.profile[i] < 0.93 * Math.max(ai.profile[(i - 120 + n) % n], ai.profile[(i + 120) % n])) corners.push(i)
}
let est = 0
for (let i = 0; i < n; i++) est += ds / Math.max(ai.profile[i], 1)
type C = { minV: number; maxBeta: number; sat: number; tLost: number; thrExit: number; exitN: number; walls: number; off: number }
const mk = (): C => ({ minV: 1e9, maxBeta: 0, sat: 0, tLost: 0, thrExit: 0, exitN: 0, walls: 0, off: 0 })
const lapTimes: number[] = []
const phase = [0, 0, 0]
const accS = [0, 0]
let prevV = 0
let stats = corners.map(mk)
const all: C[][] = []
let t = 0, lapStart = 0, lastS = ai.s, maxBeta = 0, lastIdx = track.idx(ai.s), started = false
let wallsSeen = 0
const steps = 1 / 60
const costs: number[] = []
while (lapTimes.length < laps && t < laps * 140 + 30) {
  const c0 = performance.now()
  ai.drive(steps, inp, [], true)
  costs.push(performance.now() - c0)
  Object.assign(car.input, inp)
  for (let i = 0; i < 10; i++) world.stepOnce(PHYSICS_DT)
  t += steps
  const i = track.idx(ai.s)
  // segment ownership: nearest corner (by index) within +-150 samples
  let ci = -1, best = 1e9
  for (let k = 0; k < corners.length; k++) {
    let d = i - corners[k]
    if (d > n / 2) d -= n
    if (d < -n / 2) d += n
    if (Math.abs(d) < best) { best = Math.abs(d); ci = k }
  }
  if (started && inp.throttle > 0.99 && Math.abs(v.accelLat) < 0.2 && v.speed > 40 && v.shiftTimer <= 0) {
    const m = v.totalMass
    const pk = Math.max(...v.spec.engine.torque.map(([r, q]) => (q * r * Math.PI) / 30)) / m
    accS[0] += (v.speed - prevV) / steps + (0.6 * v.cdA * v.speed * v.speed) / m
    accS[1] += pk / v.speed
  }
  prevV = v.speed
  const vf = v.vel.x * v.fwd.x + v.vel.z * v.fwd.z
  const vl = v.vel.x * v.left.x + v.vel.z * v.left.z
  const beta = vf > 5 ? Math.abs(Math.atan2(vl, vf)) / DEG : 0
  if (started && beta > 12 && maxBeta <= 12) console.log(`first slide > 12 deg at s ${f(ai.s, 0)} t ${f(t - lapStart, 1)} v ${f(v.speed * 3.6, 0)} thr ${f(inp.throttle)} brk ${f(inp.brake)} gear ${v.gear}`)
  if (started) {
    maxBeta = Math.max(maxBeta, beta)
    const c = stats[ci]
    let d = i - corners[ci]
    if (d > n / 2) d -= n
    if (d < -n / 2) d += n
    if (Math.abs(d) < 15) c.minV = Math.min(c.minV, v.speed)
    c.maxBeta = Math.max(c.maxBeta, beta)
    if (Math.abs(inp.steer) > 0.97) c.sat += steps
    // time lost: dt - distance covered / profile speed
    let adv = i - lastIdx
    if (adv < -n / 2) adv += n
    if (adv > 0) {
      let tp = 0
      for (let k = 1; k <= adv; k++) tp += ds / Math.max(ai.profile[(lastIdx + k) % n], 1)
      c.tLost += steps - tp
      phase[inp.brake > 0 ? 0 : inp.throttle > 0.95 ? 2 : 1] += steps - tp
    } else {
      c.tLost += steps
      phase[inp.brake > 0 ? 0 : inp.throttle > 0.95 ? 2 : 1] += steps
    }
    if (d > 10 && d < 120) { c.thrExit += inp.throttle; c.exitN++ }
    if (Math.abs(ai.d) > track.hw[i] + 0.3) c.off += steps
  }
  const W = process.env.DETAIL ? process.env.DETAIL.split(':').map(Number) : null
  if (W && started && ai.s > W[0] && ai.s < W[1] && Math.round(t * 60) % 6 === 0)
    console.log(`s ${f(ai.s, 0)} v ${f(v.speed * 3.6, 0)} vp ${f(ai.profile[i] * 3.6, 0)} thr ${f(inp.throttle)} brk ${f(inp.brake)} st ${f(inp.steer)} beta ${f(beta, 1)} aF ${f(v.wheels[0].tyre.slipAngle / DEG, 1)}/${f(v.wheels[1].tyre.slipAngle / DEG, 1)} aR ${f(v.wheels[2].tyre.slipAngle / DEG, 1)}/${f(v.wheels[3].tyre.slipAngle / DEG, 1)} cR ${f(Math.max(v.wheels[2].tyre.combinedSlip, v.wheels[3].tyre.combinedSlip))} srR ${f(v.wheels[2].tyre.slipRatio)} d ${f(ai.d, 1)} line ${f(track.racing[i], 1)} hw ${f(track.hw[i], 1)} g ${v.gear} ay ${f(v.accelLat)}`)
  lastIdx = i
  const w = world.events.filter((e) => e.kind === 'wall').length
  if (w > wallsSeen && started) stats[ci].walls += w - wallsSeen
  wallsSeen = w
  if (lastS > track.length - 200 && ai.s < 200) {
    if (started) { lapTimes.push(t - lapStart); all.push(stats); stats = corners.map(mk) }
    started = true
    lapStart = t
  }
  lastS = ai.s
}
console.log(`${spec.name} skill ${skill}  profile estimate ${f(est)} s  corners ${corners.length}`)
console.log('corner   s     vProf  vMin(lap1..)  tLost(s)  beta  sat(s)  exitThr  off(s) walls')
for (let k = 0; k < corners.length; k++) {
  const i = corners[k]
  const row = all.map((st) => st[k])
  console.log(`C${String(k + 1).padStart(2)} ${f(i * ds, 0).padStart(5)}  ${f(ai.profile[i] * 3.6, 0).padStart(5)}  ${row.map((r) => f(r.minV * 3.6, 0)).join('/').padEnd(12)}  ${row.map((r) => f(r.tLost)).join('/').padEnd(15)} ${f(Math.max(...row.map((r) => r.maxBeta)), 1).padStart(5)}  ${f(Math.max(...row.map((r) => r.sat)), 2)}  ${f(row[0].thrExit / Math.max(row[0].exitN, 1))}   ${f(Math.max(...row.map((r) => r.off)), 2)}  ${row.reduce((a, r) => a + r.walls, 0)}`)
}
console.log(`time lost by phase (all laps): braking ${f(phase[0])} s  partial throttle ${f(phase[1])} s  full throttle ${f(phase[2])} s`)
console.log(`full-throttle straight-line acceleration / (peak power / v): ${f(accS[0] / accS[1], 3)}`)
costs.sort((a, b) => a - b)
console.log(`laps ${lapTimes.map((x) => f(x, 3)).join(', ')}  vs est ${f(est)} (${f((lapTimes[lapTimes.length - 1] / est - 1) * 100, 1)} %)  spread (flying laps) ${f(Math.max(...lapTimes.slice(1)) - Math.min(...lapTimes.slice(1)), 3)}  max body slip ${f(maxBeta, 1)} deg  AI cost median ${f(costs[costs.length >> 1] * 1000, 1)} us`)
