// AI driver: follows the optimised racing line with pure-pursuit steering, slip-angle aware
// counter-steer, a car-specific speed profile and simple traffic awareness (overtaking offsets).
import { makeSample } from '../physics/ground'
import { clamp, lerp } from '../physics/math'
import { COMPOUNDS } from '../physics/spec'
import type { Vehicle, VehicleInput } from '../physics/vehicle'
import type { Track } from '../track/track'

export interface TrafficCar {
  s: number
  d: number
  speed: number
  id: string
}

/** Share of the tyre's peak friction the AI's speed profile plans with (cornering / braking). */
export const GRIP_SHARE = 0.94
/** The car's steady-state cornering capability, fitted to the skidpad of scripts/physics-audit.ts (Vanta GT3
 *  on 18/57/126/250 m circles: 1.55/1.63/1.76/2.13 g at 60/109/169/260 km/h, fit rms 0.01 g): the compound's
 *  peak friction scaled by LAT_MU_CAL (load transfer across the axles, slip-angle spread) and the
 *  downforce by LAT_AERO_CAL (pitch / ride height at speed). LAT_SHARE: the driver's share of it. */
export const LAT_MU_CAL = 0.9125
export const LAT_AERO_CAL = 0.77
export const LAT_SHARE = 0.96
/** lateral jerk (m/s^3) at which a direction change halves the usable lateral grip */
export const LAT_JERK = 30
export const BRAKE_SHARE = 0.89
/** Wheel power at full throttle, averaged over the shift band with drivetrain and rolling losses,
 * as a share of the engine's peak (measured on the straights by scripts/ai-lap-trace.ts: 0.78). */
/** Share of the rear axle's friction the AI brakes up to with the car's brake balance */
export const REAR_BRAKE_SHARE = 0.97
export const POWER_SHARE = 0.79
/** Braking left over while cornering: 1 - (lat/max)^2 instead of the ellipse's square root, since
 * braking unloads the rear axle that has to hold the car's yaw (the ellipse spun it on trail-braked entries). */
export const TRAIL_EXP = 1

/** Quasi-steady-state target speed along the racing line for a given car. */
export function speedProfileFor(v: Vehicle, track: Track, skill = 1, out?: Float32Array) {
  const sp = v.spec
  const cp = COMPOUNDS[v.setup.compound] ?? COMPOUNDS.RM
  const m = v.totalMass
  const peakPower = Math.max(...sp.engine.torque.map(([rpm, t]) => (t * rpm * Math.PI) / 30)) * POWER_SHARE
  return track.computeSpeedProfile(
    {
      mu: cp.mu * GRIP_SHARE * skill,
      clA_m: (v.clAF + v.clAR) / m,
      lat: { mu: cp.mu * LAT_MU_CAL * LAT_SHARE * skill, clA_m: ((v.clAF + v.clAR) / m) * LAT_AERO_CAL, jerk: LAT_JERK },
      power_m: peakPower / m,
      cdA_m: v.cdA / m,
      brakeMu: cp.mu * BRAKE_SHARE * skill,
      loadSens: cp.loadSens,
      fz0_m: cp.nominalLoad / m,
      trailExp: TRAIL_EXP,
      rearBrake: {
        wr: 1 - sp.weightFront,
        bf: v.setup.brakeBias,
        hL: sp.cgHeight / sp.wheelbase,
        aeroR: v.clAR / Math.max(v.clAF + v.clAR, 1e-6),
        mu: cp.mu * cp.muLong * REAR_BRAKE_SHARE * skill,
      },
    },
    out ?? new Float32Array(track.n),
  )
}

export class AIDriver {
  profile: Float32Array
  sample = makeSample()
  offset = 0 // lateral offset from racing line for overtakes
  targetOffset = 0
  stuckTime = 0
  reverseTime = 0
  s = 0
  d = 0
  /** 0..1: commits to a pass (brakes later when alongside a car it is overtaking) */
  attack = 0
  /** driver error: carries this much extra speed into the corners while overdriveTime > 0 */
  overdrive = 0
  overdriveTime = 0
  private steerPrev = 0
  private us = 0 // learnt steering offset (understeer / slip) at the current corner
  private thrCap = 1
  private brkCap = 1
  private slide = 0
  private passSide = 0
  private lo = -Infinity
  private hi = Infinity
  private grip = 1
  private muBrk = 1.5
  private clA_m = 0
  private cdA_m = 0
  private power_m = 300
  private loadSens = 0
  private fz0_m = 1
  id = ''
  constructor(
    public vehicle: Vehicle,
    public track: Track,
    public skill = 0.97,
    public aggression = 0.5,
  ) {
    this.profile = new Float32Array(track.n)
    this.rebuildProfile()
    vehicle.assists = { abs: true, tc: 2, steering: 0, autoGear: true, stability: false }
    // race cars (sequential box): shift like a racing driver; road cars keep their road schedule
    // (on the Aurel the racing downshifts put engine braking into a rear that already locks)
    vehicle.racingShift = vehicle.spec.shiftTime <= 0.08
  }

  rebuildProfile() {
    speedProfileFor(this.vehicle, this.track, this.skill, this.profile)
    const v = this.vehicle
    const cp = COMPOUNDS[v.setup.compound] ?? COMPOUNDS.RM
    const m = v.totalMass
    this.muBrk = cp.mu * BRAKE_SHARE * this.skill
    this.clA_m = (v.clAF + v.clAR) / m
    this.cdA_m = v.cdA / m
    this.power_m = Math.max(...v.spec.engine.torque.map(([rpm, t]) => (t * rpm * Math.PI) / 30)) * POWER_SHARE / m
    this.loadSens = cp.loadSens
    this.fz0_m = cp.nominalLoad / m
  }

  /** Target lateral position at sample i: racing line plus the traffic offset, inside the track. */
  lineAt(i: number) {
    const a = Math.max(this.track.lineLo[i], this.lo),
      b = Math.min(this.track.lineHi[i], this.hi)
    return a <= b ? clamp(this.track.racing[i] + this.offset, a, b) : 0.5 * (a + b)
  }

  /** Compute controls for this frame. */
  drive(dt: number, out: VehicleInput, traffic: TrafficCar[], racing: boolean) {
    const v = this.vehicle
    const tr = this.track
    tr.sample(v.pos.x, v.pos.z, this.sample)
    this.s = this.sample.s
    this.d = this.sample.d
    const speed = v.speed
    const n = tr.n

    if (!racing) {
      out.throttle = 0
      out.brake = 1
      out.steer = 0
      return
    }

    // ---- traffic
    // following: never closer than the braking distance allows (the car ahead may brake as hard as
    // we can, or earlier), a short time gap behind it; passing: pull out to the side with room when
    // faster, the slipstream does the rest; alongside: leave a car's width (bounds on the line)
    let blockSpeed = Infinity
    let wantOffset = 0
    let alongside = false
    let lo = -Infinity,
      hi = Infinity
    const aB = 0.7 * this.muBrk * (9.81 + 0.6 * this.clA_m * speed * speed)
    let passTarget = false
    const i00 = tr.idx(this.s)
    const rejoin = Math.abs(this.d) > tr.hw[i00] - 0.8 && Math.abs(this.d - tr.racing[i00]) > 3
    for (const o of traffic) {
      if (o.id === this.id) continue
      let ds = o.s - this.s
      if (ds < -tr.length / 2) ds += tr.length
      if (ds > tr.length / 2) ds -= tr.length
      const lat = o.d - this.d
      const alat = Math.abs(lat)
      // a car much slower than us ahead (spun, sideways, crawling back) may lie across the track:
      // treat it as wider than a car on its line
      const pathW = o.speed < speed * 0.6 && speed > 10 ? 3.6 : 2.3
      if (ds > 0 && ds < 120 && alat < pathW) {
        const gap = ds - 4.8
        const gapMin = 1.2 + 0.18 * speed
        blockSpeed = Math.min(blockSpeed, Math.sqrt(Math.max(0, o.speed * o.speed + 2 * aB * (gap - gapMin))))
        // a pass: closing, or held up (within a few car lengths at similar speed)
        if (ds < 20 + speed * 0.5 && (speed - o.speed > 0.3 || gap < gapMin + 6)) {
          passTarget = true
          const i = tr.idx(o.s)
          const roomLeft = tr.hw[i] - o.d
          const roomRight = tr.hw[i] + o.d
          if (this.passSide === 0) this.passSide = roomLeft > roomRight ? 1 : -1
          const want = o.d + this.passSide * 2.6 - tr.racing[tr.idx(this.s)]
          if (Math.abs(want) > Math.abs(wantOffset)) wantOffset = want
        }
      }
      // alongside: keep a car's width from it, whoever is ahead
      // ... and when rejoining (pit exit, grass), any car coming up behind: merge behind it, not into it
      const soon = rejoin && ds <= -5.5 && ds > -60 && o.speed > speed - 2
      if (((ds > -5.5 && ds < 5.5) || soon) && alat >= 0.9) {
        if (lat > 0) hi = Math.min(hi, o.d - 2.4)
        else lo = Math.max(lo, o.d + 2.4)
        if (ds > -3 && ds < 4) alongside = true
      }
    }
    if (!passTarget) this.passSide = 0
    this.lo = lo
    this.hi = hi
    this.targetOffset = wantOffset
    this.offset = lerp(this.offset, this.targetOffset, clamp(dt * 1.5, 0, 1))

    // ---- steering: path-following on the line (curvature feed-forward + lateral/course feedback)
    // and an inner path-curvature loop whose integrator learns the car's understeer at the limit.
    const DSm = tr.length / n
    const i0 = tr.idx(this.s)
    const ia = (i0 + 3) % n,
      ib = (i0 - 3 + n) % n
    const lineD0 = this.lineAt(i0)
    const lineSlope = (this.lineAt(ia) - this.lineAt(ib)) / (6 * DSm)
    const vl = v.vel.x * v.left.x + v.vel.z * v.left.z
    const vf = v.vel.x * v.fwd.x + v.vel.z * v.fwd.z
    const psiLine = Math.atan2(tr.tx[i0], tr.tz[i0]) + Math.atan(lineSlope)
    const course = speed > 2 ? Math.atan2(v.vel.x, v.vel.z) : Math.atan2(v.fwd.x, v.fwd.z)
    let chi = course - psiLine
    chi -= Math.round(chi / (2 * Math.PI)) * 2 * Math.PI
    const e = this.d - lineD0
    const Lc = 7 + 0.25 * speed
    const kFF = tr.racingCurv[tr.idx(this.s + 2 + speed * 0.2)]
    // far off the line (rejoining from the grass or the pit exit): converge at a bounded angle
    // instead of a full-lock dart across the track
    const eC = clamp(e, -2.5, 2.5)
    let kCmd = kFF - eC / (Lc * Lc) - (1.8 * Math.sin(clamp(chi, -0.35, 0.35))) / Lc
    kCmd = clamp(kCmd, -0.25, 0.25)
    const L = v.spec.wheelbase
    const vRef = Math.max(vf, 3)
    const kMeas = v.w.y / vRef
    const dErr = Math.atan(L * kCmd) - Math.atan(L * kMeas)
    // front axle saturation: do not wind more lock into a front that is past its peak
    const aF = 0.5 * (v.wheels[0].tyre.slipAngle + v.wheels[1].tyre.slipAngle)
    const peakF = v.wheels[0].model.compound.peakSlipAngle
    const frontSat = Math.abs(aF) > peakF * 1.05 && Math.sign(dErr) === Math.sign(this.us + 1e-9)
    const betaR = vf > 3 ? Math.atan2(vl - v.w.y * v.b, vf) : 0
    // 0..1: how far the rear is past its working range (a slide to catch)
    const slide = clamp((Math.abs(betaR) - 0.09) / 0.07, 0, 1)
    this.slide = slide
    if (speed > 4 && !frontSat && slide === 0) this.us = clamp(this.us + dErr * dt * 8, -0.12, 0.12)
    else if (speed <= 4) this.us *= 0.9
    let delta = Math.atan(L * kCmd) + this.us + 0.6 * dErr
    // counter-steer on a rear slide (body slip at the rear axle beyond the tyres' working range)
    if (Math.abs(betaR) > 0.04) delta += (betaR - Math.sign(betaR) * 0.04) * 1.2
    // a real slide: point the front wheels along the front axle's travel, a little into the corner
    // (opposite lock that catches it without a slide the other way)
    if (slide > 0) {
      const catchDelta = Math.atan2(vl + v.w.y * v.a, vf) + 0.5 * peakF * Math.sign(kCmd)
      delta = lerp(delta, catchDelta, slide)
    }
    delta = clamp(delta, -v.spec.steerLock, v.spec.steerLock)
    let steer = -delta / v.spec.steerLock
    steer = lerp(this.steerPrev, steer, clamp(dt * 30, 0, 1))
    this.steerPrev = steer

    // ---- speed control: follow the profile's acceleration (feed-forward) plus speed feedback,
    // mapped to pedals through the car's grip/power model; exit traction held just under the
    // rear tyres' peak combined slip.
    const sA = this.s + 1 + speed * 0.05
    const dA = 4 + speed * 0.15
    // the plan is for the racing line: on an offset line (traffic) the corner is tighter on the inside,
    // R' = R - o, so the grip-limited speed scales by sqrt(1 - k o); the same off the line in a corner
    const iA = tr.idx(sA),
      iB = tr.idx(sA + dA)
    const kA = tr.racingCurv[iA],
      kB = tr.racingCurv[iB]
    const pa = this.profile[iA] * Math.sqrt(clamp(1 - kA * (this.lineAt(iA) - tr.racing[iA]), 0.5, 1))
    const pb = this.profile[iB] * Math.sqrt(clamp(1 - kB * (this.lineAt(iB) - tr.racing[iB]), 0.5, 1))
    let vt = pa
    // reduce target if off line (driving on the wrong part of the track): rejoining in a corner is a
    // tighter arc than the line's
    const lineErr = Math.abs(e)
    vt *= clamp(1 - Math.max(0, lineErr - 2) * 0.03 - Math.max(0, lineErr - 0.7) * Math.abs(kA) * 3, 0.75, 1)
    // a committed pass: out-brake the car alongside
    if (alongside && this.attack > 0) vt *= 1 + 0.015 * this.attack
    if (this.overdriveTime > 0) {
      this.overdriveTime -= dt
      vt *= 1 + this.overdrive
    }
    // tyres cooked past their window or grip gone (heat, wear): a driver feels it and backs off
    const w = v.wheels
    const cp = w[0].model.compound
    let hot = 0
    for (let k = 0; k < 4; k++) hot = Math.max(hot, (w[k].tyre.surfTemp - cp.optTemp - cp.tempWindow) / cp.tempWindow)
    const gf = Math.min(w[0].tyre.gripFactor, w[1].tyre.gripFactor, w[2].tyre.gripFactor, w[3].tyre.gripFactor)
    this.grip += ((1 - 0.4 * clamp(hot, 0, 1)) * clamp(gf / 0.85, 0.5, 1) - this.grip) * clamp(dt * 2, 0, 1)
    vt *= Math.sqrt(this.grip)
    vt = Math.min(vt, blockSpeed)
    let aCmd = (pb * pb - pa * pa) / (2 * dA)
    if (vt < pa) aCmd = Math.min(aCmd, 0)
    aCmd += 2.5 * (vt - speed)
    const v2 = speed * speed
    const fzN = 9.81 + 0.6 * this.clA_m * v2
    const muB = this.muBrk * Math.max(0.5, 1 - this.loadSens * (fzN / (4 * this.fz0_m) - 1))
    const drag = 0.6 * this.cdA_m * v2
    let throttle = 0,
      brake = 0
    if (aCmd >= 0) {
      const aMax = Math.max(1, this.power_m / Math.max(speed, 5))
      throttle = clamp((aCmd + drag) / aMax + 0.1, 0, 1)
    } else {
      const need = -aCmd - drag
      if (need > 0) brake = clamp(need / (muB * fzN * 1.05), 0, 1)
      else throttle = clamp((drag + aCmd) / Math.max(1, this.power_m / Math.max(speed, 5)), 0, 0.4)
    }
    // traction: a throttle cap that backs off as the rear's combined slip nears its peak
    const rearComb = Math.max(v.wheels[2].tyre.combinedSlip, v.wheels[3].tyre.combinedSlip)
    // (not in a standing start: there the launch revs and traction control do it, the cap bogged it)
    if (rearComb > 0.9 && throttle > 0 && speed > 12) this.thrCap = Math.max(0.1, this.thrCap - dt * 30 * (rearComb - 0.9))
    else this.thrCap = Math.min(1, this.thrCap + dt * 1.5)
    throttle = Math.min(throttle, this.thrCap)
    // trail braking: release the brake as fast as the rear's combined slip passes its peak
    // (braking while turning unloads the rear), so the car rotates without stepping out
    // (not on longitudinal slip alone: under braking ABS holds that at its peak by design)
    const aRr = Math.max(Math.abs(v.wheels[2].tyre.slipAngle), Math.abs(v.wheels[3].tyre.slipAngle)) / v.wheels[2].model.compound.peakSlipAngle
    // past its peak while also cornering (slip angle > 60 % of peak), the rear is about to let go
    const rearOver = aRr > 0.6 ? Math.max(rearComb - 1.3, aRr - 1) : 0
    if (rearOver > 0 && brake > 0) this.brkCap = Math.max(0, this.brkCap - dt * 20 * rearOver)
    else this.brkCap = Math.min(1, this.brkCap + dt * 2)
    brake = Math.min(brake, this.brkCap)
    // catching a slide: a balancing touch of throttle instead of a coasting (engine-braked) rear
    if (this.slide > 0 && brake < 0.05) throttle = Math.max(throttle, 0.18 * this.slide)

    // ---- stuck / reverse recovery
    if (speed < 1.5) this.stuckTime += dt
    else this.stuckTime = 0
    if (this.reverseTime > 0) {
      this.reverseTime -= dt
      out.steer = -steer
      out.throttle = 0
      out.brake = 0.7 // auto box: brake engages reverse
      out.handbrake = 0
      return
    }
    if (this.stuckTime > 3.5) {
      this.stuckTime = 0
      this.reset()
      return
    }
    out.steer = steer
    out.throttle = throttle
    out.brake = brake
    out.handbrake = 0
  }

  /** Teleport back onto the racing line a little behind the current position. */
  reset() {
    const tr = this.track
    const s = this.s - 10
    const i = tr.idx(s)
    const p = tr.pointAt(s, tr.racing[i], { x: 0, y: 0, z: 0 })
    this.vehicle.reset(p.x, p.z, tr.headingAt(s), tr, true)
  }
}
