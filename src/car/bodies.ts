// Parametric body styles expressed as signed distance fields.
// Model space: metres, y up from the ground, z forward from the middle of the wheelbase, x left.
import type { CarSpec } from '../physics/spec'
import { curve, sdBox, sdCylX, sdEllipsoid, sdRoundTrapezoid, type SDF, smax, smin } from './sdf'

export const enum Mat {
  Paint = 0,
  Glass = 1,
  Trim = 2,
  Carbon = 3,
  Headlight = 4,
  Taillight = 5,
  WheelWell = 6,
  Grille = 7,
}
export const MAT_COUNT = 8

export interface WheelPos {
  x: number
  y: number
  z: number
  r: number
  w: number
  front: boolean
}

export interface BodyDef {
  sdf: SDF
  min: [number, number, number]
  max: [number, number, number]
  wheels: WheelPos[]
  classify: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => Mat
  zFront: number
  zRear: number
  beltY: (z: number) => number
  roofY: (z: number) => number
  cabinHalfWidth: (z: number) => number
  style: CarSpec['bodyStyle']
  wing: boolean
  exhausts: [number, number][] // (x, y) at the tail
  driverX: number
  eyeY: number
  eyeZ: number
}

type Keys = [number, number][]

interface StyleParams {
  hwBot: Keys
  hwTop: Keys
  top: Keys
  bottom: Keys
  cabTop: Keys
  cabHw: Keys
  cabZ: [number, number]
  cabBottom: number
  bodyRadius: number
  cabRadius: number
  fenderExtra: number
  fenderX: number
  fenderHalf: number
  fenderBlend: number
  sideIntake?: { y: number; z: number; ry: number; rz: number; depth: number }
  hoodVents: boolean
  wing: boolean
  exhausts: [number, number][]
  headlight: { zMin: number; yMin: number; yMax: number; xMin: number; xMax: number }
  taillight: { zMax: number; yMin: number; yMax: number }
  sideWindow: { zMin: number; zMax: number }
  rearWindow?: { zMin: number; zMax: number; xMax: number }
  driverX: number
  eyeY: number
  eyeZ: number
}

function styleFor(spec: CarSpec): StyleParams {
  if (spec.bodyStyle === 'coupe') {
    return {
      hwBot: [[-2.31, 0.84], [-2.05, 0.93], [-1.39, 0.95], [-0.7, 0.9], [0.2, 0.89], [0.9, 0.9], [1.39, 0.93], [1.95, 0.9], [2.25, 0.78], [2.39, 0.62]],
      hwTop: [[-2.31, 0.78], [-2.0, 0.85], [-1.39, 0.87], [-0.7, 0.84], [0.2, 0.83], [0.9, 0.84], [1.39, 0.85], [1.95, 0.8], [2.25, 0.68], [2.39, 0.5]],
      top: [[-2.31, 0.98], [-2.1, 1.0], [-1.7, 0.96], [-1.2, 0.92], [-0.5, 0.88], [0.3, 0.86], [0.9, 0.83], [1.5, 0.77], [2.0, 0.66], [2.25, 0.55], [2.39, 0.42]],
      bottom: [[-2.31, 0.32], [-2.05, 0.2], [-1.7, 0.14], [1.8, 0.13], [2.2, 0.17], [2.39, 0.24]],
      cabTop: [[0.62, 0.8], [0.4, 0.9], [0.05, 1.12], [-0.35, 1.26], [-0.8, 1.27], [-1.25, 1.18], [-1.7, 1.06], [-2.05, 1.0], [-2.25, 0.99]],
      cabHw: [[0.6, 0.7], [0.2, 0.66], [-0.5, 0.62], [-1.2, 0.62], [-1.8, 0.7], [-2.25, 0.74]],
      cabZ: [-2.28, 0.68],
      cabBottom: 0.66,
      bodyRadius: 0.13,
      cabRadius: 0.12,
      fenderExtra: 0.1,
      fenderX: 0.8,
      fenderHalf: 0.15,
      fenderBlend: 0.26,
      sideIntake: { y: 0.6, z: 0.82, ry: 0.07, rz: 0.2, depth: 0.04 },
      hoodVents: false,
      wing: false,
      exhausts: [
        [0.62, 0.3],
        [0.5, 0.3],
        [-0.5, 0.3],
        [-0.62, 0.3],
      ],
      headlight: { zMin: 1.92, yMin: 0.46, yMax: 0.66, xMin: 0.42, xMax: 0.86 },
      taillight: { zMax: -2.18, yMin: 0.76, yMax: 0.92 },
      sideWindow: { zMin: -1.55, zMax: 0.38 },
      rearWindow: { zMin: -2.15, zMax: -1.25, xMax: 0.55 },
      driverX: 0.38,
      eyeY: 1.08,
      eyeZ: -0.45,
    }
  }
  // gt3 / proto: mid-engine race car
  return {
    hwBot: [[-2.26, 0.88], [-2.0, 0.95], [-1.36, 0.96], [-0.8, 0.92], [0.0, 0.91], [0.8, 0.92], [1.36, 0.95], [1.9, 0.93], [2.2, 0.84], [2.36, 0.72]],
    hwTop: [[-2.26, 0.8], [-1.9, 0.86], [-1.36, 0.88], [-0.8, 0.85], [0.0, 0.84], [0.8, 0.84], [1.36, 0.86], [1.9, 0.8], [2.2, 0.7], [2.36, 0.52]],
    top: [[-2.26, 0.9], [-2.05, 0.95], [-1.6, 0.95], [-1.1, 0.9], [-0.5, 0.83], [0.6, 0.8], [1.0, 0.74], [1.5, 0.66], [2.0, 0.55], [2.25, 0.44], [2.36, 0.33]],
    bottom: [[-2.26, 0.36], [-2.0, 0.17], [-1.6, 0.09], [1.8, 0.09], [2.2, 0.12], [2.36, 0.15]],
    cabTop: [[0.82, 0.74], [0.62, 0.8], [0.35, 0.98], [0.05, 1.13], [-0.3, 1.185], [-0.75, 1.175], [-1.1, 1.09], [-1.5, 1.0], [-1.95, 0.94]],
    cabHw: [[0.75, 0.68], [0.3, 0.64], [-0.4, 0.6], [-1.0, 0.6], [-1.5, 0.66], [-1.95, 0.72]],
    cabZ: [-1.98, 0.86],
    cabBottom: 0.6,
    bodyRadius: 0.12,
    cabRadius: 0.1,
    fenderExtra: 0.12,
    fenderX: 0.82,
    fenderHalf: 0.17,
    fenderBlend: 0.24,
    sideIntake: { y: 0.55, z: -0.72, ry: 0.17, rz: 0.42, depth: 0.12 },
    hoodVents: true,
    wing: true,
    exhausts: [
      [0.14, 0.42],
      [-0.14, 0.42],
    ],
    headlight: { zMin: 1.78, yMin: 0.42, yMax: 0.6, xMin: 0.38, xMax: 0.86 },
    taillight: { zMax: -2.12, yMin: 0.72, yMax: 0.88 },
    sideWindow: { zMin: -0.95, zMax: 0.55 },
    rearWindow: { zMin: -1.75, zMax: -0.95, xMax: 0.42 },
    driverX: 0.36,
    eyeY: 0.98,
    eyeZ: -0.3,
  }
}

export function makeBody(spec: CarSpec): BodyDef {
  const P = styleFor(spec)
  const hwBot = curve(P.hwBot),
    hwTop = curve(P.hwTop),
    top = curve(P.top),
    bottom = curve(P.bottom)
  const cabTop = curve(P.cabTop),
    cabHw = curve(P.cabHw)
  const zFront = P.top[P.top.length - 1][0],
    zRear = P.top[0][0]
  const L = spec.wheelbase / 2
  const wheels: WheelPos[] = [
    { x: spec.trackFront / 2, y: spec.tyreFront.radius - 0.012, z: L, r: spec.tyreFront.radius, w: spec.tyreFront.width, front: true },
    { x: -spec.trackFront / 2, y: spec.tyreFront.radius - 0.012, z: L, r: spec.tyreFront.radius, w: spec.tyreFront.width, front: true },
    { x: spec.trackRear / 2, y: spec.tyreRear.radius - 0.012, z: -L, r: spec.tyreRear.radius, w: spec.tyreRear.width, front: false },
    { x: -spec.trackRear / 2, y: spec.tyreRear.radius - 0.012, z: -L, r: spec.tyreRear.radius, w: spec.tyreRear.width, front: false },
  ]

  const lower = (x: number, y: number, z: number) => {
    const t = top(z),
      b = bottom(z)
    const he = (t - b) / 2,
      yc = (t + b) / 2
    const d2 = sdRoundTrapezoid(x, y - yc, hwBot(z), hwTop(z), he, P.bodyRadius)
    const cap = Math.max(z - zFront, zRear - z)
    return smax(d2, cap, 0.12)
  }
  const cabin = (x: number, y: number, z: number) => {
    if (z < P.cabZ[0] - 0.3 || z > P.cabZ[1] + 0.3) return 1
    const t = cabTop(z),
      b = P.cabBottom
    const he = (t - b) / 2,
      yc = (t + b) / 2
    const d2 = sdRoundTrapezoid(x, y - yc, 0.86, cabHw(z), he, P.cabRadius)
    const cap = Math.max(z - P.cabZ[1], P.cabZ[0] - z)
    return smax(d2, cap, 0.25)
  }
  const fender = (x: number, y: number, z: number) => {
    let d = 10
    for (const w of wheels) {
      const sx = Math.sign(w.x)
      if (Math.sign(x) !== sx && x !== 0) continue
      const f = sdCylX(x, y, z, sx * P.fenderX, w.y, w.z, w.r + P.fenderExtra - 0.04, P.fenderHalf) - 0.04
      d = Math.min(d, Math.max(f, 0.14 - y))
    }
    return d
  }
  const wheelCut = (x: number, y: number, z: number) => {
    let d = 10
    for (const w of wheels) {
      const sx = Math.sign(w.x)
      if (Math.sign(x) !== sx && x !== 0) continue
      d = Math.min(d, sdCylX(x, y, z, sx * (Math.abs(w.x) + 0.12), w.y, w.z, w.r + 0.045, w.w / 2 + 0.3))
    }
    return d
  }

  const sdf: SDF = (x, y, z) => {
    let d = smin(lower(x, y, z), cabin(x, y, z), 0.13)
    d = smin(d, fender(x, y, z), P.fenderBlend)
    // side intakes
    if (P.sideIntake) {
      const si = P.sideIntake
      const ax = Math.abs(x)
      const e = sdEllipsoid(ax - (hwBot(si.z) + 0.05), y - si.y, z - si.z, 0.06 + si.depth, si.ry, si.rz)
      d = smax(d, -e, 0.05)
    }
    // front mouth
    d = smax(d, -sdBox(x, y - 0.27, z - zFront, 0.5, 0.075, 0.12, 0.04), 0.03)
    // hood vents (race car)
    if (P.hoodVents) {
      const ax = Math.abs(x)
      d = smax(d, -sdBox(ax - 0.32, y - (top(1.45) + 0.0), z - 1.45, 0.17, 0.035, 0.16, 0.02), 0.02)
    }
    // wheel arches
    d = smax(d, -wheelCut(x, y, z), 0.025)
    return d
  }

  const beltY = (z: number) => Math.max(top(z), P.cabBottom + 0.18)
  const classify = (x: number, y: number, z: number, nx: number, ny: number, nz: number): Mat => {
    const ax = Math.abs(x)
    // wheel wells (surface created by the arch cut)
    if (Math.abs(wheelCut(x, y, z)) < 0.012) return Mat.WheelWell
    const hl = P.headlight
    if (z > hl.zMin && y > hl.yMin && y < hl.yMax && ax > hl.xMin && ax < hl.xMax && nz > 0.05) {
      // slanted lamp shape
      const u = (ax - hl.xMin) / (hl.xMax - hl.xMin)
      const yc = hl.yMin + (hl.yMax - hl.yMin) * (0.35 + 0.35 * u)
      if (Math.abs(y - yc) < (hl.yMax - hl.yMin) * 0.32) return Mat.Headlight
    }
    const tl = P.taillight
    if (z < tl.zMax && y > tl.yMin && y < tl.yMax && ax < 0.88 && nz < -0.3) return Mat.Taillight
    if (z > zFront - 0.25 && y < 0.36) return Mat.Grille
    if (y < 0.165 || (z < zRear + 0.3 && y < 0.38)) return Mat.Carbon
    if (P.sideIntake) {
      const si = P.sideIntake
      if (Math.abs(z - si.z) < si.rz * 0.92 && Math.abs(y - si.y) < si.ry * 0.9 && ax < hwBot(si.z) + 0.02) return Mat.Trim
    }
    // greenhouse
    const ct = cabTop(Math.min(Math.max(z, P.cabZ[0]), P.cabZ[1]))
    const onCabin = z > P.cabZ[0] - 0.05 && z < P.cabZ[1] && y > beltY(z) + 0.03
    if (onCabin) {
      const sw = P.sideWindow
      if (z > sw.zMin && z < sw.zMax && Math.abs(nx) > 0.3 && y < ct - 0.07) {
        // rounded window corners
        const zr = Math.min(z - sw.zMin, sw.zMax - z)
        const yr = Math.min(y - (beltY(z) + 0.03), ct - 0.07 - y)
        if (Math.hypot(Math.max(0, 0.08 - zr), Math.max(0, 0.08 - yr)) < 0.08) return Mat.Glass
      }
      if (nz > 0.2 && ny > 0.25 && z > 0.0 && ax < cabHw(z) - 0.06 && z < P.cabZ[1] - 0.04) return Mat.Glass
      const rw = P.rearWindow
      if (rw && z > rw.zMin && z < rw.zMax && ny > 0.4 && nz < 0.1 && ax < rw.xMax) return Mat.Glass
    }
    return Mat.Paint
  }

  const maxW = Math.max(...P.hwBot.map((k) => k[1])) + P.fenderExtra + 0.2
  return {
    sdf,
    min: [-maxW, 0.0, zRear - 0.08],
    max: [maxW, Math.max(...P.cabTop.map((k) => k[1])) + 0.08, zFront + 0.08],
    wheels,
    classify,
    zFront,
    zRear,
    beltY,
    roofY: (z: number) => cabTop(z),
    cabinHalfWidth: (z: number) => cabHw(z),
    style: spec.bodyStyle,
    wing: P.wing,
    exhausts: P.exhausts,
    driverX: P.driverX,
    eyeY: P.eyeY,
    eyeZ: P.eyeZ,
  }
}
