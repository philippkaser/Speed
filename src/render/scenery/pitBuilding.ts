// The pit building: 27 garage bays along the pit lane (one per 11 m, the team boxes centred on theirs),
// each with a lit interior (epoxy floor, white walls with a team-colour band, tool cabinets, tyre
// racks, monitors, ceiling light strips) and some with the roller door part or fully down; above them
// a glazed hospitality floor whose curtain wall leans out over a canopy and balustrade, a second glazed
// floor set back behind a terrace, and a deep roof cantilevered 7 m out over the pit lane on steel
// fins, its fascia an LED sponsor band. Race control stands on the roof at the start line.
//
// Built bay by bay, each in the track's own frame at its s, so the building follows the straight.
import * as THREE from 'three/webgpu'
import type { Track } from '../../track/track'
import { pitLane } from '../../track/pitlane'
import { Kit, lin, Pat, surf, trackFrame, type Surf } from './kit'
import { SLOT, signQuad, slotUV } from './signage'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
/** up vector for vertical members: their width runs along x, their depth along z */
const Z_UP = new THREE.Vector3(0, 0, 1)

const S = {
  white: surf(lin(0xd9dbdc), 0.45, { p: Pat.Cladding }),
  grey: surf(lin(0x8a8e92), 0.5, { p: Pat.Cladding }),
  dark: surf(lin(0x2a2d31), 0.42, { p: Pat.Cladding, m: 0.3 }),
  concrete: surf(lin(0x9a9893), 0.85, { p: Pat.Concrete }),
  alu: surf(lin(0xb9bec3), 0.32, { m: 0.9 }),
  steel: surf(lin(0x3b3f44), 0.45, { m: 0.6, p: Pat.Steel }),
  soffit: surf(lin(0xc4c6c7), 0.6, { p: Pat.Cladding, ao: 0.8 }),
  roofTop: surf(lin(0x6e7275), 0.6, { p: Pat.Ribbed, m: 0.4 }),
  downlight: surf([1, 0.96, 0.88], 0.3, { e: 3.5 }),
  // garage interiors: lit (emission) and kept out of the sky light (ao)
  gFloor: surf(lin(0x55585c), 0.32, { p: Pat.Floor, e: 0.35, ao: 0.35 }),
  gWall: surf(lin(0xe4e4e0), 0.6, { e: 0.32, ao: 0.4 }),
  gCeil: surf(lin(0xb0b2b4), 0.7, { e: 0.22, ao: 0.3 }),
  gLight: surf([1, 0.98, 0.94], 0.3, { e: 4.5 }),
  rubber: surf(lin(0x161616), 0.75, { e: 0.08, ao: 0.6 }),
  door: surf(lin(0xb4b8bb), 0.45, { p: Pat.Ribbed, m: 0.5 }),
  screen: surf(lin(0x2a6fd6), 0.2, { e: 1.2 }),
  windowDark: surf(lin(0x1a2128), 0.12, { m: 0.5 }),
}

const TEAM = [0xc8102e, 0x0d47a1, 0xf5b800, 0x1e7a3c, 0xff6a00, 0x6a1b9a, 0x00897b, 0x37474f]
const CAB = [0xb71c1c, 0x1c1c1c, 0x455a64, 0x0d47a1]

export interface PitBuildingParts {
  /** where the garage fronts are (track d), for the pit lane's boards */
  dFront: number
}

/** Local z of the garage fronts is 0; the building goes back to -16 and the roof out to +7. */
export function buildPitBuilding(track: Track, kits: { arch: Kit; glass: Kit; sign: Kit }) {
  const lane = pitLane(track)
  const dFront = lane.dGarage + 0.3
  const { arch, glass, sign } = kits
  const bays: number[] = []
  for (let k = -17; k <= 9; k++) bays.push(-62 + 11 * k)
  const r = mkRng(91)
  const teamBay = new Set(lane.boxS.map((s) => Math.round((s + 62) / 11)))
  bays.forEach((s, j) => {
    const m = trackFrame(track, s, dFront, -1)
    const baseY = m.elements[13]
    arch.setFrame(m)
    glass.setFrame(m)
    sign.setFrame(m)
    const first = j === 0,
      last = j === bays.length - 1
    const k = Math.round((s + 62) / 11)
    const isTeam = teamBay.has(k)
    // ---------------------------------------------------------------- ground floor: garage
    for (const px of first ? [-5.5, 5.5] : [5.5]) arch.box(px - 0.7, -0.6, -0.8, px + 0.7, 5.2, 0, S.white, 0b110111)
    // apron between the lane and the garages
    arch.box(-5.5, -0.3, 0, 5.5, 0.04, 0.6, S.concrete, 0b010100)
    // lintel (the team boards hang on it)
    arch.box(-4.8, 4.4, -0.5, 4.8, 5.2, 0, S.dark, 0b011000)
    // interior
    const team = surf(lin(TEAM[(k * 5 + 3) % TEAM.length], 0.8), 0.5, { e: 0.3, ao: 0.4 })
    arch.quad(V(-4.8, 0.02, 0), V(4.8, 0.02, 0), V(4.8, 0.02, -12), V(-4.8, 0.02, -12), S.gFloor)
    arch.quad(V(-4.8, 0, -12), V(4.8, 0, -12), V(4.8, 4.4, -12), V(-4.8, 4.4, -12), S.gWall)
    arch.quad(V(-4.8, 1.3, -11.98), V(4.8, 1.3, -11.98), V(4.8, 2.3, -11.98), V(-4.8, 2.3, -11.98), team)
    arch.quad(V(-4.8, 0, 0), V(-4.8, 0, -12), V(-4.8, 4.4, -12), V(-4.8, 4.4, 0), S.gWall)
    arch.quad(V(4.8, 0, -12), V(4.8, 0, 0), V(4.8, 4.4, 0), V(4.8, 4.4, -12), S.gWall)
    arch.quad(V(-4.8, 4.4, -12), V(4.8, 4.4, -12), V(4.8, 4.4, 0), V(-4.8, 4.4, 0), S.gCeil)
    for (const lx of [-2.6, 0, 2.6]) arch.quad(V(lx - 0.15, 4.38, -11), V(lx + 0.15, 4.38, -11), V(lx + 0.15, 4.38, -1), V(lx - 0.15, 4.38, -1), S.gLight)
    // cabinets along the back wall, tyre racks at the side, a monitor gantry
    const cab = surf(lin(CAB[(k * 7) % CAB.length], 0.85), 0.4, { m: 0.4, e: 0.15, ao: 0.5 })
    arch.box(-3.8, 0, -11.98, 1.5, 1.05, -11.3, cab, 0b010111)
    arch.box(-3.8, 1.05, -11.98, 1.5, 1.1, -11.25, S.steel, 0b010111)
    if (r() < 0.8)
      for (let t = 0; t < 2; t++) {
        const tz = -9.2 + t * 0.9
        arch.cylinderY(3.9, tz, 0, 1.3, 0.33, 10, S.rubber)
      }
    arch.box(-1.5, 3.0, -6.2, 1.5, 3.6, -6.0, S.steel, 0b111111)
    arch.quad(V(-1.4, 3.05, -5.99), V(1.4, 3.05, -5.99), V(1.4, 3.55, -5.99), V(-1.4, 3.55, -5.99), S.screen)
    // roller doors: team garages open, some others half down, a few closed
    const doorR = r()
    const doorY = isTeam ? 4.4 : doorR < 0.35 ? 4.4 : doorR < 0.75 ? 2.2 + r() * 1.8 : 0
    if (doorY < 4.39) arch.box(-4.8, doorY, -0.42, 4.8, 4.4, -0.3, S.door, 0b011100)
    // ---------------------------------------------------------------- level 1: hospitality
    arch.box(-5.5, 5.2, -16, 5.5, 5.75, 3.0, S.white, 0b011100)
    for (const lx of [-3, 0, 3]) arch.quad(V(lx - 0.2, 5.19, 1.6), V(lx + 0.2, 5.19, 1.6), V(lx + 0.2, 5.19, 2.0), V(lx - 0.2, 5.19, 2.0), S.downlight)
    balustrade(arch, -5.5, 5.5, 5.75, 2.85)
    // curtain wall leaning out
    roomFace(glass, V(-5.5, 5.75, 0.6), V(5.5, 5.75, 0.6), V(5.5, 9.0, 1.3), V(-5.5, 9.0, 1.3), baseY + 5.75, baseY + 9.0, 9, 0.3)
    for (let q = 0; q <= 8; q++) {
      const x = -5.5 + q * 1.375
      arch.beam(V(x, 5.75, 0.66), V(x, 9.0, 1.36), 0.07, 0.14, S.alu, Z_UP)
    }
    arch.beam(V(-5.5, 7.05, 0.95), V(5.5, 7.05, 0.95), 0.08, 0.1, S.alu)
    // ---------------------------------------------------------------- level 2
    arch.box(-5.5, 9.0, -16, 5.5, 9.5, 1.6, S.white, 0b011100)
    balustrade(arch, -5.5, 5.5, 9.5, 1.45)
    roomFace(glass, V(-5.5, 9.5, -1.5), V(5.5, 9.5, -1.5), V(5.5, 12.4, -1.5), V(-5.5, 12.4, -1.5), baseY + 9.5, baseY + 12.4, 8, 0.7)
    for (let q = 0; q <= 4; q++) arch.beam(V(-5.5 + q * 2.75, 9.5, -1.45), V(-5.5 + q * 2.75, 12.4, -1.45), 0.08, 0.16, S.alu, Z_UP)
    // ---------------------------------------------------------------- roof, cantilevered over the lane
    arch.box(-5.5, 12.4, -16, 5.5, 13.1, 6.8, S.soffit, 0b001000)
    arch.box(-5.5, 12.4, -16, 5.5, 13.1, 6.8, S.roofTop, 0b000100)
    for (let q = 0; q < 4; q++) {
      const lx = -4.1 + q * 2.75
      arch.quad(V(lx - 0.12, 12.39, 4.2), V(lx + 0.12, 12.39, 4.2), V(lx + 0.12, 12.39, 4.44), V(lx - 0.12, 12.39, 4.44), S.downlight)
    }
    // fascia: a deep nose with the LED band
    arch.box(-5.5, 12.0, 6.8, 5.5, 13.7, 7.3, S.dark, 0b011100)
    for (const half of [-1, 1]) signQuad(sign, half * 2.75, 12.85, 7.32, 5.4, 1.36, slotUV(SLOT.led), { emission: 1.6, gloss: 1 })
    // steel fins carrying the cantilever
    arch.beam(V(-5.5, 9.5, -1.4), V(-5.5, 12.4, 6.6), 0.25, 0.55, S.steel)
    // rooftop plant on some bays
    if (r() < 0.35) arch.box(-2 - r() * 2, 13.1, -12, 1 + r() * 2, 14.6, -8.5, S.grey, 0b110111)
    // ---------------------------------------------------------------- rear facade (paddock side)
    arch.quad(V(5.5, -0.5, -16), V(-5.5, -0.5, -16), V(-5.5, 13.1, -16), V(5.5, 13.1, -16), S.grey)
    for (const wy of [6.4, 10.3]) arch.quad(V(5.0, wy, -16.02), V(-5.0, wy, -16.02), V(-5.0, wy + 1.6, -16.02), V(5.0, wy + 1.6, -16.02), S.windowDark)
    // ends of the building
    if (first || last) {
      const ex = first ? -5.5 : 5.5
      const f = first ? 0b000010 : 0b000001
      arch.box(ex - (first ? 0.3 : 0), -0.5, -16, ex + (first ? 0 : 0.3), 13.1, 0, S.white, f)
      arch.box(ex - (first ? 0.3 : 0), 5.2, 0, ex + (first ? 0 : 0.3), 9.0, 3.0, S.white, f)
    }
  })

  // ---------------------------------------------------------------- race control at the start line
  {
    const m = trackFrame(track, -6, dFront, -1)
    const baseY = m.elements[13]
    arch.setFrame(m)
    glass.setFrame(m)
    sign.setFrame(m)
    arch.box(-11, 13.1, -13, 11, 18, 1, S.white, 0b110111)
    signQuad(sign, 0, 15.6, 1.02, 14, 3.5, slotUV(SLOT.speed), { emission: 0.0 })
    // the control room: glazed all round, leaning out at the front
    roomFace(glass, V(-11, 18, 1), V(11, 18, 1), V(11, 22.5, 2.2), V(-11, 22.5, 2.2), baseY + 18, baseY + 22.5, 10, 0.1)
    roomFace(glass, V(11, 18, 1), V(11, 18, -13), V(11, 22.5, -13), V(11, 22.5, 2.2), baseY + 18, baseY + 22.5, 10, 0.5)
    roomFace(glass, V(-11, 18, -13), V(-11, 18, 1), V(-11, 22.5, 2.2), V(-11, 22.5, -13), baseY + 18, baseY + 22.5, 10, 0.9)
    arch.quad(V(11, 18, -13), V(-11, 18, -13), V(-11, 22.5, -13), V(11, 22.5, -13), S.grey)
    for (let q = 0; q <= 16; q++) {
      const x = -11 + q * 1.375
      arch.beam(V(x, 18, 1.06), V(x, 22.5, 2.26), 0.08, 0.14, S.alu, Z_UP)
    }
    arch.box(-12.5, 22.5, -14, 12.5, 23.3, 3.6, S.white, 0b111111)
    arch.box(-12.5, 23.3, 3.2, 12.5, 23.9, 3.6, S.dark, 0b010100)
    arch.cylinderY(6, -6, 23.3, 32, 0.12, 6, S.alu)
    arch.box(-4, 23.3, -10, 2, 24.8, -6, S.grey, 0b110111)
  }
  return { dFront } as PitBuildingParts
}

/** Steel balustrade: posts, a handrail and two cables. */
export function balustrade(k: Kit, x0: number, x1: number, y: number, z: number, h = 1.1) {
  const sf = S.alu
  for (let x = x0; x <= x1 + 1e-3; x += 1.375) k.box(x - 0.03, y, z - 0.03, x + 0.03, y + h, z + 0.03, sf, 0b110111)
  k.beam(V(x0, y + h, z), V(x1, y + h, z), 0.06, 0.08, sf)
  for (const yy of [0.38, 0.72]) k.beam(V(x0, y + yy * h, z), V(x1, y + yy * h, z), 0.02, 0.02, sf)
}

/** A glazed face with its rooms (aRoom: floor and ceiling heights, depth, style). */
export function roomFace(k: Kit, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, floorY: number, ceilY: number, depth: number, style: number) {
  const ex = k.extra.aRoom
  ex.cur[0] = floorY
  ex.cur[1] = ceilY
  ex.cur[2] = depth
  ex.cur[3] = style
  k.quad(a, b, c, d, GLASS)
}
const GLASS: Surf = { c: [0, 0, 0], r: 0.03 }

/** A glass kit (adds the aRoom attribute). */
export function glassKit() {
  const k = new Kit()
  k.defineExtra('aRoom', 4, [0, 3, 6, 0])
  return k
}

function mkRng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
}

export { S as pitSurfaces }
