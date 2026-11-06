// Trackside structures and dressing, all into the shared kits (one draw call per material): the start
// gantry (lattice towers and a box truss), the bridge over the straight, billboards on scaffolding,
// braking distance boards, marshal posts, floodlight masts, TV camera towers, the big screen, team
// stations on the pit wall and sponsor boards along the walls of the straight.
import * as THREE from 'three/webgpu'
import { Surface } from '../../physics/ground'
import { DS, type Track } from '../../track/track'
import { pitLane, inPitGap } from '../../track/pitlane'
import { Kit, lin, Pat, surf } from './kit'
import { SLOT, SPONSORS, signQuad, slotUV } from './signage'
import { mulberry } from './noise'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const Z_UP = new THREE.Vector3(0, 0, 1)

const S = {
  gantry: surf(lin(0x202326), 0.45, { m: 0.6, p: Pat.Steel }),
  galv: surf(lin(0xa7abae), 0.5, { m: 0.85, p: Pat.Steel }),
  white: surf(lin(0xdedfe0), 0.5, { p: Pat.Cladding }),
  concrete: surf(lin(0xa4a19a), 0.88, { p: Pat.Concrete }),
  orange: surf(lin(0xff6a00, 0.85), 0.55, { p: Pat.Ribbed }),
  dark: surf(lin(0x15181b), 0.2, { m: 0.4 }),
  black: surf(lin(0x0b0c0d), 0.4),
  lamp: surf([0.9, 0.92, 0.95], 0.15, { m: 0.2, e: 0.08 }),
  screenFrame: surf(lin(0x141619), 0.45, { m: 0.5 }),
  board: surf(lin(0x6d7176), 0.55, { m: 0.3, p: Pat.Steel }),
}

const _p = { x: 0, y: 0, z: 0 }

/**
 * A frame at (s, d) whose local +z points along a horizontal direction given in the track's terms:
 * f along the travel direction, l along the left.
 */
export function frameDir(track: Track, s: number, d: number, f: number, l: number, yLift = 0) {
  track.pointAt(s, d, _p)
  const i = track.idx(s)
  const zx = track.tx[i] * f + track.lx[i] * l,
    zz = track.tz[i] * f + track.lz[i] * l
  const len = Math.hypot(zx, zz) || 1
  const Z = new THREE.Vector3(zx / len, 0, zz / len)
  const Y = new THREE.Vector3(0, 1, 0)
  const X = new THREE.Vector3().crossVectors(Y, Z)
  const m = new THREE.Matrix4().makeBasis(X, Y, Z)
  m.setPosition(_p.x, _p.y + yLift, _p.z)
  return m
}

interface Kits {
  arch: Kit
  sign: Kit
  /** small props (left out of the reflection probes) */
  props: Kit
  propSign: Kit
}

/** Lattice tower: four corner posts with ties and diagonals, centred at (x, z). */
function lattice(k: Kit, x: number, z: number, h: number, w: number, s = S.gantry) {
  const c = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]
  for (const [a, b] of c) k.box(x + (a * w) / 2 - 0.09, 0, z + (b * w) / 2 - 0.09, x + (a * w) / 2 + 0.09, h, z + (b * w) / 2 + 0.09, s, 0b110111)
  const step = 1.4
  for (let y = 0.5; y < h - 0.2; y += step) {
    for (let e = 0; e < 4; e++) {
      const [a0, b0] = c[e],
        [a1, b1] = c[(e + 1) % 4]
      const p0 = V(x + (a0 * w) / 2, y, z + (b0 * w) / 2),
        p1 = V(x + (a1 * w) / 2, y, z + (b1 * w) / 2)
      k.beam(p0, p1, 0.07, 0.07, s)
      const p2 = V(x + (a1 * w) / 2, Math.min(h, y + step), z + (b1 * w) / 2)
      k.beam(p0, p2, 0.05, 0.05, s)
    }
  }
}

export function buildProps(track: Track, kits: Kits) {
  const { arch, sign, props, propSign } = kits
  const L = track.length
  const r = mulberry(track.def.seed * 31 + 5)

  // ---------------------------------------------------------------- start gantry (s = -3)
  {
    const s = -3
    const i = track.idx(s)
    const wl = track.L.wall[i] + 1.0,
      wr = track.R.wall[i] + 1.0
    // local z across the track (+left), +x towards the oncoming cars
    const m = frameDir(track, s, 0, 0, 1)
    // the frame's +x is Y x Z: with Z = left, X = -forward: towards the oncoming cars
    for (const k of [arch, sign]) k.setFrame(m)
    lattice(arch, 0, wl, 9.6, 1.1)
    lattice(arch, 0, -wr, 9.6, 1.1)
    // box truss over the track
    const y0 = 7.5,
      y1 = 8.9,
      hx = 0.55
    for (const [cx, cy] of [
      [-hx, y0],
      [hx, y0],
      [-hx, y1],
      [hx, y1],
    ])
      arch.beam(V(cx, cy, -wr), V(cx, cy, wl), 0.16, 0.16, S.gantry, new THREE.Vector3(0, 1, 0))
    for (let z = -wr; z <= wl + 1e-3; z += 1.4) {
      for (const cx of [-hx, hx]) arch.beam(V(cx, y0, z), V(cx, y1, z), 0.08, 0.08, S.gantry, Z_UP)
      arch.beam(V(-hx, y1, z), V(hx, y1, z), 0.08, 0.08, S.gantry, Z_UP)
      if (z + 1.4 <= wl) for (const cx of [-hx, hx]) arch.beam(V(cx, y0, z), V(cx, y1, z + 1.4), 0.06, 0.06, S.gantry, new THREE.Vector3(1, 0, 0))
    }
    // the light panel and its lamps (instanced elsewhere), sponsor banners on top
    arch.box(-0.3, 6.5, -2.9, 0.3, 7.5, 2.9, S.black)
    arch.box(-0.12, 8.9, -9.2, 0.12, 10.5, 9.2, S.gantry, 0b001100)
    for (const face of [1, -1] as const) {
      signQuad(sign, face * 0.13, 9.7, -4.6, 9, 1.5, slotUV(SLOT.speed), { facing: face, axis: 'z', emission: 0.25 })
      signQuad(sign, face * 0.13, 9.7, 4.6, 9, 1.5, slotUV(SLOT.bridge), { facing: face, axis: 'z', emission: 0.25 })
    }
  }

  // ---------------------------------------------------------------- bridge over the straight (s = 300)
  {
    const s = 300
    const i = track.idx(s)
    const wl = track.L.wall[i] + 3,
      wr = track.R.wall[i] + 3
    const m = frameDir(track, s, (wl - wr) / 2, 0, 1)
    for (const k of [arch, sign]) k.setFrame(m)
    const half = (wl + wr) / 2
    const yd = 6.6
    arch.box(-2.2, yd, -half - 1, 2.2, yd + 1.4, half + 1, S.white)
    // piers
    for (const z of [-half, half]) {
      arch.box(-1.8, -0.5, z - 1.4, 1.8, yd, z + 1.4, S.concrete, 0b110111)
      // stair tower beside each pier
      arch.box(-1.6, -0.5, z + (z > 0 ? 1.4 : -4.4), 1.6, yd + 4.2, z + (z > 0 ? 4.4 : -1.4), S.white, 0b111111)
    }
    // walkway: railings, a canopy on posts
    for (const x of [-2.1, 2.1]) {
      arch.beam(V(x, yd + 2.6, -half), V(x, yd + 2.6, half), 0.06, 0.08, S.galv, new THREE.Vector3(0, 1, 0))
      for (let z = -half; z <= half + 1e-3; z += 3) arch.box(x - 0.05, yd + 1.4, z - 0.05, x + 0.05, yd + 3.9, z + 0.05, S.galv, 0b110111)
    }
    arch.box(-2.6, yd + 3.9, -half - 1, 2.6, yd + 4.2, half + 1, S.white)
    // the sponsor faces
    const n = Math.floor((half * 2 + 2) / 5.4)
    for (const face of [1, -1] as const)
      for (let q = 0; q < n; q++) {
        const z = -((n - 1) * 5.4) / 2 + q * 5.4
        signQuad(sign, face * 2.21, yd + 0.7, z, 5.2, 1.3, slotUV(q === Math.floor(n / 2) ? SLOT.bridge : SPONSORS[(q * 3 + (face > 0 ? 0 : 5)) % SPONSORS.length]), { facing: face, axis: 'z', emission: 0.2 })
      }
  }

  // ---------------------------------------------------------------- billboards on scaffolding
  let bi = 0
  for (let s = 120; s < L - 60; s += 150) {
    const i = track.idx(s)
    if (track.speed[i] < 40) continue
    const side = (Math.floor(s / 150) % 2) * 2 - 1
    const Sd = side > 0 ? track.L : track.R
    const off = side * (Sd.wall[i] + 4)
    // facing the track, turned 25 degrees towards the oncoming cars
    const a = (25 * Math.PI) / 180
    const m = frameDir(track, s, off, -Math.sin(a), -side * Math.cos(a))
    for (const k of [arch, sign]) k.setFrame(m)
    for (const x of [-4.5, 4.5]) {
      arch.box(x - 0.12, 0, -0.5, x + 0.12, 4.0, -0.26, S.galv, 0b110111)
      arch.beam(V(x, 0, -2.2), V(x, 3.4, -0.4), 0.08, 0.08, S.galv, Z_UP)
    }
    arch.box(-6.1, 0.9, -0.25, 6.1, 4.1, -0.1, S.board, 0b111111)
    signQuad(sign, 0, 2.5, -0.09, 12, 3, slotUV(SPONSORS[bi++ % SPONSORS.length]))
    signQuad(sign, 0, 2.5, -0.26, 12, 3, slotUV(SPONSORS[(bi + 4) % SPONSORS.length]), { facing: -1 })
  }

  // ---------------------------------------------------------------- braking boards (300/200/100 m)
  const sp = track.speed
  const n = track.n
  for (let i = 0; i < n; i++) {
    const v = sp[i]
    if (v > sp[(i - 1 + n) % n] || v > sp[(i + 1) % n]) continue
    let vmax = 0
    for (let k = 1; k < 400; k++) vmax = Math.max(vmax, sp[(i - k + n) % n])
    if (vmax - v < 18) continue
    let b = i
    for (let k = 1; k < 400; k++) {
      const j = (i - k + n) % n
      if (sp[j] >= vmax - 1) {
        b = j
        break
      }
    }
    const turnSide = track.curv[i] > 0 ? 1 : -1
    const side = -turnSide
    for (let k = 1; k <= 3; k++) {
      const s = b * DS - (k - 1) * 100 + 30
      const ii = track.idx(s)
      const Sd = side > 0 ? track.L : track.R
      // facing the oncoming cars
      const m = frameDir(track, s, side * (track.hw[ii] + Sd.kerb[ii] + 2.2), -1, 0)
      for (const kk of [props, propSign]) kk.setFrame(m)
      props.box(-0.05, 0, -0.08, 0.05, 0.4, 0.0, S.galv, 0b110111)
      props.box(-0.47, 0.35, -0.06, 0.47, 1.95, -0.01, S.board, 0b111111)
      const tile = 3 - k
      signQuad(propSign, 0, 1.15, 0.0, 0.9, 1.6, slotUV(SLOT.brake, tile * 341, (tile + 1) * 341))
    }
    i += 200
  }

  // ---------------------------------------------------------------- marshal posts
  for (let s = 200; s < L; s += 420) {
    const i = track.idx(s)
    const side = track.curv[i] > 0 ? -1 : 1
    const Sd = side > 0 ? track.L : track.R
    const m = frameDir(track, s, side * (Sd.wall[i] + 2.4), 0, -side)
    props.setFrame(m)
    props.box(-1.5, -0.3, -1.3, 1.5, 0.5, 1.3, S.concrete, 0b111111)
    props.box(-1.1, 0.5, -1.0, 1.1, 2.7, 1.0, S.white, 0b110111)
    props.box(-1.0, 1.5, 1.0, 1.0, 2.4, 1.02, S.dark, 0b010000)
    props.box(-1.35, 2.7, -1.25, 1.35, 2.88, 1.45, S.orange)
    // signal light panel on a pole
    props.box(1.25, 0.5, 0.8, 1.33, 3.6, 0.88, S.galv, 0b110111)
    props.box(1.0, 3.6, 0.82, 1.6, 4.2, 0.95, S.black)
  }

  // ---------------------------------------------------------------- floodlight masts and TV towers
  const mast = (s: number, d: number) => {
    const m = frameDir(track, s, d, 0, d > 0 ? -1 : 1)
    arch.setFrame(m)
    arch.cylinderY(0, 0, -0.5, 34, 0.42, 10, S.galv)
    arch.cylinderY(0, 0, -0.5, 2.0, 0.9, 10, S.concrete)
    // lamp head tilted towards the track
    const head = new THREE.Matrix4().makeTranslation(0, 33, 0.6).multiply(new THREE.Matrix4().makeRotationX(0.45))
    arch.setFrame(m.clone().multiply(head))
    arch.box(-3.4, -1.6, -0.3, 3.4, 1.6, 0.1, S.gantry)
    for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) arch.box(-2.9 + a * 1.93 - 0.4, -1.2 + b * 1.2 - 0.38, 0.1, -2.9 + a * 1.93 + 0.4, -1.2 + b * 1.2 + 0.38, 0.32, S.lamp, 0b010111)
  }
  for (const s of [-290, -60, 170]) mast(s, -(track.R.wall[track.idx(s)] + 30))
  for (const s of [-180, 60]) mast(s, track.L.wall[track.idx(s)] + 52)
  const tvTower = (s: number, d: number) => {
    const m = frameDir(track, s, d, 0, d > 0 ? -1 : 1)
    props.setFrame(m)
    lattice(props, 0, 0, 8, 1.8, S.galv)
    props.box(-1.4, 8, -1.4, 1.4, 8.2, 1.4, S.galv)
    props.box(-1.5, 10.6, -1.5, 1.5, 10.8, 1.5, S.white)
    for (const [a, b] of [
      [-1.4, -1.4],
      [1.4, -1.4],
      [1.4, 1.4],
      [-1.4, 1.4],
    ])
      props.box(a - 0.04, 8.2, b - 0.04, a + 0.04, 10.6, b + 0.04, S.galv, 0b110111)
    // the camera and its operator
    props.box(-0.25, 8.2, 0.2, 0.25, 9.3, 0.6, S.black)
    props.box(-0.3, 9.3, 0.0, 0.3, 9.7, 1.0, S.dark)
  }
  tvTower(150, -(track.R.wall[track.idx(150)] + 3.5))
  tvTower(-330, track.L.wall[track.idx(-330)] + 4)
  for (let s = 900; s < L - 500; s += 1100) {
    const i = track.idx(s)
    const side = track.curv[i] > 0 ? -1 : 1
    tvTower(s, side * ((side > 0 ? track.L : track.R).wall[i] + 6))
  }

  // ---------------------------------------------------------------- big screen opposite the pits
  {
    const s = -220
    const d = -(track.R.wall[track.idx(s)] + 10)
    const a = (20 * Math.PI) / 180
    const m = frameDir(track, s, d, -Math.sin(a), Math.cos(a))
    for (const k of [arch, sign]) k.setFrame(m)
    for (const x of [-3, 3]) arch.box(x - 0.3, -0.5, -0.8, x + 0.3, 6, -0.3, S.galv, 0b110111)
    arch.box(-5.3, 5.5, -0.6, 5.3, 11.6, -0.05, S.screenFrame)
    signQuad(sign, 0, 8.55, -0.04, 10, 5.6, slotUV(SLOT.screen), { emission: 2.2, gloss: 1 })
  }

  // ---------------------------------------------------------------- team stations on the pit wall
  {
    const lane = pitLane(track)
    for (const bs of lane.boxS) {
      const i = track.idx(bs)
      const m = frameDir(track, bs, track.L.wall[i] + 1.6, 0, -1)
      props.setFrame(m)
      // facing the track (+z): roof, posts, desk and monitors
      props.box(-2.2, 2.6, -1.0, 2.2, 2.75, 1.0, S.white)
      for (const x of [-2.0, 2.0]) props.box(x - 0.05, 0, -0.85, x + 0.05, 2.6, -0.75, S.galv, 0b110111)
      props.box(-1.8, 0.9, -0.2, 1.8, 1.0, 0.5, S.dark)
      for (const x of [-1.2, 0, 1.2]) props.box(x - 0.45, 1.6, 0.35, x + 0.45, 2.1, 0.42, S.black, 0b010111)
    }
  }

  // ---------------------------------------------------------------- sponsor boards on the walls of the straight
  for (const side of [1, -1] as const) {
    const Sd = side > 0 ? track.L : track.R
    let q = Math.floor(r() * SPONSORS.length)
    for (let s = -370; s < 410; s += 2.7) {
      const i = track.idx(s)
      if (side > 0 && inPitGap(track, s)) continue
      if (Sd.outer[i] === Surface.Gravel) continue
      const m = frameDir(track, s + 1.3, side * (Sd.wall[i] - 0.255), 0, -side)
      propSign.setFrame(m)
      signQuad(propSign, 0, 0.36, 0, 2.6, 0.62, slotUV(SPONSORS[q++ % SPONSORS.length]))
    }
  }
}

export { S as propSurfaces }
