// Replays: every car's visible state recorded at 30 Hz into compact typed arrays while a session
// runs, and played back without physics.
//
// Recording (ReplayRecorder): per car and sample about 110 bytes (position as float32, orientation,
// velocity, wheel angles / speeds / steering / suspension travel quantised to int16, brake heat, tyre
// slide state for smoke, skids and squeal, pedals, rpm and gear as bytes, the timing for the
// broadcast graphics). Samples are kept in chunks of 256; a session longer than its cap drops its
// oldest chunk (practice keeps the last 15 minutes, races 45).
//
// Playback (ReplayPlayer): each CarEntry gets a stand-in SimCar / Vehicle of the same car and setup
// (and its own LapTiming) while the replay runs; the real ones are put back afterwards, untouched,
// so a practice session carries on where it stopped. Every frame the recorded state, interpolated to
// the replay clock, is written into the fields the renderer reads (CarVisual: pos, q, prevPos /
// prevQuat with world.alpha = 1; the car models: wheel spin / steer / travel / brake heat, steerInput,
// brake; the motion blur: wheel omega; effects and audio: tyre slide state, rpm, throttle). Physics
// does not step (Game.update returns early). Wheel spin is integrated from the recorded wheel speeds
// (a wheel turns more than a revolution between two samples at speed), and the wheel omega the
// motion blur reads is scaled by the playback speed, so the blur matches what is shown at 0.25x-4x.
import { clamp, RADS_TO_RPM } from '../physics/math'
import { getCar, type CarSetup } from '../physics/spec'
import { Vehicle } from '../physics/vehicle'
import { SimCar } from '../physics/world'
import type { Surface } from '../physics/ground'
import { type CarEntry, LapTiming } from './game'

export const REPLAY_HZ = 30
const CHUNK = 256
const SHIFT = 8

// channels per car and sample
const F32 = 5 // px py pz, lap time, distance
const I16 = 8 + 4 * 4 // quaternion (4), velocity (3, cm/s), steerInput; per wheel: spin, omega, steer, travel
const U8 = 12 + 4 * 8 // pedals, engine, gear, position, flags, sector, lap...; per wheel: brake temp, slide, power, temp, surface, combined, sliding, slip ratio
const U16 = 2 // rpm, track position s (dm)

const FL_ABS = 1,
  FL_TC = 2,
  FL_VALID = 4,
  FL_FINISHED = 8,
  FL_SLIDE = 16,
  FL_OFF = 32,
  FL_STARTED = 64

interface Chunk {
  t: Float64Array
  n: number
  f32: Float32Array
  i16: Int16Array
  u8: Uint8Array
  u16: Uint16Array
}

export interface ReplayCar {
  id: string
  name: string
  carId: string
  setup: CarSetup
  isPlayer: boolean
}

export interface ReplayHeader {
  mode: string
  trackId: string
  laps: number
  trackLength: number
  cars: ReplayCar[]
}

const q16 = (x: number, s: number) => clamp(Math.round(x * s), -32767, 32767)
const u8 = (x: number) => clamp(Math.round(x), 0, 255)
const wrapAngle = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))

/** Recorded session: a header and the samples (shared by the recorder and the player). */
export class Replay {
  chunks: Chunk[] = []
  count = 0
  /** session time of the race start ("go"), -1 when there is none */
  goAt = -1
  constructor(
    public header: ReplayHeader,
    public maxSamples: number,
  ) {}

  get nCars() {
    return this.header.cars.length
  }
  t(k: number) {
    return this.chunks[k >> SHIFT].t[k & (CHUNK - 1)]
  }
  get start() {
    return this.count ? this.t(0) : 0
  }
  get end() {
    return this.count ? this.t(this.count - 1) : 0
  }
  get duration() {
    return this.end - this.start
  }
  /** bytes held by the samples */
  get bytes() {
    let b = 0
    for (const c of this.chunks) b += c.t.byteLength + c.f32.byteLength + c.i16.byteLength + c.u8.byteLength + c.u16.byteLength
    return b
  }

  /** index of the last sample at or before t (0 if before the first) */
  find(t: number) {
    let lo = 0,
      hi = this.count - 1
    if (hi < 0 || t <= this.t(0)) return 0
    if (t >= this.t(hi)) return hi
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (this.t(mid) <= t) lo = mid
      else hi = mid
    }
    return lo
  }

  /** a new sample slot; returns [chunk, index in chunk] */
  push(t: number): [Chunk, number] {
    if (this.count >= this.maxSamples && this.chunks.length > 1) {
      // over the cap: drop the oldest chunk
      this.chunks.shift()
      this.count -= CHUNK
    }
    const ci = this.count >> SHIFT
    let c = this.chunks[ci]
    if (!c) {
      const n = this.nCars
      c = { t: new Float64Array(CHUNK), n: 0, f32: new Float32Array(CHUNK * n * F32), i16: new Int16Array(CHUNK * n * I16), u8: new Uint8Array(CHUNK * n * U8), u16: new Uint16Array(CHUNK * n * U16) }
      this.chunks.push(c)
    }
    const i = this.count & (CHUNK - 1)
    c.t[i] = t
    c.n = i + 1
    this.count++
    return [c, i]
  }
}

/** Records the cars of a session (CarEntry order at the start) at REPLAY_HZ of simulation time. */
export class ReplayRecorder {
  replay: Replay
  private acc = 0
  private cars: CarEntry[]
  constructor(cars: CarEntry[], meta: { mode: string; trackId: string; laps: number; trackLength: number }, maxSeconds: number) {
    this.cars = [...cars]
    this.replay = new Replay(
      { ...meta, cars: this.cars.map((c) => ({ id: c.id, name: c.name, carId: c.carId, setup: { ...c.sim.vehicle.setup }, isPlayer: c.isPlayer })) },
      Math.ceil((maxSeconds * REPLAY_HZ) / CHUNK) * CHUNK,
    )
  }

  /** after the simulation of a frame: dt of simulated time, now = the session clock */
  update(dt: number, now: number) {
    this.acc += dt
    if (this.acc < 1 / REPLAY_HZ && this.replay.count > 0) return
    this.acc = Math.min(this.acc - 1 / REPLAY_HZ, 1 / REPLAY_HZ)
    if (this.acc < 0) this.acc = 0
    this.capture(now)
  }

  capture(now: number) {
    const [c, i] = this.replay.push(now)
    const n = this.cars.length
    for (let k = 0; k < n; k++) {
      const e = this.cars[k]
      const v = e.sim.vehicle
      const t = e.timing
      const s = i * n + k
      const f = c.f32,
        a = c.i16,
        b = c.u8,
        w16 = c.u16
      let o = s * F32
      f[o] = v.pos.x
      f[o + 1] = v.pos.y
      f[o + 2] = v.pos.z
      f[o + 3] = t.current
      f[o + 4] = t.distance
      o = s * I16
      a[o] = q16(v.q.x, 32767)
      a[o + 1] = q16(v.q.y, 32767)
      a[o + 2] = q16(v.q.z, 32767)
      a[o + 3] = q16(v.q.w, 32767)
      a[o + 4] = q16(v.vel.x, 100)
      a[o + 5] = q16(v.vel.y, 100)
      a[o + 6] = q16(v.vel.z, 100)
      a[o + 7] = q16(v.steerInput, 32767)
      for (let j = 0; j < 4; j++) {
        const wh = v.wheels[j]
        const p = o + 8 + j * 4
        a[p] = q16(wrapAngle(wh.spin), 32767 / Math.PI)
        a[p + 1] = q16(wh.omega, 100)
        a[p + 2] = q16(wh.steer, 10000)
        a[p + 3] = q16(wh.c - wh.cStatic, 100000)
      }
      o = s * U8
      b[o] = u8(v.brake * 255)
      b[o + 1] = u8(v.throttle * 255)
      b[o + 2] = u8(v.engine.throttleEff * 255)
      b[o + 3] = u8(v.engine.boost * 255)
      b[o + 4] = u8(v.engine.backfire * 255)
      b[o + 5] = u8(v.scrape * 255)
      b[o + 6] = u8(v.gear + 2)
      b[o + 7] = u8(t.position)
      b[o + 8] =
        (v.absActive ? FL_ABS : 0) |
        (v.tcActive ? FL_TC : 0) |
        (t.valid ? FL_VALID : 0) |
        (t.finished ? FL_FINISHED : 0) |
        (Math.abs(v.bodySlip) > 0.17 ? FL_SLIDE : 0) |
        (!v.onTrackSurface ? FL_OFF : 0) |
        (t.started ? FL_STARTED : 0)
      b[o + 9] = u8(t.sector)
      b[o + 10] = u8(t.lap)
      b[o + 11] = u8(v.accelLong * 40 + 128)
      for (let j = 0; j < 4; j++) {
        const wh = v.wheels[j]
        const ty = wh.tyre
        const p = o + 12 + j * 8
        b[p] = u8(wh.brakeTemp / 4)
        b[p + 1] = u8(ty.slideVel * 4)
        b[p + 2] = u8(ty.slipPower / 1000)
        b[p + 3] = u8(ty.surfTemp)
        b[p + 4] = (wh.surface & 15) | (wh.contact ? 16 : 0)
        b[p + 5] = u8(ty.combinedSlip * 40)
        b[p + 6] = u8(ty.sliding * 255)
        b[p + 7] = u8(clamp(ty.slipRatio, -1, 1) * 127 + 128)
      }
      o = s * U16
      w16[o] = clamp(Math.round(v.rpm), 0, 65535)
      w16[o + 1] = clamp(Math.round(t.s * 10), 0, 65535)
    }
  }
}

/** One car's state at the replay clock, for the broadcast graphics. */
export interface ReplayCarView {
  id: string
  name: string
  isPlayer: boolean
  position: number
  lap: number
  lapTime: number
  distance: number
  s: number
  speed: number
  gear: number
  finished: boolean
  sliding: boolean
  offTrack: boolean
}

interface Swap {
  entry: CarEntry
  sim: SimCar
  timing: LapTiming
}

export type ReplayCamMode = 'tv' | 'chase' | 'onboard'

/** Plays a Replay back into the session's cars. */
export class ReplayPlayer {
  /** the replay clock (session time of the recording) */
  t: number
  speed = 1
  playing = true
  /** camera: the TV director, or chase / onboard of the focused car */
  cam: ReplayCamMode = 'tv'
  /** the car the chase / onboard cameras follow (the player's at first) */
  focus = ''
  /** the car the TV director is asked to follow ('' = its own choice) */
  tvFocus = ''
  /** set on a jump (seek, restart): the camera rig cuts */
  jumped = true
  private swaps: Swap[] = []
  /** car index in the recording for each swapped entry */
  private index: number[] = []
  views: ReplayCarView[] = []
  constructor(
    public replay: Replay,
    entries: CarEntry[],
  ) {
    this.t = replay.start
    const ids = replay.header.cars.map((c) => c.id)
    for (const e of entries) {
      const k = ids.indexOf(e.id)
      if (k < 0) continue
      const rc = replay.header.cars[k]
      // the same car and setup: the same wheel geometry under the same body (its pose is written below)
      const v = new Vehicle(getCar(rc.carId), rc.setup)
      const sim = new SimCar(e.id, v)
      this.swaps.push({ entry: e, sim: e.sim, timing: e.timing })
      e.sim = sim
      e.timing = new LapTiming()
      this.index.push(k)
      this.views.push({ id: e.id, name: e.name, isPlayer: e.isPlayer, position: 1, lap: 0, lapTime: 0, distance: 0, s: 0, speed: 0, gear: 1, finished: false, sliding: false, offTrack: false })
    }
    const player = this.views.find((v) => v.isPlayer)
    this.focus = player?.id ?? this.views[0]?.id ?? ''
    // watching a race starts at the green light (the grid is a few seconds before it)
    if (replay.goAt >= 0) this.t = Math.max(replay.start, replay.goAt - 4)
    this.apply(0)
  }

  /** the entries' real cars and timing back in place */
  restore() {
    for (const s of this.swaps) {
      s.entry.sim = s.sim
      s.entry.timing = s.timing
    }
    this.swaps = []
  }

  get start() {
    return this.replay.start
  }
  get end() {
    return this.replay.end
  }

  seek(t: number) {
    this.t = clamp(t, this.replay.start, this.replay.end)
    this.jumped = true
    this.apply(0)
  }

  /** a frame: dt of real time */
  update(dt: number) {
    const adv = this.playing ? dt * this.speed : 0
    this.t += adv
    if (this.t >= this.replay.end) {
      this.t = this.replay.end
      this.playing = false
    }
    this.apply(adv)
  }

  /** replay time advanced this frame (s): what the cameras smooth over */
  lastAdvance = 0

  private apply(adv: number) {
    this.lastAdvance = adv
    const R = this.replay
    if (!R.count) return
    const k0 = R.find(this.t)
    const k1 = Math.min(k0 + 1, R.count - 1)
    const t0 = R.t(k0),
      t1 = R.t(k1)
    const span = Math.max(t1 - t0, 1e-6)
    const tau = clamp(this.t - t0, 0, span)
    const f = k1 === k0 ? 0 : tau / span
    const c0 = R.chunks[k0 >> SHIFT],
      i0 = k0 & (CHUNK - 1)
    const c1 = R.chunks[k1 >> SHIFT],
      i1 = k1 & (CHUNK - 1)
    const n = R.nCars
    const L = R.header.trackLength
    for (let m = 0; m < this.swaps.length; m++) {
      const k = this.index[m]
      const e = this.swaps[m].entry
      const v = e.sim.vehicle
      const s0 = i0 * n + k,
        s1 = i1 * n + k
      const fa = c0.f32,
        fb = c1.f32
      let o0 = s0 * F32,
        o1 = s1 * F32
      const lerp = (x: number, y: number) => x + (y - x) * f
      v.pos.set(lerp(fa[o0], fb[o1]), lerp(fa[o0 + 1], fb[o1 + 1]), lerp(fa[o0 + 2], fb[o1 + 2]))
      const lapTime = lerp(fa[o0 + 3], fb[o1 + 3]),
        distance = lerp(fa[o0 + 4], fb[o1 + 4])
      const A = c0.i16,
        B = c1.i16
      o0 = s0 * I16
      o1 = s1 * I16
      // orientation: normalised lerp along the shorter way
      let qx = B[o1] / 32767,
        qy = B[o1 + 1] / 32767,
        qz = B[o1 + 2] / 32767,
        qw = B[o1 + 3] / 32767
      const ax = A[o0] / 32767,
        ay = A[o0 + 1] / 32767,
        az = A[o0 + 2] / 32767,
        aw = A[o0 + 3] / 32767
      if (ax * qx + ay * qy + az * qz + aw * qw < 0) {
        qx = -qx
        qy = -qy
        qz = -qz
        qw = -qw
      }
      qx = ax + (qx - ax) * f
      qy = ay + (qy - ay) * f
      qz = az + (qz - az) * f
      qw = aw + (qw - aw) * f
      const ql = Math.hypot(qx, qy, qz, qw) || 1
      v.q.set(qx / ql, qy / ql, qz / ql, qw / ql)
      const vx0 = A[o0 + 4] / 100,
        vy0 = A[o0 + 5] / 100,
        vz0 = A[o0 + 6] / 100
      const vx1 = B[o1 + 4] / 100,
        vy1 = B[o1 + 5] / 100,
        vz1 = B[o1 + 6] / 100
      v.vel.set(vx0 + (vx1 - vx0) * f, vy0 + (vy1 - vy0) * f, vz0 + (vz1 - vz0) * f)
      v.speed = v.vel.len()
      v.steerInput = lerp(A[o0 + 7], B[o1 + 7]) / 32767
      v.updateAxes()
      // g forces from the recorded velocities (the cameras lean on them)
      const ax_ = (vx1 - vx0) / span,
        ay_ = (vy1 - vy0) / span,
        az_ = (vz1 - vz0) / span
      v.accelLat = k1 === k0 ? 0 : (ax_ * v.left.x + ay_ * v.left.y + az_ * v.left.z) / 9.81
      const bU = c0.u8,
        cU = c1.u8
      const u0 = s0 * U8,
        u1 = s1 * U8
      v.accelLong = (lerp(bU[u0 + 11], cU[u1 + 11]) - 128) / 40
      for (let j = 0; j < 4; j++) {
        const wh = v.wheels[j]
        const p0 = o0 + 8 + j * 4,
          p1 = o1 + 8 + j * 4
        const w0 = A[p0 + 1] / 100,
          w1 = B[p1 + 1] / 100
        // spin: the recorded angle, turned on by the recorded wheel speed (integrated, not lerped)
        wh.spin = (A[p0] * Math.PI) / 32767 + w0 * tau + ((w1 - w0) * tau * tau) / (2 * span)
        const omega = w0 + (w1 - w0) * f
        // the motion blur turns the wheel by omega x exposure: the speed it turns on screen
        wh.omega = omega * (this.playing ? this.speed : 0)
        wh.steer = lerp(A[p0 + 2], B[p1 + 2]) / 10000
        wh.c = wh.cStatic + lerp(A[p0 + 3], B[p1 + 3]) / 100000
        const q0 = u0 + 12 + j * 8,
          q1 = u1 + 12 + j * 8
        wh.brakeTemp = lerp(bU[q0], cU[q1]) * 4
        const ty = wh.tyre
        ty.slideVel = lerp(bU[q0 + 1], cU[q1 + 1]) / 4
        ty.slipPower = lerp(bU[q0 + 2], cU[q1 + 2]) * 1000
        ty.surfTemp = lerp(bU[q0 + 3], cU[q1 + 3])
        const sf = (f < 0.5 ? bU[q0 + 4] : cU[q1 + 4]) as number
        wh.surface = (sf & 15) as Surface
        wh.contact = (sf & 16) !== 0
        ty.combinedSlip = lerp(bU[q0 + 5], cU[q1 + 5]) / 40
        ty.sliding = lerp(bU[q0 + 6], cU[q1 + 6]) / 255
        ty.slipRatio = (lerp(bU[q0 + 7], cU[q1 + 7]) - 128) / 127
      }
      v.brake = lerp(bU[u0], cU[u1]) / 255
      v.throttle = lerp(bU[u0 + 1], cU[u1 + 1]) / 255
      v.engine.throttleEff = lerp(bU[u0 + 2], cU[u1 + 2]) / 255
      v.engine.boost = lerp(bU[u0 + 3], cU[u1 + 3]) / 255
      v.engine.backfire = lerp(bU[u0 + 4], cU[u1 + 4]) / 255
      v.scrape = lerp(bU[u0 + 5], cU[u1 + 5]) / 255
      const near = f < 0.5 ? u0 : u1,
        nb = f < 0.5 ? bU : cU
      v.gear = nb[near + 6] - 2
      const flags = nb[near + 8]
      v.absActive = (flags & FL_ABS) !== 0
      v.tcActive = (flags & FL_TC) !== 0
      v.onTrackSurface = (flags & FL_OFF) === 0
      v.engine.omega = lerp(c0.u16[s0 * U16], c1.u16[s1 * U16]) / RADS_TO_RPM
      // wheels in the world: hubs from the pose, contact under them
      v.updateWheelWorld()
      for (const wh of v.wheels) {
        wh.normal.copy(v.up)
        wh.contactPoint.copy(wh.hub).addScaled(v.up, -(wh.radius - 0.012))
      }
      // the renderer interpolates prevPos -> pos by world.alpha (1 during a replay)
      e.sim.prevPos.copy(v.pos)
      e.sim.prevQuat.copy(v.q)
      // timing for the graphics (and the practice ghost)
      const t = e.timing
      t.current = lapTime
      t.distance = distance
      t.lap = nb[near + 10]
      t.position = nb[near + 7]
      t.sector = nb[near + 9]
      t.valid = (flags & FL_VALID) !== 0
      t.finished = (flags & FL_FINISHED) !== 0
      t.started = (flags & FL_STARTED) !== 0
      t.s = (f < 0.5 ? c0.u16[s0 * U16 + 1] : c1.u16[s1 * U16 + 1]) / 10
      if (t.s > L) t.s = L
      const view = this.views[m]
      view.position = t.position
      view.lap = t.lap
      view.lapTime = lapTime
      view.distance = distance
      view.s = t.s
      view.speed = v.speed
      view.gear = v.gear
      view.finished = t.finished
      view.sliding = (flags & FL_SLIDE) !== 0
      view.offTrack = (flags & FL_OFF) !== 0
    }
  }

  /** cars by position at the replay clock */
  standings() {
    return [...this.views].sort((a, b) => a.position - b.position)
  }

  /** the race clock at the replay clock (s since the green light; session clock if none) */
  get raceTime() {
    return this.replay.goAt >= 0 ? this.t - this.replay.goAt : this.t - this.replay.start
  }
}
