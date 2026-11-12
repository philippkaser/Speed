// Vehicle-dynamics audit: drives the real 600 Hz simulation through standard manoeuvres with simple
// closed-loop drivers and prints measured vs reference values (GT3 references).
//   bun scripts/physics-audit.ts [carId] [--quick]
import { AIDriver } from '../src/ai/aiDriver'
import { FlatGround, Surface, type Ground, type GroundSample } from '../src/physics/ground'
import { obbOverlap } from '../src/physics/world'
import { CARS, getCar } from '../src/physics/spec'
import { RIBS, TyreModel } from '../src/physics/tyre'
import { makeInput, Vehicle } from '../src/physics/vehicle'
import { PhysicsWorld, PHYSICS_DT } from '../src/physics/world'
import { Track } from '../src/track/track'
import { TRACKS } from '../src/track/trackDef'

const args = process.argv.slice(2)
const quick = args.includes('--quick')
const spec = args[0] && !args[0].startsWith('--') ? getCar(args[0]) : CARS[0]
// AUDIT_SET="defaultSetup.arbF=60,aero.clAFront=1.3" overrides spec fields for what-if runs
for (const kv of (process.env.AUDIT_SET ?? '').split(',').filter(Boolean)) {
  const [path, val] = kv.split('=')
  const keys = path.split('.')
  let o: any = spec
  for (const k of keys.slice(0, -1)) o = o[k]
  o[keys[keys.length - 1]] = Number(val)
}
const DEG = Math.PI / 180
const G = 9.81
const rows: [string, string, string][] = []
const row = (name: string, val: string, ref: string) => {
  rows.push([name, val, ref])
  if (process.env.AUDIT_LIVE) console.log(name, val, ref)
}
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x))

/** flat ground with an optional wall at x = wallX (left side), a grade along z, and a kerb strip */
class TestGround implements Ground {
  constructor(
    public wallX = 1e9,
    public grade = 0,
    public kerb: { z0: number; z1: number; h: number } | null = null,
  ) {}
  h(x: number, z: number) {
    let y = z * this.grade
    const k = this.kerb
    if (k && z > k.z0 && z < k.z1) y += k.h * Math.sin((Math.PI * (z - k.z0)) / (k.z1 - k.z0))
    return y
  }
  heightNear(_r: GroundSample, x: number, z: number) {
    return this.h(x, z)
  }
  sample(x: number, z: number, o: GroundSample) {
    o.qx = x
    o.qz = z
    o.height = this.h(x, z)
    const k = this.kerb
    let dz = this.grade
    if (k && z > k.z0 && z < k.z1) dz += ((k.h * Math.PI) / (k.z1 - k.z0)) * Math.cos((Math.PI * (z - k.z0)) / (k.z1 - k.z0))
    const n = Math.hypot(1, dz)
    o.nx = 0
    o.ny = 1 / n
    o.nz = -dz / n
    o.surface = k && z > k.z0 && z < k.z1 ? Surface.Kerb : Surface.Asphalt
    o.s = z
    o.d = x
    o.wallLeft = this.wallX
    o.wallRight = 1e9
    o.lx = 1
    o.lz = 0
    o.grip = 1
  }
}

function warm(v: Vehicle) {
  for (const w of v.wheels) {
    w.tyre.surfTemp = w.tyre.coreTemp = w.model.compound.optTemp
    w.tyre.updatePressure()
  }
}
function setup(ground: Ground = new FlatGround(), assists: Partial<Vehicle['assists']> = {}, x = 0, z = 0, yaw = 0) {
  ceInt = 0
  const world = new PhysicsWorld(ground)
  const v = new Vehicle(spec)
  Object.assign(v.assists, { abs: true, tc: 0, steering: 0, autoGear: true, stability: false }, assists)
  v.reset(x, z, yaw, ground)
  warm(v)
  const car = world.addCar('a', v)
  return { world, v, car }
}
function run(world: PhysicsWorld, seconds: number, each?: (t: number) => boolean | void) {
  const n = Math.round(seconds / PHYSICS_DT)
  for (let i = 0; i < n; i++) {
    if (each && each(i * PHYSICS_DT)) return i * PHYSICS_DT
    world.stepOnce(PHYSICS_DT)
  }
  return seconds
}
const vf = (v: Vehicle) => v.vel.x * v.fwd.x + v.vel.z * v.fwd.z
const vl = (v: Vehicle) => v.vel.x * v.left.x + v.vel.z * v.left.z
const beta = (v: Vehicle) => Math.atan2(vl(v), Math.max(Math.abs(vf(v)), 1)) / DEG
const yawRate = (v: Vehicle) => v.w.x * v.up.x + v.w.y * v.up.y + v.w.z * v.up.z
const heading = (v: Vehicle) => Math.atan2(v.fwd.x, v.fwd.z)
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const roadSteer = (v: Vehicle) => (v.wheels[0].steer + v.wheels[1].steer) / 2

// ---------------------------------------------------------------- straight line
function acceleration(tc: number) {
  const { world, v, car } = setup(undefined, { tc })
  car.input.throttle = 1
  let t100 = -1,
    t200 = -1,
    vmax = 0
  run(world, quick ? 25 : 60, (t) => {
    const k = v.speed * 3.6
    if (t100 < 0 && k >= 100) t100 = t
    if (t200 < 0 && k >= 200) t200 = t
    vmax = Math.max(vmax, k)
  })
  return { t100, t200, vmax }
}
function braking(kmh: number) {
  const { world, v, car } = setup()
  v.setVelocityForward(kmh / 3.6)
  v.gear = kmh > 150 ? 5 : 3
  run(world, 0.3)
  const z0 = v.pos.z
  const v0 = v.speed
  car.input.brake = 1
  let peak = 0
  const t = run(world, 15, () => {
    peak = Math.max(peak, -v.accelLong)
    return v.speed < 0.3
  })
  const d = v.pos.z - z0
  return { d, peak, mean: (v0 * v0) / (2 * d) / G, t }
}

// ---------------------------------------------------------------- circle driver
/** follow a left-hand circle of radius R centred at the origin, starting at (-R,0) heading +z */
let ceInt = 0
function circleSteer(v: Vehicle, R: number) {
  const r = Math.hypot(v.pos.x, v.pos.z)
  const desired = Math.atan2(v.pos.z / r, -v.pos.x / r)
  const he = wrap(desired - heading(v))
  const ce = r - R
  const kin = Math.atan(spec.wheelbase / R)
  ceInt = Math.max(-20, Math.min(20, ceInt + ce * PHYSICS_DT))
  return { cmd: kin + he * 1.5 + ce * 0.12 + ceInt * 0.04, he, ce, r }
}
/** ramp speed on a constant radius; returns max sustained lateral g, the speed and the understeer gradient */
function pinTemps(v: Vehicle) {
  for (const w of v.wheels) {
    const T = w.model.compound.optTemp
    w.tyre.ribSurf.fill(T)
    w.tyre.ribBulk.fill(T)
    w.tyre.surfTemp = w.tyre.coreTemp = T
  }
}
/** pin = hold the tread at its optimum temperature (isolates mechanical + aero grip from thermals) */
function circle(R: number, startKmh: number, pin = true) {
  const { world, v, car } = setup(undefined, { tc: 2 })
  v.reset(-R, 0, 0, world.ground)
  warm(v)
  v.setVelocityForward(startKmh / 3.6)
  let target = startKmh / 3.6
  let best = 0,
    bestV = 0,
    bestSteer = 0,
    sustained = 0,
    latF = 0,
    steerF = 0
  const pts: [number, number][] = []
  const held: [number, number][] = []
  run(world, 90, (t) => {
    if (pin) pinTemps(v)
    const c = circleSteer(v, R)
    car.input.steer = -c.cmd / spec.steerLock
    target += 0.25 * PHYSICS_DT
    const err = target - v.speed
    car.input.throttle = Math.max(0, Math.min(1, 0.3 + err * 0.8))
    car.input.brake = err < -1 ? Math.min(1, -err * 0.2) : 0
    if (Math.abs(c.ce) < 3 && Math.abs(c.he) < 0.15) {
      const lat = (v.speed * v.speed) / c.r / G
      // the limit is the highest lateral g held for ~0.5 s (filtered), with the steering held there,
      // not the spike of the moment the car leaves the circle with the steering winding on
      latF += (lat - latF) * (PHYSICS_DT / 0.5)
      steerF += (roadSteer(v) - steerF) * (PHYSICS_DT / 0.5)
      sustained++
      if (sustained > 600) {
        if (latF > best) {
          best = latF
          bestV = v.speed
          bestSteer = steerF
        }
        if (sustained % 60 === 0) pts.push([lat, roadSteer(v) - Math.atan(spec.wheelbase / c.r)])
        if (sustained % 30 === 0) held.push([latF, steerF])
      }
    } else {
      sustained = 0
      latF = (v.speed * v.speed) / c.r / G
      steerF = roadSteer(v)
    }
    if (process.env.DIAG && Math.round(t * 600) % 1200 === 0)
      console.log(`t ${f(t, 0)} v ${f(v.speed * 3.6, 0)} lat ${f((v.speed * v.speed) / c.r / G)} ay ${f(v.accelLat)} DF ${f(v.downforce, 0)} bal ${f(v.aeroBalance)} drag ${f(v.dragForce, 0)} rh ${f(v.rideHeightF * 1000, 0)}/${f(v.rideHeightR * 1000, 0)} aF ${f(v.wheels[0].tyre.slipAngle / DEG, 1)}/${f(v.wheels[1].tyre.slipAngle / DEG, 1)} aR ${f(v.wheels[2].tyre.slipAngle / DEG, 1)}/${f(v.wheels[3].tyre.slipAngle / DEG, 1)} Fz ${v.wheels.map((w) => f(w.tyre.Fz, 0)).join('/')} d ${f(roadSteer(v) / DEG, 1)} ce ${f(c.ce, 1)} he ${f(c.he, 2)} thr ${f(car.input.throttle)} T ${f(v.wheels[1].tyre.surfTemp, 0)} lean ${v.wheels.map((w) => f(w.lean / DEG, 1)).join("/")} grip ${v.wheels.map((w) => f(w.tyre.gripFactor, 2)).join("/")} p ${f(v.wheels[1].tyre.pressure, 2)} rib ${Array.from(v.wheels[1].tyre.ribLoad).map((x) => f(x, 2)).join(",")} mu ${Array.from(v.wheels[1].tyre.ribMu).map((x) => f(x, 2)).join(",")} rT ${Array.from(v.wheels[1].tyre.ribSurf).map((x) => f(x, 0)).join(",")} opt ${f(v.wheels[1].model.optPressure, 2)} Fy ${v.wheels.map((w) => f(w.tyre.Fy, 0)).join("/")} Fx ${v.wheels.map((w) => f(w.tyre.Fx, 0)).join("/")} Mz ${v.wheels.map((w) => f(w.tyre.Mz, 0)).join("/")} beta ${f(Math.atan2(v.vel.x * v.left.x + v.vel.z * v.left.z, v.speed) / DEG, 2)}`)
    return Math.abs(c.ce) > 8
  })
  // understeer gradient: slope of (delta - L/R) vs ay over 30..80 % of the limit
  const sel = pts.filter((p) => p[0] > best * 0.3 && p[0] < best * 0.8)
  let K = NaN
  if (sel.length > 3) {
    const mx = sel.reduce((a, p) => a + p[0], 0) / sel.length
    const my = sel.reduce((a, p) => a + p[1], 0) / sel.length
    let sxy = 0,
      sxx = 0
    for (const p of sel) {
      sxy += (p[0] - mx) * (p[1] - my)
      sxx += (p[0] - mx) ** 2
    }
    K = sxy / sxx / DEG
  }
  // steering where the car first holds 98 % of its limit: past that point an understeering car only
  // buys the last per cent with a lot more lock, which says little about its balance
  const at98 = held.find((p) => p[0] >= best * 0.98)
  return { best, kmh: bestV * 3.6, steer: (at98 ? at98[1] : bestSteer) / DEG, K }
}

// ---------------------------------------------------------------- step steer
function stepSteer(kmh: number, deltaDeg: number) {
  const { world, v, car } = setup(undefined, { tc: 2 })
  v.setVelocityForward(kmh / 3.6)
  v.gear = 4
  const target = kmh / 3.6
  const trace: [number, number][] = []
  run(world, 4.5, (t) => {
    car.input.steer = t > 1 ? -(deltaDeg * DEG) / spec.steerLock : 0
    const err = target - vf(v)
    car.input.throttle = Math.max(0, Math.min(1, 0.35 + err * 0.5))
    if (t >= 1) trace.push([t - 1, yawRate(v)])
  })
  const ss = trace.slice(-300).reduce((a, p) => a + p[1], 0) / 300
  const t10 = trace.find((p) => p[1] >= 0.1 * ss)?.[0] ?? NaN
  const t90 = trace.find((p) => p[1] >= 0.9 * ss)?.[0] ?? NaN
  const peak = Math.max(...trace.map((p) => p[1]))
  let settle = 0
  for (const p of trace) if (Math.abs(p[1] - ss) > 0.05 * Math.abs(ss)) settle = p[0]
  return { rise: t90 - t10, t90, over: (peak / ss - 1) * 100, settle, ss: ss / DEG, ay: Math.abs(v.accelLat) }
}

// ---------------------------------------------------------------- lane change
/** one full sine period of steering at speed (a lane change and back), then straight ahead */
function laneChange(kmh: number, deltaDeg: number, period = 2.4) {
  const { world, v, car } = setup(undefined, { tc: 2 })
  v.setVelocityForward(kmh / 3.6)
  v.gear = 6
  let ay = 0,
    b = 0,
    rEnd = 0,
    spun = false
  run(world, 1 + period + 2, (t) => {
    const u = t - 1
    car.input.steer = u > 0 && u < period ? -(deltaDeg * DEG * Math.sin((2 * Math.PI * u) / period)) / spec.steerLock : 0
    const err = kmh / 3.6 - vf(v)
    car.input.throttle = Math.max(0, Math.min(1, 0.5 + err * 0.5))
    if (u > 0) {
      ay = Math.max(ay, Math.abs(v.accelLat))
      b = Math.max(b, Math.abs(beta(v)))
      if (Math.abs(beta(v)) > 30) spun = true
      if (u > period + 1.5) rEnd = Math.max(rEnd, Math.abs(yawRate(v)) / DEG)
    }
  })
  return { ay, beta: b, rEnd, spun }
}

// ---------------------------------------------------------------- transient in a corner
/** steady state on R at a fraction of the limit speed, then apply the event; report the yaw response */
/** drive = the driver keeps steering for the circle during the event (closed loop); otherwise the
 *  steering is frozen at its steady-state angle (open loop, the harsher test) */
function cornerEvent(R: number, kmh: number, ev: 'lift' | 'trail' | 'power', tc = 0, gear = 0, drive = false) {
  const { world, v, car } = setup(undefined, { tc: ev === 'power' ? tc : 2, autoGear: gear === 0 })
  v.reset(-R, 0, 0, world.ground)
  warm(v)
  v.setVelocityForward(kmh / 3.6)
  if (gear) v.gear = gear
  let steerHold = 0
  let r0 = 0,
    b0 = 0
  let maxB = 0,
    maxR = 0,
    minR = 1e9,
    spun = false
  let maxRearSlip = 0,
    tSpin = -1
  run(world, 9, (t) => {
    if (t < 6) {
      const c = circleSteer(v, R)
      car.input.steer = -c.cmd / spec.steerLock
      const err = kmh / 3.6 - v.speed
      car.input.throttle = Math.max(0, Math.min(1, 0.3 + err * 0.8))
      car.input.brake = 0
      steerHold = car.input.steer
      r0 = yawRate(v)
      b0 = beta(v)
      return
    }
    car.input.steer = drive ? -circleSteer(v, R).cmd / spec.steerLock : steerHold
    if (ev === 'lift') {
      car.input.throttle = 0
      car.input.brake = 0
    } else if (ev === 'trail') {
      car.input.throttle = 0
      car.input.brake = 0.35
    } else {
      car.input.throttle = 1
      car.input.brake = 0
    }
    if (process.env.DIAGEV === ev && Math.round(t * 600) % 60 === 0 && t < 7.5)
      console.log(`ev t ${f(t, 1)} v ${f(v.speed * 3.6, 0)} beta ${f(beta(v), 1)} r ${f(yawRate(v) / DEG, 1)} ay ${f(v.accelLat)} ax ${f(v.accelLong)} Fz ${v.wheels.map((w) => f(w.tyre.Fz, 0)).join('/')} sr ${v.wheels.map((w) => f(w.tyre.slipRatio, 2)).join('/')} a ${v.wheels.map((w) => f(w.tyre.slipAngle / DEG, 1)).join('/')} Fx ${v.wheels.map((w) => f(w.tyre.Fx, 0)).join('/')} gear ${v.gear} rh ${f(v.rideHeightF * 1000, 0)}/${f(v.rideHeightR * 1000, 0)} bal ${f(v.aeroBalance)}`)
    if (t < 8) {
      const r = yawRate(v) / r0
      maxR = Math.max(maxR, r)
      minR = Math.min(minR, r)
      maxB = Math.max(maxB, b0 - beta(v)) // left turn: oversteer drives beta negative
      if (tSpin < 0 && b0 - beta(v) > 10) tSpin = t - 6
      maxRearSlip = Math.max(maxRearSlip, Math.abs(v.wheels[2].tyre.slipRatio), Math.abs(v.wheels[3].tyre.slipRatio))
      if (Math.abs(beta(v)) > 30) spun = true
    }
  })
  return { b0, dBeta: maxB, rMax: maxR, rMin: minR, spun, rearSlip: maxRearSlip, tSpin }
}

// ---------------------------------------------------------------- tyre
function tyreModel() {
  const v = new Vehicle(spec)
  return v.wheels[0].model
}
function brushCurve(m: TyreModel, Fz: number, kind: 'lat' | 'long', other = 0) {
  const a = m.halfLength(m.nominalDeflection(Fz))
  const loads = new Float64Array(RIBS),
    mu = new Float64Array(RIBS)
  const pts: { s: number; F: number; Fo: number }[] = []
  let prev = 0
  for (let k = 1; k <= 200; k++) {
    const s = kind === 'lat' ? k * 0.15 * DEG : k * 0.0025
    // theoretical slips: sx = k/(1+k), sy = tan(alpha)/(1+k)
    const kap = kind === 'long' ? s : other
    const alp = kind === 'lat' ? s : other
    const sx = kap / (1 + kap)
    const sy = Math.tan(alp) / (1 + kap)
    const fP = Math.pow(m.ribPressure(Fz / 3, a) / m.pRef, -m.nP)
    m.ribShares(0, kind === 'lat' ? prev / Fz : 0, 0, 0, loads)
    mu.fill(m.muS * fP)
    const slide = 30 * Math.hypot(sx, sy)
    const o = m.brush(Fz, a, sx, sy, 0, loads, mu, slide, m.out)
    const F = kind === 'lat' ? o.Fy : o.Fx
    prev = o.Fy
    pts.push({ s, F: Math.abs(F), Fo: Math.abs(kind === 'lat' ? o.Fx : o.Fy) })
  }
  const pk = pts.reduce((b, p) => (p.F > b.F ? p : b))
  return { pts, peak: pk.F, at: pk.s, end: pts[pts.length - 1].F, mu: pk.F / Fz }
}

// ---------------------------------------------------------------- rest / slope / kerb
function rest(grade: number, brake: number) {
  const g = new TestGround(1e9, grade)
  const { world, v, car } = setup(g, { autoGear: false })
  car.input.brake = brake
  run(world, 3)
  const p0 = { x: v.pos.x, z: v.pos.z }
  let maxV = 0
  run(world, 10, () => {
    maxV = Math.max(maxV, v.speed)
  })
  const drift = Math.hypot(v.pos.x - p0.x, v.pos.z - p0.z) / 10
  return { drift: drift * 1000, maxV: maxV * 1000 }
}
function energy(v: Vehicle) {
  let e = 0.5 * v.mass * (v.vel.x ** 2 + v.vel.y ** 2 + v.vel.z ** 2) + v.mass * G * v.pos.y
  for (const w of v.wheels) e += 0.5 * w.inertia * w.omega * w.omega
  return e
}
function kerbStrike(h: number) {
  const out: number[] = []
  let maxGain = 0
  for (const kerb of [null, { z0: 30, z1: 30.6, h }]) {
    const g = new TestGround(1e9, 0, kerb)
    const { world, v, car } = setup(g)
    v.setVelocityForward(30)
    v.gear = 4
    car.input.throttle = 0
    car.input.clutch = 1
    run(world, 0.2)
    const e0 = energy(v)
    let emax = 0
    run(world, 2.5, () => {
      emax = Math.max(emax, energy(v) - e0)
    })
    maxGain = Math.max(maxGain, emax)
    out.push(v.speed)
  }
  return { dv: (out[1] - out[0]) * 3.6, gain: maxGain }
}

// ---------------------------------------------------------------- collisions
function barrier(speed: number, angleDeg: number) {
  const wallX = 10
  const g = new TestGround(wallX)
  const yaw = angleDeg * DEG // yaw 90 = heading +x (into the wall)
  const { world, v } = setup(g, {}, 0, 0, yaw)
  v.setVelocityForward(speed)
  // place the car so that it reaches the wall in 0.5 s
  const ax = Math.sin(yaw)
  v.pos.x = wallX - spec.length * 0.5 * ax - spec.width * 0.5 * Math.cos(yaw) - speed * ax * 0.5 - 0.05
  const vnIn = v.vel.x
  let pen = 0,
    finite = true,
    vnOut = 0,
    contact = false
  const ke = () => 0.5 * v.mass * (v.vel.x ** 2 + v.vel.y ** 2 + v.vel.z ** 2)
  const e0 = ke()
  let ekMax = 0
  const tmp = { x: 0, y: 0, z: 0 } as any
  run(world, 2, () => {
    for (let i = 0; i < 12 && i < v.hull.length; i++) {
      const hp = v.hull[i]
      v.R.apply(hp.x, hp.y, hp.z, tmp)
      pen = Math.max(pen, v.pos.x + tmp.x - wallX)
    }
    if (world.events.some((e) => e.kind === 'wall')) contact = true
    if (contact && v.vel.x < vnOut) vnOut = v.vel.x
    if (contact) ekMax = Math.max(ekMax, ke() - e0)
    if (!v.isFinite()) finite = false
  })
  return { pen, e: -vnOut / Math.max(vnIn, 1e-6), speedOut: v.speed * 3.6, finite, gain: ekMax, nEv: world.events.length }
}
function carToCar(kind: 'rear' | 'side', closing: number) {
  const world = new PhysicsWorld(new FlatGround())
  const a = new Vehicle(spec),
    b = new Vehicle(spec)
  a.reset(0, 0, 0, world.ground)
  if (kind === 'rear') b.reset(0, spec.length + 0.6, 0, world.ground)
  else b.reset(-(spec.width * 0.5 + spec.length * 0.5 + 0.4), 0, Math.PI / 2, world.ground)
  if (kind === 'rear') {
    a.setVelocityForward(20 + closing)
    b.setVelocityForward(20)
  } else {
    a.setVelocityForward(20)
    b.setVelocityForward(closing)
  }
  const A = world.addCar('a', a),
    B = world.addCar('b', b)
  for (const c of [A, B]) c.input.clutch = 1
  const ke = () => 0.5 * a.mass * (a.vel.x ** 2 + a.vel.z ** 2) + 0.5 * b.mass * (b.vel.x ** 2 + b.vel.z ** 2)
  const p0 = { ax: a.vel.x, az: a.vel.z, bx: b.vel.x, bz: b.vel.z }
  const e0 = ke()
  let depth = 0,
    finite = true,
    welded = 0,
    tHit = -1,
    keAfter = NaN,
    relAfter = NaN
  const n = kind === 'rear' ? [0, 1] : [-1, 0]
  run(world, 2, (t) => {
    if (tHit < 0 && world.events.some((e) => e.kind === 'car')) tHit = t
    if (tHit >= 0 && Number.isNaN(keAfter) && t > tHit + 0.1) {
      keAfter = ke() / e0
      relAfter = (b.vel.x - a.vel.x) * n[0] + (b.vel.z - a.vel.z) * n[1]
    }
    const r = obbOverlap(a.pos.x, a.pos.z, a.fwd.x, a.fwd.z, spec.length / 2, spec.width / 2, b.pos.x, b.pos.z, b.fwd.x, b.fwd.z, spec.length / 2, spec.width / 2)
    if (r) {
      depth = Math.max(depth, r.depth)
      welded++
    }
    if (!a.isFinite() || !b.isFinite()) finite = false
  })
  // restitution along the initial closing direction
  const rel0 = (p0.bx - p0.ax) * n[0] + (p0.bz - p0.az) * n[1]
  const evs = world.events.filter((e) => e.kind === 'car')
  return { depth, rel0, e: relAfter / -rel0, ke: keAfter, finite, overlapMs: (welded * PHYSICS_DT * 1000) | 0, contacts: evs.length, va: a.speed * 3.6, vb: b.speed * 3.6 }
}

// ---------------------------------------------------------------- AI lap
function aiLap() {
  const track = new Track(TRACKS[0])
  const world = new PhysicsWorld(track)
  const v = new Vehicle(spec)
  const p = track.pointAt(-20, 0, { x: 0, y: 0, z: 0 })
  v.reset(p.x, p.z, track.headingAt(-20), track)
  const car = world.addCar('ai', v)
  const ai = new AIDriver(v, track, 1.0)
  const inp = makeInput()
  const laps: number[] = []
  let lastS = ai.s,
    lapStart = 0,
    t = 0,
    gLat = 0,
    gBrake = 0,
    gAcc = 0
  while (t < 260 && laps.length < 2) {
    ai.drive(1 / 60, inp, [], true)
    Object.assign(car.input, inp)
    for (let i = 0; i < 10; i++) world.stepOnce(PHYSICS_DT)
    t += 1 / 60
    if (laps.length === 1) {
      gLat = Math.max(gLat, Math.abs(v.accelLat))
      gBrake = Math.max(gBrake, -v.accelLong)
      gAcc = Math.max(gAcc, v.accelLong)
    }
    if (lastS > track.length - 200 && ai.s < 200) {
      if (t - lapStart > 20) laps.push(t - lapStart)
      lapStart = t
    }
    lastS = ai.s
  }
  return { laps, gLat, gBrake, gAcc, walls: world.events.filter((e) => e.kind === 'wall').length }
}

// ================================================================= run
console.log(`physics audit: ${spec.name} (${spec.mass} kg)  ${quick ? '[quick]' : ''}`)
const sec = (s: string) => rows.push([`-- ${s}`, '', ''])
const T0 = performance.now()

if (process.env.DIAG) {
  const [dr, dk] = process.env.DIAG.split(':').map(Number)
  circle(dr, dk || 120)
  process.exit(0)
}
sec('straight line')
const acc = acceleration(3)
row('0-100 km/h (TC3)', `${f(acc.t100)} s`, '~3.2 s')
row('0-200 km/h (TC3)', `${f(acc.t200)} s`, '10-11 s')
row('top speed', `${f(acc.vmax, 0)} km/h`, '270-290')
const acc0 = acceleration(0)
row('0-100 km/h (TC off)', `${f(acc0.t100)} s`, '3.2-3.6 s')
for (const k of [100, 200]) {
  const b = braking(k)
  row(`${k}-0 km/h braking (ABS)`, `${f(b.d, 1)} m  peak ${f(b.peak)} g  mean ${f(b.mean)} g`, k === 100 ? '~30-33 m, 1.5-1.7 g' : '~70-80 m, peak 2.2-2.6 g')
}

sec('steady state (constant radius, speed ramp 0.25 m/s2, TC2, tread pinned at optimum temp)')
for (const [R, kmh, ref] of [
  [18, 30, '>=1.5 g @ ~60'],
  [57, 70, '>=1.65 g @ ~110, delta <~2 L/R'],
  [126, 120, '>=1.9 g @ ~165'],
  [250, 200, '>=2.2 g @ ~220'],
] as [number, number, string][]) {
  const c = circle(R, kmh)
  const geo = Math.atan(spec.wheelbase / R) / DEG
  row(`R=${R} m max lateral`, `${f(c.best)} g @ ${f(c.kmh, 0)} km/h, delta@98% ${f(c.steer, 1)} deg (L/R ${f(geo, 1)}), K ${f(c.K, 2)} deg/g`, `${ref}; K +0.2..+1 deg/g`)
}

sec('step steer 120 km/h, 1.5 deg road wheel')
const ss = stepSteer(120, 1.5)
row('yaw rate rise 10-90 %', `${f(ss.rise, 3)} s (t90 ${f(ss.t90, 3)})`, '0.15-0.25 s')
row('overshoot / settle 5 %', `${f(ss.over, 1)} %  ${f(ss.settle, 2)} s`, '<10 %, <0.6 s')
row('steady yaw rate / lat g', `${f(ss.ss, 1)} deg/s  ${f(ss.ay)} g`, '')

sec('transients on R=57 m at 85 % of limit')
const lim57 = circle(57, 70)
const v85 = lim57.kmh * 0.85
const lift = cornerEvent(57, v85, 'lift')
row('lift-off: body slip +, yaw r/r0 max', `${f(lift.dBeta, 1)} deg  ${f(lift.rMax)}  spun ${lift.spun}`, 'mild: +1..4 deg, r/r0 1.05-1.3')
const trail = cornerEvent(57, v85, 'trail')
row('trail brake 35 %: body slip +, r/r0', `${f(trail.dBeta, 1)} deg  ${f(trail.rMax)}/${f(trail.rMin)}  spun ${trail.spun}`, 'rotation, no snap')
const liftHi = cornerEvent(250, 200, 'lift')
row('lift-off R=250 m @ 200 km/h: slip +, r/r0', `${f(liftHi.dBeta, 1)} deg  ${f(liftHi.rMax)}/${f(liftHi.rMin)}  spun ${liftHi.spun}`, 'stable: < +2 deg, r/r0 < 1.2')
const trailHi = cornerEvent(250, 200, 'trail', 0, 0, true)
row('trail brake R=250 m @ 200 km/h, driver holds the line: slip +, r/r0', `${f(trailHi.dBeta, 1)} deg  ${f(trailHi.rMax)}/${f(trailHi.rMin)}  spun ${trailHi.spun}`, 'rotation, no snap')
const lc = laneChange(200, 0.8)
row('lane change 200 km/h, 0.8 deg sine 2.4 s', `peak ${f(lc.ay)} g  beta max ${f(lc.beta, 1)} deg  yaw rate after +1.5 s ${f(lc.rEnd, 1)} deg/s  spun ${lc.spun}`, 'beta < 2 deg, settles, no snap')
for (const tc of [0, 3]) {
  const p = cornerEvent(25, 60, 'power', tc, 2)
  row(`power-on R=25 2nd gear TC${tc}`, `dBeta ${f(p.dBeta, 1)} deg  r/r0 ${f(p.rMax)}  rear slip ${f(p.rearSlip * 100, 0)} %  +10deg after ${f(p.tSpin, 2)} s`, tc ? 'contained, slip ~10 %' : 'progressive: >0.5 s to +10 deg')
}

sec('tyre (front, brush model, cold-free calibration)')
const tm = tyreModel()
const lats = [1500, 3000, 4500, 6000, 8000].map((Fz) => ({ Fz, ...brushCurve(tm, Fz, 'lat') }))
row('lat mu @ 1.5/3/4.5/6/8 kN', lats.map((l) => f(l.mu)).join(' / '), 'falling, degressive')
row('lat peak force kN', lats.map((l) => f(l.peak / 1000, 1)).join(' / '), 'concave in Fz')
row('peak slip angle deg', lats.map((l) => f(l.at / DEG, 1)).join(' / '), '6-9 deg')
row('lat fall-off at 30 deg', lats.map((l) => f((1 - l.end / l.peak) * 100, 0) + '%').join(' / '), '10-20 %')
const lon = [3000, 6000].map((Fz) => ({ Fz, ...brushCurve(tm, Fz, 'long') }))
row('long mu / peak slip / fall-off @3,6 kN', lon.map((l) => `${f(l.mu)} ${f(l.at * 100, 1)}% ${f((1 - l.end / l.peak) * 100, 0)}%`).join(' | '), '8-12 %, 10-20 %')
{
  const Fz = 4000
  const fy0 = brushCurve(tm, Fz, 'lat').peak
  const fx0 = brushCurve(tm, Fz, 'long').peak
  let worst = 0
  for (const a of [2, 4, 7]) {
    const c = brushCurve(tm, Fz, 'long', a * DEG)
    for (const p of c.pts) worst = Math.max(worst, Math.hypot(p.F / fx0, p.Fo / fy0))
  }
  row('combined slip max |(Fx/Fx0,Fy/Fy0)|', f(worst, 3), '<= ~1.05 (ellipse)')
}

sec('rest, slope, kerb')
const r0 = rest(0, 0)
row('at rest drift / max speed', `${f(r0.drift, 3)} mm/s  ${f(r0.maxV, 2)} mm/s`, '< 1 mm/s')
const sl = rest(0.15, 1)
row('15 % slope, brakes on: drift', `${f(sl.drift, 3)} mm/s`, '< 1 mm/s')
const kb = kerbStrike(0.06)
row('6 cm kerb at 108 km/h coasting', `dv ${f(kb.dv, 2)} km/h  max E gain ${f(kb.gain, 0)} J`, 'dv <= 0, gain ~0')

sec('collisions')
for (const [s, a] of [
  [5, 30],
  [5, 90],
  [30, 30],
  [30, 90],
]) {
  const b = barrier(s, a)
  row(`barrier ${s} m/s @ ${a} deg`, `pen ${f(b.pen * 100, 0)} cm  e ${f(b.e)}  out ${f(b.speedOut, 0)} km/h  KE gain ${f(b.gain, 0)} J  ${b.finite ? 'ok' : 'NaN'}`, 'pen < 5 cm, e 0.1-0.3, no gain')
}
for (const [k, c] of [
  ['rear', 5],
  ['rear', 15],
  ['side', 10],
] as ['rear' | 'side', number][]) {
  const r = carToCar(k, c)
  row(`car-car ${k} ${c} m/s`, `depth ${f(r.depth * 100, 0)} cm  overlap ${r.overlapMs} ms  KE(+0.1s) ${f(r.ke, 3)}  e ${f(r.e)}  ${r.finite ? 'ok' : 'NaN'}`, 'depth < 5 cm, KE < 1, e 0.1-0.4')
}

if (!quick) {
  sec('AI lap, default circuit')
  const l = aiLap()
  row('lap times / peak g lat brake acc', `${l.laps.map((x) => f(x)).join(', ')} s  ${f(l.gLat)} / ${f(l.gBrake)} / ${f(l.gAcc)} g  walls ${l.walls}`, '')
}

const w0 = Math.max(...rows.map((r) => r[0].length)),
  w1 = Math.max(...rows.map((r) => r[1].length))
for (const r of rows) console.log(r[1] === '' && r[0].startsWith('--') ? r[0] : `${r[0].padEnd(w0)}  ${r[1].padEnd(w1)}  ${r[2]}`)
console.log(`(${((performance.now() - T0) / 1000).toFixed(1)} s)`)
