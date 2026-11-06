// Modern grandstands: a front parapet carrying sponsor hoardings, stepped concrete terraces with
// coloured bucket seats in blocks between aisles (with their half steps and handrails), railings,
// closed ends, a clad back wall, and a cantilevered roof on steel trusses (top and bottom chords
// with diagonals, purlins, ribbed sheeting) with a sponsor fascia along its front edge. Returns the
// seats' spectator spots for the crowd.
import * as THREE from 'three/webgpu'
import { Kit, lin, Pat, surf } from './kit'
import { SPONSORS, SLOT, signQuad, slotUV } from './signage'
import type { Spectator } from './crowd'
import { mulberry } from './noise'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

const S = {
  concrete: surf(lin(0xa29f98), 0.88, { p: Pat.Concrete }),
  concreteDark: surf(lin(0x7d7a74), 0.9, { p: Pat.Concrete, ao: 0.8 }),
  riser: surf(lin(0x8e8b85), 0.9, { p: Pat.Concrete, ao: 0.85 }),
  steel: surf(lin(0xd8dadb), 0.45, { m: 0.7, p: Pat.Steel }),
  steelDark: surf(lin(0x2f3236), 0.45, { m: 0.6, p: Pat.Steel }),
  rail: surf(lin(0xc0c4c8), 0.35, { m: 0.9 }),
  roof: surf(lin(0x9a9ea2), 0.55, { p: Pat.Ribbed, m: 0.5 }),
  roofUnder: surf(lin(0xdcdedf), 0.6, { p: Pat.Ribbed, ao: 0.7 }),
  clad: surf(lin(0x5b6168), 0.5, { p: Pat.Cladding }),
  dark: surf(lin(0x1d1f22), 0.5, { ao: 0.5 }),
}

export interface StandOpts {
  length: number
  rows: number
  /** seat colours: main and accent (every accentEvery-th block) */
  seat: number
  accent: number
  seed: number
  /** share of seats taken */
  occupancy: number
  /** sponsor slots for the parapet hoardings */
  hoardings?: number[]
}

const RISE = 0.42,
  DEPTH = 0.8,
  H0 = 1.7

/** Builds a stand in the kits' current frames (local +z towards the track, front edge at z = 0). */
export function buildGrandstand(o: StandOpts, kits: { arch: Kit; seats: Kit; sign: Kit }, toWorld: THREE.Matrix4): Spectator[] {
  const { arch, seats, sign } = kits
  const r = mulberry(o.seed)
  const L = o.length,
    R = o.rows
  const x0 = -L / 2,
    x1 = L / 2
  const yTop = (k: number) => H0 + k * RISE
  const zBack = -R * DEPTH
  // ---------------------------------------------------------------- parapet and hoardings
  arch.box(x0, 0, 0, x1, yTop(0) + 0.95, 0.35, S.concrete, 0b010111)
  const hs = o.hoardings ?? SPONSORS
  const bw = 6
  let hi = Math.floor(r() * hs.length)
  for (let x = x0 + 0.3; x + bw <= x1 - 0.3 + 1e-3; x += bw + 0.1) signQuad(sign, x + bw / 2, 1.05, 0.36, bw, 1.5, slotUV(hs[hi++ % hs.length]))
  // front railing on the parapet
  for (let x = x0; x <= x1 + 1e-3; x += 2) arch.box(x - 0.03, yTop(0) + 0.95, 0.12, x + 0.03, yTop(0) + 1.75, 0.18, S.rail, 0b110111)
  arch.beam(V(x0, yTop(0) + 1.75, 0.15), V(x1, yTop(0) + 1.75, 0.15), 0.06, 0.06, S.rail)
  arch.beam(V(x0, yTop(0) + 1.35, 0.15), V(x1, yTop(0) + 1.35, 0.15), 0.03, 0.03, S.rail)
  // ---------------------------------------------------------------- terraces
  for (let k = 0; k < R; k++) {
    const zf = -k * DEPTH,
      zb = -(k + 1) * DEPTH
    const y = yTop(k)
    arch.quad(V(x0, y, zf), V(x1, y, zf), V(x1, y, zb), V(x0, y, zb), S.concrete)
    if (k > 0) arch.quad(V(x0, yTop(k - 1), zf), V(x1, yTop(k - 1), zf), V(x1, y, zf), V(x0, y, zf), S.riser)
    // closed ends
    arch.quad(V(x1, 0, zf), V(x1, 0, zb), V(x1, y, zb), V(x1, y, zf), S.concreteDark)
    arch.quad(V(x0, 0, zb), V(x0, 0, zf), V(x0, y, zf), V(x0, y, zb), S.concreteDark)
  }
  // ---------------------------------------------------------------- back wall up to the roof
  const yRoof = yTop(R - 1) + 5.2
  arch.quad(V(x0, yTop(R - 1), zBack), V(x1, yTop(R - 1), zBack), V(x1, yRoof, zBack), V(x0, yRoof, zBack), S.clad)
  arch.quad(V(x1, 0, zBack - 0.3), V(x0, 0, zBack - 0.3), V(x0, yRoof + 0.6, zBack - 0.3), V(x1, yRoof + 0.6, zBack - 0.3), S.clad)
  // ends above the terraces
  for (const [x, sgn] of [
    [x0, -1],
    [x1, 1],
  ] as const) {
    const f = sgn > 0 ? 0b000001 : 0b000010
    arch.box(x - (sgn < 0 ? 0.3 : 0), yTop(R - 1), zBack - 0.3, x + (sgn > 0 ? 0.3 : 0), yRoof, zBack + 2.4, S.concreteDark, f)
  }
  // big sponsor panels on the end walls, framed
  {
    const w = Math.min(R * DEPTH * 0.8, 14),
      h = w / 4
    const zc = zBack * 0.55,
      yc = Math.max(h / 2 + 0.8, yTop(Math.floor(R * 0.45)) - h / 2)
    for (const [x, f] of [
      [x1 + 0.02, 1],
      [x0 - 0.02, -1],
    ] as const) {
      arch.box(x - (f < 0 ? 0.15 : 0), yc - h / 2 - 0.15, zc - w / 2 - 0.15, x + (f > 0 ? 0.15 : 0), yc + h / 2 + 0.15, zc + w / 2 + 0.15, S.steelDark, f > 0 ? 0b000001 : 0b000010)
      signQuad(sign, x + f * 0.17, yc, zc, w, h, slotUV(SPONSORS[(o.seed + (f > 0 ? 2 : 7)) % SPONSORS.length]), { facing: f, axis: 'z', emission: 0.1 })
    }
  }
  // ---------------------------------------------------------------- seats, aisles, crowd
  const spots: Spectator[] = []
  const seatW = 0.5
  const block = 16
  const aisleW = 1.2
  const pitch = block * seatW + aisleW
  const blocks = Math.floor((L - 1) / pitch)
  const start = -(blocks * pitch - aisleW) / 2
  const main = surf(lin(o.seat), 0.45, { p: Pat.Plastic }),
    acc = surf(lin(o.accent), 0.45, { p: Pat.Plastic })
  const P = new THREE.Vector3()
  for (let b = 0; b < blocks; b++) {
    const bx = start + b * pitch
    for (let k = 0; k < R; k++) {
      const zf = -k * DEPTH
      const y = yTop(k)
      for (let q = 0; q < block; q++) {
        const sx = bx + q * seatW + seatW / 2
        // the accent colour draws a band across the stand
        const sf = k === R - 3 || k === 3 || (b % 3 === 1 && q < 2) ? acc : main
        const hx = 0.21
        // seat pan and backrest (bucket seat seen from the front)
        seats.quad(V(sx - hx, y + 0.42, zf - 0.2), V(sx + hx, y + 0.42, zf - 0.2), V(sx + hx, y + 0.44, zf - 0.56), V(sx - hx, y + 0.44, zf - 0.56), sf)
        seats.quad(V(sx - hx, y + 0.44, zf - 0.58), V(sx + hx, y + 0.44, zf - 0.58), V(sx + hx * 0.95, y + 0.86, zf - 0.68), V(sx - hx * 0.95, y + 0.86, zf - 0.68), sf)
        if (r() < o.occupancy) {
          P.set(sx + (r() - 0.5) * 0.06, y + 0.3, zf - 0.52).applyMatrix4(toWorld)
          spots.push({ x: P.x, y: P.y, z: P.z })
        }
      }
    }
    // aisle after the block: half steps and a handrail
    const ax = bx + block * seatW + aisleW / 2
    if (b < blocks - 1) {
      for (let k = 1; k < R; k++) {
        const zf = -k * DEPTH
        arch.box(ax - aisleW / 2 + 0.05, yTop(k - 1), zf + DEPTH * 0.5, ax + aisleW / 2 - 0.05, yTop(k - 1) + RISE / 2, zf, S.concrete, 0b010100)
      }
      arch.beam(V(ax, yTop(0) + 0.95, -0.2), V(ax, yTop(R - 1) + 0.95, zBack + 0.4), 0.05, 0.05, S.rail)
      for (let k = 0; k < R; k += 4) arch.box(ax - 0.025, yTop(k), -k * DEPTH - 0.45, ax + 0.025, yTop(k) + 0.95, -k * DEPTH - 0.4, S.rail, 0b110111)
    }
  }
  // entrances (vomitories) half way up, in some aisles' blocks
  for (let b = 1; b < blocks; b += 3) {
    const vx = start + b * pitch + (block * seatW) / 2
    const k = Math.floor(R * 0.55)
    arch.box(vx - 1.2, yTop(k) - 0.02, -k * DEPTH - DEPTH, vx + 1.2, yTop(k) + 0.01, -k * DEPTH, S.dark, 0b000100)
  }
  // ---------------------------------------------------------------- roof
  const zFront = 1.2
  const yFrontTop = yRoof + 2.6,
    yBackTop = yRoof + 1.6
  const yBackBot = yRoof - 0.6,
    yFrontBot = yFrontTop - 0.5
  const topAt = (z: number) => yBackTop + ((z - (zBack - 0.6)) / (zFront - (zBack - 0.6))) * (yFrontTop - yBackTop)
  const botAt = (z: number) => yBackBot + ((z - (zBack - 0.6)) / (zFront - (zBack - 0.6))) * (yFrontBot - yBackBot)
  const zb0 = zBack - 0.6
  const span = 15
  const nTruss = Math.max(2, Math.round(L / span) + 1)
  for (let t = 0; t < nTruss; t++) {
    const x = x0 + 0.6 + ((L - 1.2) * t) / (nTruss - 1)
    // column
    arch.box(x - 0.25, 0, zb0 - 0.25, x + 0.25, yBackTop, zb0 + 0.25, S.steel)
    // chords
    arch.beam(V(x, yBackTop, zb0), V(x, yFrontTop, zFront), 0.3, 0.35, S.steel)
    arch.beam(V(x, yBackBot, zb0), V(x, yFrontBot, zFront), 0.25, 0.3, S.steel)
    // diagonals (warren truss)
    const nd = 9
    for (let q = 0; q < nd; q++) {
      const za = zb0 + ((zFront - zb0) * q) / nd,
        zc = zb0 + ((zFront - zb0) * (q + 1)) / nd
      const up = q % 2 === 0
      arch.beam(V(x, up ? botAt(za) : topAt(za), za), V(x, up ? topAt(zc) : botAt(zc), zc), 0.12, 0.12, S.steel)
    }
    // back stay
    arch.beam(V(x, yBackTop, zb0), V(x, 0.5, zb0 - 6), 0.2, 0.2, S.steel)
  }
  // purlins
  for (let q = 0; q <= 6; q++) {
    const z = zb0 + ((zFront - zb0) * q) / 6
    arch.beam(V(x0, topAt(z) + 0.25, z), V(x1, topAt(z) + 0.25, z), 0.15, 0.2, S.steelDark)
  }
  // sheeting (ribbed on top, lighter underneath)
  const rt = 0.36
  arch.quad(V(x0 - 0.5, topAt(zb0) + rt, zb0 - 0.3), V(x0 - 0.5, topAt(zFront) + rt, zFront + 0.3), V(x1 + 0.5, topAt(zFront) + rt, zFront + 0.3), V(x1 + 0.5, topAt(zb0) + rt, zb0 - 0.3), S.roof)
  arch.quad(V(x0 - 0.5, topAt(zb0) + rt - 0.02, zb0 - 0.3), V(x1 + 0.5, topAt(zb0) + rt - 0.02, zb0 - 0.3), V(x1 + 0.5, topAt(zFront) + rt - 0.02, zFront + 0.3), V(x0 - 0.5, topAt(zFront) + rt - 0.02, zFront + 0.3), S.roofUnder)
  // fascia with sponsors along the front edge
  const yf = topAt(zFront) + rt
  arch.box(x0 - 0.5, yf - 1.3, zFront + 0.3, x1 + 0.5, yf + 0.1, zFront + 0.5, S.steelDark, 0b011111)
  const fw = 6.4
  const nf = Math.floor((L + 1) / (fw + 0.2))
  const fs = -(nf * (fw + 0.2) - 0.2) / 2
  for (let q = 0; q < nf; q++) signQuad(sign, fs + q * (fw + 0.2) + fw / 2, yf - 0.6, zFront + 0.51, fw, 1.2, slotUV(q % 3 === 1 ? SLOT.fascia : SPONSORS[(q * 3 + o.seed) % SPONSORS.length]), { emission: 0.15 })
  return spots
}

export { S as standSurfaces }
