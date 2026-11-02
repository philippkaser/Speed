// Pit lane of the Autodromo Valle Alta, in track coordinates (s along the lap, d to the left).
//
// The pit road peels off to the left before the long final right-hander, runs through the corner's
// outside runoff, passes behind the pit wall along the main straight (speed limited) past the team
// garages of the pit building, and rejoins on the left after the start/finish line.
import { clamp } from '../physics/math'
import type { Track } from './track'

const sm = (x: number) => {
  const t = clamp(x, 0, 1)
  return t * t * (3 - 2 * t)
}

export interface PitLane {
  /** the scripted pit path starts here (on the racing surface) */
  sEntry: number
  /** speed limit zone */
  sLaneStart: number
  sLaneEnd: number
  /** the car is handed back to the racing simulation here */
  sExit: number
  /** fast lane and working (box) lane offsets */
  dFast: number
  dBox: number
  /** the far edge of the lane (garage fronts) */
  dGarage: number
  /** stopping point of each garage box */
  boxS: number[]
  /** barrier openings on the left side, [s0, s1] (unwrapped, may be negative) */
  gaps: [number, number][]
  /** speed limit, m/s */
  speed: number
  /** lateral offset of the pit road (without the detour into a box) */
  roadD(s: number, d0?: number): number
}

const cache = new WeakMap<Track, PitLane>()

export function pitLane(track: Track): PitLane {
  let p = cache.get(track)
  if (p) return p
  const sMid = -110
  const wall = track.L.wall[track.idx(sMid)]
  const dFast = wall + 7
  const dBox = wall + 15.5
  const sEntry = -800,
    sLaneStart = -250,
    sLaneEnd = 60,
    sExit = 300
  const exitD = track.hw[track.idx(sExit)] - 2.5
  p = {
    sEntry,
    sLaneStart,
    sLaneEnd,
    sExit,
    dFast,
    dBox,
    dGarage: wall + 19.5,
    boxS: [-172, -150, -128, -106, -84, -62],
    gaps: [
      [-345, -235],
      [55, 205],
    ],
    speed: 22.2,
    roadD(s: number, d0 = 0) {
      if (s < -640) return d0 + (9.5 - d0) * sm((s - sEntry) / (-640 - sEntry))
      if (s < -330) return 9.5 + (20 - 9.5) * sm((s + 640) / 310)
      if (s < sLaneStart) return 20 + (dFast - 20) * sm((s - -330) / (sLaneStart + 330))
      if (s <= sLaneEnd) return dFast
      return dFast + (exitD - dFast) * sm((s - sLaneEnd) / (sExit - sLaneEnd))
    },
  }
  cache.set(track, p)
  return p
}

/** Is s (any lap) inside one of the left-side barrier openings? */
export function inPitGap(track: Track, s: number) {
  const L = track.length
  for (const [a, b] of pitLane(track).gaps) {
    const x = ((((s - a) % L) + L) % L)
    if (x <= b - a) return true
  }
  return false
}

export interface Pose {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
}

/**
 * The path a car follows from the pit entry through its box to the exit, sampled every metre with
 * the cumulative arc length. Track positions are unwrapped (s runs from sEntry < 0 to sExit > 0).
 */
export class PitPath {
  x: Float32Array
  y: Float32Array
  z: Float32Array
  s: Float32Array
  u: Float32Array
  length: number
  /** arc length of the box stop, the queueing point behind it and the speed-limit zone */
  boxU = 0
  holdU = 0
  laneStartU = 0
  laneEndU = 0
  constructor(track: Track, lane: PitLane, boxS: number, d0: number) {
    const n = Math.ceil(lane.sExit - lane.sEntry) + 1
    this.x = new Float32Array(n)
    this.y = new Float32Array(n)
    this.z = new Float32Array(n)
    this.s = new Float32Array(n)
    this.u = new Float32Array(n)
    const p = { x: 0, y: 0, z: 0 }
    let u = 0
    let best = Infinity
    for (let i = 0; i < n; i++) {
      const s = lane.sEntry + i
      let d = lane.roadD(s, d0)
      // detour into the box
      const db = s < boxS - 16 || s > boxS + 16 ? 0 : s < boxS - 3 ? sm((s - (boxS - 16)) / 13) : s <= boxS + 3 ? 1 : 1 - sm((s - (boxS + 3)) / 13)
      d += (lane.dBox - lane.dFast) * db
      track.pointAt(s, d, p)
      this.x[i] = p.x
      this.y[i] = p.y
      this.z[i] = p.z
      this.s[i] = s
      if (i > 0) u += Math.hypot(p.x - this.x[i - 1], p.y - this.y[i - 1], p.z - this.z[i - 1])
      this.u[i] = u
      if (Math.abs(s - boxS) < best) {
        best = Math.abs(s - boxS)
        this.boxU = u
      }
      if (s <= lane.sLaneStart) this.laneStartU = u
      if (s <= lane.sLaneEnd) this.laneEndU = u
    }
    this.length = u
    this.holdU = this.boxU - 9
  }

  /** Position and heading at arc length u. */
  poseAt(u: number, out: Pose) {
    const n = this.u.length
    const uu = clamp(u, 0, this.length)
    // binary search
    let lo = 0,
      hi = n - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (this.u[m] <= uu) lo = m
      else hi = m
    }
    const f = this.u[hi] > this.u[lo] ? (uu - this.u[lo]) / (this.u[hi] - this.u[lo]) : 0
    out.x = this.x[lo] + (this.x[hi] - this.x[lo]) * f
    out.y = this.y[lo] + (this.y[hi] - this.y[lo]) * f
    out.z = this.z[lo] + (this.z[hi] - this.z[lo]) * f
    const a = Math.max(0, lo - 1),
      b = Math.min(n - 1, hi + 1)
    const dx = this.x[b] - this.x[a],
      dy = this.y[b] - this.y[a],
      dz = this.z[b] - this.z[a]
    out.yaw = Math.atan2(dx, dz)
    out.pitch = Math.atan2(dy, Math.hypot(dx, dz))
    return out
  }

  /** Track distance (unwrapped) at arc length u. */
  sAt(u: number) {
    const n = this.u.length
    const uu = clamp(u, 0, this.length)
    let lo = 0,
      hi = n - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (this.u[m] <= uu) lo = m
      else hi = m
    }
    const f = this.u[hi] > this.u[lo] ? (uu - this.u[lo]) / (this.u[hi] - this.u[lo]) : 0
    return this.s[lo] + (this.s[hi] - this.s[lo]) * f
  }
}
