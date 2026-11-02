// Characterisation of the brush tyre & suspension kinematics against known physical behaviour.
import { describe, expect, test } from 'bun:test'
import { Kinematics, defaultGeometry } from '../src/physics/kinematics'
import { CARS, COMPOUNDS } from '../src/physics/spec'
import { RIBS, TyreModel, TyreState, updateTyre } from '../src/physics/tyre'

const model = new TyreModel(CARS[0].tyreFront, COMPOUNDS.RM)

function lateralCurve(Fz: number) {
  const a = model.halfLength(model.nominalDeflection(Fz))
  const loads = new Float64Array(RIBS),
    mu = new Float64Array(RIBS)
  const fP = Math.pow(model.ribPressure(Fz / 3, a) / model.pRef, -model.nP)
  const pts: { alpha: number; fy: number; mz: number }[] = []
  let fyPrev = 0
  for (let k = 1; k <= 140; k++) {
    const alpha = ((k * 0.2) * Math.PI) / 180
    model.ribShares(0, fyPrev / Fz, 0, 0, loads)
    mu.fill(model.muS * fP)
    const o = model.brush(Fz, a, 0, Math.tan(alpha), 0, loads, mu, 30 * Math.sin(alpha), model.out)
    fyPrev = o.Fy
    pts.push({ alpha, fy: o.Fy, mz: o.Mz })
  }
  const peak = pts.reduce((b, p) => (p.fy > b.fy ? p : b))
  const mzPeak = pts.reduce((b, p) => (-p.mz > -b.mz ? p : b))
  return { a, pts, peak, mzPeak }
}

describe('brush tyre', () => {
  test('pneumatic trail at small slip is a/3 (parabolic pressure)', () => {
    const c = lateralCurve(3500)
    const trail = -c.pts[1].mz / c.pts[1].fy
    expect(Math.abs(trail - c.a / 3) / (c.a / 3)).toBeLessThan(0.08)
  })

  test('aligning moment peaks well before the lateral force (wheel goes light at the limit)', () => {
    const c = lateralCurve(3500)
    expect(c.mzPeak.alpha).toBeLessThan(c.peak.alpha * 0.55)
    // and has collapsed by the time the tyre is sliding
    const late = c.pts[c.pts.length - 1]
    expect(-late.mz).toBeLessThan(-c.mzPeak.mz * 0.35)
  })

  test('load sensitivity: friction falls and peak slip angle rises with load', () => {
    const loads = [1500, 3500, 6000, 9000].map((Fz) => {
      const c = lateralCurve(Fz)
      return { mu: c.peak.fy / Fz, alpha: c.peak.alpha }
    })
    for (let i = 1; i < loads.length; i++) {
      expect(loads[i].mu).toBeLessThan(loads[i - 1].mu)
      expect(loads[i].alpha).toBeGreaterThanOrEqual(loads[i - 1].alpha - 1e-9)
    }
    // calibrated nominal point
    expect(Math.abs(loads[1].mu - COMPOUNDS.RM.mu)).toBeLessThan(0.03)
  })

  test('post-peak fall-off matches the compound sliding ratio', () => {
    const c = lateralCurve(3500)
    const last = c.pts[c.pts.length - 1].fy
    const ratio = last / c.peak.fy
    expect(ratio).toBeGreaterThan(0.72)
    expect(ratio).toBeLessThan(0.92)
  })

  test('combined slip: braking reduces available lateral force (friction circle)', () => {
    const Fz = 3500
    const a = model.halfLength(model.nominalDeflection(Fz))
    const loads = new Float64Array(RIBS).fill(1 / 3),
      mu = new Float64Array(RIBS).fill(model.muS)
    let prev = Infinity
    for (const k of [0, -0.03, -0.06, -0.12, -0.3]) {
      const o = model.brush(Fz, a, k / (1 + k), Math.tan(0.07) / (1 + k), 0, loads, mu, 10, model.out)
      expect(o.Fy).toBeLessThan(prev + 1e-6)
      prev = o.Fy
      expect(Math.hypot(o.Fx, o.Fy) / Fz).toBeLessThan(model.muS * 1.05)
    }
  })

  test('camber: small thrust towards the lean, load shifts to the leaning shoulder', () => {
    const Fz = 3500
    const a = model.halfLength(model.nominalDeflection(Fz))
    const loads = new Float64Array(RIBS),
      mu = new Float64Array(RIBS).fill(model.muS)
    const lean = (-3 * Math.PI) / 180 // top leaning right
    model.ribShares(lean, 0, 0, 0, loads)
    expect(loads[0]).toBeGreaterThan(loads[2]) // right shoulder (index 0) carries more
    const thrust = model.brush(Fz, a, 0, 0, lean, loads, mu, 0, model.out).Fy
    expect(thrust).toBeLessThan(0)
    // camber stiffness much lower than cornering stiffness (radial tyre)
    const fy05 = model.brush(Fz, a, 0, Math.tan((0.5 * Math.PI) / 180), 0, new Float64Array(RIBS).fill(1 / 3), mu, 0, model.out).Fy
    const cAlpha = fy05 / 0.5,
      cGamma = Math.abs(thrust) / 3
    expect(cGamma / cAlpha).toBeLessThan(0.15)
  })

  test('negative camber heats the inner shoulder when rolling straight', () => {
    const st = new TyreState()
    st.reset(60, 1.4)
    for (let i = 0; i < 600 * 60; i++) {
      updateTyre(model, st, { Fz: 3500, defl: model.nominalDeflection(3500), Vx: 50, Vy: 0, Vsx: 0.35, lean: (-3 * Math.PI) / 180, surfaceGrip: 1, speed: 50, dt: 1 / 600 })
    }
    // lean right -> right shoulder (index 0) hotter
    expect(st.ribSurf[0]).toBeGreaterThan(st.ribSurf[2] + 1)
    expect(st.pressure).toBeGreaterThan(1.4) // pressure rises with gas temperature
  })
})

describe('suspension kinematics', () => {
  const k = new Kinematics(defaultGeometry(0.845, 0.34, 'gt3F'), 0.43, 2.72)
  test('negative camber gain in bump, positive in droop', () => {
    expect(k.camberAt(0.03)).toBeLessThan(-0.005)
    expect(k.camberAt(-0.03)).toBeGreaterThan(0.005)
  })
  test('roll centre above ground and migrating down in bump', () => {
    const rc0 = k.rollCentreAt(0)
    expect(rc0).toBeGreaterThan(0.02)
    expect(rc0).toBeLessThan(0.15)
    expect(k.rollCentreAt(0.04)).toBeLessThan(rc0)
  })
  test('jacking: inward cornering force on the outer wheel lifts the chassis', () => {
    // outward force component negative (towards the car) * positive coefficient -> extending force
    expect(k.jackAt(0)).toBeGreaterThan(0)
  })
})
