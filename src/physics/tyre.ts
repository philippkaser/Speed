// Physical brush tyre model with a three-rib tread.
//
// Contact patch
//   * length from the tyre's vertical deflection (chord of the loaded tyre, carcass-lengthened),
//     parabolic pressure distribution along it, three ribs (left / centre / right) across it
//   * rib load shares follow camber (lean), lateral force (carcass roll), inflation (crown vs.
//     shoulders) and partial road contact (enveloping, e.g. one side on a kerb)
//   * each rib is discretised into bristle elements: elastic deflection = slip * distance from
//     the leading edge (+ the curved contact line of a cambered tyre) until the local friction
//     limit, then sliding. Combined slip, the fall-off past the peak, camber thrust and the
//     self-aligning moment / pneumatic trail all emerge instead of being curve-fitted.
// Rubber friction
//   mu = mu_s * f(local contact pressure)^-n * f(sliding speed) * f(rib temperature) * f(wear)
//   -> load sensitivity is a consequence of contact pressure, not a fudge factor.
// Transients
//   first-order carcass deflection states (relaxation lengths) integrated implicitly, stable down
//   to standstill where they act as a damped spring (static friction).
// Thermal
//   per rib: tread surface + tread bulk; shared carcass and inflation gas -> hot pressure (ideal
//   gas). Lateral conduction between ribs, convection, road conduction, rolling hysteresis.
// The rubber/bristle parameters are calibrated numerically at start-up so the compound data
// (peak slip angle / ratio, peak friction, sliding ratio) keep their physical meaning.
import { clamp } from './math'
import type { CompoundSpec, TyreSpec } from './spec'

export const AMBIENT_TEMP = 24
export let TRACK_TEMP = 34
export function setTrackTemp(t: number) {
  TRACK_TEMP = t
}

export const RIBS = 3
const NSEG = 18
const REF_SPEED = 30

/** Result of one brush evaluation (reused, allocation free). */
export interface BrushOut {
  Fx: number
  Fy: number
  Mz: number
  sliding: number // load weighted sliding fraction 0..1
  ribFx: Float64Array
  ribFy: Float64Array
  ribPower: Float64Array // relative share of the slip work per rib
}

function makeOut(): BrushOut {
  return { Fx: 0, Fy: 0, Mz: 0, sliding: 0, ribFx: new Float64Array(RIBS), ribFy: new Float64Array(RIBS), ribPower: new Float64Array(RIBS) }
}

// local pressure / mean pressure along a parabolic patch, per element (independent of size)
const SHAPE = new Float64Array(NSEG)
for (let i = 0; i < NSEG; i++) {
  const t = ((i + 0.5) / NSEG) * 2 - 1
  SHAPE[i] = 1 - t * t
}

export class TyreModel {
  /** bristle stiffness per unit length per unit length (N/m^2), whole tread */
  cpx = 1e7
  cpy = 1e7
  /** static (adhesion) friction coefficient at reference pressure & optimum temperature */
  muS = 1.6
  muLongFactor = 1.03
  /** high-speed sliding / static friction ratio */
  kRatio = 0.8
  vC = 8
  /** contact pressure exponent: mu ~ p^-n */
  nP = 0.25
  pRef = 2e5
  optPressure: number
  ribY: Float64Array
  ribW: number
  peakTan0 = 0.12 // calibrated lateral peak slip (tan alpha) at nominal load
  peakKappa0 = 0.1
  private fpShape = new Float64Array(NSEG)
  readonly out = makeOut()

  constructor(
    public spec: TyreSpec,
    public compound: CompoundSpec,
  ) {
    this.optPressure = compound.id.startsWith('R') ? 1.9 : 2.4
    const b = spec.width * 0.43
    this.ribW = (2 * b) / RIBS
    this.ribY = new Float64Array(RIBS)
    for (let r = 0; r < RIBS; r++) this.ribY[r] = -b + this.ribW * (r + 0.5)
    this.nP = clamp(compound.loadSens * 2, 0.05, 0.6)
    for (let i = 0; i < NSEG; i++) this.fpShape[i] = Math.pow(Math.max(SHAPE[i] * 1.5, 0.12), -this.nP)
    this.calibrate()
  }

  /** contact half length for a given vertical deflection */
  halfLength(defl: number) {
    const R = this.spec.radius
    const d = clamp(defl, 0, R * 0.5)
    return Math.sqrt(Math.max(2 * R * d - d * d, 1e-6)) * 1.12
  }

  nominalDeflection(Fz: number) {
    return Fz / this.spec.vertStiffness
  }

  /** mean contact pressure of one rib */
  ribPressure(FzRib: number, a: number) {
    return FzRib / Math.max(2 * a * this.ribW, 1e-6)
  }

  /**
   * Steady-state brush forces for theoretical slips (sx, sy) in the contact frame.
   * ribMu: friction coefficient of each rib incl. temperature / wear / surface / mean pressure.
   */
  brush(Fz: number, a: number, sx: number, sy: number, lean: number, ribLoad: ArrayLike<number>, ribMu: ArrayLike<number>, slideSpeed: number, out: BrushOut) {
    out.Fx = out.Fy = out.Mz = out.sliding = 0
    const dxi = (2 * a) / NSEG
    // radial carcass: the contact line follows only ~40% of the cambered rolling cone
    const camb = (0.4 * Math.sin(lean)) / (2 * this.spec.radius)
    const kf = this.kRatio + (1 - this.kRatio) * Math.exp(-slideSpeed / this.vC)
    // carcass lateral compliance grows with load: cornering stiffness ~ Fz^0.7, peak slip rises
    const loadStiff = Math.pow(Math.max(Fz, 200) / this.compound.nominalLoad, -0.3)
    const cx = (this.cpx / RIBS) * Math.pow(loadStiff, 0.5),
      cy = (this.cpy / RIBS) * loadStiff
    let slidingLoad = 0
    for (let r = 0; r < RIBS; r++) {
      out.ribFx[r] = out.ribFy[r] = out.ribPower[r] = 0
      const Fzr = Fz * ribLoad[r]
      if (Fzr <= 0) continue
      const q0 = (3 * Fzr) / (4 * a) // N/m at the patch centre
      const muS = ribMu[r]
      const muK = muS * kf
      const yr = this.ribY[r]
      let fxr = 0,
        fyr = 0,
        mz = 0,
        sl = 0
      for (let i = 0; i < NSEG; i++) {
        const xi = (i + 0.5) * dxi
        const q = q0 * SHAPE[i] * dxi
        const fp = this.fpShape[i]
        const ex = cx * xi * sx * dxi
        const ey = cy * (xi * sy + xi * (2 * a - xi) * camb) * dxi
        const e = Math.sqrt(ex * ex + ey * ey)
        const lim = muS * fp * q
        let fx = ex,
          fy = ey
        if (e > lim) {
          const s = (muK * fp * q) / e
          fx *= s
          fy *= s
          sl += q
        }
        fxr += fx
        fyr += fy
        mz += (a - xi) * fy
      }
      mz -= yr * fxr
      out.ribFx[r] = fxr
      out.ribFy[r] = fyr
      out.Fx += fxr
      out.Fy += fyr
      out.Mz += mz
      slidingLoad += sl
    }
    out.sliding = Fz > 0 ? slidingLoad / Fz : 0
    return out
  }

  /** rib load shares from lean, lateral force ratio, inflation and partial road contact */
  ribShares(lean: number, fyRatio: number, presDev: number, contactBias: number, out: Float64Array) {
    const b = this.spec.width * 0.43
    let sum = 0
    for (let r = 0; r < RIBS; r++) {
      const y = this.ribY[r] / b // -1 (right shoulder) .. +1 (left shoulder)
      // lean shifts load towards the side the tyre leans to; lateral force rolls the carcass
      // and loads the shoulder opposite to the force; over-inflation crowns the centre
      let w = 1 + y * (3.0 * lean - 0.12 * fyRatio + contactBias)
      const crown = 1 - Math.abs(y) * 1.5 // +1 centre, -0.5 shoulders
      w *= 1 + 0.55 * presDev * crown
      w = Math.max(0.04, w)
      out[r] = w
      sum += w
    }
    for (let r = 0; r < RIBS; r++) out[r] /= sum
    return out
  }

  // ------------------------------------------------------------------ calibration
  private curve(Fz: number, axis: 'lat' | 'long') {
    const a = this.halfLength(this.nominalDeflection(Fz))
    const loads = new Float64Array(RIBS)
    const mu = new Float64Array(RIBS)
    const p = this.ribPressure(Fz / RIBS, a)
    const fP = Math.pow(p / this.pRef, -this.nP)
    let peak = 0,
      peakAt = 0,
      last = 0,
      fyPrev = 0
    const N = 160
    for (let k = 1; k <= N; k++) {
      const s = axis === 'lat' ? Math.tan((k / N) * 0.62) : (k / N) * 0.9
      // a few fixed point iterations for the load shift caused by the lateral force itself
      for (let it = 0; it < 2; it++) {
        this.ribShares(0, axis === 'lat' ? fyPrev / Fz : 0, 0, 0, loads)
        for (let r = 0; r < RIBS; r++) mu[r] = this.muS * fP
        const sx = axis === 'long' ? s / (1 + s) : 0
        const sy = axis === 'lat' ? s : 0
        const vs = REF_SPEED * (axis === 'lat' ? Math.sin(Math.atan(s)) : s / (1 + s))
        this.brush(Fz, a, sx, sy, 0, loads, mu, vs, this.out)
        fyPrev = this.out.Fy
      }
      const f = axis === 'lat' ? this.out.Fy : this.out.Fx
      if (f > peak) {
        peak = f
        peakAt = s
      }
      last = f
    }
    return { peak: peak / Fz, peakAt, slide: last / Math.max(peak, 1e-6) }
  }

  private calibrate() {
    const cp = this.compound
    const Fz0 = cp.nominalLoad
    const a0 = this.halfLength(this.nominalDeflection(Fz0))
    this.pRef = this.ribPressure(Fz0 / RIBS, a0)
    this.muLongFactor = cp.muLong
    this.kRatio = cp.slideLat
    this.muS = cp.mu
    const tanA = Math.tan(cp.peakSlipAngle)
    // brush theory: full sliding at tan(a) = 3 mu Fz / (2 c a^2); the peak sits at ~70% of that
    this.cpy = (3 * this.muS * Fz0) / (2 * a0 * a0 * (tanA / 0.7))
    this.cpx = (3 * this.muS * Fz0) / (2 * a0 * a0 * ((cp.peakSlipRatio / 0.7) / (1 + cp.peakSlipRatio)))
    for (let it = 0; it < 10; it++) {
      const lat = this.curve(Fz0, 'lat')
      this.muS *= cp.mu / lat.peak
      this.cpy *= clamp(lat.peakAt / tanA, 0.5, 2)
      this.kRatio = clamp(this.kRatio * Math.pow(cp.slideLat / Math.max(lat.slide, 0.3), 0.8), 0.45, 0.99)
    }
    for (let it = 0; it < 8; it++) {
      const lon = this.curve(Fz0, 'long')
      this.cpx *= clamp(lon.peakAt / cp.peakSlipRatio, 0.5, 2)
    }
    this.peakTan0 = tanA
    this.peakKappa0 = cp.peakSlipRatio
  }
}

export class TyreState {
  // carcass deflection states (m)
  u = 0
  v = 0
  // outputs
  Fx = 0
  Fy = 0
  Fz = 0
  Mz = 0 // self-aligning moment about the vertical axis (N m)
  trail = 0 // pneumatic trail (m)
  slipRatio = 0
  slipAngle = 0 // rad, relaxed; positive -> force to the left
  combinedSlip = 0 // normalised combined slip (1 = peak)
  sliding = 0 // fraction of the contact patch that slides
  slideVel = 0 // m/s of contact patch sliding
  slipPower = 0 // W dissipated in the contact patch
  gripFactor = 1
  contactLength = 0
  // thermal; ribs ordered by lateral coordinate in the tyre frame: 0 = right, 1 = centre, 2 = left
  ribSurf = new Float64Array(RIBS).fill(70)
  ribBulk = new Float64Array(RIBS).fill(68)
  ribWear = new Float64Array(RIBS).fill(1)
  ribLoad = new Float64Array(RIBS).fill(1 / RIBS)
  ribMu = new Float64Array(RIBS).fill(1)
  carcassTemp = 65
  gasTemp = 60
  pressure = 1.9 // bar, gauge (hot)
  coldPressure = 1.6
  contactBias = 0 // lateral load bias from partial road contact (-1..1, + = left)
  /** abrasion multiplier (race-length scaling, driving style); 1 = physical */
  wearMul = 1

  slideVelocity() {
    return this.slideVel
  }
  get surfTemp() {
    return (this.ribSurf[0] + this.ribSurf[1] + this.ribSurf[2]) / 3
  }
  set surfTemp(t: number) {
    this.ribSurf.fill(t)
  }
  get coreTemp() {
    return this.carcassTemp
  }
  set coreTemp(t: number) {
    this.carcassTemp = t
    this.gasTemp = t
    this.ribBulk.fill(t)
  }
  get wear() {
    return (this.ribWear[0] + this.ribWear[1] + this.ribWear[2]) / 3
  }

  reset(temp: number, coldPressure: number) {
    this.u = this.v = 0
    this.Fx = this.Fy = this.Fz = this.Mz = 0
    this.surfTemp = temp
    this.coreTemp = temp
    this.coldPressure = coldPressure
    this.ribWear.fill(1)
    this.updatePressure()
  }

  updatePressure() {
    // ideal gas, absolute pressures, cold reference at 25C
    this.pressure = (this.coldPressure + 1.013) * ((this.gasTemp + 273.15) / 298.15) - 1.013
  }
}

export interface TyreInputs {
  Fz: number
  defl: number // vertical tyre deflection (m) -> contact length
  Vx: number // contact patch velocity along wheel heading (m/s)
  Vy: number // contact patch velocity lateral (+ left)
  Vsx: number // longitudinal slip velocity = omega*R - Vx
  lean: number // rad, top of tyre leaning left (+)
  surfaceGrip: number
  speed: number // vehicle speed for convective cooling
  dt: number
}

/**
 * Advance the tyre state and compute forces in the contact frame (Fx along heading, Fy to the
 * left, Mz about the contact normal).
 */
/**
 * Grip left in a rib with the given tread (1 = new). A worn tread loses grip slowly and steadily
 * (thinner, hotter-running rubber), then falls off a cliff once the compound layer is nearly gone.
 */
export function wearGrip(tread: number) {
  const w = clamp(tread, 0, 1)
  const cliff = w < 0.4 ? ((0.4 - w) / 0.4) ** 2 : 0
  return 1 - 0.06 * (1 - w) - 0.3 * cliff
}

export function updateTyre(model: TyreModel, st: TyreState, inp: TyreInputs) {
  const cp = model.compound
  const sp = model.spec
  const { Fz, Vx, Vy, Vsx, dt } = inp
  const absVx = Math.abs(Vx)

  if (Fz <= 0) {
    const k = Math.exp(-dt * 60)
    st.u *= k
    st.v *= k
    st.Fx = st.Fy = st.Fz = st.Mz = 0
    st.slipPower = st.slideVel = st.combinedSlip = st.sliding = 0
    thermal(model, st, inp, null)
    return st
  }

  const loadRatio = Fz / cp.nominalLoad
  const sat = clamp(st.combinedSlip, 0, 1.5)
  // carcass relaxation shortens as the patch saturates and grows with load
  const sigX = sp.relaxLong * clamp(1 - 0.55 * sat, 0.35, 1) * clamp(0.6 + 0.4 * loadRatio, 0.5, 1.4)
  const sigY = sp.relaxLat * clamp(1 - 0.55 * sat, 0.35, 1) * clamp(0.6 + 0.4 * loadRatio, 0.5, 1.4)
  st.u = (st.u + dt * Vsx) / (1 + (dt * absVx) / sigX)
  st.v = (st.v - dt * Vy) / (1 + (dt * absVx) / sigY)
  const maxK = 1.6
  st.u = clamp(st.u, -maxK * sigX, maxK * sigX)
  st.v = clamp(st.v, -maxK * sigY, maxK * sigY)
  const kappa = st.u / sigX
  const tanA = st.v / sigY
  st.slipRatio = kappa
  st.slipAngle = Math.atan(tanA)

  // contact patch
  const a = model.halfLength(inp.defl)
  st.contactLength = 2 * a
  const presDev = (st.pressure - model.optPressure) / model.optPressure
  model.ribShares(inp.lean, st.Fy / Math.max(Fz, 1), presDev, st.contactBias, st.ribLoad)

  // rubber friction per rib: temperature, wear, mean contact pressure, surface
  let gripSum = 0
  for (let r = 0; r < RIBS; r++) {
    const T = 0.62 * st.ribSurf[r] + 0.38 * st.ribBulk[r]
    const tDev = (T - cp.optTemp) / cp.tempWindow
    const tempMu = clamp(1 - cp.tempGripLoss * tDev * tDev, 0.74, 1.01)
    const wearMu = wearGrip(st.ribWear[r])
    const p = model.ribPressure(Fz * st.ribLoad[r], a)
    const presMu = Math.pow(Math.max(p, 1e3) / model.pRef, -model.nP)
    st.ribMu[r] = model.muS * tempMu * wearMu * presMu * inp.surfaceGrip
    gripSum += tempMu * wearMu * presMu
  }
  st.gripFactor = gripSum / RIBS

  // theoretical slips
  const den = Math.max(0.25, 1 + kappa)
  const sx = kappa / den
  const sy = tanA / den
  const vsy = -Vy
  const slideV = Math.sqrt(Vsx * Vsx + vsy * vsy)
  const o = model.brush(Fz, a, sx, sy, inp.lean, st.ribLoad, st.ribMu, slideV, model.out)
  // longitudinal grip anisotropy (tread pattern / construction)
  let fx = o.Fx * model.muLongFactor
  let fy = o.Fy
  let mz = o.Mz

  // low-speed damping of the deflection springs (prevents creeping/oscillation at rest)
  const lowBlend = clamp(1 - Math.hypot(Vx, Vy) / 2.5, 0, 1)
  if (lowBlend > 0) {
    const kd = Fz * 4.5 * lowBlend
    fx += kd * Vsx * 0.35
    fy -= kd * Vy
    mz *= 1 - lowBlend
  }
  // overall friction cap (the brush already respects it; the damping must not exceed it)
  const muMax = model.muS * st.gripFactor * inp.surfaceGrip * 1.05
  const fl = Math.hypot(fx / model.muLongFactor, fy)
  if (fl > muMax * Fz) {
    const s = (muMax * Fz) / fl
    fx *= s
    fy *= s
  }

  st.Fx = fx
  st.Fy = fy
  st.Fz = Fz
  st.Mz = mz
  st.trail = Math.abs(fy) > 50 ? -mz / fy : st.trail * 0.9
  st.sliding = o.sliding
  // normalised combined slip: 1 at the calibrated peak (scaled with current friction)
  const muScale = st.gripFactor * inp.surfaceGrip
  const nx = kappa / (model.peakKappa0 * muScale),
    ny = tanA / (model.peakTan0 * muScale)
  st.combinedSlip = Math.sqrt(nx * nx + ny * ny)
  st.slideVel = slideV
  st.slipPower = Math.abs(fx * Vsx) + Math.abs(fy * vsy)
  thermal(model, st, inp, o)
  return st
}

// ------------------------------------------------------------------------------- thermal model
// Per rib lumped capacities; shared carcass and inflation gas.
const C_SURF = 700 // J/K per rib (tread surface layer)
const C_BULK = 1500 // J/K per rib (tread bulk)
const C_CARC = 6000 // J/K carcass
const C_GAS = 420 // J/K inflation gas + rim coupling
const H_SB = 90 // W/K surface <-> bulk per rib
const H_BC = 40 // W/K bulk <-> carcass per rib
const H_LAT = 12 // W/K lateral conduction between neighbouring ribs
const H_CG = 14 // W/K carcass <-> gas

function thermal(model: TyreModel, st: TyreState, inp: TyreInputs, o: BrushOut | null) {
  const cp = model.compound
  const dt = inp.dt
  const v = Math.abs(inp.speed)
  const S = st.ribSurf,
    B = st.ribBulk
  // rib shares of the slip work: proportional to the rib's force share
  let tot = 0
  if (o) for (let r = 0; r < RIBS; r++) tot += Math.abs(o.ribFx[r]) + Math.abs(o.ribFy[r])
  const work = st.slipPower * cp.heatGain
  const loaded = o !== null && inp.Fz > 0
  const presFlex = clamp(model.optPressure / Math.max(st.pressure, 0.8), 0.6, 1.8)
  let toCarcass = 0
  for (let r = 0; r < RIBS; r++) {
    const share = loaded && tot > 0 ? (Math.abs(o!.ribFx[r]) + Math.abs(o!.ribFy[r])) / tot : 0
    const slip = work * share
    // rolling hysteresis of this rib (more when under-inflated)
    // internal hysteresis of the deforming tread & carcass (dominant heat source when not sliding)
    const roll = loaded ? 1.8 * cp.rollingRes * inp.Fz * st.ribLoad[r] * v * presFlex : 0
    const hAir = (5 + 0.33 * v)
    const road = loaded ? 13 * (TRACK_TEMP - S[r]) : 0
    const left = r > 0 ? r - 1 : r,
      right = r < RIBS - 1 ? r + 1 : r
    const latS = H_LAT * (S[left] + S[right] - 2 * S[r])
    const latB = H_LAT * (B[left] + B[right] - 2 * B[r])
    const qS = 0.7 * slip - hAir * (S[r] - AMBIENT_TEMP) + road - H_SB * (S[r] - B[r]) + latS
    const qB = 0.3 * slip + 0.7 * roll + H_SB * (S[r] - B[r]) - H_BC * (B[r] - st.carcassTemp) + latB
    S[r] += (qS / C_SURF) * dt
    B[r] += (qB / C_BULK) * dt
    toCarcass += H_BC * (B[r] - st.carcassTemp) + 0.3 * roll
    // abrasion ~ slip work on that rib (plus faster when overheated)
    const hot = S[r] > cp.optTemp + cp.tempWindow ? 1 + (S[r] - cp.optTemp - cp.tempWindow) * 0.05 : 1
    st.ribWear[r] = Math.max(0, st.ribWear[r] - slip * cp.wearRate * 9e-9 * hot * st.wearMul * dt)
  }
  const hCarc = 20 + 0.8 * v
  const qC = toCarcass - hCarc * (st.carcassTemp - AMBIENT_TEMP) - H_CG * (st.carcassTemp - st.gasTemp)
  st.carcassTemp += (qC / C_CARC) * dt
  st.gasTemp += ((H_CG * (st.carcassTemp - st.gasTemp)) / C_GAS) * dt
  st.updatePressure()
}
