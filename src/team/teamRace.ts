// Team race engine (pit wall mode). Sits on top of the normal race (game.ts) and adds what a team
// principal manages: fuel load and burn, tyre compounds with race-length scaled wear, driving
// instructions, pit stops through the real pit lane (scripted path, box queueing, crew variance),
// rival strategies, timing intervals, and the events the broadcast and the team radio are built from.
import type { CarEntry, Game, TeamRaceHooks } from '../game/game'
import { clamp } from '../physics/math'
import { COMPOUNDS } from '../physics/spec'
import { wearGrip } from '../physics/tyre'
import { pitLane, PitPath, type PitLane, type Pose } from '../track/pitlane'
import { type Driver, driverName, type Team } from './data'
import { type Compound, type DriveMode, ENGINE_WORK_PER_LAP, fuelFor, MODES, type RaceRules, raceRules, type Strategy, TREAD_LIMIT, TYRES } from './strategy'

export type RaceEvent =
  | { kind: 'start' }
  | { kind: 'overtake'; car: string; other: string; pos: number }
  | { kind: 'lead'; car: string }
  | { kind: 'pit'; car: string; phase: 'in' | 'stop' | 'out'; time?: number; compound?: Compound; fuel?: number; slow?: boolean; pos?: number }
  | { kind: 'fastest'; car: string; time: number }
  | { kind: 'radio'; car: string; text: string; from: 'driver' | 'engineer' }
  | { kind: 'mistake'; car: string }
  | { kind: 'retire'; car: string; reason: string }
  | { kind: 'battle'; car: string; other: string; pos: number }
  | { kind: 'lastLap' }
  | { kind: 'chequered'; car: string }
  | { kind: 'finish'; car: string; pos: number }
  | { kind: 'complete' }

export type Stamped = RaceEvent & { t: number; id: number }

export interface PitState {
  phase: 'called' | 'in' | 'service' | 'out'
  path: PitPath | null
  u: number
  speed: number
  compound: Compound
  fuel: number
  serviceTotal: number
  serviceLeft: number
  stationary: number
  slow: boolean
  /** CoG height above the path */
  cg: number
  enteredAt: number
}

/** AI grip budget for a driver (pace 0..1); the field spans about 1.2 s a lap */
export function driverSkill(d: Driver) {
  return 0.966 + d.pace * 0.016
}

export class RaceCar {
  compound: Compound
  tyreLaps = 0
  stops = 0
  pit: PitState | null = null
  /** next stop as changed on the pit wall (overrides the plan) */
  request: { compound: Compound; fuel: number } | null = null
  /** the stop the car is committed to this lap */
  retired = ''
  baseSkill: number
  grip = 1
  /** race time at every 10 m of race distance (for intervals) */
  times = new Float64Array(0)
  nextMark = 0
  interval = 0
  gap = 0
  lapsDown = 0
  lapTimes: number[] = []
  best = 0
  lastPitAt = -1e9
  lastOvertakeAt = -1e9
  lastMistakeAt = -1e9
  lastRadio = new Map<string, number>()
  gridPos = 0
  skillRebuildAt = 0
  appliedSkill = 0
  battleSince = -1
  /** track position at the previous frame (crossing detection) */
  prevS = -1
  battleAnnounced = false
  finished = false
  constructor(
    public entry: CarEntry,
    public team: Team,
    public driver: Driver,
    public mine: boolean,
    public slot: 0 | 1,
    public strategy: Strategy,
    public mode: DriveMode,
  ) {
    this.compound = strategy.startCompound
    this.baseSkill = driverSkill(driver)
  }
  get id() {
    return this.entry.id
  }
  get vehicle() {
    return this.entry.sim.vehicle
  }
  get name() {
    return driverName(this.driver)
  }
  get fuel() {
    return this.vehicle.fuel
  }
  get tread() {
    const w = this.vehicle.wheels
    return Math.min(w[0].tyre.wear, w[1].tyre.wear, w[2].tyre.wear, w[3].tyre.wear)
  }
  get lap() {
    return this.entry.timing.lap
  }
  inPit() {
    return !!this.pit && this.pit.phase !== 'called'
  }
  /** next planned stop (lap and service), after the stops already made */
  nextStop() {
    if (this.request) return { lap: this.lap + 1, ...this.request }
    return this.strategy.stops[this.stops] ?? null
  }
  timeAt(distance: number) {
    const k = (distance + 1000) / 10
    const i = Math.floor(k)
    if (i < 0) return 0
    if (i + 1 >= this.nextMark) return this.times[Math.max(0, Math.min(this.nextMark - 1, i))]
    return this.times[i] + (this.times[i + 1] - this.times[i]) * (k - i)
  }
}

const AIR_LINES = {
  tyresGoing: ['Tyres are starting to go.', 'Rears are going off, losing grip on exit.', 'The fronts are graining, I am sliding a lot.'],
  tyresGone: ['These tyres are finished!', 'No grip at all, box me soon!', 'I am a passenger here, the tyres are gone.'],
  passed: ['Got him!', 'Yes! Clean move.', 'That is one more.'],
  lost: ['He had a better exit, nothing I could do.', 'Lost the tow and he was past.', 'Sorry, he got me on the brakes.'],
  mistake: ['Sorry, locked up.', 'Ran wide, lost a bit there.', 'Oops, the rear stepped out.'],
  push: ['Copy, pushing now.', 'Understood, full attack.'],
  save: ['Understood, managing.', 'Copy, lifting and coasting.'],
  race: ['Copy, race pace.'],
}
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)]

export class TeamRace implements TeamRaceHooks {
  rules: RaceRules
  cars: RaceCar[] = []
  byId = new Map<string, RaceCar>()
  lane: PitLane
  boxBusy: (string | null)[] = [null, null, null, null, null, null]
  log: Stamped[] = []
  private seq = 0
  listeners = new Set<(e: Stamped) => void>()
  fastest: { car: string; time: number } | null = null
  leader = ''
  started = false
  chequered = false
  complete = false
  completeAt = 0
  lastLapAnnounced = false
  private order: string[] = []
  private swapGuard = new Map<string, number>()
  private fuelAcc = 0
  private offGame: () => void

  constructor(
    public game: Game,
    laps: number,
  ) {
    this.rules = raceRules(laps)
    this.lane = pitLane(game.track)
    this.offGame = game.on((e) => {
      if (e.type === 'lap') this.onLap(e.car, e.time)
      if (e.type === 'go') this.onStart()
      if (e.type === 'finish') this.onFinish(e.car, e.position)
    })
  }

  dispose() {
    this.offGame()
    this.listeners.clear()
  }

  add(entry: CarEntry, team: Team, driver: Driver, mine: boolean, slot: 0 | 1, strategy: Strategy, mode: DriveMode) {
    const c = new RaceCar(entry, team, driver, mine, slot, structuredClone(strategy), mode)
    const v = entry.sim.vehicle
    v.fuelTracked = true
    v.setFuel(Math.min(this.rules.tank, strategy.startFuel))
    v.applySetup({ ...v.setup, compound: strategy.startCompound })
    for (const w of v.wheels) w.tyre.reset(62, w.tyre.coldPressure)
    c.times = new Float64Array(Math.ceil((this.rules.laps * this.game.track.length + 3000) / 10))
    this.cars.push(c)
    this.byId.set(entry.id, c)
    return c
  }

  emit(e: RaceEvent) {
    const s = { ...e, t: this.game.raceTime, id: this.seq++ } as Stamped
    this.log.push(s)
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400)
    for (const l of this.listeners) l(s)
  }
  on(fn: (e: Stamped) => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private radio(c: RaceCar, key: string, text: string, from: 'driver' | 'engineer' = 'driver', minGap = 25) {
    if (!c.mine) return
    const last = c.lastRadio.get(key) ?? -1e9
    if (this.game.raceTime - last < minGap) return
    c.lastRadio.set(key, this.game.raceTime)
    this.emit({ kind: 'radio', car: c.id, text, from })
  }

  // ------------------------------------------------------------------------------- pit wall commands

  setMode(id: string, mode: DriveMode) {
    const c = this.byId.get(id)
    if (!c || c.mode === mode) return
    c.mode = mode
    this.radio(c, 'mode', pick(AIR_LINES[mode]), 'driver', 0)
  }

  /** Call the car in at the next opportunity with this service. */
  box(id: string, compound: Compound, fuel: number) {
    const c = this.byId.get(id)
    if (!c || c.retired || c.finished) return
    c.request = { compound, fuel: Math.round(fuel) }
    if (c.pit?.phase === 'called' || c.pit?.phase === 'in') {
      c.pit.compound = compound
      c.pit.fuel = c.request.fuel
    }
  }

  cancelBox(id: string) {
    const c = this.byId.get(id)
    if (!c) return
    c.request = null
    if (c.pit?.phase === 'called') {
      c.pit = null
      this.radio(c, 'cancel', 'Stay out, stay out!', 'engineer', 0)
      // skip the planned stop for this lap
      const st = c.strategy.stops[c.stops]
      if (st && st.lap <= c.lap + 1) st.lap = c.lap + 2
    }
  }

  /** has the car passed the point where a call to box is still taken this lap? */
  callWindowOpen(c: RaceCar) {
    const L = this.game.track.length
    const s = c.entry.timing.s
    return s < L + this.lane.sEntry - 200 || s > L - 100 || s < 400
  }

  // ------------------------------------------------------------------------------- frame update

  beforePhysics(dt: number) {
    if (dt <= 0) return
    const tr = this.game.track
    const L = tr.length
    const racing = this.game.phase === 'racing' || this.game.phase === 'finished'
    for (const c of this.cars) {
      const v = c.vehicle
      const ai = c.entry.ai
      const sNow = c.entry.timing.s
      const sPrev = c.prevS < 0 ? sNow : c.prevS
      c.prevS = sNow
      if (c.retired) {
        c.entry.sim.frozen = true
        continue
      }
      // tyre wear: race-length scale, instruction, the driver's touch
      const wearMul = this.rules.wearScale * MODES[c.mode].wear * (1.25 - 0.5 * c.driver.tyreCare)
      for (const w of v.wheels) w.tyre.wearMul = wearMul

      // grip the driver can feel: tread and temperature
      const cp = COMPOUNDS[c.compound]
      let g = 0
      for (const w of v.wheels) {
        const t = w.tyre
        const T = 0.62 * t.surfTemp + 0.38 * t.coreTemp
        const dT = (T - cp.optTemp) / cp.tempWindow
        // the tread is felt fully; a tyre out of its window only half (it comes in as it heats up)
        g += wearGrip(t.wear) * (1 - 0.5 * (1 - clamp(1 - cp.tempGripLoss * dT * dT, 0.75, 1)))
      }
      c.grip = g / 4

      if (ai && !c.inPit() && !c.finished) {
        // drive to the grip that is there (a touch optimistic), plus the instruction
        const fuelShy = v.fuel < 0.5 ? -0.04 : 0
        const target = (c.baseSkill + MODES[c.mode].skill + fuelShy) * Math.pow(c.grip, 0.85)
        if (Math.abs(target - c.appliedSkill) > 0.0025 && this.game.raceTime >= c.skillRebuildAt) {
          ai.skill = target
          ai.rebuildProfile()
          c.appliedSkill = target
          c.skillRebuildAt = this.game.raceTime + 0.8
        }
        // rival pit walls: attack when there is a car to catch, nurse marginal tyres or fuel
        if (!c.mine && this.started && this.game.raceTime > 20) {
          const lapsLeft = this.lapsToNextService(c)
          const fuelTight = v.fuel < lapsLeft * this.rules.fuelPerLap * 1.02
          const want: DriveMode = fuelTight || c.tread < 0.3 ? 'save' : c.interval > 0 && c.interval < 1.1 && c.tread > 0.4 ? 'push' : 'race'
          c.mode = want
        }
        // racecraft: how hard the driver attacks when a pass is on
        ai.attack = c.driver.racecraft * (c.mode === 'push' ? 1.3 : c.mode === 'save' ? 0.5 : 1)
        // driver errors: more when pushing, on worn or cold tyres and in a fight
        if (racing && this.game.raceTime > 6 && ai.overdriveTime <= 0) {
          const fight = c.interval > 0 && c.interval < 0.8 ? 1.6 : 1
          const hazard = 0.0028 * MODES[c.mode].risk * (1.35 - c.driver.consistency) * (1 + 5 * Math.max(0, 0.95 - c.grip)) * fight
          if (Math.random() < hazard * dt) {
            // only matters on the way into a braking zone
            const i = tr.idx(c.entry.timing.s + 40 + v.speed * 0.8)
            if (ai.profile[i] < v.speed - 6) {
              ai.overdrive = 0.06 + Math.random() * 0.08
              ai.overdriveTime = 1.6
              c.lastMistakeAt = this.game.raceTime
              this.emit({ kind: 'mistake', car: c.id })
              this.radio(c, 'mistake', pick(AIR_LINES.mistake), 'driver', 30)
            }
          }
        }
      }

      // pit call: decided before the entry, committed at the entry
      if (racing && !c.pit && !c.finished && this.started) this.considerPit(c, sPrev, sNow)
      if (c.pit?.phase === 'called') {
        const sEntry = L + this.lane.sEntry
        if (sPrev < sEntry && sNow >= sEntry && !this.chequered) this.enterPit(c)
      }
      if (c.inPit()) this.drivePit(c, dt)
    }
  }

  afterPhysics(dt: number) {
    if (dt <= 0) return
    const g = this.game
    const now = g.raceTime
    // fuel burn from engine work
    const kFuel = this.rules.fuelPerLap / ENGINE_WORK_PER_LAP
    this.fuelAcc += dt
    const updMass = this.fuelAcc > 0.4
    for (const c of this.cars) {
      const v = c.vehicle
      if (c.retired || c.inPit() || g.phase === 'grid' || g.phase === 'countdown') continue
      const P = Math.max(0, v.engine.torque * v.engine.omega)
      const burn = P * kFuel * MODES[c.mode].fuel * dt
      v.fuel = Math.max(0, v.fuel - burn)
      if (updMass) v.setFuel(v.fuel)
      if (v.fuel <= 0) {
        v.fuelCut = true
        if (v.speed < 1.5 && !c.retired) this.retire(c, 'Out of fuel')
      }
      if (c.mine) {
        const need = this.lapsToNextService(c) * this.rules.fuelPerLap * MODES[c.mode].fuel
        if (v.fuel < need - 1 && need > 0) this.radio(c, 'fuel', `Fuel is ${(need - v.fuel).toFixed(1)} kg short. Save fuel or box.`, 'engineer', 40)
        const tread = c.tread
        if (this.started && c.tyreLaps >= 1) {
          if (tread < 0.22) this.radio(c, 'tyresGone', pick(AIR_LINES.tyresGone), 'driver', 50)
          else if (tread < 0.42) this.radio(c, 'tyresGoing', pick(AIR_LINES.tyresGoing), 'driver', 90)
        }
      }
      // timing loops
      const k = Math.floor((c.entry.timing.distance + 1000) / 10)
      while (c.nextMark <= k && c.nextMark < c.times.length) c.times[c.nextMark++] = now
    }
    if (updMass) this.fuelAcc = 0
    this.updateIntervals()
    if (g.phase === 'racing' || g.phase === 'finished') this.detectOvertakes()
    // race complete: everybody has finished, or two minutes after the winner
    if (this.chequered && !this.complete) {
      const running = this.cars.filter((c) => !c.finished && !c.retired)
      if (running.length === 0 || now - this.completeAt > 120) {
        this.complete = true
        this.emit({ kind: 'complete' })
      }
    }
  }

  private lapsToNextService(c: RaceCar) {
    const st = c.nextStop()
    const to = st && st.lap > c.lap ? st.lap : this.rules.laps
    const frac = c.entry.timing.s / this.game.track.length
    return Math.max(0, to - c.lap - frac)
  }

  private considerPit(c: RaceCar, prev: number, s: number) {
    const L = this.game.track.length
    // the decision is taken once per lap, shortly before the entry
    const decide = L + this.lane.sEntry - 220
    if (!(prev < decide && s >= decide)) return
    const lapNo = c.lap + 1 // the lap being driven
    if (lapNo >= this.rules.laps) return
    let call: { compound: Compound; fuel: number } | null = null
    const plan = c.strategy.stops[c.stops]
    if (c.request) call = c.request
    else if (plan && plan.lap <= lapNo) call = { compound: plan.compound, fuel: plan.fuel }
    // reactive calls (rivals always; ours only to avoid running dry or on destroyed tyres)
    const lapsLeft = this.rules.laps - lapNo
    const fuelNeed = lapsLeft * this.rules.fuelPerLap * MODES[c.mode].fuel
    const lapsOfFuel = c.vehicle.fuel / (this.rules.fuelPerLap * MODES[c.mode].fuel)
    if (!call && (lapsOfFuel < 1.25 && c.vehicle.fuel < fuelNeed)) call = this.emergencyCall(c, lapsLeft)
    if (!call && !c.mine && c.tread < 0.22 && lapsLeft > 1) call = this.emergencyCall(c, lapsLeft)
    if (!call) return
    c.pit = { phase: 'called', path: null, u: 0, speed: 0, compound: call.compound, fuel: call.fuel, serviceTotal: 0, serviceLeft: 0, stationary: 0, slow: false, cg: 0, enteredAt: 0 }
    this.radio(c, 'box', `Box, box. ${TYRES[call.compound].name}s${call.fuel > 0 ? ` and ${call.fuel} kilos` : ''}.`, 'engineer', 0)
  }

  /** Service for the rest of the race (or to a second stop if needed). */
  emergencyCall(c: RaceCar, lapsLeft: number) {
    const r = this.rules
    const life = (cmp: Compound) => (1 - TREAD_LIMIT - 0.15) / r.treadPerLap[cmp]
    const compound: Compound = lapsLeft <= life('RS') ? 'RS' : lapsLeft <= life('RM') ? 'RM' : 'RH'
    const needed = fuelFor(r, lapsLeft, c.mode) - c.vehicle.fuel
    return { compound, fuel: Math.max(0, Math.min(r.tank - c.vehicle.fuel, needed)) }
  }

  private enterPit(c: RaceCar) {
    const p = c.pit!
    const tr = this.game.track
    const v = c.vehicle
    const ground = tr.pointAt(c.entry.timing.s, c.entry.sample.d, { x: 0, y: 0, z: 0 }).y
    p.cg = v.pos.y - ground
    p.path = new PitPath(tr, this.lane, this.lane.boxS[c.team.box], c.entry.sample.d)
    p.u = 0
    p.speed = v.speed
    p.phase = 'in'
    p.enteredAt = this.game.raceTime
    c.entry.sim.scripted = true
    this.emit({ kind: 'pit', car: c.id, phase: 'in' })
  }

  private drivePit(c: RaceCar, dt: number) {
    const p = c.pit!
    const path = p.path!
    const v = c.vehicle
    const sim = c.entry.sim
    const aDec = 9,
      aAcc = 6
    const lim = this.rules.pitSpeed
    if (p.phase === 'service') {
      p.serviceLeft -= dt
      p.stationary += dt
      if (p.serviceLeft <= 0) this.finishService(c)
    } else {
      let cap: number
      if (p.u < path.laneStartU) cap = Math.sqrt(lim * lim + 2 * aDec * (path.laneStartU - p.u))
      else if (p.u <= path.laneEndU) cap = lim
      else cap = Math.min(52, Math.sqrt(lim * lim + 2 * aAcc * (p.u - path.laneEndU)))
      if (p.phase === 'in') {
        // queue behind a team mate being serviced (double stack)
        const box = c.team.box
        const busy = this.boxBusy[box]
        if (!busy && p.u > path.boxU - 60) this.boxBusy[box] = c.id
        const stopU = this.boxBusy[box] === c.id ? path.boxU : path.holdU
        cap = Math.min(cap, Math.sqrt(Math.max(0, 2 * aDec * (stopU - p.u))))
        if (p.u >= stopU - 0.05 && stopU === path.boxU && p.speed < 2) this.startService(c)
      }
      p.speed += clamp(cap - p.speed, -aDec * dt, aAcc * dt)
      p.u += p.speed * dt
      if (p.u >= path.length) {
        this.leavePit(c)
        return
      }
    }
    // pose
    const pose = path.poseAt(p.u, _pose)
    const lift = p.phase === 'service' && p.stationary > 0.25 && p.serviceLeft > 0.3 ? 0.07 : 0
    v.pos.set(pose.x, pose.y + p.cg + lift, pose.z)
    // yaw about +y, pitch with the slope (negative rotation about the car's left axis)
    const cy = Math.cos(pose.yaw / 2),
      sy = Math.sin(pose.yaw / 2)
    const cpch = Math.cos(-pose.pitch / 2),
      spch = Math.sin(-pose.pitch / 2)
    v.q.set(cy * spch, sy * cpch, -sy * spch, cy * cpch)
    v.updateAxes()
    v.vel.copy(v.fwd).scale(p.speed)
    v.w.set(0, 0, 0)
    for (const w of v.wheels) {
      w.omega = p.speed / w.radius
      w.spin += w.omega * dt
    }
    v.engine.omega = Math.max(v.spec.engine.idleRpm * (Math.PI / 30), (p.speed / v.wheels[2].radius) * v.currentRatio())
    sim.prevPos.copy(v.pos)
    sim.prevQuat.copy(v.q)
  }

  private startService(c: RaceCar) {
    const p = c.pit!
    const fuel = Math.max(0, Math.min(p.fuel, this.rules.tank - c.vehicle.fuel))
    p.fuel = fuel
    const crew = 0.92 + Math.random() * 0.2
    p.slow = Math.random() < 0.06
    const tyres = this.rules.tyreTime * crew + (p.slow ? 2 + Math.random() * 4 : 0)
    p.serviceTotal = 0.6 + Math.max(tyres, fuel / this.rules.refuelRate)
    p.serviceLeft = p.serviceTotal
    p.speed = 0
    p.u = p.path!.boxU
    p.phase = 'service'
    this.emit({ kind: 'pit', car: c.id, phase: 'stop', compound: p.compound, fuel })
  }

  private finishService(c: RaceCar) {
    const p = c.pit!
    const v = c.vehicle
    v.applySetup({ ...v.setup, compound: p.compound })
    for (const w of v.wheels) w.tyre.reset(62, w.tyre.coldPressure)
    v.setFuel(v.fuel + p.fuel)
    v.fuelCut = false
    c.compound = p.compound
    c.tyreLaps = 0
    c.stops++
    if (c.request) c.request = null
    else if (c.strategy.stops[c.stops - 1]) c.strategy.stops[c.stops - 1].lap = Math.min(c.strategy.stops[c.stops - 1].lap, c.lap + 1)
    c.entry.ai?.rebuildProfile()
    c.appliedSkill = 0
    this.boxBusy[c.team.box] = null
    p.phase = 'out'
    this.emit({ kind: 'pit', car: c.id, phase: 'out', time: p.stationary, compound: p.compound, fuel: p.fuel, slow: p.slow })
    if (c.mine) this.radio(c, 'stop', `${p.slow ? 'Sorry, problem with a wheel nut. ' : 'Good stop. '}${p.stationary.toFixed(1)} seconds.`, 'engineer', 0)
  }

  private leavePit(c: RaceCar) {
    const p = c.pit!
    const v = c.vehicle
    const tr = this.game.track
    const pose = p.path!.poseAt(p.path!.length, _pose)
    const speed = p.speed
    c.entry.sim.scripted = false
    v.reset(pose.x, pose.z, pose.yaw, tr, true)
    v.setVelocityForward(speed)
    v.gear = speed < 22 ? 2 : speed < 34 ? 3 : speed < 46 ? 4 : 5
    v.pendingGear = v.gear
    v.setVelocityForward(speed)
    c.entry.sim.snapshot()
    c.pit = null
    c.lastPitAt = this.game.raceTime
    if (c.mine) {
      const pos = c.entry.timing.position
      const behind = this.cars.find((o) => o.entry.timing.position === pos + 1)
      this.radio(c, 'rejoin', `You are P${pos}${behind ? `, ${behind.name} ${behind.interval > 0 ? behind.interval.toFixed(1) + ' seconds' : ''} behind` : ''}. Tyres are cold, careful.`, 'engineer', 0)
    }
  }

  private retire(c: RaceCar, reason: string) {
    c.retired = reason
    const tr = this.game.track
    const v = c.vehicle
    // pushed off onto the verge
    const s = c.entry.timing.s
    const i = tr.idx(s)
    const side = c.entry.sample.d >= 0 ? 1 : -1
    const S = side > 0 ? tr.L : tr.R
    const p = tr.pointAt(s, side * (tr.hw[i] + S.kerb[i] + 3), { x: 0, y: 0, z: 0 })
    v.reset(p.x, p.z, tr.headingAt(s) + side * 0.5, tr, true)
    c.entry.sim.frozen = true
    c.entry.ai = undefined
    c.entry.sim.input.throttle = 0
    c.entry.sim.input.brake = 1
    this.emit({ kind: 'retire', car: c.id, reason })
    if (c.mine) this.radio(c, 'retire', reason === 'Out of fuel' ? 'The engine has cut out... we are out of fuel.' : 'We have to retire the car.', 'driver', 0)
  }

  // ------------------------------------------------------------------------------- game events

  private onStart() {
    this.started = true
    this.emit({ kind: 'start' })
    for (const c of this.cars) c.gridPos = c.entry.timing.position
  }

  private onLap(id: string, time: number) {
    const c = this.byId.get(id)
    if (!c) return
    if (!this.started) return
    c.lapTimes.push(time)
    c.tyreLaps++
    if (c.best === 0 || time < c.best) c.best = time
    if (c.lap >= 2 && (!this.fastest || time < this.fastest.time) && time > 30) {
      this.fastest = { car: id, time }
      this.emit({ kind: 'fastest', car: id, time })
    }
    const lead = this.game.standings()[0]
    if (lead && lead.id === id && c.lap === this.rules.laps - 1 && !this.lastLapAnnounced) {
      this.lastLapAnnounced = true
      this.emit({ kind: 'lastLap' })
    }
  }

  private onFinish(id: string, pos: number) {
    const c = this.byId.get(id)
    if (!c) return
    c.finished = true
    if (!this.chequered) {
      this.chequered = true
      this.completeAt = this.game.raceTime
      this.emit({ kind: 'chequered', car: id })
    }
    this.emit({ kind: 'finish', car: id, pos })
  }

  // ------------------------------------------------------------------------------- timing

  private updateIntervals() {
    const st = this.game.standings()
    const L = this.game.track.length
    const now = this.game.raceTime
    const leader = st[0]
    for (let i = 0; i < st.length; i++) {
      const c = this.byId.get(st[i].id)
      if (!c) continue
      const d = st[i].timing.distance
      if (i === 0) {
        c.interval = 0
        c.gap = 0
        c.lapsDown = 0
        continue
      }
      const ahead = this.byId.get(st[i - 1].id)!
      c.interval = c.finished && ahead.finished ? st[i].timing.finishTime - st[i - 1].timing.finishTime : now - ahead.timeAt(d)
      const lc = this.byId.get(leader.id)!
      c.gap = c.finished && lc.finished ? st[i].timing.finishTime - leader.timing.finishTime : now - lc.timeAt(d)
      c.lapsDown = Math.floor((leader.timing.distance - d) / L)
      // battles for the broadcast
      if (c.interval > 0 && c.interval < 0.7 && !c.inPit() && !ahead.inPit() && this.started) {
        if (c.battleSince < 0) c.battleSince = now
        if (!c.battleAnnounced && now - c.battleSince > 6) {
          c.battleAnnounced = true
          this.emit({ kind: 'battle', car: c.id, other: ahead.id, pos: i })
        }
      } else if (c.interval > 1.4) {
        c.battleSince = -1
        c.battleAnnounced = false
      }
    }
    if (leader && leader.id !== this.leader && !this.byId.get(leader.id)?.retired) {
      if (this.leader && this.started) this.emit({ kind: 'lead', car: leader.id })
      this.leader = leader.id
    }
  }

  private detectOvertakes() {
    const st = this.game.standings().map((c) => c.id)
    const prev = this.order
    this.order = st
    if (prev.length !== st.length || this.game.raceTime < 3) return
    const now = this.game.raceTime
    for (let i = 0; i < st.length; i++) {
      const id = st[i]
      const was = prev.indexOf(id)
      if (was <= i) continue
      // moved up: who was passed?
      for (let j = i + 1; j <= was && j < st.length; j++) {
        const other = st[j]
        if (prev.indexOf(other) >= was) continue
        const a = this.byId.get(id)!,
          b = this.byId.get(other)!
        // position changes in the pit cycle are not overtakes
        if (a.pit || b.pit || now - a.lastPitAt < 8 || now - b.lastPitAt < 8 || b.retired) continue
        const key = id < other ? id + other : other + id
        if (now - (this.swapGuard.get(key) ?? -1e9) < 6) continue
        this.swapGuard.set(key, now)
        a.lastOvertakeAt = now
        this.emit({ kind: 'overtake', car: id, other, pos: i + 1 })
        if (a.mine) this.radio(a, 'passed', pick(AIR_LINES.passed), 'driver', 20)
        if (b.mine) this.radio(b, 'lost', pick(AIR_LINES.lost), 'driver', 20)
      }
    }
  }
}

const _pose: Pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
