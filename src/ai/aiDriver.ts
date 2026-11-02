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

/** Quasi-steady-state target speed along the racing line for a given car. */
export function speedProfileFor(v: Vehicle, track: Track, skill = 1, out?: Float32Array) {
  const sp = v.spec
  const cp = COMPOUNDS[v.setup.compound] ?? COMPOUNDS.RM
  const m = v.totalMass
  const peakPower = Math.max(...sp.engine.torque.map(([rpm, t]) => (t * rpm * Math.PI) / 30)) * 0.9
  return track.computeSpeedProfile(
    {
      mu: cp.mu * 0.85 * skill,
      clA_m: (v.clAF + v.clAR) / m,
      power_m: peakPower / m,
      cdA_m: v.cdA / m,
      brakeMu: cp.mu * 0.82 * skill,
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
  private trace = 0
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
  }

  rebuildProfile() {
    speedProfileFor(this.vehicle, this.track, this.skill, this.profile)
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

    // ---- traffic: pick a lane to pass slower cars ahead
    let blockSpeed = Infinity
    let wantOffset = 0
    let alongside = false
    for (const o of traffic) {
      if (o.id === this.id) continue
      let ds = o.s - this.s
      if (ds < -tr.length / 2) ds += tr.length
      if (ds > tr.length / 2) ds -= tr.length
      const lat = o.d - this.d
      if (ds > 0 && ds < 30 + speed * 0.6 && Math.abs(lat) < 3.2) {
        const closing = speed - o.speed
        if (closing > -1) {
          // move to the side with more room
          const i = tr.idx(o.s)
          const roomLeft = tr.hw[i] - o.d
          const roomRight = tr.hw[i] + o.d
          const side = roomLeft > roomRight ? 1 : -1
          wantOffset = side * 3.3 * clamp(1 - ds / (40 + speed * 0.6), 0.2, 1)
          if (ds < 12 + speed * 0.25 && Math.abs(lat) < 2.4) blockSpeed = Math.min(blockSpeed, o.speed - 0.5 + ds * 0.08)
        }
      }
      // side by side: keep away
      if (Math.abs(ds) < 6 && Math.abs(lat) < 2.6) wantOffset += (lat > 0 ? -1 : 1) * 1.5
      if (ds > -3 && ds < 9 && Math.abs(lat) > 1.6 && Math.abs(lat) < 4.5) alongside = true
    }
    this.targetOffset = wantOffset
    this.offset = lerp(this.offset, this.targetOffset, clamp(dt * 1.2, 0, 1))

    // ---- steering: pure pursuit on racing line (+ offset)
    const look = 7 + speed * 0.42
    const ts = this.s + look
    const ti = tr.idx(ts)
    const hw = tr.hw[ti]
    const lineD = clamp(tr.racing[ti] + this.offset, -hw + 1.2, hw - 1.2)
    const p = tr.pointAt(ts, lineD, { x: 0, y: 0, z: 0 })
    const dx = p.x - v.pos.x,
      dz = p.z - v.pos.z
    const localLeft = dx * v.left.x + dz * v.left.z
    const localFwd = dx * v.fwd.x + dz * v.fwd.z
    const L2 = localLeft * localLeft + localFwd * localFwd
    const curvature = (2 * localLeft) / Math.max(L2, 1)
    let delta = Math.atan(curvature * v.spec.wheelbase * 1.05)
    // counter-steer using body slip angle at the rear axle
    const vl = v.vel.x * v.left.x + v.vel.z * v.left.z
    const vf = v.vel.x * v.fwd.x + v.vel.z * v.fwd.z
    if (vf > 3) {
      const yaw = v.w.y
      const vRear = vl - yaw * v.b // lateral velocity at the rear axle
      const beta = Math.atan2(vRear, vf)
      if (Math.abs(beta) > 0.05) delta += beta * 0.9
    }
    delta = clamp(delta, -v.spec.steerLock, v.spec.steerLock)
    let steer = -delta / v.spec.steerLock
    steer = lerp(this.steerPrev, steer, clamp(dt * 14, 0, 1))
    this.steerPrev = steer

    // ---- speed control
    const pi = tr.idx(this.s + 2 + speed * 0.12)
    let vt = this.profile[pi]
    // reduce target if off line (driving on the wrong part of the track)
    const lineErr = Math.abs(this.d - (tr.racing[tr.idx(this.s)] + this.offset))
    vt *= clamp(1 - Math.max(0, lineErr - 2) * 0.03, 0.75, 1)
    // a committed pass: out-brake the car alongside
    if (alongside && this.attack > 0) vt *= 1 + 0.045 * this.attack
    if (this.overdriveTime > 0) {
      this.overdriveTime -= dt
      vt *= 1 + this.overdrive
    }
    vt = Math.min(vt, blockSpeed)
    const err = vt - speed
    let throttle = 0,
      brake = 0
    if (err > 0) throttle = clamp(0.35 + err * 0.6, 0, 1)
    else if (err > -1.2) throttle = clamp(0.25 + err * 0.2, 0, 0.3)
    else brake = clamp(-err * 0.22, 0, 1)
    // stability: lift when sliding
    // traction-aware throttle: feed in power only as fast as the rears can take it
    const rearSlip = Math.max(Math.abs(v.wheels[2].tyre.slipAngle), Math.abs(v.wheels[3].tyre.slipAngle))
    const peak = v.wheels[2].model.compound.peakSlipAngle
    const rearComb = Math.max(v.wheels[2].tyre.combinedSlip, v.wheels[3].tyre.combinedSlip)
    throttle *= clamp(1 - (rearSlip / peak - 0.85) * 1.6, 0.15, 1)
    throttle *= clamp(1 - (rearComb - 1.0) * 1.5, 0.3, 1)
    const yawErr = Math.abs(v.w.y) - Math.abs(speed * curvature) * 1.25
    if (yawErr > 0.08 && speed > 8) throttle *= 0.6

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
    this.trace++
    void n
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
