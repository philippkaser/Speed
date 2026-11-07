// Imperative game runtime. Owns the track, the physics world, cars (player / AI / remote),
// timing and race flow. React reads from it through refs and a lightweight store.
import { AIDriver, type TrafficCar } from '../ai/aiDriver'
import { ffb } from '../input/ffb'
import { input } from '../input/input'
import { makeSample } from '../physics/ground'
import { clamp } from '../physics/math'
import { type CarSetup, getCar } from '../physics/spec'
import { Vehicle } from '../physics/vehicle'
import { type KinematicBody, PhysicsWorld, SimCar } from '../physics/world'
import { net } from '../net/client'
import type { RoomInfo } from '../net/protocol'
import { useSettings } from '../state/settings'
import { Track } from '../track/track'
import { getTrackDef } from '../track/trackDef'
import type { GltfCarId } from '../car/gltfCars'
import { ReplayPlayer, ReplayRecorder } from './replay'

/** bodywork of the GT3 field, in turn */
const GT3_FIELD: GltfCarId[] = ['amg-gt3', 'ferrari-296-gt3', 'mustang-gt3']

/** What the game loop needs from the team race engine (src/team/teamRace.ts). */
export interface TeamRaceHooks {
  beforePhysics(dt: number): void
  afterPhysics(dt: number): void
  dispose(): void
}

export type Mode = 'attract' | 'showroom' | 'practice' | 'race' | 'online' | 'team'
export type Phase = 'idle' | 'grid' | 'countdown' | 'racing' | 'finished'

export class LapTiming {
  lap = 0 // completed laps
  lapStartTime = 0
  current = 0
  last = 0
  best = 0
  sector = 0
  sectorStart = 0
  sectorTimes = [0, 0, 0]
  lastSectors = [0, 0, 0]
  bestSectors = [0, 0, 0]
  valid = true
  s = 0
  prevS = 0
  distance = 0 // total progress along the track (laps * length + s)
  finished = false
  finishTime = 0
  position = 1
  started = false
  wrongWay = 0
  offTime = 0
  deltaToBest = 0
  bestTrace: Float32Array | null = null
  trace: Float32Array | null = null
}

export interface CarEntry {
  id: string
  name: string
  carId: string
  color: string
  sim: SimCar
  ai?: AIDriver
  isPlayer: boolean
  isRemote: boolean
  timing: LapTiming
  sample: ReturnType<typeof makeSample>
  /** detailed body for GT3 cars (src/car/gltfCars.ts) */
  model?: GltfCarId
  /** team race: livery and timing-screen identity */
  teamId?: string
  accent?: string
  number?: number
  code?: string
}

/** One car of a team race (pit wall mode). */
export interface TeamEntryConfig {
  model?: GltfCarId
  id: string
  name: string
  code: string
  teamId: string
  color: string
  accent: string
  number: number
  carId: string
  setup: CarSetup
  skill: number
}

export interface SessionConfig {
  /** bodywork of the player's GT3 car */
  gt3Model?: GltfCarId
  mode: Mode
  trackId: string
  carId: string
  color: string
  setup?: CarSetup
  opponents: number
  laps: number
  aiSkill: number
  playerName: string
  startOnGrid?: number
}

type GameEvent =
  | { type: 'lap'; car: string; time: number; best: boolean; valid: boolean }
  | { type: 'sector'; car: string; sector: number; time: number; delta: number }
  | { type: 'finish'; car: string; position: number }
  | { type: 'countdown'; value: number }
  | { type: 'go' }
  | { type: 'trackLimits' }
  | { type: 'session' }
  | { type: 'notice'; text: string }
  | { type: 'replay'; on: boolean }

const AI_NAMES = ['M. Okafor', 'L. Marchetti', 'S. Lindqvist', 'K. Tanaka', 'A. Duarte', 'J. Becker', 'R. Moreau', 'D. Novak', 'P. Haddad', 'E. Varga', 'T. Silva']
const AI_COLORS = ['#f2f2f0', '#0a0a0c', '#f5b800', '#0057b8', '#2e7d32', '#ff6f00', '#6a1b9a', '#9e9e9e', '#00838f', '#b71c1c', '#c0a060']

/** pre-start sequence of a team race: grid shot, five red lights, random hold */
export const TEAM_COUNTDOWN = 9

const DONUT = typeof location !== 'undefined' && new URLSearchParams(location.search).has('donut')

export class Game {
  track: Track
  world: PhysicsWorld
  cars: CarEntry[] = []
  player: CarEntry | null = null
  mode: Mode = 'attract'
  phase: Phase = 'idle'
  config: SessionConfig | null = null
  countdown = 0
  raceTime = 0
  sessionTime = 0
  totalLaps = 3
  version = 0
  listeners = new Set<(e: GameEvent) => void>()
  private trackCache = new Map<string, Track>()
  finishOrder: string[] = []
  /** team race engine (pit wall mode) */
  teamRace: TeamRaceHooks | null = null
  /** simulation speed multiplier (team races) */
  timeScale = 1
  countdownTotal = 4.5

  constructor() {
    this.track = this.getTrack('valle-alta')
    this.world = new PhysicsWorld(this.track)
  }

  getTrack(id: string) {
    let t = this.trackCache.get(id)
    if (!t) {
      t = new Track(getTrackDef(id))
      this.trackCache.set(id, t)
    }
    return t
  }

  on(fn: (e: GameEvent) => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  emit(e: GameEvent) {
    for (const l of this.listeners) l(e)
  }

  /** Start a new session. */
  start(cfg: SessionConfig) {
    const prevCar = this.config?.carId
    this.endReplay()
    this.endTeamRace()
    this.timeScale = 1
    this.config = cfg
    this.mode = cfg.mode
    this.track = this.getTrack(cfg.trackId)
    this.world = new PhysicsWorld(this.track)
    this.cars = []
    this.player = null
    this.finishOrder = []
    this.ghostRec = []
    if (cfg.mode !== 'practice' || prevCar !== cfg.carId) this.ghostBest = null
    this.totalLaps = cfg.laps
    this.raceTime = 0
    this.sessionTime = 0
    const assists = useSettings.getState().assists

    const gridSlots = this.gridPositions(Math.max(cfg.opponents + 1, 1))
    const playerSlot = cfg.mode === 'race' ? Math.min(cfg.startOnGrid ?? cfg.opponents, cfg.opponents) : 0

    if (cfg.mode !== 'attract') {
      const v = new Vehicle(getCar(cfg.carId), cfg.setup)
      v.assists = { ...assists }
      const slot = cfg.mode === 'practice' || cfg.mode === 'showroom' ? this.practiceStart() : gridSlots[playerSlot]
      v.reset(slot.x, slot.z, slot.yaw, this.track)
      const sim = this.world.addCar('player', v)
      this.player = this.addEntry('player', cfg.playerName, cfg.carId, cfg.color, sim, true)
    }
    // test / demo hook: ?autopilot lets the AI drive the player's car
    if (this.player && typeof location !== 'undefined' && new URLSearchParams(location.search).has('autopilot')) {
      const ai = new AIDriver(this.player.sim.vehicle, this.track, 0.97)
      ai.id = 'player'
      this.player.ai = ai
    }
    if (cfg.mode === 'race' || cfg.mode === 'attract') {
      let slot = 0
      for (let i = 0; i < cfg.opponents; i++) {
        if (cfg.mode === 'race' && slot === playerSlot) slot++
        const g = gridSlots[slot++] ?? gridSlots[gridSlots.length - 1]
        // races are single-class (the player's car); the menu attract mode shows a mixed field
        const carId = cfg.mode === 'race' ? cfg.carId : i % 3 === 2 ? 'aurel-gt' : 'vanta-gt3'
        const spec = getCar(carId)
        const v = new Vehicle(spec)
        v.reset(g.x, g.z, g.yaw, this.track)
        const id = 'ai' + i
        const sim = this.world.addCar(id, v)
        const skill = clamp(cfg.aiSkill - 0.035 + ((i * 7919) % 100) / 100 * 0.05, 0.8, 1.02)
        const ai = new AIDriver(v, this.track, skill, 0.5)
        ai.id = id
        const e = this.addEntry(id, AI_NAMES[i % AI_NAMES.length], carId, AI_COLORS[i % AI_COLORS.length], sim, false)
        e.ai = ai
      }
    }
    if (cfg.mode === 'race' || cfg.mode === 'online') {
      this.phase = 'grid'
      this.countdown = this.countdownTotal = 4.5
      for (const c of this.cars) c.sim.frozen = true
    } else if (cfg.mode === 'attract') {
      this.phase = 'racing'
      // spread AI around the lap so the menu always shows cars in shot
      this.cars.forEach((c, i) => {
        const s = (i / this.cars.length) * this.track.length * 0.9 + 40
        const p = this.track.pointAt(s, this.track.racing[this.track.idx(s)], { x: 0, y: 0, z: 0 })
        c.sim.vehicle.reset(p.x, p.z, this.track.headingAt(s), this.track)
        c.sim.vehicle.setVelocityForward(c.ai!.profile[this.track.idx(s)] * 0.8)
        c.sim.vehicle.gear = 3
      })
    } else {
      this.phase = 'racing'
    }
    if (cfg.mode === 'showroom') this.phase = 'idle'
    for (const c of this.cars) this.initTiming(c)
    this.beginRecording()
    this.version++
    this.emit({ type: 'session' })
  }

  private addEntry(id: string, name: string, carId: string, color: string, sim: SimCar, isPlayer: boolean): CarEntry {
    const e: CarEntry = { id, name, carId, color, sim, isPlayer, isRemote: false, timing: new LapTiming(), sample: makeSample() }
    // GT3 class: the player's chosen bodywork, the field takes turns with the three models
    if (carId === 'vanta-gt3') e.model = isPlayer ? (this.config?.gt3Model ?? 'ferrari-296-gt3') : GT3_FIELD[this.cars.length % GT3_FIELD.length]
    this.cars.push(e)
    return e
  }

  private initTiming(c: CarEntry) {
    const t = c.timing
    this.track.sample(c.sim.vehicle.pos.x, c.sim.vehicle.pos.z, c.sample)
    t.s = c.sample.s
    t.prevS = t.s
    // cars behind the line start at "lap 0" with negative progress
    t.distance = t.s > this.track.length / 2 ? t.s - this.track.length : t.s
    t.lapStartTime = this.sessionTime
    t.started = this.mode === 'race' || this.mode === 'online' || this.mode === 'team' ? false : t.distance > 0
    t.trace = new Float32Array(Math.ceil(this.track.length / 10) + 1)
  }

  /** Team race: every car is AI driven, the player runs the pit wall. Cars are given in grid order. */
  startTeam(trackId: string, laps: number, cars: TeamEntryConfig[]) {
    this.endReplay()
    this.recorder = null
    this.endTeamRace()
    this.timeScale = 1
    this.config = { mode: 'team', trackId, carId: cars[0]?.carId ?? 'vanta-gt3', color: '#fff', opponents: cars.length, laps, aiSkill: 1, playerName: '' }
    this.mode = 'team'
    this.track = this.getTrack(trackId)
    this.world = new PhysicsWorld(this.track)
    this.cars = []
    this.player = null
    this.finishOrder = []
    this.totalLaps = laps
    this.raceTime = 0
    this.sessionTime = 0
    const slots = this.gridPositions(cars.length)
    cars.forEach((cfg, i) => {
      const v = new Vehicle(getCar(cfg.carId), cfg.setup)
      const g = slots[i]
      v.reset(g.x, g.z, g.yaw, this.track)
      const sim = this.world.addCar(cfg.id, v)
      const ai = new AIDriver(v, this.track, cfg.skill, 0.5)
      ai.id = cfg.id
      const e = this.addEntry(cfg.id, cfg.name, cfg.carId, cfg.color, sim, false)
      e.ai = ai
      e.teamId = cfg.teamId
      e.model = cfg.model
      e.accent = cfg.accent
      e.number = cfg.number
      e.code = cfg.code
      sim.frozen = true
    })
    this.phase = 'grid'
    this.countdown = this.countdownTotal = TEAM_COUNTDOWN + 0.3 + Math.random() * 1.1
    for (const c of this.cars) this.initTiming(c)
    this.version++
    this.emit({ type: 'session' })
  }

  endTeamRace() {
    this.teamRace?.dispose()
    this.teamRace = null
  }

  gridPositions(count: number) {
    const tr = this.track
    const out: { x: number; z: number; yaw: number }[] = []
    for (let i = 0; i < count; i++) {
      const s = -14 - i * 9
      const d = i % 2 === 0 ? 2.6 : -2.6
      const p = tr.pointAt(s - (i % 2) * 4.5, d, { x: 0, y: 0, z: 0 })
      out.push({ x: p.x, z: p.z, yaw: tr.headingAt(s) })
    }
    return out
  }

  practiceStart() {
    const s = this.track.length - 260
    const p = this.track.pointAt(s, this.track.racing[this.track.idx(s)], { x: 0, y: 0, z: 0 })
    return { x: p.x, z: p.z, yaw: this.track.headingAt(s) }
  }

  /** Online race: own car on its grid slot, everybody else as interpolated remote cars. */
  startOnline(room: RoomInfo, myId: string, setup?: CarSetup) {
    const me = room.players.find((p) => p.id === myId)
    if (!me) return
    this.endReplay()
    this.config = { mode: 'online', trackId: room.trackId, carId: me.carId, color: me.color, setup, opponents: 0, laps: room.laps, aiSkill: 1, playerName: me.name }
    this.mode = 'online'
    this.track = this.getTrack(room.trackId)
    this.world = new PhysicsWorld(this.track)
    this.cars = []
    this.player = null
    this.finishOrder = []
    this.totalLaps = room.laps
    this.raceTime = 0
    this.sessionTime = 0
    this.onlineStartAt = room.startAt
    const slots = this.gridPositions(Math.max(room.players.length, 1))
    const v = new Vehicle(getCar(me.carId), setup)
    v.assists = { ...useSettings.getState().assists }
    const g = slots[Math.min(me.grid, slots.length - 1)]
    v.reset(g.x, g.z, g.yaw, this.track)
    const sim = this.world.addCar('player', v)
    this.player = this.addEntry('player', me.name, me.carId, me.color, sim, true)
    for (const p of room.players) {
      if (p.id === myId) continue
      this.addRemote(p.id, p.name, p.carId, p.color, slots[Math.min(p.grid, slots.length - 1)])
    }
    this.phase = 'grid'
    this.countdown = (room.startAt - net.serverNow()) / 1000
    sim.frozen = true
    for (const c of this.cars) this.initTiming(c)
    this.beginRecording()
    this.version++
    this.emit({ type: 'session' })
  }

  addRemote(id: string, name: string, carId: string, color: string, slot?: { x: number; z: number; yaw: number }) {
    const v = new Vehicle(getCar(carId))
    const s = slot ?? this.practiceStart()
    v.reset(s.x, s.z, s.yaw, this.track)
    const sim = new SimCar(id, v)
    const e = this.addEntry(id, name, carId, color, sim, false)
    e.isRemote = true
    const body: KinematicBody = { id, pos: v.pos, vel: v.vel, fwd: v.fwd, halfLength: v.spec.length / 2, halfWidth: v.spec.width / 2, active: true }
    this.world.kinematics.push(body)
    return e
  }

  removeRemote(id: string) {
    this.cars = this.cars.filter((c) => c.id !== id)
    this.world.kinematics = this.world.kinematics.filter((k) => k.id !== id)
    this.version++
    this.emit({ type: 'session' })
  }

  onlineStartAt = 0
  /** the session's recording (practice, races, online) */
  recorder: ReplayRecorder | null = null
  /** a replay being watched: physics, input and timing stand still while it plays */
  replay: ReplayPlayer | null = null

  private beginRecording() {
    const m = this.mode
    this.recorder =
      m === 'practice' || m === 'race' || m === 'online'
        ? new ReplayRecorder(this.cars, { mode: m, trackId: this.track.def.id, laps: this.totalLaps, trackLength: this.track.length }, m === 'practice' ? 15 * 60 : 45 * 60)
        : null
  }

  /** Watch the session's recording from its start (a race from the green light). */
  startReplay() {
    const rec = this.recorder
    if (!rec || rec.replay.count < 2 || this.replay) return false
    this.replay = new ReplayPlayer(rec.replay, this.cars)
    this.emit({ type: 'replay', on: true })
    return true
  }

  /** Back to the live session, exactly as it was left. */
  endReplay() {
    if (!this.replay) return
    this.replay.restore()
    this.replay = null
    this.world.alpha = 1
    this.emit({ type: 'replay', on: false })
  }
  private ffbFrame = false
  paused = false
  /** time trial ghost: samples [t, x, y, z, qx, qy, qz, qw] at 30 Hz */
  ghostRec: number[] = []
  ghostBest: Float32Array | null = null
  private ghostAcc = 0

  stop() {
    this.endReplay()
    this.recorder = null
    this.cars = []
    this.player = null
    this.world = new PhysicsWorld(this.track)
    this.phase = 'idle'
    this.version++
  }

  resetPlayerToTrack() {
    const p = this.player
    if (!p) return
    const v = p.sim.vehicle
    const tr = this.track
    tr.sample(v.pos.x, v.pos.z, p.sample)
    const s = p.sample.s
    const i = tr.idx(s)
    const pt = tr.pointAt(s, tr.racing[i], { x: 0, y: 0, z: 0 })
    v.reset(pt.x, pt.z, tr.headingAt(s), tr)
    p.timing.valid = false
  }

  /** the race is on: also after the player's flag (the rest of the field still has to finish) */
  get racing() {
    return this.phase === 'racing' || this.phase === 'finished'
  }

  /** Called every frame before rendering. */
  update(dt: number) {
    if (this.replay) {
      // playback: the recording drives the cars, nothing is simulated
      this.replay.update(Math.min(dt, 0.1))
      this.world.alpha = 1
      if (ffb.status === 'on') ffb.update(0)
      return
    }
    dt = Math.min(dt, 0.1) * this.timeScale
    const tr = this.track
    this.sessionTime += dt

    // race start sequence (online: driven by the server clock)
    if (this.phase === 'grid' || this.phase === 'countdown') {
      const prev = Math.ceil(this.countdown)
      if (this.mode === 'online') this.countdown = (this.onlineStartAt - net.serverNow()) / 1000
      else this.countdown -= dt
      const now = Math.ceil(this.countdown)
      if (this.countdown <= 3.5) this.phase = 'countdown'
      if (now !== prev && now >= 1 && now <= 3) this.emit({ type: 'countdown', value: now })
      if (this.countdown <= 0) {
        this.phase = 'racing'
        this.raceTime = 0
        for (const c of this.cars) {
          c.sim.frozen = false
          c.timing.lapStartTime = this.sessionTime
        }
        if (this.recorder) this.recorder.replay.goAt = this.sessionTime
        this.emit({ type: 'go' })
      }
    }
    // the race runs on after the player's flag until the whole field is home
    if (this.racing) this.raceTime += dt

    // player controls
    if (this.player && !this.player.isRemote && !this.player.ai) {
      const v = this.player.sim.vehicle
      const c = input.update(dt, v.speed, v.bodySlip)
      const inp = this.player.sim.input
      inp.steer = c.steer
      inp.throttle = c.throttle
      inp.brake = c.brake
      inp.handbrake = c.handbrake
      inp.clutch = c.clutch
      const sh = input.consumeShifts()
      if (sh.up) inp.shiftUp = true
      if (sh.down) inp.shiftDown = true
      v.assists = { ...useSettings.getState().assists }
      if (DONUT) {
        // test hook (?donut): full throttle at full lock with traction control off -> tyre smoke
        inp.throttle = 1
        inp.brake = 0
        inp.steer = 1
        v.assists.tc = 0
      }
      // feedback
      const fl = v.wheels[0].tyre,
        rl = v.wheels[2].tyre
      const kerb = v.wheels.some((w) => w.surface === 1) ? 0.35 : 0
      // pads: low-frequency motor = rear slip, kerbs, scraping; high-frequency = front slip, ABS,
      // road texture and the steering going light (aligning torque dropping past the peak)
      const light = clamp((fl.combinedSlip - 1) * 0.8, 0, 0.4)
      input.rumble(clamp(Math.max(0, rl.combinedSlip - 0.9) * 0.6 + kerb + v.scrape, 0, 1), clamp(light + v.roadFeel * 0.5 + (v.absActive ? 0.25 : 0), 0, 1))
      // wheels: steering-rack torque + road texture over WebHID
      if (ffb.status === 'on') {
        const cs = useSettings.getState().controls
        this.ffbFrame = !this.ffbFrame
        const lowSpeedCentre = -c.steer * 0.25 * clamp(1 - v.speed / 3, 0, 1)
        const texture = v.roadFeel * 0.14 * (this.ffbFrame ? 1 : -1)
        let force = (v.ffb + lowSpeedCentre + texture) * cs.ffbGain
        if (cs.ffbInvert) force = -force
        ffb.update(this.paused ? 0 : force)
      }
    }

    // AI controls (traffic list in track coordinates)
    const traffic: TrafficCar[] = this.cars.map((c) => ({ id: c.id, s: c.timing.s, d: c.sample.d, speed: c.sim.vehicle.speed }))
    for (const c of this.cars) {
      if (c.ai) c.ai.drive(dt, c.sim.input, traffic, this.racing || this.mode === 'attract')
    }

    // remote cars: interpolated network state
    if (this.mode === 'online') {
      for (const c of this.cars) {
        if (!c.isRemote) continue
        const r = net.applyRemote(c.id, c.sim.vehicle, dt)
        if (r) {
          c.timing.distance = r.distance
          c.timing.lap = r.lap
          c.sim.prevPos.copy(c.sim.vehicle.pos)
          c.sim.prevQuat.copy(c.sim.vehicle.q)
        }
      }
    }

    // physics
    this.teamRace?.beforePhysics(dt)
    this.world.update(dt)

    if (this.mode === 'online' && this.player) net.tick(dt, this.player.sim.vehicle, this.player.timing.distance, this.player.timing.lap)

    // timing
    for (const c of this.cars) this.updateTiming(c, dt)
    // ghost recording (time trial)
    if (this.mode === 'practice' && this.player?.timing.started) {
      this.ghostAcc += dt
      if (this.ghostAcc >= 1 / 30) {
        this.ghostAcc = 0
        const v = this.player.sim.vehicle
        this.ghostRec.push(this.player.timing.current, v.pos.x, v.pos.y, v.pos.z, v.q.x, v.q.y, v.q.z, v.q.w)
      }
    }
    this.updatePositions()
    this.recorder?.update(dt, this.sessionTime)
    this.teamRace?.afterPhysics(dt)
    this.world.events.length = Math.min(this.world.events.length, 64)
  }

  private updateTiming(c: CarEntry, dt: number) {
    const tr = this.track
    const v = c.sim.vehicle
    const t = c.timing
    if (c.isRemote) return
    tr.sample(v.pos.x, v.pos.z, c.sample)
    const s = c.sample.s
    let ds = s - t.prevS
    if (ds < -tr.length / 2) ds += tr.length
    if (ds > tr.length / 2) ds -= tr.length
    t.distance += ds
    t.prevS = s
    t.s = s
    if (!this.racing && this.mode !== 'practice') return
    t.current = this.sessionTime - t.lapStartTime

    // wrong way detection
    const heading = Math.atan2(v.fwd.x, v.fwd.z)
    let dh = heading - tr.headingAt(s)
    while (dh > Math.PI) dh -= 2 * Math.PI
    while (dh < -Math.PI) dh += 2 * Math.PI
    t.wrongWay = Math.abs(dh) > 2.2 && v.speed > 3 ? t.wrongWay + dt : 0

    // track limits: all four wheels beyond the white line (kerbs count as track)
    const allOut = v.wheels.every((w) => {
      const sm = w.sample
      const i = tr.idx(sm.s)
      const S = sm.d >= 0 ? tr.L : tr.R
      return Math.abs(sm.d) > tr.hw[i] + S.kerb[i] + 0.1
    })
    if (allOut && t.started) {
      t.offTime += dt
      if (t.offTime > 0.25 && t.valid) {
        t.valid = false
        if (c.isPlayer) this.emit({ type: 'trackLimits' })
      }
    } else t.offTime = 0

    // delta trace (time at each 10 m)
    if (t.trace && t.started) {
      const k = Math.floor(s / 10)
      if (k >= 0 && k < t.trace.length) t.trace[k] = t.current
      if (t.bestTrace && k > 0 && t.bestTrace[k] > 0) {
        const target = t.current - t.bestTrace[k]
        t.deltaToBest += (target - t.deltaToBest) * clamp(dt * 6, 0, 1)
      }
    }

    // sectors
    const secs = tr.sectors
    const nextSector = (t.sector + 1) % 3
    const crossedSector = t.sector < 2 && ds > 0 && s >= secs[nextSector] && s - ds < secs[nextSector]
    if (crossedSector && t.started) {
      const time = this.sessionTime - t.sectorStart
      t.sectorTimes[t.sector] = time
      const ref = t.bestSectors[t.sector]
      if (c.isPlayer) this.emit({ type: 'sector', car: c.id, sector: t.sector, time, delta: ref > 0 ? time - ref : 0 })
      t.sector = nextSector
      t.sectorStart = this.sessionTime
    }

    // start/finish line crossing (s wraps from ~length to ~0 moving forward)
    if (ds > 0 && s - ds < 0 && t.distance > -5) this.onLineCrossed(c)
  }

  private onLineCrossed(c: CarEntry) {
    const t = c.timing
    const now = this.sessionTime
    if (!t.started) {
      t.started = true
      t.lapStartTime = now
      t.sectorStart = now
      t.sector = 0
      t.valid = true
      return
    }
    const lapTime = now - t.lapStartTime
    if (lapTime < 15) return
    t.sectorTimes[2] = now - t.sectorStart
    t.lastSectors = [...t.sectorTimes]
    t.last = lapTime
    t.lap++
    let isBest = false
    if (c.isPlayer && this.mode === 'practice') {
      if (t.valid && (t.best === 0 || lapTime < t.best) && this.ghostRec.length > 80) this.ghostBest = Float32Array.from(this.ghostRec)
      this.ghostRec = []
    }
    if (t.valid && (t.best === 0 || lapTime < t.best)) {
      t.best = lapTime
      isBest = true
      if (t.trace) t.bestTrace = Float32Array.from(t.trace)
      t.bestSectors = [...t.sectorTimes]
    } else if (t.valid) {
      for (let i = 0; i < 3; i++) if (t.bestSectors[i] === 0 || t.sectorTimes[i] < t.bestSectors[i]) t.bestSectors[i] = t.sectorTimes[i]
    }
    this.emit({ type: 'lap', car: c.id, time: lapTime, best: isBest, valid: t.valid })
    if (c.isPlayer && this.mode === 'online') net.send({ type: 'lap', lap: t.lap + 1, time: lapTime, valid: t.valid })
    t.lapStartTime = now
    t.sectorStart = now
    t.sector = 0
    t.valid = true
    t.deltaToBest = 0
    if (t.trace) t.trace.fill(0)
    if ((this.mode === 'race' || this.mode === 'online' || this.mode === 'team') && t.lap >= this.totalLaps && !t.finished) {
      t.finished = true
      t.finishTime = this.raceTime
      this.finishOrder.push(c.id)
      t.position = this.finishOrder.length
      this.emit({ type: 'finish', car: c.id, position: t.position })
      if (c.isPlayer && this.mode === 'online') net.send({ type: 'finish', time: t.finishTime, bestLap: t.best })
      if (c.isPlayer) {
        this.phase = 'finished'
        // the cool-down lap drives itself (the results are up), as after a race in GT
        if (!c.ai && this.mode === 'race') {
          c.ai = new AIDriver(c.sim.vehicle, this.track, 0.8)
          c.ai.id = c.id
        }
      } else if (c.ai) {
        c.ai.skill *= 0.85 // cool-down lap
        c.ai.rebuildProfile()
      }
    }
  }

  private updatePositions() {
    const sorted = [...this.cars].sort((a, b) => {
      const fa = this.finishOrder.indexOf(a.id),
        fb = this.finishOrder.indexOf(b.id)
      if (fa >= 0 || fb >= 0) {
        if (fa < 0) return 1
        if (fb < 0) return -1
        return fa - fb
      }
      return b.timing.distance - a.timing.distance
    })
    sorted.forEach((c, i) => {
      c.timing.position = i + 1
    })
  }

  standings() {
    return [...this.cars].sort((a, b) => a.timing.position - b.timing.position)
  }
}

export const game = new Game()
if (typeof window !== 'undefined') (window as unknown as { game: Game }).game = game
