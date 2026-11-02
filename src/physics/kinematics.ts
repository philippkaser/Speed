// Suspension kinematics from hardpoints (front-view double wishbone).
//
// The linkage is solved once over the travel range: for every lower-arm angle the upper ball joint
// is found by intersecting the upper-arm circle with the (rigid) upright circle. From that we tabulate
// against vertical wheel travel:
//   - camber change (upright rotation)
//   - track change (lateral wheel-centre motion -> tyre scrub)
//   - instant centre -> jacking coefficient (lateral force -> vertical link force), i.e. a roll centre
//     that migrates with heave and roll instead of a fixed number
// Side-view anti-dive / anti-squat and bump steer are characterised by swing-arm angle and toe gradient.

export type P2 = [number, number] // [lateral (outward from centreline), height above ground] in metres

export interface WishboneGeometry {
  lowerInner: P2
  lowerOuter: P2
  upperInner: P2
  upperOuter: P2
  wheelCentre: P2 // static
  /** side-view: anti-dive (front, braking) or anti-squat (rear, traction) fraction 0..1 */
  anti: number
  /** toe change per metre of bump (rad/m), + = toe-in */
  bumpSteer: number
  /** mechanical trail from caster (m), front only */
  mechTrail: number
}

const STEPS = 121
const RANGE = 0.12 // +- metres of wheel travel tabulated

export class Kinematics {
  z = new Float64Array(STEPS) // wheel-centre travel (m, + = bump)
  camber = new Float64Array(STEPS) // rad, change vs static; negative = top inward
  track = new Float64Array(STEPS) // m, lateral wheel-centre change, + = outward
  jack = new Float64Array(STEPS) // vertical generalised force per unit outward lateral force
  rcHeight = new Float64Array(STEPS) // roll-centre height for a symmetric heave position (m)
  anti: number
  bumpSteer: number
  mechTrail: number
  antiTan = 0

  constructor(
    public g: WishboneGeometry,
    cgHeight: number,
    wheelbase: number,
  ) {
    this.anti = g.anti
    this.bumpSteer = g.bumpSteer
    this.mechTrail = g.mechTrail
    // side view swing arm: tan(theta) = anti * h / L
    this.antiTan = (g.anti * cgHeight) / wheelbase
    this.solve()
  }

  private solve() {
    const g = this.g
    const LI = g.lowerInner,
      LO = g.lowerOuter,
      UI = g.upperInner,
      UO = g.upperOuter,
      WC = g.wheelCentre
    const Ll = Math.hypot(LO[0] - LI[0], LO[1] - LI[1])
    const Lu = Math.hypot(UO[0] - UI[0], UO[1] - UI[1])
    const Lk = Math.hypot(UO[0] - LO[0], UO[1] - LO[1])
    const th0 = Math.atan2(LO[1] - LI[1], LO[0] - LI[0])
    const phi0 = Math.atan2(UO[1] - LO[1], UO[0] - LO[0])
    // wheel centre relative to the lower ball joint in the upright frame
    const wcRel: P2 = [WC[0] - LO[0], WC[1] - LO[1]]
    // sample lower arm angles, find the resulting travel, then resample uniformly in travel
    const raw: { z: number; cam: number; tr: number; jack: number; rc: number }[] = []
    let prevUO: P2 = [...UO]
    for (let k = -200; k <= 200; k++) {
      const th = th0 + (k / 200) * 0.6
      const lo: P2 = [LI[0] + Ll * Math.cos(th), LI[1] + Ll * Math.sin(th)]
      const uo = circleIntersect(UI, Lu, lo, Lk, prevUO)
      if (!uo) continue
      prevUO = uo
      const phi = Math.atan2(uo[1] - lo[1], uo[0] - lo[0])
      const d = phi - phi0 // upright rotation (+ = counter-clockwise looking from behind, outward = +x)
      const c = Math.cos(d),
        s = Math.sin(d)
      const wc: P2 = [lo[0] + wcRel[0] * c - wcRel[1] * s, lo[1] + wcRel[0] * s + wcRel[1] * c]
      // upright rotating CCW (top moving inward towards the centreline when outward = +x) => negative camber
      const cam = -d
      // instant centre: intersection of the two arm lines
      const ic = lineIntersect(LI, lo, UI, uo)
      const cp: P2 = [wc[0], 0]
      let jack = 0,
        rc = 0
      if (ic) {
        const rLat = cp[0] - ic[0]
        // generalised vertical force per unit outward lateral contact force (virtual work)
        jack = Math.abs(rLat) > 1e-3 ? ic[1] / rLat : 0
        // roll centre: line contact patch -> IC crossing the centreline
        const t = cp[0] / (cp[0] - ic[0])
        rc = t * ic[1]
      }
      raw.push({ z: wc[1] - WC[1], cam, tr: wc[0] - WC[0], jack, rc })
    }
    raw.sort((a, b) => a.z - b.z)
    for (let i = 0; i < STEPS; i++) {
      const z = -RANGE + (2 * RANGE * i) / (STEPS - 1)
      this.z[i] = z
      let j = 0
      while (j < raw.length - 2 && raw[j + 1].z < z) j++
      const a = raw[j],
        b = raw[Math.min(j + 1, raw.length - 1)]
      const f = b.z !== a.z ? Math.min(1, Math.max(0, (z - a.z) / (b.z - a.z))) : 0
      this.camber[i] = a.cam + (b.cam - a.cam) * f
      this.track[i] = a.tr + (b.tr - a.tr) * f
      this.jack[i] = clampAbs(a.jack + (b.jack - a.jack) * f, 1.2)
      this.rcHeight[i] = a.rc + (b.rc - a.rc) * f
    }
  }

  private idx(z: number) {
    const f = ((z + RANGE) / (2 * RANGE)) * (STEPS - 1)
    const i = Math.max(0, Math.min(STEPS - 2, Math.floor(f)))
    return { i, f: Math.max(0, Math.min(1, f - i)) }
  }
  camberAt(z: number) {
    const { i, f } = this.idx(z)
    return this.camber[i] + (this.camber[i + 1] - this.camber[i]) * f
  }
  trackAt(z: number) {
    const { i, f } = this.idx(z)
    return this.track[i] + (this.track[i + 1] - this.track[i]) * f
  }
  /** d(track)/dz for scrub velocity */
  trackRate(z: number) {
    const { i } = this.idx(z)
    return (this.track[i + 1] - this.track[i]) / (this.z[i + 1] - this.z[i])
  }
  jackAt(z: number) {
    const { i, f } = this.idx(z)
    return this.jack[i] + (this.jack[i + 1] - this.jack[i]) * f
  }
  rollCentreAt(z: number) {
    const { i, f } = this.idx(z)
    return this.rcHeight[i] + (this.rcHeight[i + 1] - this.rcHeight[i]) * f
  }
}

function clampAbs(v: number, m: number) {
  return v > m ? m : v < -m ? -m : v
}

function circleIntersect(c0: P2, r0: number, c1: P2, r1: number, near: P2): P2 | null {
  const dx = c1[0] - c0[0],
    dy = c1[1] - c0[1]
  const d = Math.hypot(dx, dy)
  if (d > r0 + r1 || d < Math.abs(r0 - r1) || d < 1e-9) return null
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, r0 * r0 - a * a))
  const mx = c0[0] + (a * dx) / d,
    my = c0[1] + (a * dy) / d
  const p1: P2 = [mx + (h * dy) / d, my - (h * dx) / d]
  const p2: P2 = [mx - (h * dy) / d, my + (h * dx) / d]
  const d1 = (p1[0] - near[0]) ** 2 + (p1[1] - near[1]) ** 2
  const d2 = (p2[0] - near[0]) ** 2 + (p2[1] - near[1]) ** 2
  return d1 < d2 ? p1 : p2
}

function lineIntersect(a0: P2, a1: P2, b0: P2, b1: P2): P2 | null {
  const x1 = a0[0],
    y1 = a0[1],
    x2 = a1[0],
    y2 = a1[1],
    x3 = b0[0],
    y3 = b0[1],
    x4 = b1[0],
    y4 = b1[1]
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
  if (Math.abs(den) < 1e-9) return null // parallel arms: IC at infinity
  const px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / den
  const py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / den
  // keep the IC in a sane range (very long swing arms)
  return [Math.max(-60, Math.min(60, px)), Math.max(-30, Math.min(30, py))]
}

/** Typical race car double wishbone, scaled to the axle. */
export function defaultGeometry(trackHalf: number, wheelR: number, kind: 'gt3F' | 'gt3R' | 'gtF' | 'gtR'): WishboneGeometry {
  const wc: P2 = [trackHalf, wheelR - 0.012]
  const front = kind === 'gt3F' || kind === 'gtF'
  const race = kind === 'gt3F' || kind === 'gt3R'
  // short-long arms with ball joints inside the rim; the arm lines converge inboard so the
  // instant centre sits inboard & above ground: negative camber gain in bump, roll centre ~50-90 mm
  return {
    lowerInner: [trackHalf - (race ? 0.52 : 0.5), race ? 0.135 : 0.14],
    lowerOuter: [trackHalf - 0.06, 0.115],
    upperInner: [trackHalf - (race ? 0.36 : 0.33), wc[1] + (race ? 0.15 : 0.165)],
    upperOuter: [trackHalf - 0.1, wc[1] + 0.19],
    wheelCentre: wc,
    anti: front ? (race ? 0.22 : 0.3) : race ? 0.45 : 0.3,
    // toe change per metre of bump: slight toe-out at the front, stabilising toe-in at the rear
    bumpSteer: front ? (race ? -0.03 : -0.05) : race ? 0.04 : 0.06,
    mechTrail: front ? (race ? 0.024 : 0.03) : 0,
  }
}
