// Drive-feel probe: the player's car driven headlessly through typical situations with keyboard-like
// and gamepad-like inputs, through the exact input pipeline of src/input/input.ts and the assists of
// src/physics/vehicle.ts, at the game's frame rate (60 Hz input, 600 Hz physics). Every scenario
// returns a small set of numbers (yaw response, overshoot, body slip, spins, frames to catch a
// slide...), printed by scripts/feel-probe.ts and checked by tests/feel.test.ts.
//
// Sign conventions: input steer +1 = right; yaw rate (w . up) + = turning left; body slip beta
// + = the car moves to the left of where it points. Metrics are reported as magnitudes relative to
// the direction of the manoeuvre.
import { KeyboardFilter, PadFilter, type KeyState } from '../../src/input/input'
import { FlatGround, type Ground } from '../../src/physics/ground'
import { clamp, RADS_TO_RPM } from '../../src/physics/math'
import { getCar } from '../../src/physics/spec'
import { type Assists, Vehicle } from '../../src/physics/vehicle'
import { PhysicsWorld, type SimCar } from '../../src/physics/world'
import { useSettings } from '../../src/state/settings'
import { Track } from '../../src/track/track'
import { getTrackDef } from '../../src/track/trackDef'

export const FRAME = 1 / 60
const DEG = 180 / Math.PI

/** What the virtual driver does this frame. Keys go through the keyboard ramps; a pad through the pad filter. */
export interface Cmd {
  keys?: Partial<KeyState>
  /** gamepad: raw stick (-1..1, + right) and triggers (0..1) */
  stick?: number
  /** analog override of the pedals (e.g. a cruise control holding speed for a steering test) */
  throttle?: number
  brake?: number
  handbrake?: number
}

export interface Sample {
  t: number
  speed: number
  yaw: number
  beta: number
  front: number
  rear: number
  latG: number
  steer: number
  wheel: number
  x: number
  z: number
  heading: number
  abs: boolean
  tc: boolean
}

let _track: Track | null = null
export function track() {
  return (_track ??= new Track(getTrackDef('valle-alta')))
}

export interface ProbeOptions {
  car?: string
  assists?: Partial<Assists>
  ground?: Ground
}

export class Probe {
  world: PhysicsWorld
  v: Vehicle
  sim: SimCar
  kb = new KeyboardFilter()
  pad = new PadFilter()
  t = 0
  log: Sample[] = []
  /** device of the last command (the pad filter only runs while the pad drives) */
  private lastKeys: KeyState = { left: false, right: false, up: false, down: false }
  keyPresses = 0
  constructor(opts: ProbeOptions = {}) {
    const ground = opts.ground ?? new FlatGround()
    this.world = new PhysicsWorld(ground)
    const s = useSettings.getState()
    this.v = new Vehicle(getCar(opts.car ?? 'vanta-gt3'))
    this.v.assists = { ...s.assists, ...opts.assists }
    this.v.contactQuality = 2
    this.v.reset(0, 0, 0, ground)
    this.sim = this.world.addCar('player', this.v)
    warm(this.v)
  }

  get controls() {
    return useSettings.getState().controls
  }

  /** One 60 Hz frame: the driver's command through the input pipeline, then physics. */
  frame(cmd: Cmd) {
    const v = this.v
    const inp = this.sim.input
    const keys: KeyState = { left: !!cmd.keys?.left, right: !!cmd.keys?.right, up: !!cmd.keys?.up, down: !!cmd.keys?.down }
    if ((keys.left && !this.lastKeys.left) || (keys.right && !this.lastKeys.right)) this.keyPresses++
    this.lastKeys = keys
    this.kb.update(FRAME, v.speed, keys, this.controls, v.bodySlip ?? 0)
    if (cmd.stick !== undefined) {
      inp.steer = this.pad.update(FRAME, v.speed, cmd.stick, this.controls)
    } else {
      this.pad.reset()
      inp.steer = this.kb.steer
    }
    inp.throttle = cmd.throttle ?? this.kb.throttle
    inp.brake = cmd.brake ?? this.kb.brake
    inp.handbrake = cmd.handbrake ?? 0
    this.world.update(FRAME)
    this.t += FRAME
    this.log.push(this.sample())
  }

  sample(): Sample {
    const v = this.v
    const vl = v.vel.x * v.left.x + v.vel.y * v.left.y + v.vel.z * v.left.z
    const vf = v.vel.x * v.fwd.x + v.vel.y * v.fwd.y + v.vel.z * v.fwd.z
    return {
      t: this.t,
      speed: v.speed,
      yaw: v.w.x * v.up.x + v.w.y * v.up.y + v.w.z * v.up.z,
      beta: Math.atan2(vl, Math.max(Math.abs(vf), 1)),
      front: Math.max(Math.abs(v.wheels[0].tyre.slipAngle), Math.abs(v.wheels[1].tyre.slipAngle)),
      rear: Math.max(Math.abs(v.wheels[2].tyre.slipAngle), Math.abs(v.wheels[3].tyre.slipAngle)),
      latG: v.accelLat,
      steer: this.sim.input.steer,
      wheel: (v.wheels[0].steer + v.wheels[1].steer) / 2,
      x: v.pos.x,
      z: v.pos.z,
      heading: Math.atan2(v.fwd.x, v.fwd.z),
      abs: v.absActive,
      tc: v.tcActive,
    }
  }

  /** Throttle / brake holding a speed (m/s), for steering tests that should not be about the pedals. */
  cruise(target: number) {
    const err = target - this.v.speed
    this.cruiseI = clamp(this.cruiseI + err * FRAME * 0.15, 0, 0.8)
    const thr = clamp(0.12 + this.cruiseI + err * 0.35, 0, 1)
    return { throttle: err < -2 ? 0 : thr, brake: err < -2 ? clamp(-err * 0.08, 0, 0.6) : 0 }
  }
  private cruiseI = 0.25

  /** Straight-line cruise at the given speed to let everything settle (not logged). */
  settle(speed: number, seconds = 1.2) {
    for (let i = 0; i < seconds / FRAME; i++) this.frame({ ...this.cruise(speed) })
    this.log = []
    this.t = 0
    this.keyPresses = 0
  }
}

/** Tyres and brakes at working temperature, as after an out-lap. */
export function warm(v: Vehicle) {
  for (const w of v.wheels) {
    w.tyre.surfTemp = w.tyre.coreTemp = w.model.compound.optTemp
    w.tyre.updatePressure()
    w.brakeTemp = 420
  }
}

/** Rolling at speed (m/s) in a sensible gear. */
export function launch(p: Probe, speed: number) {
  const v = p.v
  v.setVelocityForward(speed)
  const eng = v.spec.engine
  let g = 1
  for (let k = 1; k <= v.gearCount; k++) {
    const rpm = (speed / v.wheels[2].radius) * v.ratioFor(k) * RADS_TO_RPM
    if (rpm < eng.limiterRpm - 300 && rpm > eng.limiterRpm * 0.5) g = k
  }
  v.gear = v.pendingGear = g
  v.engine.omega = (speed / v.wheels[2].radius) * v.ratioFor(g)
}

// --------------------------------------------------------------------------------- measurements

const absMax = (xs: number[]) => xs.reduce((a, b) => Math.max(a, Math.abs(b)), 0)
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)

/** First time (s, from t0) |x| reaches frac of ref. */
function riseTime(log: Sample[], key: keyof Sample, ref: number, frac: number, t0 = 0) {
  for (const s of log) if (s.t >= t0 && Math.abs(s[key] as number) >= frac * ref) return s.t - t0
  return Infinity
}

export interface Result {
  name: string
  device: 'keyboard' | 'pad'
  metrics: Record<string, number>
}

const spun = (log: Sample[]) => (absMax(log.map((s) => s.beta)) * DEG > 35 ? 1 : 0)

/**
 * Step steer at 120 km/h. Keyboard: a held key (the ramp and the assist's limit decide everything);
 * pad: the stick to 40 % at once (linear range). Yaw-rate response time (90 %) and overshoot.
 */
export function stepSteer(device: 'keyboard' | 'pad', speedKmh = 120): Result {
  const p = new Probe()
  const V = speedKmh / 3.6
  launch(p, V)
  p.settle(V)
  // constant throttle from here on (ISO 7401 style): what held the speed on the straight
  const thr = p.cruise(V).throttle
  const hold = 1.6
  for (let i = 0; i < hold / FRAME; i++) p.frame({ ...(device === 'keyboard' ? { keys: { right: true } } : { stick: 0.4 }), throttle: thr, brake: 0 })
  const log = p.log
  const ss = mean(log.filter((s) => s.t > 1.0 && s.t <= 1.5).map((s) => Math.abs(s.yaw)))
  const peak = absMax(log.filter((s) => s.t <= 1.0).map((s) => s.yaw))
  return {
    name: `step steer ${speedKmh}`,
    device,
    metrics: {
      'yaw t90 ms': riseTime(log, 'yaw', ss, 0.9) * 1000,
      'yaw overshoot %': Math.max(0, peak / ss - 1) * 100,
      'steady lat g': Math.abs(mean(log.filter((s) => s.t > 1.0 && s.t <= 1.5).map((s) => s.latG))),
      'max beta deg': absMax(log.map((s) => s.beta)) * DEG,
      spin: spun(log),
    },
  }
}

/**
 * A keyboard tap (a 0.12 s press, a typical small correction) at 160 km/h: how far the car turns
 * and whether the yaw rings after the key comes up.
 */
export function tap(speedKmh = 160): Result {
  const p = new Probe()
  const V = speedKmh / 3.6
  launch(p, V)
  p.settle(V)
  for (let i = 0; i < 2.5 / FRAME; i++) p.frame({ keys: { right: i < Math.round(0.12 / FRAME) }, ...p.cruise(V) })
  const log = p.log
  const peak = absMax(log.map((s) => s.yaw))
  const sign = Math.sign(log.find((s) => Math.abs(s.yaw) === peak)!.yaw)
  const reverse = Math.max(0, ...log.map((s) => -sign * s.yaw))
  const tPeak = log.find((s) => Math.abs(s.yaw) === peak)!.t
  const settle = lastAbove(log, 'yaw', 0.1 * peak)
  return {
    name: `key tap ${speedKmh}`,
    device: 'keyboard',
    metrics: {
      'heading change deg': Math.abs(log[log.length - 1].heading - log[0].heading) * DEG,
      'peak yaw deg/s': peak * DEG,
      'yaw peak ms': tPeak * 1000,
      'yaw rebound %': (reverse / peak) * 100,
      'settle ms': settle * 1000,
    },
  }
}

function lastAbove(log: Sample[], key: keyof Sample, thr: number) {
  let t = 0
  for (const s of log) if (Math.abs(s[key] as number) > thr) t = s.t
  return t
}

/**
 * Single lane change at 120 km/h (about 3.5 m): keyboard right 0.32 s, left 0.32 s, release; pad one
 * period of a sine. Lateral offset, residual heading, yaw ringing and settling.
 */
export function laneChange(device: 'keyboard' | 'pad', speedKmh = 120): Result {
  const p = new Probe()
  const V = speedKmh / 3.6
  launch(p, V)
  p.settle(V)
  const T = 0.32
  const n = Math.round(4 / FRAME)
  for (let i = 0; i < n; i++) {
    const t = i * FRAME
    const cmd: Cmd = { ...p.cruise(V) }
    if (device === 'keyboard') cmd.keys = { right: t < T, left: t >= T && t < 2 * T }
    else cmd.stick = t < 2 * T * 1.15 ? 0.3 * Math.sin((Math.PI * 2 * t) / (2 * T * 1.15)) : 0
    p.frame(cmd)
  }
  const log = p.log
  const release = 2 * T * (device === 'keyboard' ? 1 : 1.15)
  const after = log.filter((s) => s.t > release + 0.25)
  const lat = Math.abs(log[log.length - 1].x - log[0].x)
  // ringing: yaw-rate sign changes above 1 deg/s after the inputs stop
  let flips = 0,
    prev = 0
  for (const s of after) {
    const sg = Math.abs(s.yaw) > 1 / DEG ? Math.sign(s.yaw) : 0
    if (sg && prev && sg !== prev) flips++
    if (sg) prev = sg
  }
  return {
    name: `lane change ${speedKmh}`,
    device,
    metrics: {
      'lateral m': lat,
      'heading err deg': Math.abs(log[log.length - 1].heading - log[0].heading) * DEG,
      'yaw after inputs deg/s': absMax(after.map((s) => s.yaw)) * DEG,
      'yaw flips': flips,
      'settle ms': Math.max(0, lastAbove(log, 'yaw', 1.5 / DEG) - release) * 1000,
      'max beta deg': absMax(log.map((s) => s.beta)) * DEG,
    },
  }
}

/**
 * Hairpin entry: 200 km/h, full brake, turn in at 125 km/h still braking (trail braking), off the
 * brake at 75 km/h. Body slip, spins, ABS, how far the car turns.
 */
export function hairpin(device: 'keyboard' | 'pad'): Result {
  const p = new Probe()
  launch(p, 200 / 3.6)
  p.settle(200 / 3.6, 0.6)
  let turning = false,
    braking = true
  let turnAt = 0
  for (let i = 0; i < 4.5 / FRAME; i++) {
    const kmh = p.v.speed * 3.6
    if (!turning && kmh < 125) {
      turning = true
      turnAt = p.t
    }
    if (braking && kmh < 75) braking = false
    if (device === 'keyboard') p.frame({ keys: { down: braking, right: turning }, ...(braking ? {} : { throttle: 0.15 }) })
    else p.frame({ stick: turning ? 0.85 : 0, brake: braking ? (turning ? 0.55 : 1) : 0, throttle: braking ? 0 : 0.15 })
  }
  const log = p.log
  const turn = log.filter((s) => s.t >= turnAt)
  return {
    name: 'hairpin trail-brake',
    device,
    metrics: {
      'max beta deg': absMax(turn.map((s) => s.beta)) * DEG,
      'peak yaw deg/s': absMax(turn.map((s) => s.yaw)) * DEG,
      'heading change deg': Math.abs(unwrap(turn.map((s) => s.heading))) * DEG,
      'abs active %': (log.filter((s) => s.abs).length / log.length) * 100,
      spin: spun(turn),
    },
  }
}

function unwrap(h: number[]) {
  let total = 0
  for (let i = 1; i < h.length; i++) {
    let d = h[i] - h[i - 1]
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    total += d
  }
  return total
}

/**
 * Steering ramp at 200 km/h with the pad (0 -> full over 5 s): how progressive the car is.
 * Input at 50 % / 90 % of the peak lateral g, the drop past the peak (a cliff feels numb or snappy),
 * understeer at the limit (front minus rear slip angle).
 */
export function ramp(speedKmh = 200): Result {
  const p = new Probe()
  const V = speedKmh / 3.6
  launch(p, V)
  p.settle(V)
  const T = 5
  for (let i = 0; i < T / FRAME; i++) p.frame({ stick: (i * FRAME) / T, ...p.cruise(V) })
  const log = p.log
  const g = log.map((s) => Math.abs(s.latG))
  const peak = Math.max(...g)
  const ip = g.indexOf(peak)
  const at = (f: number) => (log.find((s) => Math.abs(s.latG) >= f * peak)?.t ?? T) / T
  const lim = log.slice(Math.max(0, ip - 30), ip + 1)
  return {
    name: `steering ramp ${speedKmh}`,
    device: 'pad',
    metrics: {
      'peak lat g': peak,
      'stick at 50% g': at(0.5),
      'stick at 90% g': at(0.9),
      'g drop past peak %': (1 - Math.abs(log[log.length - 1].latG) / peak) * 100,
      'understeer deg': mean(lim.map((s) => s.front - s.rear)) * DEG,
      'max beta deg': absMax(log.map((s) => s.beta)) * DEG,
      spin: spun(log),
    },
  }
}

/** Full lock at 200 km/h with 35 % throttle (key held / stick full). */
export function fullLock(device: 'keyboard' | 'pad', speedKmh = 200): Result {
  const p = new Probe()
  launch(p, speedKmh / 3.6)
  p.settle(speedKmh / 3.6, 0.5)
  for (let i = 0; i < 2 / FRAME; i++) p.frame(device === 'keyboard' ? { keys: { right: true }, throttle: 0.35 } : { stick: 1, throttle: 0.35 })
  const log = p.log
  return {
    name: `full lock ${speedKmh}`,
    device,
    metrics: {
      'max beta deg': absMax(log.map((s) => s.beta)) * DEG,
      'front slip deg': absMax(log.map((s) => s.front)) * DEG,
      'rear slip deg': absMax(log.map((s) => s.rear)) * DEG,
      'peak lat g': absMax(log.map((s) => s.latG)),
      'speed lost km/h': (log[0].speed - log[log.length - 1].speed) * 3.6,
      spin: spun(log),
    },
  }
}

/**
 * The keyboard (or pad) driver catching a slide: reacts after `reaction` s to body slip in the
 * direction of oversteer with opposite lock, lets go once it is caught. Shared by the power-on exit
 * and the slide-recovery scenarios.
 */
class SlideCatcher {
  /** turn direction of the corner: +1 right, -1 left (steer sign) */
  constructor(
    public dir: number,
    public reaction = 0.2,
    /** body slip (deg) the driver reacts to */
    public onsetDeg = 4,
  ) {}
  seen = -1
  onset = -1
  recovered = -1
  quietSince = -1
  maxBeta = 0
  secondary = 0
  /** the slide being caught: +1 towards the first oversteer, -1 the other way, 0 none */
  catching = 0
  /** body slip measured towards the oversteer direction (deg) */
  slip(s: Sample) {
    // a right turn (steer +) that oversteers: the rear goes left, the car moves to the left of its heading... beta > 0
    return s.beta * DEG * this.dir
  }
  /** returns the steering wish: +1 hold the turn, -1 counter-steer, 0 hands off */
  decide(s: Sample, history: Sample[]) {
    const b = this.slip(s)
    this.maxBeta = Math.max(this.maxBeta, b)
    if (this.onset < 0 && b > this.onsetDeg) this.onset = s.t
    if (this.onset >= 0) this.secondary = Math.max(this.secondary, -b)
    // what the driver sees now happened `reaction` seconds ago
    const lag = Math.round(this.reaction / FRAME)
    const seen = history[history.length - 1 - lag]
    if (!seen) return 1
    const bs = this.slip(seen)
    // like a player: opposite lock against whichever way the car is seen sliding, off once it stops
    if (!this.catching && this.onset >= 0 && Math.abs(bs) > this.onsetDeg && Math.sign(bs) * seen.yaw * DEG < 20) this.catching = Math.sign(bs)
    // ...and off as soon as the car is seen rotating back (the rear has gripped again)
    if (this.catching && (this.catching * bs < 1.5 || this.catching * seen.yaw * DEG > 20)) this.catching = 0
    if (this.onset >= 0 && this.recovered < 0) {
      // caught: little body slip, and not just passing through zero on the way to a slide the other way
      const prev = history[history.length - 2]
      const rate = prev ? Math.abs(b - this.slip(prev)) / FRAME : 0
      if (Math.abs(b) < 2.5 && rate < 10) {
        if (this.quietSince < 0) this.quietSince = s.t
        if (s.t - this.quietSince > 0.3) this.recovered = this.quietSince
      } else this.quietSince = -1
    }
    if (this.catching) return -this.catching
    return this.onset >= 0 ? 0 : 1
  }
  framesToRecover() {
    return this.onset < 0 ? 0 : this.recovered < 0 ? Infinity : Math.round((this.recovered - this.onset) / FRAME)
  }
}

/**
 * Power-on corner exit: at the limit in a slow right-hander (key held), full throttle (key W). The
 * driver catches what the rear does (from 6 deg: a few degrees on power is normal). How far the rear
 * steps out, the overcorrection that follows, and how much speed the exit gains in 3 s.
 */
export function powerExit(device: 'keyboard' | 'pad'): Result {
  const p = new Probe()
  const V = 70 / 3.6
  launch(p, V)
  p.settle(V, 0.6)
  for (let i = 0; i < 1.5 / FRAME; i++) p.frame({ ...(device === 'keyboard' ? { keys: { right: true } } : { stick: 0.7 }), ...p.cruise(V) })
  p.log = []
  p.t = 0
  // a few degrees of slip on power is normal: the driver reacts from 6
  const catcher = new SlideCatcher(1, 0.2, 6)
  const v0 = p.v.speed
  for (let i = 0; i < 3 / FRAME; i++) {
    const s = p.sample()
    const want = catcher.decide(s, p.log.length ? p.log : [s])
    const lift = catcher.slip(s) > 15
    if (device === 'keyboard') p.frame({ keys: { right: want > 0, left: want < 0, up: !lift } })
    else p.frame({ stick: want > 0 ? 0.7 : want < 0 ? -0.6 : 0, throttle: lift ? 0 : clamp(p.t / 0.15, 0, 1) })
  }
  const log = p.log
  return {
    name: 'power-on exit',
    device,
    metrics: {
      'max beta deg': catcher.maxBeta,
      'speed gain km/h': (p.v.speed - v0) * 3.6,
      'secondary slide deg': catcher.secondary,
      'tc active %': (log.filter((s) => s.tc).length / log.length) * 100,
      spin: spun(log),
    },
  }
}

/**
 * Slide recovery: at the limit in a 110 km/h right-hander the rear steps out (a lift and a yaw kick
 * of 45 deg/s, as from a bump or a kerb); the driver reacts after 0.2 s with opposite lock. Frames
 * (60 Hz) from the slide's onset until it is caught, and the slide the other way that follows.
 */
export function slideRecovery(device: 'keyboard' | 'pad'): Result {
  const p = new Probe()
  const V = 110 / 3.6
  launch(p, V)
  p.settle(V, 0.6)
  const corner = device === 'keyboard' ? { keys: { right: true } } : { stick: 0.6 }
  for (let i = 0; i < 1.2 / FRAME; i++) p.frame({ ...corner, ...p.cruise(V) })
  p.log = []
  p.t = 0
  p.keyPresses = 0
  // the kick: rotate the car further into the corner (right = negative yaw)
  const v = p.v
  v.w.addScaled(v.up, -45 / DEG)
  const catcher = new SlideCatcher(1)
  for (let i = 0; i < 4 / FRAME; i++) {
    const s = p.sample()
    const want = catcher.decide(s, p.log.length ? p.log : [s])
    const turn = device === 'keyboard' ? { keys: { right: want > 0, left: want < 0 } } : { stick: want > 0 ? 0.6 : want < 0 ? -0.6 : 0 }
    p.frame({ ...turn, throttle: p.t < 0.3 ? 0 : 0.3 })
  }
  const log = p.log
  return {
    name: 'slide recovery',
    device,
    metrics: {
      'max beta deg': catcher.maxBeta,
      'frames to catch': catcher.framesToRecover(),
      'secondary slide deg': catcher.secondary,
      'counter-steer presses': p.keyPresses,
      spin: spun(log),
    },
  }
}

/** Straight-line braking from 250 km/h (key S): yaw wander, distance to 60 km/h. */
export function braking(): Result {
  const p = new Probe()
  launch(p, 250 / 3.6)
  p.settle(250 / 3.6, 0.5)
  const x0 = p.v.pos.z
  let dist = 0
  for (let i = 0; i < 5 / FRAME; i++) {
    p.frame({ keys: { down: true } })
    if (!dist && p.v.speed < 60 / 3.6) dist = p.v.pos.z - x0
  }
  const log = p.log.filter((s) => s.speed > 60 / 3.6)
  return {
    name: 'braking 250-60',
    device: 'keyboard',
    metrics: {
      'distance m': dist,
      'max yaw deg/s': absMax(log.map((s) => s.yaw)) * DEG,
      'heading drift deg': absMax(log.map((s) => s.heading - log[0].heading)) * DEG,
      'abs active %': (log.filter((s) => s.abs).length / log.length) * 100,
    },
  }
}

/** Braking from 200 km/h while already turning a little (pad): does the rear step out? */
export function brakeInTurn(): Result {
  const p = new Probe()
  const V = 200 / 3.6
  launch(p, V)
  p.settle(V, 0.5)
  for (let i = 0; i < 1 / FRAME; i++) p.frame({ stick: 0.25, ...p.cruise(V) })
  p.log = []
  for (let i = 0; i < 2.5 / FRAME; i++) p.frame({ stick: 0.25, brake: 1, throttle: 0 })
  const log = p.log
  return {
    name: 'brake in a curve 200',
    device: 'pad',
    metrics: {
      'max beta deg': absMax(log.map((s) => s.beta)) * DEG,
      'peak yaw deg/s': absMax(log.map((s) => s.yaw)) * DEG,
      spin: spun(log),
    },
  }
}

/**
 * Kerb strike on the real circuit: 160 km/h hands off across an exit kerb at a shallow angle. How
 * hard the kerb kicks the car (yaw, heading) and the steering wheel.
 */
export function kerbStrike(): Result {
  const tr = track()
  // a kerb on a nearly straight piece of track
  let si = -1
  for (let i = 0; i < tr.n; i++) {
    const k = (i + 200) % tr.n
    if (tr.L.kerb[k] > 0.8 && Math.abs(tr.curv[k]) < 0.0025 && Math.abs(tr.curv[(k + 30) % tr.n]) < 0.0025 && Math.abs(tr.curv[(k - 40 + tr.n) % tr.n]) < 0.0025) {
      si = k
      break
    }
  }
  const p = new Probe({ ground: tr })
  const sKerb = (si / tr.n) * tr.length
  const s0 = sKerb - 45
  const i0 = tr.idx(s0)
  // aim so the left wheels reach the middle of the kerb at sKerb
  const dKerb = tr.hw[si] + tr.L.kerb[si] * 0.5 - p.v.spec.trackFront * 0.5
  const d0 = dKerb - 45 * Math.tan(1.6 / DEG)
  const pt = tr.pointAt(s0, d0, { x: 0, y: 0, z: 0 })
  p.v.reset(pt.x, pt.z, tr.headingAt(s0) + 1.6 / DEG, tr)
  warm(p.v)
  launch(p, 160 / 3.6)
  p.t = 0
  const V = 160 / 3.6
  let wheel = 0
  for (let i = 0; i < 2.2 / FRAME; i++) {
    p.frame({ stick: 0, ...p.cruise(V) })
    wheel = Math.max(wheel, Math.abs(p.log[p.log.length - 1].wheel))
  }
  const log = p.log
  void i0
  return {
    name: 'kerb strike 160',
    device: 'pad',
    metrics: {
      'peak yaw deg/s': absMax(log.map((s) => s.yaw)) * DEG,
      'heading change deg': Math.abs(log[log.length - 1].heading - log[0].heading) * DEG,
      'max beta deg': absMax(log.map((s) => s.beta)) * DEG,
      'road wheel twitch deg': wheel * DEG,
    },
  }
}

/**
 * A fast sweeper with the keyboard: a 300 m radius at 200 km/h, followed by a driver who taps the
 * keys (0.1 s perception delay) to hold the line. Line error, weave and taps per second.
 */
export function sweeperKeyboard(): Result {
  const R = 300
  const V = 200 / 3.6
  const p = new Probe()
  // start on the circle (centre at +x: a left-hander... use a right-hander: centre at -x)
  p.v.reset(R, 0, 0, p.world.ground)
  warm(p.v)
  launch(p, V)
  const hist: { e: number; he: number }[] = []
  const T = 8
  for (let i = 0; i < T / FRAME; i++) {
    const v = p.v
    // right-hand circle centred at the origin, start at x = R heading +z: the centre is at -x... the car turns right towards -x? (+x is left)
    const r = Math.hypot(v.pos.x, v.pos.z)
    const e = r - R // + = outside
    // desired heading: tangent of a clockwise (right-hand, seen from above with +x left) circle
    const tx = -v.pos.z / r,
      tz = v.pos.x / r
    let he = Math.atan2(tx, tz) - Math.atan2(v.fwd.x, v.fwd.z)
    while (he > Math.PI) he -= 2 * Math.PI
    while (he < -Math.PI) he += 2 * Math.PI
    hist.push({ e, he })
    const seen = hist[Math.max(0, hist.length - 1 - 6)]
    // wanted: turn more right when outside or pointing outside
    const want = seen.e * 0.15 - seen.he * 8 // > 0: needs more right
    const yawWanted = V / R
    const yawNow = -(v.w.y)
    const more = want + (yawWanted - yawNow) * 6
    p.frame({ keys: { right: more > 0.08, left: more < -0.5 }, ...p.cruise(V) })
  }
  const log = p.log.filter((s) => s.t > 2)
  const errs: number[] = []
  for (const s of log) errs.push(Math.hypot(s.x, s.z) - R)
  // weave: yaw rate about its mean
  const ym = mean(log.map((s) => s.yaw))
  const weave = Math.sqrt(mean(log.map((s) => (s.yaw - ym) ** 2)))
  return {
    name: 'sweeper 200 (R 300)',
    device: 'keyboard',
    metrics: {
      'line rms m': Math.sqrt(mean(errs.map((e) => e * e))),
      'yaw weave deg/s': weave * DEG,
      'taps per s': p.keyPresses / T,
      'max beta deg': absMax(log.map((s) => s.beta)) * DEG,
    },
  }
}

export function allScenarios(): Result[] {
  return [
    stepSteer('keyboard'),
    stepSteer('pad'),
    tap(),
    laneChange('keyboard'),
    laneChange('pad'),
    hairpin('keyboard'),
    hairpin('pad'),
    ramp(),
    fullLock('keyboard'),
    fullLock('pad'),
    powerExit('keyboard'),
    powerExit('pad'),
    slideRecovery('keyboard'),
    slideRecovery('pad'),
    braking(),
    brakeInTurn(),
    sweeperKeyboard(),
    kerbStrike(),
  ]
}

export function formatResults(rs: Result[]) {
  const lines: string[] = []
  for (const r of rs) {
    const m = Object.entries(r.metrics)
      .map(([k, v]) => `${k} ${Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : 'never'}`)
      .join('  |  ')
    lines.push(`${(r.name + ' [' + r.device + ']').padEnd(34)} ${m}`)
  }
  return lines.join('\n')
}
