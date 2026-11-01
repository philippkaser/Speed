import { clamp, lookup, RADS_TO_RPM, smoothstep } from './math'
import type { EngineSpec } from './spec'

export class EngineState {
  omega = 0 // rad/s
  boost = 0 // 0..1 normalised spool
  limiterCut = 0 // seconds of fuel cut remaining
  throttleEff = 0 // after limiter / idle control / shift cut
  torque = 0 // last net torque (Nm)
  load = 0 // 0..1 (for audio)
  blowOff = 0 // triggered when boost dumped (for audio), decays
  backfire = 0 // pops on overrun (for audio / flames)
  running = true
  get rpm() {
    return this.omega * RADS_TO_RPM
  }
}

/**
 * Compute net crank torque for the given throttle. Updates turbo, rev limiter and idle control.
 */
export function engineTorque(spec: EngineSpec, st: EngineState, throttle: number, dt: number, rand: number) {
  const rpm = st.omega * RADS_TO_RPM

  // rev limiter: hard fuel cut with hysteresis
  if (rpm > spec.limiterRpm) st.limiterCut = 0.045
  if (st.limiterCut > 0) st.limiterCut -= dt

  // idle controller keeps the engine alive
  const idleErr = spec.idleRpm - rpm
  const idleThrottle = clamp(idleErr / 400, 0, 0.35)
  let thr = Math.max(throttle, idleThrottle)
  if (st.limiterCut > 0) thr = 0
  st.throttleEff = thr

  // turbo spool
  let boostMul = 1
  if (spec.turbo) {
    const t = spec.turbo
    const spoolAvail = smoothstep(t.spoolRpm, t.fullRpm, rpm)
    const target = thr * spoolAvail
    const rate = target > st.boost ? 1 / t.spoolUp : 1 / t.spoolDown
    const prev = st.boost
    st.boost += (target - st.boost) * clamp(rate * dt, 0, 1)
    if (prev > 0.55 && thr < 0.15 && st.boost < prev) st.blowOff = Math.min(1, st.blowOff + (prev - st.boost) * 4)
    boostMul = t.naFraction + (1 - t.naFraction) * st.boost
  }
  st.blowOff = Math.max(0, st.blowOff - dt * 2.2)

  const full = lookup(spec.torque, Math.max(rpm, 300)) * boostMul
  // part-throttle: progressive map. Engine braking when closed.
  const map = Math.pow(thr, 1.35)
  const drag = (spec.dragA + (spec.dragB * Math.max(rpm, 0)) / 1000) * (rpm > 200 ? 1 : rpm / 200)
  let T = map * full - (1 - map) * drag
  if (rpm > spec.maxRpm) T -= (rpm - spec.maxRpm) * 2

  // overrun pops: lifting at high rpm
  if (thr < 0.05 && rpm > 4500 && rand < dt * 9) st.backfire = 1
  st.backfire = Math.max(0, st.backfire - dt * 12)

  st.torque = T
  st.load = clamp(thr * boostMul, 0, 1)
  return T
}
