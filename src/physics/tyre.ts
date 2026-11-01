// Transient combined-slip tyre model.
//
// * Magic-Formula shaped force curve on a normalised combined slip vector (similarity method),
//   with per-direction peak slips, friction and post-peak fall-off.
// * First-order contact-patch relaxation (deflection states) integrated implicitly: stable down
//   to standstill, where the deflection acts as a damped spring (static friction behaviour).
// * Load sensitivity, camber (lean) effects incl. camber thrust, thermal model (surface + carcass),
//   pressure from ideal gas law, and wear.
import { clamp, lerp } from './math'
import type { CompoundSpec, TyreSpec } from './spec'

export const AMBIENT_TEMP = 24
export const TRACK_TEMP = 34

function solveB(C: number) {
  // E = 0  ->  peak of sin(C atan(B s)) at s = 1  <=>  B = tan(pi / (2C))
  return Math.tan(Math.PI / (2 * C))
}

function shapeFromSlide(r: number) {
  return 2 - (2 * Math.asin(clamp(r, 0.3, 0.99))) / Math.PI
}

export class TyreModel {
  readonly Clat: number
  readonly Clong: number
  readonly Blat: number
  readonly Blong: number
  readonly optPressure: number
  constructor(
    public spec: TyreSpec,
    public compound: CompoundSpec,
  ) {
    this.Clat = shapeFromSlide(compound.slideLat)
    this.Clong = shapeFromSlide(compound.slideLong)
    this.Blat = solveB(this.Clat)
    this.Blong = solveB(this.Clong)
    this.optPressure = compound.id.startsWith('R') ? 1.9 : 2.4
  }
}

export class TyreState {
  // relaxation states (m)
  u = 0
  v = 0
  // outputs
  Fx = 0
  Fy = 0
  Fz = 0
  slipRatio = 0
  slipAngle = 0 // rad, relaxed; positive -> force to the left
  combinedSlip = 0 // normalised combined slip (1 = peak)
  slideVel = 0 // m/s of contact patch sliding
  slipPower = 0 // W dissipated in the contact patch
  gripFactor = 1
  // thermal
  surfTemp = 70
  coreTemp = 65
  pressure = 1.9 // bar, gauge (hot)
  coldPressure = 1.6
  wear = 1 // 1 = new

  reset(temp: number, coldPressure: number) {
    this.u = this.v = 0
    this.Fx = this.Fy = this.Fz = 0
    this.surfTemp = temp
    this.coreTemp = temp
    this.coldPressure = coldPressure
    this.wear = 1
    this.updatePressure()
  }

  updatePressure() {
    // ideal gas, absolute pressures, cold reference at 25C
    this.pressure = (this.coldPressure + 1.013) * ((this.coreTemp + 273.15) / 298.15) - 1.013
  }
}

export interface TyreInputs {
  Fz: number
  Vx: number // contact patch velocity along wheel heading (m/s)
  Vy: number // contact patch velocity lateral (+ left)
  Vsx: number // longitudinal slip velocity = omega*R - Vx
  lean: number // rad, top of tyre leaning left (+)
  surfaceGrip: number
  speed: number // vehicle speed for convective cooling
  dt: number
}

/**
 * Advance the tyre state and compute forces. Returns forces in the contact frame
 * (Fx along heading, Fy to the left) via the state object.
 */
export function updateTyre(model: TyreModel, st: TyreState, inp: TyreInputs) {
  const cp = model.compound
  const sp = model.spec
  const { Fz, Vx, Vy, Vsx, dt } = inp
  const absVx = Math.abs(Vx)
  const loadRatio = Fz / cp.nominalLoad

  // --- peak slips depend on load and pressure
  const pDev = st.pressure - model.optPressure
  const peakAlpha = Math.tan(cp.peakSlipAngle * clamp(1 + 0.12 * (loadRatio - 1) - 0.12 * pDev, 0.7, 1.4))
  const peakKappa = cp.peakSlipRatio * clamp(1 + 0.08 * (loadRatio - 1) - 0.08 * pDev, 0.7, 1.4)

  // --- relaxation lengths shrink as the tyre saturates (Pacejka)
  const sat = clamp(st.combinedSlip, 0, 1.5)
  const sigX = sp.relaxLong * clamp(1 - 0.55 * sat, 0.35, 1) * clamp(0.6 + 0.4 * loadRatio, 0.5, 1.4)
  const sigY = sp.relaxLat * clamp(1 - 0.55 * sat, 0.35, 1) * clamp(0.6 + 0.4 * loadRatio, 0.5, 1.4)

  if (Fz <= 0) {
    // airborne: deflections decay quickly
    const k = Math.exp(-dt * 60)
    st.u *= k
    st.v *= k
    st.Fx = st.Fy = st.Fz = 0
    st.slipPower = 0
    st.slideVel = 0
    st.combinedSlip = 0
    coolTyre(st, inp, false)
    return st
  }

  // implicit first-order relaxation:  du/dt = Vsx - |Vx|/sigma * u
  st.u = (st.u + dt * Vsx) / (1 + (dt * absVx) / sigX)
  st.v = (st.v - dt * Vy) / (1 + (dt * absVx) / sigY)
  const maxK = 1.6
  st.u = clamp(st.u, -maxK * sigX, maxK * sigX)
  st.v = clamp(st.v, -maxK * sigY, maxK * sigY)
  const kappa = st.u / sigX
  const tanA = st.v / sigY
  st.slipRatio = kappa
  st.slipAngle = Math.atan(tanA)

  // --- friction availability
  const loadMu = clamp(1 - cp.loadSens * (loadRatio - 1), 0.55, 1.25)
  const effTemp = 0.65 * st.surfTemp + 0.35 * st.coreTemp
  const tDev = (effTemp - cp.optTemp) / cp.tempWindow
  const tempMu = clamp(1 - cp.tempGripLoss * tDev * tDev, 0.78, 1)
  const presMu = clamp(1 - 0.09 * (pDev / 0.3) * (pDev / 0.3), 0.82, 1)
  const wearMu = 0.88 + 0.12 * st.wear
  const baseMu = cp.mu * loadMu * tempMu * presMu * wearMu * inp.surfaceGrip
  st.gripFactor = loadMu * tempMu * presMu * wearMu

  // camber: lean into the lateral force is beneficial up to an optimum
  const fyDir = tanA >= 0 ? 1 : -1
  const leanEff = inp.lean * fyDir
  const camOpt = 0.058
  const camLat = clamp(1 - 11 * (leanEff - camOpt) * (leanEff - camOpt), 0.7, 1)
  const camLong = clamp(1 - 3.5 * inp.lean * inp.lean, 0.85, 1)
  const muY = baseMu * camLat
  const muX = baseMu * cp.muLong * camLong

  // --- combined normalised slip
  const sx = kappa / peakKappa
  const sy = tanA / peakAlpha
  const s = Math.sqrt(sx * sx + sy * sy)
  st.combinedSlip = s
  let fx = 0,
    fy = 0
  if (s > 1e-9) {
    const wLat = (sy * sy) / (s * s)
    const C = lerp(model.Clong, model.Clat, wLat)
    const B = lerp(model.Blong, model.Blat, wLat)
    const f = Math.sin(C * Math.atan(B * s))
    const fs = s < 1e-4 ? C * B : f / s
    fx = muX * Fz * fs * sx
    fy = muY * Fz * fs * sy
  }

  // camber thrust, saturated by remaining capacity
  fy += Fz * 0.32 * inp.lean * clamp(1 - s, 0, 1)

  // low-speed damping of the deflection springs (prevents creeping/oscillation at rest)
  const lowBlend = clamp(1 - Math.hypot(Vx, Vy) / 2.5, 0, 1)
  if (lowBlend > 0) {
    const kd = Fz * 4.5 * lowBlend
    fx += kd * Vsx * 0.35
    fy -= kd * Vy
  }

  // friction ellipse cap
  const ex = fx / (muX * Fz),
    ey = fy / (muY * Fz)
  const e = Math.sqrt(ex * ex + ey * ey)
  if (e > 1) {
    fx /= e
    fy /= e
  }

  st.Fx = fx
  st.Fy = fy
  st.Fz = Fz

  // --- dissipated power & thermal
  const vsy = -Vy
  st.slideVel = Math.sqrt(Vsx * Vsx + vsy * vsy)
  st.slipPower = Math.abs(fx * Vsx) + Math.abs(fy * vsy)
  heatTyre(model, st, inp)
  return st
}

// Thermal model (per tyre). Lumped capacities: tread surface layer and carcass (incl. air).
//   surface <- 70% of contact-patch slip power, convection (speed dependent), road conduction
//   carcass <- 30% of slip power + rolling hysteresis, convection through sidewalls and rim
const C_SURF = 2000 // J/K
const C_CORE = 10000 // J/K
const H_SC = 100 // W/K surface <-> carcass

function heatTyre(model: TyreModel, st: TyreState, inp: TyreInputs) {
  const cp = model.compound
  const dt = inp.dt
  const v = Math.abs(inp.speed)
  const slip = st.slipPower * cp.heatGain
  const roll = cp.rollingRes * inp.Fz * v
  const hAir = 15 + 1.0 * v
  const hCore = 20 + 0.8 * v
  const qS = 0.7 * slip - hAir * (st.surfTemp - AMBIENT_TEMP) - 40 * (st.surfTemp - TRACK_TEMP) - H_SC * (st.surfTemp - st.coreTemp)
  const qC = 0.3 * slip + roll + H_SC * (st.surfTemp - st.coreTemp) - hCore * (st.coreTemp - AMBIENT_TEMP)
  st.surfTemp += (qS / C_SURF) * dt
  st.coreTemp += (qC / C_CORE) * dt
  st.wear = Math.max(0, st.wear - st.slipPower * cp.wearRate * 3.5e-10 * dt)
  st.updatePressure()
}

function coolTyre(st: TyreState, inp: TyreInputs, _contact: boolean) {
  const v = Math.abs(inp.speed)
  const qS = -(15 + 1.0 * v) * (st.surfTemp - AMBIENT_TEMP) - H_SC * (st.surfTemp - st.coreTemp)
  const qC = H_SC * (st.surfTemp - st.coreTemp) - (20 + 0.8 * v) * (st.coreTemp - AMBIENT_TEMP)
  st.surfTemp += (qS / C_SURF) * inp.dt
  st.coreTemp += (qC / C_CORE) * inp.dt
  st.updatePressure()
}

