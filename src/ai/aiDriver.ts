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
export function speedProfileFor(v: Vehicle, track: Track, skill = 1, out?: Float32Array, curv?: Float32Array) {
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
    curv,
  )
}

export class AIDriver {
  profile: Float32Array
  sample = makeSample()
  /** speed plans on the left / right lane lines (track.laneL / laneR) */
  profL: Float32Array
  profR: Float32Array
  /** 0..1: blend from the ideal line to the lane line on side `lane` (+1 left, -1 right) */
  w = 0
  lane = 0
  /** what the driver is doing in traffic: 0 free, 1 alongside, 2 attack, 3 defend, 4 rejoin */
  mode = 0
  private wTarget = 0
  private ws = 0
  private defended = false
  /** s left of recovering from a spin (rejoin through the side lane) */
  private recover = 0
  stuckTime = 0
  reverseTime = 0
  s = 0
  d = 0
  /** 0..1: commits to a pass (brakes later when alongside a car it is overtaking) */
  attack = 0
  /** diagnostics (scripts/race-audit.ts): the car being followed / attacked, its gap and speed, and the
   *  attack's gate this step (0 n/a, 1 single file, 2 lane taken, 3 plan unmeetable, 4 held: corner, 5 moving) */
  aheadId = ''
  /** the car being attacked (kept while pulled out beside it, cleared when the move is over) */
  attackId = ''
  /** diagnostics: the speed target was cut by a car ahead (or one alongside owning a corner) this step */
  held = false
  aheadDs = Infinity
  aheadV = 0
  gate = 0
  /** driver error: carries this much extra speed into the corners while overdriveTime > 0 */
  overdrive = 0
  overdriveTime = 0
  private steerPrev = 0
  private us = 0 // learnt steering offset (understeer / slip) at the current corner
  private thrCap = 1
  private brkCap = 1
  private slide = 0
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
    track.ensureLanes()
    this.profile = new Float32Array(track.n)
    this.profL = new Float32Array(track.n)
    this.profR = new Float32Array(track.n)
    this.rebuildProfile()
    vehicle.assists = { abs: true, tc: 2, steering: 0, autoGear: true, stability: false }
    // race cars (sequential box): shift like a racing driver; road cars keep their road schedule
    // (on the Aurel the racing downshifts put engine braking into a rear that already locks)
    vehicle.racingShift = vehicle.spec.shiftTime <= 0.08
  }

  rebuildProfile() {
    speedProfileFor(this.vehicle, this.track, this.skill, this.profile)
    speedProfileFor(this.vehicle, this.track, this.skill, this.profL, this.track.laneLCurv)
    speedProfileFor(this.vehicle, this.track, this.skill, this.profR, this.track.laneRCurv)
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

  /** The blended line (ideal line to lane line) at sample i, before the traffic bounds. */
  nominalAt(i: number) {
    const tr = this.track
    const r = tr.racing[i]
    if (this.ws <= 0) return r
    return r + this.ws * ((this.lane > 0 ? tr.laneL[i] : tr.laneR[i]) - r)
  }
  /** Target lateral position at sample i: the blended line, inside the usable width and the room
   *  left by a car alongside. */
  lineAt(i: number) {
    const a = Math.max(this.track.lineLo[i], this.lo),
      b = Math.min(this.track.lineHi[i], this.hi)
    return a <= b ? clamp(this.nominalAt(i), a, b) : 0.5 * (a + b)
  }
  /** Curvature of the blended line at sample i. */
  curvAt(i: number) {
    const tr = this.track
    const k = tr.racingCurv[i]
    if (this.ws <= 0) return k
    return k + this.ws * ((this.lane > 0 ? tr.laneLCurv[i] : tr.laneRCurv[i]) - k)
  }
  /** Speed plan of the line the car is on: the ideal line's, the lane's, the lower of the two while blending. */
  planAt(i: number) {
    if (this.ws <= 0) return this.profile[i]
    const pl = this.lane > 0 ? this.profL[i] : this.profR[i]
    return this.ws >= 0.999 ? pl : Math.min(pl, this.profile[i])
  }
  /** No other car on the lane line on `side` from just behind us to past the car we attack. */
  laneFree(traffic: TrafficCar[], side: number, blockerDs: number) {
    const tr = this.track
    for (const o of traffic) {
      if (o.id === this.id) continue
      let ds = o.s - this.s
      if (ds < -tr.length / 2) ds += tr.length
      if (ds > tr.length / 2) ds -= tr.length
      if (ds < -10 || ds > blockerDs + 15) continue
      const j = tr.idx(o.s)
      if (Math.abs(o.d - (side > 0 ? tr.laneL[j] : tr.laneR[j])) < 2.3) return false
    }
    return true
  }
  /** The inside of the tightest corner (sharper than R 150 m) from x0 to x1 m ahead on the ideal line
   *  (+1 left, -1 right, 0 none). */
  insideSide(x0: number, x1: number) {
    const tr = this.track
    let kMax = 0,
      side = 0
    for (let x = x0; x < x1; x += 4) {
      const j = tr.idx(this.s + x)
      if (Math.abs(tr.racingCurv[j]) > kMax) {
        kMax = Math.abs(tr.racingCurv[j])
        side = tr.racing[j] > 0.5 * (tr.lineLo[j] + tr.lineHi[j]) ? 1 : -1
      }
    }
    return kMax > 1 / 150 ? side : 0
  }
  /** Time (s) the lane plan `prof` loses to the ideal line's over the next 300 m from sample i0. */
  laneLoss(prof: Float32Array, i0: number) {
    const tr = this.track
    const n = tr.n,
      DSm = tr.length / n
    const stride = Math.max(1, Math.round(3 / DSm))
    let t = 0
    for (let x = 0, j = i0; x < 300; x += stride * DSm, j = (j + stride) % n) t += stride * DSm * (1 / Math.max(prof[j], 5) - 1 / Math.max(this.profile[j], 5))
    return t
  }
  /** Can the car, at `speed` from sample i0, still meet the plan `prof` over the next 250 m with a margin
   *  on its braking (the commit / back-out test for a move to a lane)? */
  canMeet(prof: Float32Array, i0: number, speed: number) {
    const tr = this.track
    const n = tr.n,
      DSm = tr.length / n
    const v2 = speed * speed
    if (v2 > prof[i0] * prof[i0] * 1.03) return false
    const stride = Math.max(1, Math.round(3 / DSm))
    for (let x = stride * DSm, j = (i0 + stride) % n; x < 250; x += stride * DSm, j = (j + stride) % n) {
      const vj = prof[j]
      if (vj * vj >= v2) continue
      const aCap = 0.75 * this.muBrk * (9.81 + 0.6 * this.clA_m * vj * vj)
      if (v2 - vj * vj > 2 * aCap * x) return false
    }
    return true
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

    // ---- traffic: lanes. Near another car the driver leaves the ideal line for the lane line on its
    // side (track.laneL / laneR: >= 2.5 m from the other lane, on the surface, with its own speed plan);
    // following: never closer than the braking distance allows (the car ahead may brake as hard as we
    // can), a short time gap behind it.
    let blockSpeed = Infinity
    let lo = -Infinity,
      hi = Infinity
    const aB = 0.7 * this.muBrk * (9.81 + 0.6 * this.clA_m * speed * speed)
    const i00 = tr.idx(this.s)
    // rejoining: off the usable width (grass, gravel, pit exit), or crawling back after a spin
    const bodySlip = speed > 3 ? Math.abs(Math.atan2(v.vel.x * v.left.x + v.vel.z * v.left.z, Math.abs(v.vel.x * v.fwd.x + v.vel.z * v.fwd.z))) : 0
    if (bodySlip > 0.6) this.recover = 6
    else this.recover = Math.max(0, this.recover - dt)
    const rejoin = this.d > tr.lineHi[i00] + 0.6 || this.d < tr.lineLo[i00] - 0.6 || (this.recover > 0 && speed < 20 && Math.abs(this.d - tr.racing[i00]) > 1.5)
    const safe = 8 + 0.15 * speed
    let blockerDs = Infinity,
      blockerD = 0,
      alongDs = Infinity,
      alongSide = 0,
      holdSide = 0,
      threat = false,
      anyBehind = false,
      wash = 0,
      squeezeL = Infinity,
      squeezeR = Infinity,
      squeezeDsL = 0,
      squeezeDsR = 0,
      clearBehind = true,
      blockerV = 0,
      blockerId = '',
      tgtDs = Infinity,
      concedeV = Infinity
    for (const o of traffic) {
      if (o.id === this.id) continue
      let ds = o.s - this.s
      if (ds < -tr.length / 2) ds += tr.length
      if (ds > tr.length / 2) ds -= tr.length
      const lat = o.d - this.d
      const alat = Math.abs(lat)
      if (o.id === this.attackId) tgtDs = ds
      // alongside with its nose ahead into a corner: its corner (lifts to it, applied below if a corner is near)
      // (a clear lift, so the pair resolves: otherwise both run on their lanes at lane pace, side by side)
      if (ds > 1.5 && ds < 7 && alat > 1.6 && alat < 9) concedeV = Math.min(concedeV, o.speed - 1)
      // which side of it we are on (ties broken by id, so the two cars agree)
      const mySide = lat < 0 || (lat === 0 && this.id > o.id) ? 1 : -1
      // a car much slower than us ahead (spun, sideways, crawling back) may lie across the track:
      // treat it as wider than a car on its line (a yellow flag: it may be coming back across)
      const pathW = o.speed < speed * 0.6 && speed > 10 ? 4.8 : 2.3
      if (ds > 0 && ds < 120 && alat < pathW) {
        const gap = ds - 4.8
        const gapMin = 1.2 + 0.18 * speed
        blockSpeed = Math.min(blockSpeed, Math.sqrt(Math.max(0, o.speed * o.speed + 2 * aB * (gap - gapMin))))
        // held up (within a few car lengths at similar speed) or closing: a car to pass
        if (ds < blockerDs && ds > 6 && ds < 20 + speed * 0.5 && (speed - o.speed > 0.3 || gap < gapMin + 6)) {
          blockerDs = ds
          blockerD = o.d
          blockerV = o.speed
          blockerId = o.id
        }
        // dirty air within ~1.5 car lengths (the physics' wake: front downforce lost, decaying over 10 m)
        if (gap < 12 && alat < 1.8) wash = Math.max(wash, 0.25 * Math.exp(-Math.max(0, gap) / 10) * Math.min(1, (o.speed * o.speed) / Math.max(1, speed * speed)))
      }
      // alongside (overlapping, within half a car length, or closing to that within ~1 s): each takes
      // the lane on its own side
      const closing = clamp(ds > 0 ? speed - o.speed : o.speed - speed, 0, 12)
      // (over the whole width: where the ideal line crosses the track, a car 7 m across is in the way a second later)
      if (Math.abs(ds) < 7 + closing && alat < 9) {
        if (Math.abs(ds) < alongDs) {
          alongDs = Math.abs(ds)
          alongSide = mySide
        }
        // a car on each side: three wide
        if (ds > -5 && alat < 4.5) {
          if (mySide > 0 && o.speed < squeezeR) {
            squeezeR = o.speed
            squeezeDsR = ds
          } else if (mySide < 0 && o.speed < squeezeL) {
            squeezeL = o.speed
            squeezeDsL = ds
          }
        }
      }
      // still sharing the road: hold the lane until it is a safe gap ahead or behind
      if (Math.abs(ds) < safe && alat < 9) holdSide = mySide
      if (ds < -6 && ds > -30 && alat < 2.5 && o.speed > speed + 0.3) threat = true
      if (ds < 0 && ds > -40) anyBehind = true
      if (ds < 0 && ds > -150) clearBehind = false
      // safety: keep a car's width from a car alongside, and when rejoining (pit exit, grass) from
      // any car coming up behind: merge behind it, not into it
      const soon = rejoin && ds <= -5.5 && ds > -60 && o.speed > speed - 2
      if (((ds > -5.5 && ds < 5.5) || soon) && alat >= 0.9) {
        if (lat > 0) hi = Math.min(hi, o.d - 2.4)
        else lo = Math.max(lo, o.d + 2.4)
      }
    }
    if (!anyBehind) this.defended = false
    this.aheadDs = blockerDs
    this.aheadV = blockerV
    this.aheadId = blockerId
    this.gate = 0
    let want = 0,
      wantSide = this.lane
    if (rejoin || (this.mode === 4 && Math.abs(this.d - this.nominalAt(i00)) > 1)) {
      // rejoin: through the lane on the side the car comes from, at that lane's speed
      if (this.mode !== 4 || this.lane === 0) {
        this.lane = this.d > 0 ? 1 : -1
        this.w = 1
      }
      this.mode = 4
      want = 1
      wantSide = this.lane
    } else if (squeezeL < Infinity && squeezeR < Infinity) {
      // in the middle of three wide: there are two lanes. Drop back, behind the car further ahead
      // (the one on the left if that is it: we take the left lane behind it)
      this.mode = 1
      blockSpeed = Math.min(blockSpeed, Math.min(squeezeL, squeezeR) - 3)
      want = 1
      wantSide = squeezeDsL > squeezeDsR ? 1 : -1
    } else if (alongSide !== 0) {
      this.mode = 1
      want = 1
      wantSide = alongSide
    } else if ((this.mode === 1 || this.mode === 2 || this.mode === 4) && holdSide !== 0 && (this.lane === holdSide || this.w < 0.02)) {
      // the car beside is not yet a safe gap away
      want = 1
      wantSide = holdSide
    } else if (this.mode === 2 && this.lane !== 0 && tgtDs > -safe && tgtDs < 30 + 0.6 * speed && (this.w > 0.5 || this.laneFree(traffic, this.lane, Math.max(0, tgtDs))) && (tgtDs < 7 || this.laneLoss(this.lane > 0 ? this.profL : this.profR, i00) < 0.25)) {
      // pulled out beside the car it attacks (no longer in its path): stay on the move, unless not yet
      // alongside and the lane runs into a corner where it only loses ground (back in behind)
      want = 1
      wantSide = this.lane
      this.gate = 5
    } else if (blockerDs < Infinity && tr.laneTwo[tr.idx(this.s + blockerDs)] && blockerDs - 4.8 > 1.2 + 0.18 * speed + 8 && this.mode !== 2) {
      // closing in its tow: stay in it, pull out late
      this.gate = 6
      this.mode = 0
    } else if (blockerDs < Infinity && tr.laneTwo[tr.idx(this.s + blockerDs)]) {
      // attack: to the lane away from the car ahead, only if its plan can still be met from here
      // the side whose lane loses least to the ideal line over the next corner (where a lane line runs
      // through a kink at a fraction of the ideal line's speed, a move there only loses ground), away
      // from the car ahead on a tie; no move where both lose more than ~0.25 s (wait in its tow)
      const ib = tr.idx(this.s + blockerDs)
      const away = tr.laneL[ib] - blockerD > blockerD - tr.laneR[ib] ? 1 : -1
      const cL = this.laneLoss(this.profL, i00),
        cR = this.laneLoss(this.profR, i00)
      let side = Math.abs(cL - cR) < 0.05 ? away : cL < cR ? 1 : -1
      if (!this.laneFree(traffic, side, blockerDs) && this.laneFree(traffic, -side, blockerDs)) side = -side
      if (Math.min(cL, cR) < 0.25 && (side > 0 ? cL : cR) < 0.25 && this.laneFree(traffic, side, blockerDs) && this.canMeet(side > 0 ? this.profL : this.profR, i00, speed)) {
        this.mode = 2
        want = 1
        wantSide = side
        this.gate = 5
        if (this.attackId === '') this.attackId = blockerId
      } else {
        this.gate = this.laneFree(traffic, side, blockerDs) ? 3 : 2
        this.mode = 0
      }
    } else if (this.mode === 3 && anyBehind) {
      want = 1
    } else if (threat && !this.defended && this.w < 0.02) {
      // defence: one early move to the inside lane of the next corner, then hold
      const side = this.insideSide(20, 160)
      if (side !== 0 && this.canMeet(side > 0 ? this.profL : this.profR, i00, speed)) {
        this.defended = true
        this.mode = 3
        want = 1
        wantSide = side
      } else this.mode = 0
    } else this.mode = 0
    if (this.mode !== 1 && this.mode !== 2) this.attackId = ''
    if (this.gate === 0 && blockerDs < Infinity && !tr.laneTwo[tr.idx(this.s + blockerDs)]) this.gate = 1
    // a change of side goes through the ideal line
    if (wantSide !== this.lane && this.w > 0.02) this.wTarget = 0
    else {
      this.lane = wantSide
      this.wTarget = this.lane === 0 ? 0 : want
    }
    // a corner or a braking zone within ~1.5 s: a lateral move there adds to what the tyres already do
    let cornerSoon = false
    for (let x = 0; x < 20 + speed * 1.5 && !cornerSoon; x += 6) {
      const j = tr.idx(this.s + x)
      cornerSoon = Math.max(Math.abs(tr.racingCurv[j]), Math.abs(this.curvAt(j))) > 1 / 250 || this.planAt(j) < speed - 4
    }
    // (at turn-in: the corner within ~0.6 s)
    if (concedeV < Infinity && Math.abs(this.curvAt(tr.idx(this.s + 0.6 * speed))) > 1 / 150) blockSpeed = Math.min(blockSpeed, concedeV)
    // back to the ideal line off the corners; with nobody around (free), gently through them too (a lane
    // line is ~4 % slower: held on it until the next straight, a car lost seconds a lap in clear air)
    // (except crossing over to make room for a car alongside on the side it was on: frozen part way, the
    // blend sat in that car's lane)
    if (this.wTarget < this.w && this.mode !== 4 && cornerSoon && !(this.mode === 1 && wantSide !== this.lane) && this.mode !== 0) this.wTarget = this.w
    // an attack starts before the braking zone, not in it (once half way over, it is committed)
    if (this.mode === 2 && this.wTarget > this.w && this.w < 0.5 && cornerSoon) {
      this.wTarget = this.w
      this.gate = 4
    }
    // blend rate: a smoothstep over the lane's distance D from the ideal line has a peak lateral
    // acceleration of 6 D rate^2, held to ~3 m/s^2 into a lane (urgent: a car alongside) and
    // ~1.5 m/s^2 back to the ideal line
    const dLane = Math.abs((this.lane > 0 ? tr.laneL[i00] : this.lane < 0 ? tr.laneR[i00] : tr.racing[i00]) - tr.racing[i00])
    const rate = clamp(Math.sqrt((this.wTarget > this.w && !cornerSoon ? (this.mode === 2 ? 5 : 3) : this.wTarget < this.w && cornerSoon && this.mode === 0 ? 0.6 : 1.5) / (6 * Math.max(0.5, dLane))), 0.15, 2)
    this.w = clamp(this.w + clamp(this.wTarget - this.w, -rate * dt, rate * dt), 0, 1)
    if (this.w < 1e-4 && this.wTarget === 0) {
      this.w = 0
      if (this.mode === 0) this.lane = 0
    }
    this.ws = this.w * this.w * (3 - 2 * this.w)
    this.lo = lo
    this.hi = hi

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
    const kFF = this.curvAt(tr.idx(this.s + 2 + speed * 0.2))
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
    // the plan of the line the car is on; pushed off it by a car alongside, the corner is tighter on the
    // inside, R' = R - o, so the grip-limited speed scales by sqrt(1 - k o)
    const iA = tr.idx(sA),
      iB = tr.idx(sA + dA)
    const kA = this.curvAt(iA),
      kB = this.curvAt(iB)
    let pa = this.planAt(iA) * Math.sqrt(clamp(1 - kA * (this.lineAt(iA) - this.nominalAt(iA)), 0.5, 1))
    let pb = this.planAt(iB) * Math.sqrt(clamp(1 - kB * (this.lineAt(iB) - this.nominalAt(iB)), 0.5, 1))
    // dirty air: the front downforce lost (share `wash`) takes the cornering speed from v^2 to
    // v^2 g / (g + rho clA wash v^2) on a grip-limited (front-limited) corner
    if (wash > 0.01) {
      const cl = 0.6 * this.clA_m * LAT_AERO_CAL * wash
      if (Math.abs(kA) > 1 / 400) pa *= Math.sqrt(9.81 / (9.81 + cl * pa * pa))
      if (Math.abs(kB) > 1 / 400) pb *= Math.sqrt(9.81 / (9.81 + cl * pb * pb))
    }
    // out-braking: committed to the inside of a car it attacks (within ~ a second of it or alongside), the
    // driver brakes to the lane's own apex speed nearer the tyres' peak than the plan's share
    // (BRAKE_SHARE -> REAR_BRAKE_SHARE with full attack): the same apex speed, a later braking point
    if (this.attackId !== '' && tgtDs < 25 && tgtDs > -5 && this.ws > 0.5 && pb < pa) {
      let vMin = pa
      for (let x = 0, j = iA; x < 200; x += 3 * DSm, j = (j + 3) % n) {
        const pj = this.planAt(j)
        if (pj < vMin) vMin = pj
        else if (pj > vMin + 5) break
      }
      const r = 1 + (REAR_BRAKE_SHARE / BRAKE_SHARE - 1) * clamp(this.attack, 0, 1)
      pa = Math.sqrt(vMin * vMin + (pa * pa - vMin * vMin) * r)
      pb = Math.sqrt(vMin * vMin + Math.max(0, pb * pb - vMin * vMin) * r)
    }
    let vt = pa
    // reduce target if off line (driving on the wrong part of the track): rejoining in a corner is a
    // tighter arc than the line's
    const lineErr = Math.abs(e)
    vt *= clamp(1 - Math.max(0, lineErr - 2) * 0.03 - Math.max(0, lineErr - 0.7) * Math.abs(kA) * 3, 0.75, 1)
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
    this.held = blockSpeed < vt
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
    // (not into the path of a car coming: wait until the road behind is clear)
    if (this.stuckTime > 3.5 && clearBehind) {
      this.stuckTime = 0
      this.reset(this.d > 0 ? 1 : -1)
      return
    }
    out.steer = steer
    out.throttle = throttle
    out.brake = brake
    out.handbrake = 0
  }

  /** Teleport back onto the track a little behind the current position: onto the racing line, or with
   *  `side` onto the lane line on that side, rejoining from there. */
  reset(side = 0) {
    const tr = this.track
    const s = this.s - 10
    const i = tr.idx(s)
    this.w = this.ws = side === 0 ? 0 : 1
    this.lane = side
    this.mode = side === 0 ? 0 : 4
    const p = tr.pointAt(s, side > 0 ? tr.laneL[i] : side < 0 ? tr.laneR[i] : tr.racing[i], { x: 0, y: 0, z: 0 })
    this.vehicle.reset(p.x, p.z, tr.headingAt(s), tr, true)
  }
}
