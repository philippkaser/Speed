// Full vehicle dynamics model.
//
// Sprung mass: 6-DOF rigid body (semi-implicit Euler, quaternion orientation).
// Each corner: unsprung mass with its own vertical DOF (wheel hop), spring, bilinear bump/rebound
//   damper, progressive bump stop, droop limit, anti-roll bar coupling, camber gain, roll-centre
//   force application, Ackermann + toe steering geometry.
// Tyres: transient combined-slip model (see tyre.ts) with thermal behaviour.
// Drivetrain: engine (torque map, turbo spool, limiter, engine braking) -> friction clutch ->
//   sequential gearbox -> clutch-pack LSD (preload + power/coast ramps) -> wheels, plus brakes.
//   Solved as velocity constraints with projected Gauss-Seidel impulses so that clutch lock-up,
//   diff lock and wheel lock-up all emerge from friction limits instead of special cases.
// Aero: drag + front/rear downforce with ride height / rake / yaw sensitivity, slipstream.
import { EngineState, engineTorque } from './engine'
import { type Ground, type GroundSample, makeSample, Surface, SURFACES } from './ground'
import { clamp, lerp, M3, Quat, smoothstep, V3, valueNoise2, DEG, RADS_TO_RPM } from './math'
import { COMPOUNDS, type CarSetup, type CarSpec, type CompoundSpec, cornerSprungMass, GRAVITY, type TyreSpec } from './spec'
import { Kinematics, defaultGeometry } from './kinematics'
import { TyreModel, TyreState, updateTyre } from './tyre'

export interface VehicleInput {
  steer: number // -1 (left) .. 1 (right)
  throttle: number // 0..1
  brake: number // 0..1
  handbrake: number // 0..1
  clutch: number // 0..1 pedal (0 = engaged). Ignored unless > 0
  shiftUp: boolean
  shiftDown: boolean
}

export interface Assists {
  abs: boolean
  tc: number // 0 = off, 1..5 (5 = most intrusive)
  steering: number // 0..1 steering assist strength (controllers / keyboard)
  autoGear: boolean
  stability: boolean
}

export const DEFAULT_ASSISTS: Assists = { abs: true, tc: 2, steering: 0.7, autoGear: false, stability: false }

export function makeInput(): VehicleInput {
  return { steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0, shiftUp: false, shiftDown: false }
}

const AIR_DENSITY = 1.2

export class Wheel {
  readonly front: boolean
  readonly left: boolean
  // body-frame geometry
  x = 0
  z = 0
  yHubStatic = 0
  radius = 0.33
  unsprungMass = 30
  // suspension params
  k = 100000
  bump = 5000
  rebound = 8000
  knee = 0.12
  bumpStopRate = 2e7
  bumpStopAt = 0.05
  cStatic = 0.02
  cMax = 0.1
  cMin = 0
  arb = 0
  camberStatic = 0
  camberGain = 0
  toe = 0
  rollCenter = 0.05
  brakeMax = 2000
  inertia = 1.2
  // state
  c = 0 // compression from full droop (m)
  vWheel = 0 // absolute wheel velocity along body up (m/s)
  omega = 0
  spin = 0 // visual rotation angle
  steer = 0 // road wheel angle (rad, + left)
  deflPrev = 0
  contact = false
  surface: Surface = Surface.Asphalt
  sample: GroundSample = makeSample()
  tyre = new TyreState()
  model!: TyreModel
  absFactor = 1
  kin!: Kinematics
  envelopeX = 0 // longitudinal position of the effective contact (enveloping), m
  flatSpot = 0 // depth of a flat spot ground into the tread by locking up (m)
  flatAngle = 0 // wheel rotation angle where the flat spot sits
  defl = 0
  brakeTemp = 120
  brakeTorque = 0
  driveTorque = 0
  springForce = 0
  lean = 0
  // world-space outputs (for rendering / effects)
  hub = new V3()
  contactPoint = new V3()
  normal = new V3(0, 1, 0)
  constructor(
    public index: number,
    front: boolean,
    left: boolean,
  ) {
    this.front = front
    this.left = left
  }
}

/** Collision probe points in body frame */
interface HullPoint {
  x: number
  y: number
  z: number
}

export interface VehicleEnv {
  slipstream: number // 0..1 drag reduction factor from car ahead
}

const _env = new Float64Array(8)
const _t1 = new V3(),
  _t2 = new V3(),
  _t3 = new V3(),
  _r = new V3(),
  _f = new V3(),
  _tf = new V3(),
  _tl = new V3(),
  _n = new V3(),
  _vc = new V3(),
  _hub = new V3(),
  _app = new V3(),
  _tq = new V3()

const tyreCache = new Map<string, TyreModel>()
/** Tyre models are stateless and calibrated once per (tyre, compound). */
function tyreModel(spec: TyreSpec, compound: CompoundSpec) {
  const key = `${spec.radius}:${spec.width}:${spec.vertStiffness}:${spec.relaxLat}:${compound.id}`
  let m = tyreCache.get(key)
  if (!m) tyreCache.set(key, (m = new TyreModel(spec, compound)))
  return m
}

export class Vehicle {
  spec: CarSpec
  setup: CarSetup
  assists: Assists = { ...DEFAULT_ASSISTS }
  // rigid body (sprung mass)
  mass = 1000
  invMass = 0.001
  inertia = new V3(1, 1, 1) // body-frame principal (x pitch, y yaw, z roll)
  pos = new V3()
  vel = new V3()
  q = new Quat()
  w = new V3()
  R = new M3()
  // axes (world)
  left = new V3(1, 0, 0)
  up = new V3(0, 1, 0)
  fwd = new V3(0, 0, 1)
  // forces accumulators
  F = new V3()
  T = new V3()

  wheels: Wheel[]
  engine = new EngineState()
  gear = 1
  shiftTimer = 0
  shiftDir = 0
  pendingGear = 1
  clutchEngage = 0
  clutchSlip = 0
  clutchTorque = 0
  reverseTimer = 0
  tcCut = 0
  tcActive = false
  absActive = false
  // derived params
  a = 1.3 // CoG to front axle
  b = 1.4 // CoG to rear axle
  clAF = 0
  clAR = 0
  cdA = 0
  downforce = 0
  dragForce = 0
  // processed inputs
  throttle = 0
  brake = 0
  steerInput = 0
  // telemetry
  speed = 0
  accelLong = 0 // g
  accelLat = 0 // g
  private prevVel = new V3()
  private rand = 1
  odometer = 0
  hull: HullPoint[] = []
  scrape = 0 // 0..1 body/ground scraping intensity (sparks)
  /** 2 = full 5x3 enveloping contact (player), 1 = reduced 3x1 (AI) */
  contactQuality = 1
  /** steering rack: sum of kingpin moments of the front wheels (N m, + = yaw left) */
  rackTorque = 0
  /** force feedback signal for the steering wheel, -1..1 (+ = pulls the wheel to the right) */
  ffb = 0
  /** high frequency road / kerb texture for FFB and rumble, 0..1 */
  roadFeel = 0
  private frontLoadPrev = 0
  aeroBalance = 0.5
  rideHeightF = 0
  rideHeightR = 0
  impact = 0 // last impact impulse (N s)
  onTrackSurface = true

  constructor(spec: CarSpec, setup?: CarSetup) {
    this.spec = spec
    this.setup = { ...(setup ?? spec.defaultSetup) }
    this.wheels = [new Wheel(0, true, true), new Wheel(1, true, false), new Wheel(2, false, true), new Wheel(3, false, false)]
    this.applySetup(this.setup)
  }

  /** (Re)derive all physical parameters from spec + setup. Keeps dynamic state. */
  applySetup(setup: CarSetup) {
    this.setup = { ...setup }
    const sp = this.spec
    const st = this.setup
    const unsprung = 2 * (sp.suspFront.unsprungMass + sp.suspRear.unsprungMass)
    const totalMass = sp.mass + st.ballast
    this.mass = totalMass - unsprung
    this.invMass = 1 / this.mass
    this.b = sp.wheelbase * sp.weightFront
    this.a = sp.wheelbase - this.b
    const m = this.mass
    const iyaw = m * this.a * this.b * 0.92 * sp.inertiaScale[1]
    this.inertia.set(iyaw * 0.94 * sp.inertiaScale[0], iyaw, m * ((sp.width * 0.8) ** 2 + (sp.height * 0.7) ** 2) / 12 * sp.inertiaScale[2])

    const compound = COMPOUNDS[st.compound] ?? COMPOUNDS.RM
    const rhF = st.rideHeightF / 1000,
      rhR = st.rideHeightR / 1000
    const rhNomF = sp.defaultSetup.rideHeightF / 1000,
      rhNomR = sp.defaultSetup.rideHeightR / 1000
    // CoG height shifts with average ride height change
    const cg = sp.cgHeight + ((rhF - rhNomF) + (rhR - rhNomR)) * 0.5

    for (const wh of this.wheels) {
      const axle = wh.front ? sp.suspFront : sp.suspRear
      const tyre = wh.front ? sp.tyreFront : sp.tyreRear
      const track = wh.front ? sp.trackFront : sp.trackRear
      wh.x = (wh.left ? 1 : -1) * track * 0.5
      wh.z = wh.front ? this.a : -this.b
      wh.radius = tyre.radius
      wh.unsprungMass = axle.unsprungMass
      wh.inertia = tyre.inertia
      wh.k = (wh.front ? st.springF : st.springR) * 1000
      wh.bump = wh.front ? st.bumpF : st.bumpR
      wh.rebound = wh.front ? st.reboundF : st.reboundR
      wh.knee = axle.fastKnee
      wh.arb = (wh.front ? st.arbF : st.arbR) * 1000
      wh.bumpStopRate = axle.bumpStopRate
      wh.camberStatic = (wh.front ? st.camberF : st.camberR) * DEG
      wh.camberGain = axle.camberGain / 0.01 * DEG // spec is deg per cm -> rad per m
      wh.toe = (wh.front ? st.toeF : st.toeR) * DEG
      wh.rollCenter = axle.rollCenter
      const cornerLoad = cornerSprungMass(sp, wh.front, st) * GRAVITY
      wh.cStatic = cornerLoad / wh.k
      wh.bumpStopAt = wh.cStatic + axle.bumpTravel
      wh.cMax = wh.bumpStopAt + 0.03
      // droop: limit how far the wheel can drop below static
      const droop = axle.droopTravel
      wh.cMin = Math.max(0, wh.cStatic - droop)
      const totalCorner = cornerLoad + axle.unsprungMass * GRAVITY
      const defl = totalCorner / tyre.vertStiffness
      const rh = wh.front ? rhF : rhR
      // hub height above ground at static = radius - deflection; body CoG is at cg above ground
      // ride-height rake moves each axle's hub relative to the CoG
      const rhNom = wh.front ? rhNomF : rhNomR
      // hub sits (cg_axle - (r - defl)) below the CoG, where cg_axle includes rake
      wh.yHubStatic = -((cg + (rh - rhNom) - ((rhF - rhNomF) + (rhR - rhNomR)) * 0.5) - (tyre.radius - defl))
      wh.model = tyreModel(tyre, compound)
      const kind = sp.bodyStyle === 'coupe' ? (wh.front ? 'gtF' : 'gtR') : wh.front ? 'gt3F' : 'gt3R'
      wh.kin = new Kinematics(defaultGeometry(track * 0.5, tyre.radius, kind), cg, sp.wheelbase)
      wh.tyre.coldPressure = wh.front ? st.pressureF : st.pressureR
      wh.tyre.updatePressure()
      if (wh.c === 0) wh.c = wh.cStatic
    }
    const totalBrake = sp.brakeTorque * st.brakePressure
    for (const wh of this.wheels) wh.brakeMax = (totalBrake * (wh.front ? st.brakeBias : 1 - st.brakeBias)) / 2

    const ae = sp.aero
    const addF = st.wingF * ae.wingFrontStep
    const addR = st.wingR * ae.wingRearStep
    this.clAF = ae.clAFront + addF
    this.clAR = ae.clARear + addR
    this.cdA = ae.cdA + ae.dragPerDownforce * (addF + addR)

    // collision hull (body frame, relative to CoG)
    const L = sp.length,
      W = sp.width * 0.5
    const zf = this.a + sp.frontOverhang,
      zr = -(this.b + sp.rearOverhang)
    const yb = -cg + 0.07,
      yt = -cg + sp.height,
      ym = -cg + 0.45
    this.hull = []
    for (const [x, z] of [
      [W * 0.78, zf],
      [-W * 0.78, zf],
      [W, zf - 0.55],
      [-W, zf - 0.55],
      [W, 0],
      [-W, 0],
      [W, zr + 0.4],
      [-W, zr + 0.4],
      [W * 0.85, zr],
      [-W * 0.85, zr],
      [0, zf + 0.05],
      [0, zr - 0.02],
    ]) {
      this.hull.push({ x, y: ym, z })
    }
    // underfloor + roof probes for ground contact
    for (const [x, z] of [
      [W * 0.8, zf - 0.15],
      [-W * 0.8, zf - 0.15],
      [W * 0.85, 0],
      [-W * 0.85, 0],
      [W * 0.8, zr + 0.15],
      [-W * 0.8, zr + 0.15],
      [0, zf - 0.1],
      [0, zr + 0.1],
    ])
      this.hull.push({ x, y: yb, z })
    for (const [x, z] of [
      [W * 0.6, 0.5],
      [-W * 0.6, 0.5],
      [W * 0.6, -0.8],
      [-W * 0.6, -0.8],
    ])
      this.hull.push({ x, y: yt, z })
    void L
  }

  /** Place the car at rest on the ground at the given position and heading (yaw, rad). */
  reset(x: number, z: number, yaw: number, ground: Ground) {
    const s = makeSample()
    ground.sample(x, z, s)
    this.q.setFromAxisAngle(0, 1, 0, yaw)
    // align to ground normal
    const n = _t1.set(s.nx, s.ny, s.nz)
    const ang = Math.acos(clamp(n.y, -1, 1))
    if (ang > 1e-4) {
      const ax = _t2.set(n.z, 0, -n.x).normalize()
      const tilt = new Quat().setFromAxisAngle(ax.x, ax.y, ax.z, ang)
      tilt.multiply(this.q)
      this.q.copy(tilt)
    }
    this.R.setFromQuat(this.q)
    const w0 = this.wheels[0],
      w2 = this.wheels[2]
    // CoG height above ground at static: hub depth below CoG + loaded radius (~12 mm tyre deflection)
    const cg = (-w0.yHubStatic + w0.radius + (-w2.yHubStatic + w2.radius)) * 0.5 - 0.012
    this.R.col(1, _t3)
    this.pos.set(x, s.height, z).addScaled(_t3, cg)
    this.vel.set(0, 0, 0)
    this.w.set(0, 0, 0)
    for (const wh of this.wheels) {
      wh.c = wh.cStatic
      wh.vWheel = 0
      wh.omega = 0
      wh.tyre.reset(72, wh.tyre.coldPressure)
      wh.tyre.surfTemp = wh.tyre.coreTemp = 72
      wh.deflPrev = 0
      wh.sample.hint = -1
      wh.absFactor = 1
      wh.brakeTemp = 180
      wh.flatSpot = 0
    }
    this.engine.omega = this.spec.engine.idleRpm * (Math.PI / 30)
    this.engine.boost = 0
    this.gear = 1
    this.shiftTimer = 0
    this.pendingGear = 1
    this.tcCut = 0
    this.prevVel.set(0, 0, 0)
    this.updateAxes()
    this.updateWheelWorld()
  }

  setVelocityForward(speed: number) {
    this.vel.copy(this.fwd).scale(speed)
    for (const wh of this.wheels) wh.omega = speed / wh.radius
    const g = this.currentRatio()
    if (g !== 0) this.engine.omega = Math.max(this.engine.omega, (speed / this.wheels[2].radius) * g)
  }

  updateAxes() {
    this.R.setFromQuat(this.q)
    this.R.col(0, this.left)
    this.R.col(1, this.up)
    this.R.col(2, this.fwd)
  }

  currentRatio() {
    if (this.gear === 0) return 0
    const fd = this.setup.finalDrive
    if (this.gear < 0) return this.spec.reverse * fd
    return this.spec.gears[this.gear - 1] * fd
  }

  ratioFor(gear: number) {
    if (gear === 0) return 0
    const fd = this.setup.finalDrive
    if (gear < 0) return this.spec.reverse * fd
    return this.spec.gears[gear - 1] * fd
  }

  get rpm() {
    return this.engine.omega * RADS_TO_RPM
  }

  get gearCount() {
    return this.spec.gears.length
  }

  requestShift(dir: number) {
    if (this.shiftTimer > 0) return
    const next = clamp(this.gear + dir, -1, this.spec.gears.length)
    if (next === this.gear) return
    // protect from over-rev on downshift
    if (dir < 0 && next > 0) {
      const wheelOmega = (this.wheels[2].omega + this.wheels[3].omega) * 0.5
      const rpmAfter = Math.abs(wheelOmega * this.ratioFor(next)) * RADS_TO_RPM
      if (rpmAfter > this.spec.engine.maxRpm - 150) return
    }
    if (next === -1 && this.speed > 3) return
    this.pendingGear = next
    this.shiftDir = dir
    this.shiftTimer = this.spec.shiftTime
  }

  // ------------------------------------------------------------------------------------------
  step(h: number, input: VehicleInput, ground: Ground, env?: VehicleEnv) {
    const sp = this.spec
    this.updateAxes()
    const up = this.up
    const fwd = this.fwd
    this.F.set(0, -GRAVITY * this.mass, 0)
    this.T.set(0, 0, 0)
    this.rand = (this.rand * 16807) % 2147483647
    const rnd = this.rand / 2147483647

    // body velocity in body frame
    const vBody = this.R.applyT(this.vel, _t1)
    const vf = vBody.z
    const vbx = vBody.x
    this.speed = this.vel.len()

    // ---------------------------------------------------------------- controls & gearbox
    let throttle = clamp(input.throttle, 0, 1)
    let brake = clamp(input.brake, 0, 1)
    if (this.assists.autoGear) {
      this.autoGearbox(throttle, brake, h)
      if (this.gear === -1) {
        // in reverse the pedals swap like most racing games
        const t = throttle
        throttle = brake
        brake = t
      }
    } else {
      if (input.shiftUp) this.requestShift(1)
      if (input.shiftDown) this.requestShift(-1)
    }

    // shifting: ignition cut on upshift, auto-blip on downshift
    let shiftCut = 0
    let blip = -1
    if (this.shiftTimer > 0) {
      const t = 1 - this.shiftTimer / sp.shiftTime
      if (t > 0.45 && this.gear !== this.pendingGear) this.gear = this.pendingGear
      shiftCut = 1
      if (this.shiftDir < 0 && this.gear > 0) {
        const wheelOmega = (this.wheels[2].omega + this.wheels[3].omega) * 0.5
        const targetOmega = Math.abs(wheelOmega * this.ratioFor(this.pendingGear)) * 1.04
        blip = this.engine.omega < targetOmega ? 1 : 0
      }
      this.shiftTimer -= h
      if (this.shiftTimer <= 0) {
        this.shiftTimer = 0
        this.gear = this.pendingGear
      }
    }

    // traction control (driven wheel slip)
    const rl = this.wheels[2],
      rr = this.wheels[3]
    const peakK = rl.model.compound.peakSlipRatio
    const driveSlip = Math.max(rl.tyre.slipRatio, rr.tyre.slipRatio)
    if (this.assists.tc > 0 && this.speed > 2) {
      // level 1 allows 1.5x peak slip ratio, level 5 holds the tyre right at the peak
      const thr = peakK * (1.0 + 0.5 / this.assists.tc)
      const over = driveSlip - thr
      this.tcCut = clamp(this.tcCut + (over > 0 ? over * 90 + 4 : -5) * h, 0, 0.95)
    } else this.tcCut = Math.max(0, this.tcCut - h * 5)
    this.tcActive = this.tcCut > 0.04
    throttle *= 1 - this.tcCut

    let engThrottle = throttle
    if (shiftCut && this.shiftDir > 0) engThrottle = 0
    if (blip >= 0) engThrottle = blip
    this.throttle = throttle
    this.brake = brake

    // clutch engagement
    let engage = 1
    const eng = sp.engine
    const rpm = this.engine.omega * RADS_TO_RPM
    if (this.gear === 0) engage = 0
    else {
      // centrifugal style auto clutch: slips near idle so the car can launch and never stalls
      if (this.speed < 6) {
        engage = smoothstep(eng.idleRpm + 120, eng.idleRpm + 1700, rpm)
        if (throttle < 0.02) engage = Math.min(engage, smoothstep(eng.idleRpm + 200, eng.idleRpm + 900, rpm))
      } else engage = smoothstep(eng.idleRpm - 250, eng.idleRpm + 250, rpm)
      if (input.clutch > 0) engage = Math.min(engage, 1 - input.clutch)
    }
    if (this.shiftTimer > 0) {
      const t = 1 - this.shiftTimer / sp.shiftTime
      engage *= t < 0.15 ? 1 - t / 0.15 : t > 0.65 ? (t - 0.65) / 0.35 : 0
    }
    this.clutchEngage = engage

    // steering: driver input -> road wheel angles
    let delta = -clamp(input.steer, -1, 1) * sp.steerLock
    if (this.assists.steering > 0) {
      const fa = this.a
      // velocity direction at the front axle relative to heading
      const vxF = vbx + this.wBodyY() * fa
      const beta = Math.atan2(vxF, Math.max(Math.abs(vf), 0.5))
      const speedBlend = smoothstep(4, 26, Math.abs(vf))
      const blend = speedBlend * this.assists.steering
      // the slip-angle limit engages fully from ~60% assist; counter-steer scales with strength
      const limitBlend = speedBlend * Math.min(1, this.assists.steering * 1.65)
      const peakA = this.wheels[0].model.compound.peakSlipAngle * 1.15
      const limit = lerp(sp.steerLock, Math.min(sp.steerLock, peakA), limitBlend)
      delta = -clamp(input.steer, -1, 1) * limit + beta * 0.9 * blend * (vf > 0 ? 1 : 0)
      delta = clamp(delta, -sp.steerLock, sp.steerLock)
    }
    this.steerInput = delta / sp.steerLock
    this.applySteering(delta)

    // ---------------------------------------------------------------- aero
    const vf2 = vf * vf
    const slip = env?.slipstream ?? 0
    const q = 0.5 * AIR_DENSITY
    let rhF = 0,
      rhR = 0
    {
      const w0 = this.wheels[0],
        w1 = this.wheels[1],
        w2 = this.wheels[2],
        w3 = this.wheels[3]
      rhF = this.setup.rideHeightF / 1000 - ((w0.c - w0.cStatic) + (w1.c - w1.cStatic)) * 0.5
      rhR = this.setup.rideHeightR / 1000 - ((w2.c - w2.cStatic) + (w3.c - w3.cStatic)) * 0.5
    }
    // aero map: ground effect (grows towards the ground, stalls when too low), rake moves the
    // centre of pressure forward, yaw and roll spoil the underbody, dirty air robs the front most
    const ae = sp.aero
    const ref = ae.refRideHeight
    const gScale = ae.rideSens / 2.6
    const groundEffect = (hgt: number, refH: number, stall: number) => {
      let g = Math.pow(refH / Math.max(hgt, 0.004), 0.42 * gScale)
      g *= 1 - 0.32 * (1 - smoothstep(stall * 0.5, stall, hgt))
      return clamp(g, 0.5, 1.45)
    }
    this.rideHeightF = rhF
    this.rideHeightR = rhR
    const rake = rhR - rhF
    const beta = this.speed > 2 ? Math.atan2(Math.abs(vbx), Math.max(Math.abs(vf), 0.5)) : 0
    const yawFactor = Math.max(0.25, Math.cos(beta) ** 2 * (1 - 0.9 * Math.min(beta, 0.5)))
    const rollAng = (this.wheels[0].c - this.wheels[1].c + this.wheels[2].c - this.wheels[3].c) / (sp.trackFront + sp.trackRear)
    const rollFactor = clamp(1 - 6 * rollAng * rollAng, 0.7, 1)
    const dfF = q * this.clAF * groundEffect(rhF, ref, 0.03) * (1 + 1.4 * rake) * vf2 * yawFactor * rollFactor * (1 - slip * 0.25)
    const dfR = q * this.clAR * groundEffect(rhR * 0.85 + rhF * 0.15, ref * 1.05, 0.035) * (1 - 0.7 * rake) * vf2 * yawFactor * rollFactor * (1 - slip * 0.1)
    this.downforce = dfF + dfR
    this.aeroBalance = this.downforce > 1 ? dfF / this.downforce : this.clAF / (this.clAF + this.clAR)
    // downforce along -up at axle positions
    this.applyBodyForceAtLocal(0, 0, this.a, -dfF, up)
    this.applyBodyForceAtLocal(0, 0, -this.b, -dfR, up)
    // drag
    const cd = this.cdA * (1 - slip * 0.38) * (1 + 2.5 * beta * beta)
    const spd = this.speed
    _f.copy(this.vel).scale(-q * cd * spd)
    this.dragForce = q * cd * spd * spd
    this.R.apply(0, ae.dragHeight, 0, _r)
    this.F.add(_f)
    this.T.add(_tq.crossVectors(_r, _f))

    // ---------------------------------------------------------------- wheels
    this.absActive = false
    this.rackTorque = 0
    const handbrakeT = input.handbrake * sp.handbrakeTorque
    let onTrack = 0
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i]
      this.wheelForces(wh, h, ground, brake, i >= 2 ? handbrakeT * 0.5 : 0)
      if (wh.surface === Surface.Asphalt || wh.surface === Surface.Kerb || wh.surface === Surface.Pit) onTrack++
    }
    this.onTrackSurface = onTrack >= 2
    // force feedback: kingpin moments through the (assisted) rack, plus road texture
    {
      const target = clamp(-this.rackTorque / 520, -1.2, 1.2)
      this.ffb += (target - this.ffb) * clamp(h * 60, 0, 1)
      const fl = this.wheels[0].tyre.Fz + this.wheels[1].tyre.Fz
      const dF = Math.abs(fl - this.frontLoadPrev) / Math.max(h, 1e-4)
      this.frontLoadPrev = fl
      this.roadFeel += (clamp(dF / 4e5, 0, 1) - this.roadFeel) * clamp(h * 25, 0, 1)
    }

    // ---------------------------------------------------------------- drivetrain
    this.solveDrivetrain(h, engThrottle, engage, rnd)

    // ---------------------------------------------------------------- integrate body
    this.vel.addScaled(this.F, this.invMass * h)
    // angular: w += I_world^-1 * T * h  (computed in body frame)
    const Tb = this.R.applyT(this.T, _t2)
    const wb = this.R.applyT(this.w, _t3)
    const I = this.inertia
    // gyroscopic term w x (I w)
    const Iwx = I.x * wb.x,
      Iwy = I.y * wb.y,
      Iwz = I.z * wb.z
    const gx = wb.y * Iwz - wb.z * Iwy,
      gy = wb.z * Iwx - wb.x * Iwz,
      gz = wb.x * Iwy - wb.y * Iwx
    wb.x += ((Tb.x - gx) / I.x) * h
    wb.y += ((Tb.y - gy) / I.y) * h
    wb.z += ((Tb.z - gz) / I.z) * h
    this.R.apply(wb.x, wb.y, wb.z, this.w)
    this.pos.addScaled(this.vel, h)
    this.q.integrate(this.w, h)
    this.updateAxes()

    // ---------------------------------------------------------------- unsprung integration
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i]
      this.R.apply(wh.x, wh.yHubStatic + (wh.c - wh.cStatic), wh.z, _r)
      const vAtt = this.pointVelocityAlong(_r, this.up)
      wh.c += (wh.vWheel - vAtt) * h
      if (wh.c < wh.cMin) {
        wh.c = wh.cMin
        if (wh.vWheel < vAtt) wh.vWheel = vAtt
      } else if (wh.c > wh.cMax) {
        // hard bottoming: transfer the unsprung momentum to the body
        const dv = wh.vWheel - vAtt
        wh.c = wh.cMax
        if (dv > 0) {
          this.applyImpulse(_r, _t1.copy(this.up).scale(dv * wh.unsprungMass))
          wh.vWheel = vAtt
        }
      }
      wh.spin += wh.omega * h
      if (wh.spin > 1e4) wh.spin -= Math.PI * 2 * Math.floor(wh.spin / (Math.PI * 2))
      if (wh.spin < -1e4) wh.spin += Math.PI * 2 * Math.floor(-wh.spin / (Math.PI * 2))
    }
    this.updateWheelWorld()

    // ---------------------------------------------------------------- telemetry
    const ax = (this.vel.x - this.prevVel.x) / h,
      ay = (this.vel.y - this.prevVel.y) / h,
      az = (this.vel.z - this.prevVel.z) / h
    this.prevVel.copy(this.vel)
    const along = (ax * fwd.x + ay * fwd.y + az * fwd.z) / GRAVITY
    const lat = (ax * this.left.x + ay * this.left.y + az * this.left.z) / GRAVITY
    const k = clamp(h * 12, 0, 1)
    this.accelLong += (along - this.accelLong) * k
    this.accelLat += (lat - this.accelLat) * k
    this.odometer += this.speed * h
  }

  private wBodyY() {
    return this.w.x * this.up.x + this.w.y * this.up.y + this.w.z * this.up.z
  }

  private applySteering(delta: number) {
    const sp = this.spec
    const L = sp.wheelbase
    const t = sp.trackFront
    let dl = delta,
      dr = delta
    if (Math.abs(delta) > 1e-4) {
      const Rr = L / Math.tan(Math.abs(delta))
      const inner = Math.atan(L / Math.max(Rr - t / 2, 0.5))
      const outer = Math.atan(L / (Rr + t / 2))
      const ack = sp.ackermann
      const sgn = delta > 0 ? 1 : -1
      // positive delta = left turn: left wheel is the inner one
      const innerA = sgn * lerp(Math.abs(delta), inner, ack)
      const outerA = sgn * lerp(Math.abs(delta), outer, ack)
      if (delta > 0) {
        dl = innerA
        dr = outerA
      } else {
        dr = innerA
        dl = outerA
      }
    }
    const [fl, fr, rl, rr] = this.wheels
    // toe-in: left wheel points right (negative), right wheel points left
    fl.steer = dl - fl.toe
    fr.steer = dr + fr.toe
    rl.steer = -rl.toe
    rr.steer = rr.toe
  }

  private autoGearbox(throttle: number, brake: number, h: number) {
    const sp = this.spec
    const eng = sp.engine
    if (this.shiftTimer > 0) return
    // reverse handling
    if (this.gear === -1) {
      if (throttle > 0.1 && this.speed < 2) this.requestShift(1)
      return
    }
    if (this.speed < 1 && brake > 0.4 && throttle < 0.05) {
      this.reverseTimer += h
      if (this.reverseTimer > 0.6 && this.gear === 1) {
        this.gear = -1
        this.pendingGear = -1
        this.reverseTimer = 0
      }
      return
    }
    this.reverseTimer = 0
    if (this.gear === 0) {
      this.gear = 1
      return
    }
    const rpm = this.rpm
    const wheelOmega = (this.wheels[2].omega + this.wheels[3].omega) * 0.5
    const slipping = Math.max(this.wheels[2].tyre.slipRatio, this.wheels[3].tyre.slipRatio) > 0.25
    // early upshifts when cruising, at the limiter when pushing
    const upRpm = lerp(eng.idleRpm + 2800, eng.limiterRpm - 180, smoothstep(0.3, 0.85, throttle))
    if (rpm > upRpm && this.gear < sp.gears.length && !slipping && this.clutchEngage > 0.9) {
      this.requestShift(1)
      return
    }
    if (this.gear > 1) {
      const rpmDown = Math.abs(wheelOmega * this.ratioFor(this.gear - 1)) * RADS_TO_RPM
      const threshold = throttle > 0.6 ? eng.limiterRpm - 700 : eng.limiterRpm * (brake > 0.2 ? 0.78 : 0.55)
      if (rpmDown < threshold) this.requestShift(-1)
    }
  }

  private applyBodyForceAtLocal(lx: number, ly: number, lz: number, mag: number, dir: V3) {
    this.R.apply(lx, ly, lz, _r)
    _f.copy(dir).scale(mag)
    this.F.add(_f)
    this.T.add(_tq.crossVectors(_r, _f))
  }

  /** velocity of a body point (r relative to CoG, world) projected on dir */
  private pointVelocityAlong(r: V3, dir: V3) {
    const w = this.w
    const vx = this.vel.x + (w.y * r.z - w.z * r.y)
    const vy = this.vel.y + (w.z * r.x - w.x * r.z)
    const vz = this.vel.z + (w.x * r.y - w.y * r.x)
    return vx * dir.x + vy * dir.y + vz * dir.z
  }

  pointVelocity(r: V3, out: V3) {
    out.crossVectors(this.w, r).add(this.vel)
    return out
  }

  /** Apply an impulse J (world) at body point r (relative to CoG, world). */
  applyImpulse(r: V3, J: V3) {
    this.vel.addScaled(J, this.invMass)
    const t = _tq.crossVectors(r, J)
    const tb = this.R.applyT(t, _t2)
    tb.x /= this.inertia.x
    tb.y /= this.inertia.y
    tb.z /= this.inertia.z
    this.R.apply(tb.x, tb.y, tb.z, _t3)
    this.w.add(_t3)
  }

  /** Effective inverse mass of the body at r along unit direction n. */
  invMassAt(r: V3, n: V3) {
    const rxn = _t1.crossVectors(r, n)
    const b = this.R.applyT(rxn, _t2)
    const I = this.inertia
    return this.invMass + (b.x * b.x) / I.x + (b.y * b.y) / I.y + (b.z * b.z) / I.z
  }

  private wheelForces(wh: Wheel, h: number, ground: Ground, brake: number, handbrake: number) {
    const up = this.up
    const side = wh.left ? 1 : -1
    const kin = wh.kin
    const travel = wh.c - wh.cStatic
    // hub position incl. kinematic track change
    const lat = wh.x + side * kin.trackAt(travel)
    this.R.apply(lat, wh.yHubStatic + travel, wh.z, _r)
    _hub.copy(this.pos).add(_r)
    ground.sample(_hub.x, _hub.z, wh.sample)
    const s = wh.sample
    wh.surface = s.surface
    const surf = SURFACES[s.surface]
    _n.set(s.nx, s.ny, s.nz)

    // wheel heading incl. bump steer (toe-in +)
    const steer = wh.steer - side * kin.bumpSteer * travel
    const sinS = Math.sin(steer),
      cosS = Math.cos(steer)
    _tf.copy(this.fwd).scale(cosS).addScaled(this.left, sinS)
    let hx = _tf.x,
      hz = _tf.z
    const hl = Math.hypot(hx, hz) || 1
    hx /= hl
    hz /= hl

    // ------------------------------------------------------------ enveloping contact
    const R = wh.radius
    const hiQ = this.contactQuality >= 2 && ground.heightNear
    const NL = hiQ ? 3 : 1
    const NX = ground.heightNear ? (hiQ ? 5 : 3) : 1
    const spanX = R * 0.44
    const spanY = wh.model.spec.width * 0.32
    const rough = surf.roughness
    let deflSum = 0,
      xSum = 0,
      wSum = 0,
      dLeft = 0,
      dRight = 0
    for (let l = 0; l < NL; l++) {
      const yl = NL === 1 ? 0 : (l - 1) * spanY
      // lateral offset along the wheel's left axis (horizontal)
      const ox = hz * yl,
        oz = -hx * yl
      let mx = -1e9
      for (let k = 0; k < NX; k++) {
        const xk = NX === 1 ? 0 : (k / (NX - 1) - 0.5) * 2 * spanX
        const px = _hub.x + hx * xk + ox,
          pz = _hub.z + hz * xk + oz
        let g = NX === 1 ? s.height : ground.heightNear!(s, px, pz)
        if (rough > 0) g += (valueNoise2(px * surf.roughnessFreq, pz * surf.roughnessFreq) - 0.5) * 2 * rough
        // flat spot: the tread is shorter where it was ground flat by a lock-up
        const rEff = wh.flatSpot > 0 ? R - wh.flatSpot * Math.pow(Math.max(0, Math.cos(wh.spin - wh.flatAngle + xk / R)), 24) : R
        const dk = (g - (_hub.y - Math.sqrt(rEff * rEff - xk * xk))) * _n.y
        _env[k] = dk
        if (dk > mx) mx = dk
      }
      // smooth maximum (log-sum-exp) over the samples along the tyre: rigid-ring enveloping
      let es = 0,
        ex = 0
      for (let k = 0; k < NX; k++) {
        const w = Math.exp((_env[k] - mx) / 0.0015)
        es += w
        ex += w * (NX === 1 ? 0 : (k / (NX - 1) - 0.5) * 2 * spanX)
      }
      const dl = mx + 0.0015 * Math.log(es)
      deflSum += dl
      if (dl > 0) {
        xSum += (ex / es) * dl
        wSum += dl
      }
      if (l === 0) dRight = dl
      if (l === NL - 1) dLeft = dl
    }
    const defl = deflSum / NL
    const cx = wSum > 0 ? xSum / wSum : 0
    wh.envelopeX = cx
    wh.defl = defl
    // contact normal: tilted backwards when the effective contact moves ahead (step / kerb strike)
    // and sideways when one side of the tread is pushed up more than the other
    if (NX > 1) {
      const tb = cx / Math.max(R - Math.max(defl, 0), 0.1)
      const latSlope = NL > 1 ? clamp((dLeft - dRight) / (2 * spanY), -0.25, 0.25) * 0.6 : 0
      _n.x -= hx * tb + hz * latSlope
      _n.z -= hz * tb - hx * latSlope
      _n.normalize()
    }
    wh.tyre.contactBias = NL > 1 && defl > 0 ? clamp((dLeft - dRight) / (Math.abs(defl) + 0.003), -1, 1) * 0.5 : 0

    // ------------------------------------------------------------ vertical tyre force
    let Fz = 0
    const nu = _n.dot(up)
    if (defl > 0 && nu > 0.2) {
      const tyreSpec = wh.model.spec
      const pScale = clamp(0.8 + 0.2 * (wh.tyre.pressure / wh.model.optPressure), 0.7, 1.2)
      let ddot = wh.contact ? (defl - wh.deflPrev) / h : 0
      ddot = clamp(ddot, -4, 4)
      Fz = Math.max(0, tyreSpec.vertStiffness * pScale * defl + tyreSpec.vertDamping * ddot)
      wh.contact = true
    } else wh.contact = false
    wh.deflPrev = defl

    // ------------------------------------------------------------ contact frame
    _tf.addScaled(_n, -_tf.dot(_n)).normalize()
    _tl.crossVectors(_n, _tf)
    // lean: kinematic camber (incl. body roll) relative to the road
    const cam = wh.camberStatic + kin.camberAt(travel)
    const lx = this.left.x * side,
      ly = this.left.y * side,
      lz = this.left.z * side
    const cc = Math.cos(cam),
      sc = Math.sin(cam)
    const topX = up.x * cc + lx * sc,
      topY = up.y * cc + ly * sc,
      topZ = up.z * cc + lz * sc
    wh.lean = Math.asin(clamp(topX * _tl.x + topY * _tl.y + topZ * _tl.z, -1, 1))
    wh.contactPoint.copy(_hub).addScaled(_n, -(R - Math.max(defl, 0))).addScaled(_tf, cx)
    wh.normal.copy(_n)

    // suspension velocity (needed for scrub and the dampers)
    const vAtt = this.pointVelocityAlong(_r, up)
    const cdot = wh.vWheel - vAtt

    const tyre = wh.tyre
    _app.subVectors(wh.contactPoint, this.pos)
    this.pointVelocity(_app, _vc)
    // scrub: the wheel moves sideways relative to the body as the suspension travels
    _vc.addScaled(this.left, side * kin.trackRate(travel) * cdot)
    const Vx = _vc.dot(_tf)
    const Vy = _vc.dot(_tl)
    const Re = R - Math.max(0, defl) * 0.33
    const Vsx = wh.omega * Re - Vx

    updateTyre(wh.model, tyre, {
      Fz,
      defl: Math.max(defl, 0),
      Vx,
      Vy,
      Vsx,
      lean: wh.lean,
      surfaceGrip: surf.grip * s.grip,
      speed: this.speed,
      dt: h,
    })

    // ------------------------------------------------------------ brakes
    let bt = brake * wh.brakeMax + handbrake
    if (this.assists.abs && brake > 0.05 && Fz > 0) {
      const lim = -wh.model.compound.peakSlipRatio * 1.08
      if (tyre.slipRatio < lim) wh.absFactor = Math.max(0.15, wh.absFactor - h * 28)
      else wh.absFactor = Math.min(1, wh.absFactor + h * 9)
      if (wh.absFactor < 0.97) this.absActive = true
      bt = brake * wh.brakeMax * wh.absFactor + handbrake
    } else wh.absFactor = 1
    // race pads: low bite when cold, fade when overheated
    const fade = wh.brakeTemp > 750 ? clamp(1 - (wh.brakeTemp - 750) / 900, 0.6, 1) : 1
    const cold = 0.8 + 0.2 * smoothstep(80, 220, wh.brakeTemp)
    wh.brakeTorque = bt * fade * cold
    // a locked, sliding wheel grinds a flat spot into the tread at the current rotation angle
    if (Fz > 0 && Math.abs(wh.omega) < 0.5 && Math.abs(tyre.slideVelocity()) > 8) {
      if (wh.flatSpot < 1e-5) wh.flatAngle = wh.spin
      wh.flatSpot = Math.min(0.004, wh.flatSpot + Math.abs(tyre.slideVel) * h * Fz * 1.5e-9 * wh.model.compound.wearRate)
    }
    wh.brakeTemp += (Math.abs(wh.brakeTorque * wh.omega) * 0.00006 - (wh.brakeTemp - 35) * (0.012 + this.speed * 0.0009)) * h

    // ------------------------------------------------------------ tyre force -> chassis
    let jack = 0
    if (Fz > 0) {
      _f.copy(_tf).scale(tyre.Fx).addScaled(_tl, tyre.Fy)
      if (surf.drag > 0) {
        _f.addScaled(_tf, -surf.drag * Fz * clamp(Vx, -30, 30) * 0.1)
        _f.addScaled(_tl, -surf.drag * Fz * clamp(Vy, -30, 30) * 0.1)
      }
      // link geometry: lateral force through the instant centre (roll centre migration) and
      // longitudinal force through the side-view swing arm (anti-dive / anti-squat)
      const fOut = (_f.x * this.left.x + _f.y * this.left.y + _f.z * this.left.z) * side
      const fLong = _f.x * this.fwd.x + _f.y * this.fwd.y + _f.z * this.fwd.z
      jack = fOut * kin.jackAt(travel) + (wh.front ? fLong : -fLong) * kin.antiTan
      // horizontal part of the normal force (road not perpendicular to the strut) goes to the body
      _f.addScaled(_n, Fz).addScaled(up, -Fz * nu)
      _app.subVectors(wh.contactPoint, this.pos)
      this.F.add(_f)
      this.T.add(_tq.crossVectors(_app, _f))
      // self-aligning moment reacts through the upright into the chassis
      this.T.addScaled(_n, tyre.Mz)
      if (wh.front) this.rackTorque += tyre.Mz - kin.mechTrail * tyre.Fy
      const rr = (wh.model.compound.rollingRes + surf.rolling) * Fz * Re * Math.tanh(wh.omega * 2)
      wh.driveTorque = -tyre.Fx * Re - rr
      // the rubber that leaves the tyre stays on the track
      if (s.surface === Surface.Asphalt && ground.layRubber) ground.layRubber(s, h * (0.0004 + tyre.slipPower * 3e-8))
    } else wh.driveTorque = 0

    // ------------------------------------------------------------ suspension
    let Fs = wh.k * wh.c
    const knee = wh.knee
    if (cdot > 0) Fs += cdot < knee ? wh.bump * cdot : wh.bump * knee + wh.bump * 0.4 * (cdot - knee)
    else Fs += -cdot < knee ? wh.rebound * cdot : -wh.rebound * knee + wh.rebound * 0.4 * (cdot + knee)
    if (wh.c > wh.bumpStopAt) {
      const x = wh.c - wh.bumpStopAt
      Fs += wh.bumpStopRate * x * x
    }
    const other = this.wheels[wh.index ^ 1]
    Fs += wh.arb * (wh.c - other.c)
    // link (jacking) force acts between chassis and upright like the spring does
    const Fsus = Fs - jack
    wh.springForce = Fs
    const gu = -GRAVITY * up.y
    wh.vWheel += ((Fz * nu - Fsus) / wh.unsprungMass + gu) * h
    _f.copy(up).scale(Fsus)
    this.F.add(_f)
    this.T.add(_tq.crossVectors(_r, _f))
    wh.hub.copy(_hub)
  }

  private solveDrivetrain(h: number, throttle: number, engage: number, rnd: number) {
    const sp = this.spec
    const eng = this.engine
    const W = this.wheels
    // free accelerations
    for (let i = 0; i < 4; i++) W[i].omega += (W[i].driveTorque / W[i].inertia) * h
    const Te = engineTorque(sp.engine, eng, throttle, h, rnd)
    // drivetrain losses: ~9% of positive crank torque + viscous drag on the driven wheels
    eng.omega += ((Te > 0 ? Te * 0.91 : Te) / sp.engine.inertia) * h
    W[2].omega -= W[2].omega * 0.35 * h / W[2].inertia
    W[3].omega -= W[3].omega * 0.35 * h / W[3].inertia
    if (eng.omega < 0) eng.omega = 0

    const L = W[2],
      Rw = W[3]
    const G = this.currentRatio()
    const Ie = sp.engine.inertia
    const capClutch = sp.clutchTorque * engage * engage * h
    const st = this.setup
    // accumulated impulses
    let jClutch = 0,
      jDiff = 0
    const jBrake = [0, 0, 0, 0]
    const iters = 10
    const invIL = 1 / L.inertia,
      invIR = 1 / Rw.inertia
    for (let it = 0; it < iters; it++) {
      // clutch: omega_e - G * (omega_L + omega_R)/2 = 0
      if (G !== 0 && capClutch > 0) {
        const vrel = eng.omega - G * 0.5 * (L.omega + Rw.omega)
        const K = 1 / Ie + G * G * 0.25 * (invIL + invIR)
        let lam = vrel / K
        const old = jClutch
        jClutch = clamp(old + lam, -capClutch, capClutch)
        lam = jClutch - old
        eng.omega -= lam / Ie
        L.omega += G * 0.5 * lam * invIL
        Rw.omega += G * 0.5 * lam * invIR
      }
      // limited slip diff: omega_L - omega_R = 0 within lock torque
      {
        const tin = (jClutch / h) * G
        const lock = st.diffPreload + (tin >= 0 ? st.diffPower : st.diffCoast) * Math.abs(tin)
        const cap = lock * h
        const vrel = L.omega - Rw.omega
        const K = invIL + invIR
        let lam = vrel / K
        const old = jDiff
        jDiff = clamp(old + lam, -cap, cap)
        lam = jDiff - old
        L.omega -= lam * invIL
        Rw.omega += lam * invIR
      }
      // brakes: drive omega towards 0 within brake torque
      for (let i = 0; i < 4; i++) {
        const wh = W[i]
        const cap = wh.brakeTorque * h
        if (cap <= 0) continue
        let lam = -wh.omega * wh.inertia
        const old = jBrake[i]
        jBrake[i] = clamp(old + lam, -cap, cap)
        lam = jBrake[i] - old
        wh.omega += lam / wh.inertia
      }
    }
    this.clutchTorque = jClutch / h
    this.clutchSlip = G !== 0 ? eng.omega - G * 0.5 * (L.omega + Rw.omega) : 0
  }

  updateWheelWorld() {
    for (const wh of this.wheels) {
      this.R.apply(wh.x, wh.yHubStatic + (wh.c - wh.cStatic), wh.z, _r)
      wh.hub.copy(this.pos).add(_r)
    }
  }

  /** Total load on each tyre, for diagnostics */
  loads() {
    return this.wheels.map((w) => w.tyre.Fz)
  }

  isFinite() {
    return this.pos.isFinite() && this.vel.isFinite() && this.w.isFinite() && Number.isFinite(this.engine.omega)
  }
}
