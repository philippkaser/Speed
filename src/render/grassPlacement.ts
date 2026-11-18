// Where the grass grows: patches of the clump model on the verges, from the soil margin past the kerb
// or paved runoff to the barrier, and a strip behind it. Pure data (no rendering), so the tests can
// check it against the track's surfaces.
import { makeSample, Surface } from '../physics/ground'
import { pitLane } from '../track/pitlane'
import type { Track } from '../track/track'

/** Per instance: x, y, z, yaw | scale, scaleY, tint (0..1), phase */
export const GRASS_STRIDE = 8
/** how far a patch's blades reach from its centre, at scale 1 (m): the clump's ~0.7 m and the wind's sway */
export const GRASS_REACH = 0.74
/** blades stop this short of the kerb, the asphalt or the paved runoff (m) */
export const GRASS_GAP = 0.08
/** the most room a patch is given (m): measured from the nearest point of the track, the room is right this close (further, the road may curve towards the patch) */
export const GRASS_ROOM = 2.5

export interface GrassPatches {
  /** GRASS_STRIDE floats per patch */
  data: Float32Array
  /**
   * per patch: the room it has (m from its centre to the nearest kerb, asphalt or paved runoff, up
   * to GRASS_ROOM), for layers that draw it wider (they must stay off the road too)
   */
  room: Float32Array
}

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
}

/**
 * Grass patches on the verges: from the end of the kerb or paved runoff to the barrier, and a strip
 * behind it. No blade reaches a kerb, the asphalt or a paved runoff: each patch is measured from the
 * nearest point of the track, not across the track at its own place (around a corner a patch placed
 * across from one point can be nearer to another, or lie on the paved runoff of the corner's outside).
 */
export function placeGrass(track: Track, density: number): GrassPatches {
  const r = rng(track.def.seed * 7 + 3)
  const out: number[] = []
  const rooms: number[] = []
  // a mown sward: short patches (10-14 cm); the ground's own turf carries the cover between and
  // beyond them
  const step = 0.68 / Math.sqrt(Math.max(density, 0.2))
  const smp = makeSample()
  /** from a point to the nearest kerb, asphalt or paved runoff (m; negative on them) */
  const roomAt = (x: number, z: number) => {
    smp.hint = -1
    track.sample(x, z, smp)
    const i = track.idx(smp.s)
    const S = smp.d >= 0 ? track.L : track.R
    // (the widest edge within a couple of metres: kerbs and runoffs start and end abruptly)
    let edge = 0
    for (let k = -3; k <= 3; k++) {
      const j = (i + k + track.n) % track.n
      edge = Math.max(edge, track.hw[j] + S.kerb[j] + Math.max(0, S.paved[j]))
    }
    return Math.abs(smp.d) - edge
  }
  const p = { x: 0, y: 0, z: 0 }
  const lane = pitLane(track)
  const L = track.length
  const wrap = (s: number) => ((s % L) + L + L / 2) % L - L / 2
  for (let s = 0; s < L; s += step) {
    const i = track.idx(s)
    for (const side of [1, -1]) {
      const S = side > 0 ? track.L : track.R
      // the end of the kerb or the paved runoff
      const edge = track.hw[i] + S.kerb[i] + Math.max(0, S.paved[i])
      const wall = S.wall[i]
      const gravel = S.outer[i] === Surface.Gravel
      const sw = wrap(s)
      for (let d = edge + 0.5; d < wall + 9; d += step) {
        const dd = d + (r() - 0.5) * step * 0.9
        const sc = 1.0 + r() * 0.35
        // the barrier itself, gravel traps, the pit road and lane, the grandstands
        if (Math.abs(dd - wall) < 0.9) continue
        if (gravel && dd < wall - 1.5) continue
        if (dd - GRASS_REACH * sc < edge) continue
        if (side > 0 && sw > -830 && sw < 330 && Math.abs(dd - lane.roadD(sw)) < 7) continue
        if (side > 0 && sw > -270 && sw < 80 && dd > wall - 1) continue
        if (side < 0 && sw > -190 && sw < 240 && dd > wall) continue
        const ss = s + (r() - 0.5) * step * 0.9
        track.pointAt(ss, side * dd, p)
        // measured from the nearest point of the track
        const room = roomAt(p.x, p.z)
        if (room < GRASS_REACH * sc + GRASS_GAP) continue
        // mown short inside the barrier, longer behind it
        const behind = dd - wall
        const sy = (behind > 0 ? 0.55 : 0.27) + r() * 0.1
        // tone (tint): the ground's mowing stripes under the patch (vergeMaterial), darker behind the barrier
        const x = Math.sin((behind * Math.PI) / 2.5) / 0.3
        const stripe = behind > 0 ? 0.2 : Math.min(1, Math.max(0, x * 0.5 + 0.5))
        out.push(p.x, p.y - 0.02, p.z, r() * Math.PI * 2, sc, sy, stripe * 0.85 + r() * 0.15, r() * 6.283)
        rooms.push(Math.min(room, GRASS_ROOM))
      }
      // the sward's own edge: the mower leaves a ragged fringe of longer grass whose blades lean over
      // the worn soil margin up to the kerb or the asphalt, not onto it (no ruler-straight line)
      if (gravel) continue
      for (let k = 0; k < 2; k++) {
        const sc = 0.85 + r() * 0.4
        const dd = edge + sc * GRASS_REACH + GRASS_GAP + r() * 0.3
        if (side > 0 && sw > -830 && sw < 330 && Math.abs(dd - lane.roadD(sw)) < 7) continue
        if (side > 0 && sw > -270 && sw < 80 && dd > wall - 1) continue
        if (side < 0 && sw > -190 && sw < 240 && dd > wall) continue
        track.pointAt(s + (r() - 0.5) * step, side * dd, p)
        const room = roomAt(p.x, p.z)
        if (room < GRASS_REACH * sc + GRASS_GAP) continue
        out.push(p.x, p.y - 0.02, p.z, r() * Math.PI * 2, sc, 0.3 + r() * 0.16, 0.35 + r() * 0.3, r() * 6.283)
        rooms.push(Math.min(room, GRASS_ROOM))
      }
    }
  }
  return { data: new Float32Array(out), room: new Float32Array(rooms) }
}

