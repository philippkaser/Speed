// TV broadcast director for team races. Decides who is worth watching (battles, overtakes, incidents,
// pit stops, the lead, our cars) and how (long-lens trackside camera with operator tracking and zoom,
// helicopter, T-cam onboard, rear-wing camera, chase drone, pit box camera, grid and finish cameras),
// and cuts like a live director: minimum and maximum shot lengths, no repeated shot types, hard cuts.
import * as THREE from 'three/webgpu'
import { game } from '../game/game'
import { clamp, valueNoise2 } from '../physics/math'
import { markCameraPath } from './motionHistory'
import { teamRace } from '../team/session'
import type { RaceCar } from '../team/teamRace'
import { pitLane } from '../track/pitlane'
import { carPoses } from './CarVisual'
import { cameraCut } from './PostFX'

export type ShotKind = 'grid' | 'trackside' | 'heli' | 'onboard' | 'rear' | 'chase' | 'pit' | 'finish'

export const SHOT_LABEL: Record<ShotKind, string> = {
  grid: 'Grid',
  trackside: 'Trackside',
  heli: 'Helicopter',
  onboard: 'Onboard',
  rear: 'Rear cam',
  chase: 'Chase',
  pit: 'Pit lane',
  finish: 'Finish line',
}

/** Director state, read by the broadcast graphics. */
export const director = {
  target: '',
  /** the other car in a battle shot */
  second: '',
  shot: 'grid' as ShotKind,
  since: 0,
  cut: 0,
  /** pit wall override: follow this car */
  focus: '' as string,
  /** pit wall override: only this kind of shot */
  lockShot: null as ShotKind | null,
  finishShown: false,
}

const st = {
  post: new THREE.Vector3(),
  aim: new THREE.Vector3(),
  pos: new THREE.Vector3(),
  heliAngle: 0,
  yaw: 0,
  fov: 30,
  scoreAt: 0,
  minDur: 4,
  maxDur: 9,
  lastKinds: [] as ShotKind[],
  init: false,
  shake: 0,
}

const _v = new THREE.Vector3(),
  _v2 = new THREE.Vector3(),
  _fwd = new THREE.Vector3(),
  _p = { x: 0, y: 0, z: 0 }

function interest(c: RaceCar, now: number) {
  if (c.retired || c.finished) return -100
  const pos = c.entry.timing.position
  let s = Math.max(0, 3.2 - pos * 0.28)
  if (c.interval > 0 && c.interval < 1.0 && !c.inPit()) s += 6 * (1 - c.interval) + (pos <= 5 ? 2 : 0)
  if (now - c.lastOvertakeAt < 4) s += 7
  if (now - c.lastMistakeAt < 5) s += 8
  if (c.pit && c.pit.phase !== 'called') {
    const p = c.pit
    const near = p.path ? (p.phase === 'service' || (p.u > p.path.boxU - 170 && p.u < p.path.boxU + 60)) : false
    if (near) s += c.mine ? 10 : 4.5
  }
  if (c.mine) s += 2.2
  if (director.focus === c.id) s += 60
  if (c.id === director.target) s += 1.5
  const tr = teamRace()
  if (tr?.lastLapAnnounced && pos === 1) s += 4
  return s
}

function pickKind(c: RaceCar, battle: boolean): ShotKind {
  if (director.lockShot && director.lockShot !== 'grid' && director.lockShot !== 'pit' && director.lockShot !== 'finish') return director.lockShot
  const p = c.pit
  if (p && p.path && (p.phase === 'service' || (p.phase === 'in' && p.u > p.path.boxU - 170))) return 'pit'
  return chooseKind(battle)
}

/** A shot type for a car on track: no repeats, battles get more trackside and onboard shots. */
function chooseKind(battle: boolean): ShotKind {
  const options: [ShotKind, number][] = battle
    ? [
        ['trackside', 0.38],
        ['heli', 0.18],
        ['onboard', 0.22],
        ['rear', 0.22],
      ]
    : [
        ['trackside', 0.45],
        ['chase', 0.18],
        ['heli', 0.2],
        ['onboard', 0.17],
      ]
  const last = st.lastKinds[st.lastKinds.length - 1]
  const opts = options.filter(([k]) => k !== last)
  let r = Math.random() * opts.reduce((a, [, w]) => a + w, 0)
  for (const [k, w] of opts) {
    if ((r -= w) <= 0) return k
  }
  return opts[0][0]
}

function cutTo(target: RaceCar, kind: ShotKind, second = '') {
  const tr = teamRace()
  if (!tr) return
  // rear cam looks back from the car ahead at its chaser
  if (kind === 'rear') {
    const ahead = tr.cars.find((o) => o.entry.timing.position === target.entry.timing.position - 1)
    if (ahead && target.interval < 1.2) {
      second = target.id
      target = ahead
    } else kind = 'onboard'
  }
  director.target = target.id
  director.second = second
  director.shot = kind
  director.since = 0
  director.cut++
  st.lastKinds.push(kind)
  if (st.lastKinds.length > 4) st.lastKinds.shift()
  st.init = false
  st.minDur = kind === 'pit' ? 6 : 3.8 + Math.random() * 1.5
  st.maxDur = kind === 'trackside' ? 14 : kind === 'pit' ? 30 : 7.5 + Math.random() * 4
  cameraCut.frames = 3
  if (kind === 'trackside') placePost(target.entry.timing.s, target.vehicle.speed)
  if (kind === 'heli') st.heliAngle = (Math.random() < 0.5 ? -1 : 1) * (0.7 + Math.random() * 1.6)
}

/** A trackside camera position a few seconds ahead of a car (at s, m/s), behind the barrier, raised. */
function placePost(s0: number, speed: number) {
  const tr = game.track
  const s = s0 + 55 + Math.max(speed, 20) * (1.6 + Math.random() * 1.4)
  const i = tr.idx(s)
  const side = Math.abs(tr.curv[i]) > 0.002 ? (tr.curv[i] > 0 ? -1 : 1) : Math.random() < 0.5 ? 1 : -1
  const S = side > 0 ? tr.L : tr.R
  const off = Math.min(S.wall[i], 30) + 3 + Math.random() * 7
  tr.pointAt(s, side * off, _p)
  st.post.set(_p.x, _p.y + 2.5 + Math.random() * 6, _p.z)
}

function battlePartner(tr: NonNullable<ReturnType<typeof teamRace>>, c: RaceCar) {
  if (c.interval > 0 && c.interval < 1.0) return tr.cars.find((o) => o.entry.timing.position === c.entry.timing.position - 1) ?? null
  const behind = tr.cars.find((o) => o.entry.timing.position === c.entry.timing.position + 1)
  if (behind && behind.interval > 0 && behind.interval < 1.0) return behind
  return null
}

export function broadcastCamera(cam: THREE.PerspectiveCamera, dt: number, focusOut: THREE.Vector3) {
  const tr = teamRace()
  if (!tr || !tr.cars.length) return
  const now = game.raceTime
  director.since += dt
  const phase = game.phase

  // ------------------------------------------------------------------ direction
  if (phase === 'grid' || phase === 'countdown') {
    if (director.shot !== 'grid') {
      director.shot = 'grid'
      director.cut++
      cameraCut.frames = 3
      st.init = false
    }
    director.target = game.standings()[0]?.id ?? ''
  } else {
    st.scoreAt -= dt
    const cur = tr.byId.get(director.target)
    let invalid = !cur || cur.retired || (cur.finished && director.shot !== 'finish')
    if (director.shot === 'grid' && director.since > 5) invalid = true
    if (director.shot === 'trackside' && cur) {
      const d = st.post.distanceTo(cur.vehicle.pos as unknown as THREE.Vector3)
      _fwd.set(cur.vehicle.fwd.x, cur.vehicle.fwd.y, cur.vehicle.fwd.z)
      const behind = _v.subVectors(st.post, cur.vehicle.pos as unknown as THREE.Vector3).dot(_fwd) < -25
      if (d > 330 || (behind && d > 70)) invalid = true
    }
    if (director.shot === 'pit' && cur && (!cur.pit || (cur.pit.path && cur.pit.u > cur.pit.path.boxU + 70))) invalid = true
    // the finish: catch the winner crossing the line
    const lead = game.standings()[0]
    const leadCar = lead ? tr.byId.get(lead.id) : null
    if (leadCar && tr.lastLapAnnounced && !director.finishShown && lead.timing.s > game.track.length - 520 && !leadCar.finished) {
      director.finishShown = true
      cutTo(leadCar, 'finish')
    } else if (director.shot === 'finish' && director.since < 7) {
      // hold the finish shot
    } else if (st.scoreAt <= 0 || invalid) {
      st.scoreAt = 0.4
      let best: RaceCar | null = null,
        bestS = -1e9
      for (const c of tr.cars) {
        const s = interest(c, now)
        if (s > bestS) {
          bestS = s
          best = c
        }
      }
      const curS = cur ? interest(cur, now) : -1e9
      const timeUp = director.since > st.maxDur
      const better = best && best.id !== director.target && bestS > curS + 2.5 && director.since > st.minDur
      const pitNow = best && best.mine && best.pit?.phase === 'service' && director.shot !== 'pit'
      if (best && (invalid || timeUp || better || pitNow)) {
        const partner = battlePartner(tr, best)
        cutTo(best, pickKind(best, !!partner), partner?.id ?? '')
      }
    }
  }

  // ------------------------------------------------------------------ camera
  const target = tr.byId.get(director.target)
  if (!target) return
  renderShot(cam, dt, focusOut, { id: target.id, speed: target.vehicle.speed, box: target.team.box, gridT: game.countdownTotal - game.countdown })
}

/** What a shot needs of the car it follows. */
export interface ShotTarget {
  id: string
  /** m/s */
  speed: number
  /** the team's pit box (pit shots), -1 none */
  box: number
  /** seconds since the grid shot began */
  gridT: number
}

/** Films director.shot of a car: camera placement, operator tracking, zoom. */
function renderShot(cam: THREE.PerspectiveCamera, dt: number, focusOut: THREE.Vector3, target: ShotTarget) {
  const pose = carPoses.get(target.id)
  if (!pose) return
  const carPos = pose.pos
  _fwd.set(0, 0, 1).applyQuaternion(pose.quat)
  const partnerPose = director.second ? carPoses.get(director.second) : undefined
  const smooth = (rate: number) => clamp(dt * rate, 0, 1)
  focusOut.copy(carPos)
  cam.near = 0.5
  let fov = 30
  switch (director.shot) {
    case 'grid': {
      const trk = game.track
      trk.pointAt(34, 0, _p)
      const t = target.gridT
      cam.position.set(_p.x, _p.y + 7.5 - Math.min(t, 8) * 0.25, _p.z)
      trk.pointAt(-55 - Math.min(t, 8) * 2, 0, _p)
      _v.set(_p.x, _p.y + 0.5, _p.z)
      cam.lookAt(_v)
      fov = 30 - Math.min(t, 8) * 0.6
      focusOut.copy(_v)
      break
    }
    case 'trackside':
    case 'finish': {
      if (director.shot === 'finish' && !st.init) {
        const trk = game.track
        const i = trk.idx(18)
        trk.pointAt(18, -(trk.hw[i] + 4.5), _p)
        st.post.set(_p.x, _p.y + 1.3, _p.z)
      }
      cam.position.copy(st.post)
      // operator: smooth pan with a little lead, framing the battle when there is one
      _v.copy(carPos).add(_v2.set(0, 0.55, 0))
      let frame = 7.5
      if (partnerPose) {
        const sep = partnerPose.pos.distanceTo(carPos)
        if (sep < 40) {
          _v.lerp(partnerPose.pos, 0.5)
          frame = Math.max(7.5, sep * 1.35)
        }
      }
      if (!st.init) st.aim.copy(_v)
      st.aim.lerp(_v, smooth(9))
      cam.lookAt(st.aim)
      const dist = cam.position.distanceTo(st.aim)
      fov = clamp((2 * Math.atan(frame / 2 / Math.max(dist, 1)) * 180) / Math.PI, 3.2, 55)
      break
    }
    case 'heli': {
      const heading = Math.atan2(_fwd.x, _fwd.z)
      st.heliAngle += dt * 0.04
      const a = heading + Math.PI + st.heliAngle
      _v.set(carPos.x + Math.sin(a) * 75, carPos.y + 58, carPos.z + Math.cos(a) * 75)
      if (!st.init) st.pos.copy(_v)
      st.pos.lerp(_v, smooth(1.2))
      cam.position.copy(st.pos)
      _v.copy(carPos)
      let frame = 22
      if (partnerPose && partnerPose.pos.distanceTo(carPos) < 60) {
        _v.lerp(partnerPose.pos, 0.5)
        frame = Math.max(22, partnerPose.pos.distanceTo(carPos) * 1.5)
      }
      if (!st.init) st.aim.copy(_v)
      st.aim.lerp(_v, smooth(5))
      cam.lookAt(st.aim)
      fov = clamp((2 * Math.atan(frame / 2 / Math.max(cam.position.distanceTo(st.aim), 1)) * 180) / Math.PI, 8, 45)
      break
    }
    case 'onboard':
    case 'rear': {
      const rear = director.shot === 'rear'
      _v.set(0, rear ? 0.92 : 1.3, rear ? -2.2 : -0.35).applyQuaternion(pose.quat).add(carPos)
      cam.position.copy(_v)
      _v2.set(0, rear ? 0.55 : 1.0, rear ? -22 : 16).applyQuaternion(pose.quat).add(carPos)
      cam.up.set(0, 1, 0).applyQuaternion(pose.quat)
      cam.lookAt(_v2)
      cam.up.set(0, 1, 0)
      // the camera rides with the car (its path ends here); the mount vibration does not blur
      markCameraPath(cam)
      // camera mount vibration
      st.shake += dt
      const sp = target.speed
      const amp = 0.0012 + sp * 0.00002
      cam.rotateX((valueNoise2(st.shake * 23, 1.7) - 0.5) * amp)
      cam.rotateZ((valueNoise2(st.shake * 19, 5.3) - 0.5) * amp)
      cam.near = 0.05
      fov = rear ? 52 : 66
      break
    }
    case 'chase': {
      const heading = Math.atan2(_fwd.x, _fwd.z)
      if (!st.init) st.yaw = heading
      let dy = heading - st.yaw
      while (dy > Math.PI) dy -= Math.PI * 2
      while (dy < -Math.PI) dy += Math.PI * 2
      st.yaw += dy * smooth(4)
      _v.set(carPos.x - Math.sin(st.yaw) * 10.5, carPos.y + 3.1, carPos.z - Math.cos(st.yaw) * 10.5)
      if (!st.init) st.pos.copy(_v)
      st.pos.lerp(_v, smooth(8))
      cam.position.copy(st.pos)
      _v2.copy(carPos).addScaledVector(_fwd, 4).add(_v.set(0, 0.6, 0))
      cam.lookAt(_v2)
      fov = 46
      break
    }
    case 'pit': {
      const lane = pitLane(game.track)
      const boxS = lane.boxS[Math.max(0, target.box)]
      if (!st.init) {
        game.track.pointAt(boxS + 15, lane.dFast - 2, _p)
        st.post.set(_p.x, _p.y + 2.1, _p.z)
      }
      cam.position.copy(st.post)
      _v.copy(carPos).add(_v2.set(0, 0.4, 0))
      if (!st.init) st.aim.copy(_v)
      st.aim.lerp(_v, smooth(6))
      cam.lookAt(st.aim)
      const dist = cam.position.distanceTo(st.aim)
      fov = clamp((2 * Math.atan(9 / 2 / Math.max(dist, 1)) * 180) / Math.PI, 14, 50)
      break
    }
  }
  if (!st.init) st.fov = fov
  st.fov += (fov - st.fov) * (director.shot === 'trackside' || director.shot === 'heli' ? smooth(5) : 1)
  cam.fov = st.fov
  cam.far = 12000
  cam.updateProjectionMatrix()
  st.init = true
}

// ------------------------------------------------------------------------------------- replays

/** A car of a replay, as the replay director sees it (src/game/replay.ts ReplayCarView). */
export interface ReplayFieldCar {
  id: string
  position: number
  /** track position (m) and total distance covered (m) */
  s: number
  distance: number
  /** m/s */
  speed: number
  finished: boolean
  /** sliding or off the track right now */
  incident: boolean
  isPlayer: boolean
}

export interface ReplayField {
  cars: ReplayFieldCar[]
  /** replay clock (s) */
  now: number
  /** seconds since the green light (negative on the grid) */
  raceTime: number
  /** the leader is on the last lap */
  lastLap: boolean
  /** the viewer asked to follow this car ('' = director's choice) */
  focus: string
  /** the replay jumped (seek): start over with a fresh shot */
  jumped: boolean
}

const rd = {
  positions: new Map<string, number>(),
  overtakeAt: new Map<string, number>(),
  incidentAt: new Map<string, number>(),
  scoreAt: 0,
}

function replayInterval(f: ReplayField, c: ReplayFieldCar) {
  const ahead = f.cars.find((o) => o.position === c.position - 1)
  if (!ahead) return 0
  return Math.max(0, ahead.distance - c.distance) / Math.max(c.speed, 15)
}

function replayInterest(f: ReplayField, c: ReplayFieldCar) {
  if (c.finished && director.shot !== 'finish') return -100
  const now = f.now
  let s = Math.max(0, 3.2 - c.position * 0.28)
  const gap = replayInterval(f, c)
  if (gap > 0 && gap < 1.0) s += 6 * (1 - gap) + (c.position <= 5 ? 2 : 0)
  if (now - (rd.overtakeAt.get(c.id) ?? -99) < 4) s += 7
  if (now - (rd.incidentAt.get(c.id) ?? -99) < 5) s += 8
  if (c.isPlayer) s += 3
  if (f.focus === c.id) s += 60
  if (c.id === director.target) s += 1.5
  if (f.lastLap && c.position === 1) s += 4
  return s
}

function replayCut(f: ReplayField, target: ReplayFieldCar, kind: ShotKind, second = '') {
  if (kind === 'rear') {
    const ahead = f.cars.find((o) => o.position === target.position - 1)
    if (ahead && replayInterval(f, target) < 1.2) {
      second = target.id
      target = ahead
    } else kind = 'onboard'
  }
  director.target = target.id
  director.second = second
  director.shot = kind
  director.since = 0
  director.cut++
  st.lastKinds.push(kind)
  if (st.lastKinds.length > 4) st.lastKinds.shift()
  st.init = false
  st.minDur = 3.8 + Math.random() * 1.5
  st.maxDur = kind === 'trackside' ? 14 : 7.5 + Math.random() * 4
  cameraCut.frames = 3
  if (kind === 'trackside') placePost(target.s, target.speed)
  if (kind === 'heli') st.heliAngle = (Math.random() < 0.5 ? -1 : 1) * (0.7 + Math.random() * 1.6)
}

/**
 * The TV director for replays: the same shots and cutting rules as the team broadcast, choosing from
 * what the recording shows (battles from the gaps, overtakes from position changes, incidents from
 * slides and trips off the track, the leader on the last lap, the viewer's car). dt is replay time:
 * a paused replay holds its shot, a fast one cuts faster.
 */
export function replayBroadcast(cam: THREE.PerspectiveCamera, dt: number, focusOut: THREE.Vector3, f: ReplayField) {
  if (!f.cars.length) return
  if (f.jumped) {
    rd.positions.clear()
    rd.overtakeAt.clear()
    rd.incidentAt.clear()
    rd.scoreAt = 0
    director.finishShown = false
    director.target = ''
  }
  for (const c of f.cars) {
    const prev = rd.positions.get(c.id)
    if (prev !== undefined && c.position < prev) rd.overtakeAt.set(c.id, f.now)
    rd.positions.set(c.id, c.position)
    if (c.incident) rd.incidentAt.set(c.id, f.now)
  }
  director.since += dt
  const byId = (id: string) => f.cars.find((c) => c.id === id)
  const lead = f.cars.find((c) => c.position === 1)
  if (f.raceTime < 0) {
    if (director.shot !== 'grid' || !director.target) {
      director.shot = 'grid'
      director.since = 0
      director.cut++
      cameraCut.frames = 3
      st.init = false
    }
    director.target = lead?.id ?? f.cars[0].id
  } else {
    rd.scoreAt -= dt
    const cur = byId(director.target)
    let invalid = !cur || director.shot === 'grid' || (cur.finished && director.shot !== 'finish')
    if (director.shot === 'trackside' && cur) {
      const pose = carPoses.get(cur.id)
      if (pose) {
        const d = st.post.distanceTo(pose.pos)
        _fwd.set(0, 0, 1).applyQuaternion(pose.quat)
        const behind = _v.subVectors(st.post, pose.pos).dot(_fwd) < -25
        if (d > 330 || (behind && d > 70)) invalid = true
      }
    }
    if (lead && f.lastLap && !director.finishShown && lead.s > game.track.length - 520 && !lead.finished) {
      director.finishShown = true
      replayCut(f, lead, 'finish')
    } else if (director.shot === 'finish' && director.since < 7) {
      // hold the finish shot
    } else if (rd.scoreAt <= 0 || invalid) {
      rd.scoreAt = 0.4
      let best: ReplayFieldCar | null = null,
        bestS = -1e9
      for (const c of f.cars) {
        const s = replayInterest(f, c)
        if (s > bestS) {
          bestS = s
          best = c
        }
      }
      const curS = cur ? replayInterest(f, cur) : -1e9
      const timeUp = director.since > st.maxDur
      const better = best && best.id !== director.target && bestS > curS + 2.5 && director.since > st.minDur
      if (best && (invalid || timeUp || better)) {
        const b = best
        const ahead = f.cars.find((o) => o.position === b.position - 1)
        const behind = f.cars.find((o) => o.position === b.position + 1)
        const behindGap = behind ? replayInterval(f, behind) : 0
        const partner = ahead && replayInterval(f, b) > 0 && replayInterval(f, b) < 1 ? ahead : behind && behindGap > 0 && behindGap < 1 ? behind : null
        const locked = director.lockShot && director.lockShot !== 'grid' && director.lockShot !== 'pit' && director.lockShot !== 'finish' ? director.lockShot : null
        replayCut(f, b, locked ?? chooseKind(!!partner), partner?.id ?? '')
      }
    }
  }
  const target = byId(director.target)
  if (!target) return
  renderShot(cam, dt, focusOut, { id: target.id, speed: target.speed, box: -1, gridT: Math.min(8, Math.max(0, f.raceTime + 8)) })
}
