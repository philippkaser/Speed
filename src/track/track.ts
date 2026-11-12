// Track model: spline -> dense centreline samples with per-sample cross-section description.
// Implements the physics Ground interface (height, normal, surface, track coords, barriers).
import { expandStations, lineBounds, LINE_STEP, minCurvatureLine } from './racingLine'
import { type Ground, type GroundSample, Surface } from '../physics/ground'
import { clamp, hash2, lerp, smoothstep, valueNoise2 } from '../physics/math'
import type { TrackDef } from './trackDef'

export const DS = 1 // metres between centreline samples

export interface SideInfo {
  kerb: Float32Array // kerb width (0 = none)
  paved: Float32Array // paved runoff width after the kerb
  outer: Uint8Array // surface type after paved runoff (grass / gravel)
  wall: Float32Array // distance from centreline to barrier
}

export class Track implements Ground {
  def: TrackDef
  n = 0
  length = 0
  px!: Float64Array
  py!: Float64Array
  pz!: Float64Array
  tx!: Float64Array // horizontal unit tangent
  tz!: Float64Array
  lx!: Float64Array // horizontal unit left
  lz!: Float64Array
  grade!: Float32Array // dy/ds
  slope!: Float32Array // lateral slope dy/dd (bank)
  curv!: Float32Array // signed curvature, + = left turn
  hw!: Float32Array // half width of asphalt
  L!: SideInfo // left side
  R!: SideInfo // right side
  racing!: Float32Array // racing line lateral offset (+ left)
  racingCurv!: Float32Array
  speed!: Float32Array // reference speed along racing line (m/s), for AI & markers
  sectors: number[] = []
  /** braking-zone weight per sample (0..1): ripples ("braking bumps") worn into the surface */
  brakeZone!: Float32Array
  /** dynamic track: rubber on a 2 m x 1 m grid (16 lateral cells covering -8..8 m) */
  rubber!: Float32Array
  rubberCols = 16
  rubberVersion = 0
  gridCell = 25
  grid = new Map<number, number[]>()
  minX = 0
  minZ = 0
  maxX = 0
  maxZ = 0

  constructor(def: TrackDef) {
    this.def = def
    this.build()
  }

  // ----------------------------------------------------------------------------- build
  private build() {
    const def = this.def
    const P = def.points
    const m = P.length
    // dense evaluation of a closed centripetal Catmull-Rom spline
    const dense: number[][] = []
    const SUB = 40
    for (let i = 0; i < m; i++) {
      const p0 = P[(i - 1 + m) % m],
        p1 = P[i],
        p2 = P[(i + 1) % m],
        p3 = P[(i + 2) % m]
      for (let k = 0; k < SUB; k++) {
        const t = k / SUB
        const [x, y, z] = catmull(p0, p1, p2, p3, t)
        const w = lerp(p1.width ?? def.defaultWidth, p2.width ?? def.defaultWidth, smoothstep(0, 1, t))
        const b = lerp(p1.bank ?? 0, p2.bank ?? 0, smoothstep(0, 1, t))
        dense.push([x, y, z, w, b])
      }
    }
    // arc length (horizontal)
    const cum = [0]
    for (let i = 1; i <= dense.length; i++) {
      const a = dense[i - 1],
        b = dense[i % dense.length]
      cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[2] - a[2]))
    }
    const total = cum[cum.length - 1]
    const n = Math.round(total / DS)
    this.n = n
    this.length = n * DS
    const alloc64 = () => new Float64Array(n)
    const alloc32 = () => new Float32Array(n)
    this.px = alloc64()
    this.py = alloc64()
    this.pz = alloc64()
    this.tx = alloc64()
    this.tz = alloc64()
    this.lx = alloc64()
    this.lz = alloc64()
    this.grade = alloc32()
    this.slope = alloc32()
    this.curv = alloc32()
    this.hw = alloc32()
    const bank = alloc32()
    const startShift = 360 // metres after the first control point the start line sits
    let j = 0
    for (let i = 0; i < n; i++) {
      const target = ((i * total) / n + startShift) % total
      while (j < cum.length - 2 && cum[j + 1] < target) j++
      if (cum[j] > target) j = 0
      while (cum[j + 1] < target) j++
      const f = (target - cum[j]) / (cum[j + 1] - cum[j] || 1)
      const a = dense[j],
        b = dense[(j + 1) % dense.length]
      this.px[i] = lerp(a[0], b[0], f)
      this.py[i] = lerp(a[1], b[1], f)
      this.pz[i] = lerp(a[2], b[2], f)
      this.hw[i] = lerp(a[3], b[3], f) * 0.5
      bank[i] = lerp(a[4], b[4], f)
    }
    smoothArray(this.py, 12)
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n,
        b = (i + 1) % n
      let dx = this.px[b] - this.px[a],
        dz = this.pz[b] - this.pz[a]
      const l = Math.hypot(dx, dz)
      dx /= l
      dz /= l
      this.tx[i] = dx
      this.tz[i] = dz
      // left of heading (dx, dz) in a Y-up right-handed frame: (dz, -dx)
      this.lx[i] = dz
      this.lz[i] = -dx
      this.grade[i] = (this.py[b] - this.py[a]) / l
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 3 + n) % n,
        b = (i + 3) % n
      const ha = Math.atan2(this.tx[a], this.tz[a]),
        hb = Math.atan2(this.tx[b], this.tz[b])
      let d = hb - ha
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      this.curv[i] = d / (6 * DS)
    }
    smoothArray(this.curv, 8)
    for (let i = 0; i < n; i++) {
      // bank raises the outside of the corner; d is + left. Right turn (curv<0) -> outside is left
      const sgn = this.curv[i] >= 0 ? -1 : 1
      this.slope[i] = sgn * Math.tan((bank[i] * Math.PI) / 180)
    }
    smoothArray(this.slope, 15)

    this.buildGrid()
    this.buildKerbs()
    this.computeRacingLine()
    this.computeSpeedProfile({ mu: 1.55, clA_m: 2.7 / 1340, power_m: 400000 / 1340, cdA_m: 1.0 / 1340, brakeMu: 1.6 })
    this.buildSides()
    this.sectors = [0, Math.round(n / 3) * DS, Math.round((2 * n) / 3) * DS]
    // braking zones: where the reference speed drops, cars brake hard and ripple the asphalt
    this.brakeZone = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const dv = this.speed[(i + 4) % n] - this.speed[i]
      this.brakeZone[i] = clamp(-dv / 1.2, 0, 1)
    }
    smoothArray(this.brakeZone, 10)
    this.rubber = new Float32Array(Math.ceil(n / 2) * this.rubberCols)
    this.resetRubber(0.45)
  }

  /** Kerbs depend only on the centreline curvature; built before the racing line, which runs over them. */
  private buildKerbs() {
    const n = this.n
    const mk = (): SideInfo => ({ kerb: new Float32Array(n), paved: new Float32Array(n), outer: new Uint8Array(n), wall: new Float32Array(n) })
    this.L = mk()
    this.R = mk()
    const absC = new Float32Array(n)
    for (let i = 0; i < n; i++) absC[i] = Math.abs(this.curv[i])
    for (const side of [1, -1]) {
      const S = side > 0 ? this.L : this.R
      const kerbFlag = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        const c = this.curv[i]
        const inside = (c > 0 && side > 0) || (c < 0 && side < 0)
        if (inside && absC[i] > 1 / 330) kerbFlag[i] = 1
        if (!inside && absC[i] > 1 / 150) kerbFlag[i] = 2
      }
      // dilate & remove short runs
      const dil = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        if (!kerbFlag[i]) continue
        for (let k = -9; k <= 9; k++) {
          const idx = (i + k + n) % n
          dil[idx] = Math.max(dil[idx], kerbFlag[i])
        }
      }
      for (let i = 0; i < n; i++) S.kerb[i] = dil[i] === 1 ? 1.6 : dil[i] === 2 ? 1.2 : 0
    }
  }

  private buildSides() {
    const n = this.n
    const absC = new Float32Array(n)
    for (let i = 0; i < n; i++) absC[i] = Math.abs(this.curv[i])
    for (const side of [1, -1]) {
      const S = side > 0 ? this.L : this.R
      // runoff: outside of fast corners gets big asphalt runoff, slow corners gravel traps
      const raw = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const c = this.curv[i]
        const outside = (c < 0 && side > 0) || (c > 0 && side < 0)
        const v = this.speed[i]
        let run = 9
        let paved = 2.5
        let outer = Surface.Grass
        if (outside && absC[i] > 1 / 600) {
          run = clamp(10 + (v * v) / 75, 12, 48)
          if (v > 52) {
            paved = run - 4
            outer = Surface.Grass
          } else {
            paved = 4
            outer = Surface.Gravel
          }
        } else if (!outside && absC[i] > 1 / 600) {
          run = 7
          paved = 1.5
        }
        raw[i] = run
        S.paved[i] = paved
        S.outer[i] = outer
      }
      // smooth runoff width along s: running max then average so barriers flow
      const mx = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let v = 0
        for (let k = -60; k <= 60; k += 3) v = Math.max(v, raw[(i + k + n) % n] * (1 - Math.abs(k) / 140))
        mx[i] = v
      }
      smoothArray(mx, 30)
      const pv = Float32Array.from(S.paved)
      for (let i = 0; i < n; i++) {
        let v = 0
        for (let k = -40; k <= 40; k += 4) v = Math.max(v, pv[(i + k + n) % n])
        S.paved[i] = v
      }
      smoothArray(S.paved, 20)
      // majority filter for gravel/grass
      const ou = Uint8Array.from(S.outer)
      for (let i = 0; i < n; i++) {
        let g = 0
        for (let k = -30; k <= 30; k += 3) if (ou[(i + k + n) % n] === Surface.Gravel) g++
        S.outer[i] = g >= 5 ? Surface.Gravel : Surface.Grass
      }
      for (let i = 0; i < n; i++) {
        const edge = this.hw[i] + S.kerb[i]
        S.paved[i] = Math.min(S.paved[i], mx[i] - 1)
        S.wall[i] = edge + mx[i]
      }
    }
    // keep barriers clear of other parts of the circuit
    for (const side of [1, -1]) {
      const S = side > 0 ? this.L : this.R
      for (let i = 0; i < n; i++) {
        for (let it = 0; it < 8; it++) {
          const wx = this.px[i] + this.lx[i] * S.wall[i] * side
          const wz = this.pz[i] + this.lz[i] * S.wall[i] * side
          const near = this.nearestExcluding(wx, wz, i, 260)
          if (near.idx < 0) break
          const needed = this.hw[near.idx] + 6
          if (near.dist >= needed) break
          S.wall[i] = Math.max(this.hw[i] + S.kerb[i] + 2.5, S.wall[i] - (needed - near.dist) - 1)
        }
      }
      // re-smooth after clamping (only allow narrowing)
      const w = Float32Array.from(S.wall)
      for (let i = 0; i < n; i++) {
        let v = Infinity
        for (let k = -25; k <= 25; k++) v = Math.min(v, w[(i + k + n) % n] + Math.abs(k) * 0.25)
        S.wall[i] = v
      }
      for (let i = 0; i < n; i++) S.paved[i] = Math.min(S.paved[i], S.wall[i] - this.hw[i] - S.kerb[i] - 0.5)
    }
  }

  private buildGrid() {
    let minX = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxZ = -Infinity
    for (let i = 0; i < this.n; i++) {
      minX = Math.min(minX, this.px[i])
      maxX = Math.max(maxX, this.px[i])
      minZ = Math.min(minZ, this.pz[i])
      maxZ = Math.max(maxZ, this.pz[i])
    }
    this.minX = minX
    this.minZ = minZ
    this.maxX = maxX
    this.maxZ = maxZ
    for (let i = 0; i < this.n; i++) {
      const key = this.cellKey(Math.floor(this.px[i] / this.gridCell), Math.floor(this.pz[i] / this.gridCell))
      let arr = this.grid.get(key)
      if (!arr) this.grid.set(key, (arr = []))
      arr.push(i)
    }
  }

  private cellKey(cx: number, cz: number) {
    return (cx + 10000) * 20000 + (cz + 10000)
  }

  /** global nearest centreline sample (grid search, expanding rings) */
  nearestIndex(x: number, z: number) {
    const cx = Math.floor(x / this.gridCell),
      cz = Math.floor(z / this.gridCell)
    let best = -1,
      bestD = Infinity
    for (let ring = 1; ring < 80; ring++) {
      for (let ix = cx - ring; ix <= cx + ring; ix++)
        for (let iz = cz - ring; iz <= cz + ring; iz++) {
          if (ring > 1 && Math.abs(ix - cx) < ring && Math.abs(iz - cz) < ring) continue
          const arr = this.grid.get(this.cellKey(ix, iz))
          if (!arr) continue
          for (const i of arr) {
            const d = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2
            if (d < bestD) {
              bestD = d
              best = i
            }
          }
        }
      if (best >= 0 && Math.sqrt(bestD) < (ring - 1) * this.gridCell) break
    }
    return best
  }

  private nearestExcluding(x: number, z: number, around: number, excl: number) {
    const cx = Math.floor(x / this.gridCell),
      cz = Math.floor(z / this.gridCell)
    let best = -1,
      bestD = Infinity
    for (let ix = cx - 3; ix <= cx + 3; ix++)
      for (let iz = cz - 3; iz <= cz + 3; iz++) {
        const arr = this.grid.get(this.cellKey(ix, iz))
        if (!arr) continue
        for (const i of arr) {
          let di = Math.abs(i - around)
          di = Math.min(di, this.n - di)
          if (di < excl) continue
          const d = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2
          if (d < bestD) {
            bestD = d
            best = i
          }
        }
      }
    return { idx: best, dist: Math.sqrt(bestD) }
  }

  /** local nearest search from a hint (follows a moving query point) */
  private _ln = { i: 0, d: 0 }
  private localNearest(x: number, z: number, hint: number) {
    const n = this.n
    let i = hint
    let d = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2
    for (let it = 0; it < 400; it++) {
      const a = i + 1 >= n ? 0 : i + 1
      const b = i - 1 < 0 ? n - 1 : i - 1
      const da = (this.px[a] - x) ** 2 + (this.pz[a] - z) ** 2
      const db = (this.px[b] - x) ** 2 + (this.pz[b] - z) ** 2
      if (da < d && da <= db) {
        i = a
        d = da
      } else if (db < d) {
        i = b
        d = db
      } else break
    }
    this._ln.i = i
    this._ln.d = d
    return this._ln
  }

  // ----------------------------------------------------------------------------- queries
  /** Project a world point onto the track. Writes s, d, hint and interpolation info. */
  project(x: number, z: number, out: GroundSample) {
    const n = this.n
    let i: number
    if (out.hint < 0 || out.hint >= n) i = this.nearestIndex(x, z)
    else {
      const r = this.localNearest(x, z, out.hint)
      i = r.i
      const wall = Math.max(this.L.wall[i], this.R.wall[i]) + 80
      if (r.d > wall * wall) i = this.nearestIndex(x, z)
    }
    out.hint = i
    // choose the segment (i-1,i) or (i,i+1) that contains the projection
    let i0 = i,
      i1 = (i + 1) % n
    let t = (x - this.px[i0]) * this.tx[i0] + (z - this.pz[i0]) * this.tz[i0]
    if (t < 0) {
      i1 = i
      i0 = (i - 1 + n) % n
      t = (x - this.px[i0]) * this.tx[i0] + (z - this.pz[i0]) * this.tz[i0]
    }
    const segLen = Math.hypot(this.px[i1] - this.px[i0], this.pz[i1] - this.pz[i0]) || DS
    const f = clamp(t / segLen, 0, 1)
    const r = this._proj
    r.i0 = i0
    r.i1 = i1
    r.f = f
    return r
  }
  private _proj = { i0: 0, i1: 0, f: 0 }

  sample(x: number, z: number, out: GroundSample) {
    const { i0, i1, f } = this.project(x, z, out)
    const cx = lerp(this.px[i0], this.px[i1], f)
    const cz = lerp(this.pz[i0], this.pz[i1], f)
    const cy = lerp(this.py[i0], this.py[i1], f)
    let lx = lerp(this.lx[i0], this.lx[i1], f)
    let lz = lerp(this.lz[i0], this.lz[i1], f)
    const ll = Math.hypot(lx, lz)
    lx /= ll
    lz /= ll
    const d = (x - cx) * lx + (z - cz) * lz
    const ni = f < 0.5 ? i0 : i1
    const s = (i0 + f) * DS
    out.s = s
    out.d = d
    out.lx = lx
    out.lz = lz
    out.wallLeft = lerp(this.L.wall[i0], this.L.wall[i1], f)
    out.wallRight = lerp(this.R.wall[i0], this.R.wall[i1], f)
    const slope = lerp(this.slope[i0], this.slope[i1], f)
    const grade = lerp(this.grade[i0], this.grade[i1], f)
    const prof = this.profile(ni, d, slope, s)
    out.height = cy + prof.h + this.bumps(ni, s, d)
    out.surface = prof.surface
    out.qx = x
    out.qz = z
    out.grip = prof.surface === Surface.Asphalt || prof.surface === Surface.Kerb ? this.gripAt(ni, s, d) : 1
    // normal from surface gradient: n = up - fs*T - fd*L
    const txh = -lz,
      tzh = lx // tangent from left: T = (-lz, lx)?  left=(tz,-tx) -> tx=-lz, tz=lx
    let nx = -grade * txh - prof.dhdd * lx
    let ny = 1
    let nz = -grade * tzh - prof.dhdd * lz
    const nl = Math.hypot(nx, ny, nz)
    nx /= nl
    ny /= nl
    nz /= nl
    out.nx = nx
    out.ny = ny
    out.nz = nz
  }

  // ---------------------------------------------------------------------- road micro-geometry
  /**
   * Physical road surface detail on the asphalt & kerbs (like a laser scan): long undulations,
   * mid-wavelength unevenness, asphalt laying joints and braking ripples on the racing line.
   */
  bumps(i: number, s: number, d: number) {
    const ad = Math.abs(d)
    if (ad > this.hw[i] + 2.5) return 0
    let h = (valueNoise2(s * 0.031, d * 0.11 + 13.7) - 0.5) * 0.016
    h += (valueNoise2(s * 0.29, d * 0.45 + 3.1) - 0.5) * 0.005
    // laying joints roughly every 47 m: a 1.5 mm step smeared over 0.2 m
    const j = (s % 47.3) / 47.3
    h += smoothstep(0.996, 1, j) * 0.0015
    const bz = this.brakeZone[i]
    if (bz > 0.02) {
      const dl = Math.abs(d - this.racing[i])
      if (dl < 2.8) h += bz * (1 - dl / 2.8) * 0.0035 * Math.sin(s * 5.0265)
    }
    return h
  }

  // ---------------------------------------------------------------------- dynamic track
  resetRubber(level: number) {
    const cols = this.rubberCols
    for (let k = 0; k < this.rubber.length / cols; k++) {
      const i = Math.min(this.n - 1, k * 2)
      for (let c = 0; c < cols; c++) {
        const d = c - cols / 2 + 0.5
        const dl = d - this.racing[i]
        this.rubber[k * cols + c] = 0.12 + level * Math.exp(-(dl * dl) / (1.7 * 1.7))
      }
    }
    this.rubberVersion++
  }

  private rubberIndex(s: number, d: number) {
    const k = Math.floor((((s % this.length) + this.length) % this.length) / 2)
    const c = Math.floor(d + this.rubberCols / 2)
    if (c < 0 || c >= this.rubberCols) return -1
    return k * this.rubberCols + c
  }

  /** grip multiplier: green track 0.96, rubbered line up to 1.03, marbles near the edges off-line */
  gripAt(i: number, s: number, d: number) {
    const ri = this.rubberIndex(s, d)
    const r = ri >= 0 ? this.rubber[ri] : 0
    const offLine = smoothstep(3.0, 4.6, Math.abs(d - this.racing[i]))
    const nearEdge = smoothstep(this.hw[i] - 2.2, this.hw[i] - 0.4, Math.abs(d))
    return 0.958 + 0.075 * r - 0.065 * offLine * nearEdge
  }

  layRubber(ref: GroundSample, amount: number) {
    const ri = this.rubberIndex(ref.s, ref.d)
    if (ri < 0) return
    const v = this.rubber[ri]
    this.rubber[ri] = Math.min(1, v + amount * (1 - v))
    if (amount > 0) this.rubberDirty = true
  }
  rubberDirty = false

  /** surface height at (x, z) near a previous sample, via the local track frame (no projection) */
  heightNear(ref: GroundSample, x: number, z: number) {
    const dx = x - ref.qx,
      dz = z - ref.qz
    // track tangent = (-lz, lx)
    const ds = -dx * ref.lz + dz * ref.lx
    const dd = dx * ref.lx + dz * ref.lz
    const s = ref.s + ds,
      d = ref.d + dd
    const n = this.n
    let fs = s / DS
    fs = ((fs % n) + n) % n
    const i0 = Math.floor(fs),
      i1 = (i0 + 1) % n,
      f = fs - i0
    const cy = this.py[i0] + (this.py[i1] - this.py[i0]) * f
    const slope = this.slope[i0] + (this.slope[i1] - this.slope[i0]) * f
    const ni = f < 0.5 ? i0 : i1
    return cy + this.profile(ni, d, slope, s).h + this.bumps(ni, s, d)
  }

  private _prof = { h: 0, dhdd: 0, surface: Surface.Asphalt as Surface }

  /** Cross-section height profile relative to the centreline at lateral offset d (reused result object). */
  profile(i: number, d: number, slope: number, s: number) {
    const side = d >= 0 ? 1 : -1
    const S = side > 0 ? this.L : this.R
    const ad = Math.abs(d)
    const hw = this.hw[i]
    const kerb = S.kerb[i]
    const edge = hw + kerb
    let h: number
    let dhdd: number
    let surface: Surface
    if (ad <= hw) {
      h = slope * d
      dhdd = slope
      surface = Surface.Asphalt
    } else if (ad <= edge) {
      const u = (ad - hw) / kerb
      const hump = 0.034 * Math.pow(Math.sin(Math.PI * clamp(u * 0.85 + 0.08, 0, 1)), 0.6)
      // rumble ridges across the kerb
      const ridge = 0.0045 * Math.abs(Math.sin((Math.PI * s) / 0.42))
      h = slope * d + hump + ridge
      dhdd = slope + side * 0.034 * Math.PI * 0.85 * 0.6 * Math.cos(Math.PI * (u * 0.85 + 0.08)) / kerb
      surface = Surface.Kerb
    } else {
      const x = ad - edge
      const sideSlope = slope * side
      const run = Math.min(x, 8)
      const outerType = S.outer[i] as Surface
      const paved = S.paved[i]
      const drop = x <= paved ? -0.005 : outerType === Surface.Gravel ? -0.09 * smoothstep(paved, paved + 1.5, x) : -0.035 * smoothstep(paved, paved + 1, x)
      // relative to centre: slope*d at the edge plus a decaying continuation of the bank
      h = slope * edge * side + sideSlope * run * (1 - run / 16) + drop
      dhdd = x < 8 ? side * sideSlope * (1 - x / 8) : 0
      surface = x <= paved ? Surface.Runoff : outerType
      if (surface === Surface.Grass) {
        // undulating grass
        const nz = (hash2(Math.floor(s / 3), Math.floor(ad / 3)) - 0.5) * 0.04
        h += nz * smoothstep(paved + 1, paved + 4, x)
      }
    }
    const out = this._prof
    out.h = h
    out.dhdd = dhdd
    out.surface = surface
    return out
  }

  /** world position on the track at distance s and offset d (+left) */
  pointAt(s: number, d: number, out: { x: number; y: number; z: number }) {
    const n = this.n
    let fs = s / DS
    fs = ((fs % n) + n) % n
    const i0 = Math.floor(fs),
      i1 = (i0 + 1) % n,
      f = fs - i0
    const cx = lerp(this.px[i0], this.px[i1], f),
      cy = lerp(this.py[i0], this.py[i1], f),
      cz = lerp(this.pz[i0], this.pz[i1], f)
    const lx = lerp(this.lx[i0], this.lx[i1], f),
      lz = lerp(this.lz[i0], this.lz[i1], f)
    const slope = lerp(this.slope[i0], this.slope[i1], f)
    const ni = f < 0.5 ? i0 : i1
    const p = this.profile(ni, d, slope, s)
    out.x = cx + lx * d
    out.z = cz + lz * d
    out.y = cy + p.h + (this.brakeZone ? this.bumps(ni, s, d) : 0)
    return out
  }

  headingAt(s: number) {
    const i = (((Math.round(s / DS) % this.n) + this.n) % this.n) | 0
    return Math.atan2(this.tx[i], this.tz[i])
  }

  idx(s: number) {
    return (((Math.round(s / DS) % this.n) + this.n) % this.n) | 0
  }

  // ----------------------------------------------------------------------------- racing line
  /** Lateral bounds of the racing line (+ left): asphalt plus usable kerb, minus half a car and a margin. */
  lineLo!: Float32Array
  lineHi!: Float32Array

  private computeRacingLine() {
    const n = this.n
    const { lo, hi } = lineBounds(this)
    this.lineLo = lo
    this.lineHi = hi
    this.racing = expandStations(minCurvatureLine(this, lo, hi), LINE_STEP, n, lo, hi)
    // racing line curvature
    this.racingCurv = new Float32Array(n)
    const rx = new Float64Array(n),
      rz = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      rx[i] = this.px[i] + this.lx[i] * this.racing[i]
      rz[i] = this.pz[i] + this.lz[i] * this.racing[i]
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 6 + n) % n,
        b = (i + 6) % n
      const h1 = Math.atan2(rx[i] - rx[a], rz[i] - rz[a])
      const h2 = Math.atan2(rx[b] - rx[i], rz[b] - rz[i])
      let d = h2 - h1
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      const len = Math.hypot(rx[b] - rx[a], rz[b] - rz[a]) * 0.5
      this.racingCurv[i] = d / Math.max(len, 1)
    }
    smoothArray(this.racingCurv, 5)
  }

  /** Quasi steady-state lap speed profile along the racing line. */
  /** loadSens / fz0_m: the tyre's friction loss per unit of load above its nominal load (fz0_m = nominal
   *  wheel load / car mass), so downforce adds grip with the same diminishing return as in the tyre model */
  computeSpeedProfile(p: { mu: number; clA_m: number; power_m: number; cdA_m: number; brakeMu: number; loadSens?: number; fz0_m?: number; trailExp?: number; rearBrake?: { wr: number; bf: number; hL: number; aeroR: number; mu: number } }, out?: Float32Array) {
    const n = this.n
    const v = out ?? new Float32Array(n)
    const g = 9.81
    const rho = 0.6
    const ls = p.loadSens ?? 0,
      fz0 = p.fz0_m ?? 1
    // friction at a vertical load of (g + rho clA/m v^2) per unit mass, shared by four wheels
    const muAt = (mu: number, v2: number) => mu * Math.max(0.5, 1 - ls * ((g + rho * p.clA_m * v2) / (4 * fz0) - 1))
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.racingCurv[i])
      // k v^2 = mu(v) (g + c v^2): fixed point on v^2 (mu falls slowly with v^2, converges in a few steps)
      let v2 = 95 * 95
      for (let it = 0; it < 8; it++) {
        const mu = muAt(p.mu, v2)
        const den = k - mu * rho * p.clA_m
        v2 = den <= 1e-6 ? 95 * 95 : Math.min(95 * 95, (mu * g) / den)
      }
      v[i] = Math.sqrt(v2)
    }
    // forward pass (acceleration limited by traction circle and power)
    for (let pass = 0; pass < 2; pass++)
      for (let j = 0; j < n; j++) {
        const i = (j + 1) % n,
          a = j
        const va = v[a]
        const latG = va * va * Math.abs(this.racingCurv[a])
        const maxA = muAt(p.mu, va * va) * (g + rho * p.clA_m * va * va)
        const avail = Math.sqrt(Math.max(0, maxA * maxA - latG * latG)) * 0.75
        const powerA = p.power_m / Math.max(va, 5)
        const acc = Math.min(avail, powerA) - rho * p.cdA_m * va * va
        const vn = Math.sqrt(Math.max(0, va * va + 2 * acc * DS))
        if (vn < v[i]) v[i] = vn
      }
    // backward pass (braking)
    for (let pass = 0; pass < 2; pass++)
      for (let j = n - 1; j >= 0; j--) {
        const i = j,
          b = (j + 1) % n
        const vb = v[b]
        const latG = vb * vb * Math.abs(this.racingCurv[b])
        let maxA = muAt(p.brakeMu, vb * vb) * (g + rho * p.clA_m * vb * vb)
        const rb = p.rearBrake
        if (rb) {
          // the brake balance: the deceleration at which the rear axle (unloaded by the braking,
          // carrying 1 - bias of the brake force) reaches its friction limit
          const mr = muAt(rb.mu, vb * vb)
          maxA = Math.min(maxA, (mr * (g * rb.wr + rho * p.clA_m * vb * vb * rb.aeroR)) / (1 - rb.bf + mr * rb.hL))
        }
        // braking left over by the cornering: friction ellipse (trailExp 0.5), or less when the rear
        // axle, unloaded by the braking, limits combined braking and turning (trailExp > 0.5)
        const f = Math.min(1, latG / maxA)
        const avail = maxA * Math.pow(1 - f * f, p.trailExp ?? 0.5) * 0.9 + rho * p.cdA_m * vb * vb
        const vn = Math.sqrt(vb * vb + 2 * avail * DS)
        if (vn < v[i]) v[i] = vn
      }
    if (!out) this.speed = v
    return v
  }

  /** Lap time estimate from a speed profile */
  lapTime(v: Float32Array) {
    let t = 0
    for (let i = 0; i < this.n; i++) t += DS / Math.max(v[i], 1)
    return t
  }
}

function catmull(p0: { x: number; z: number; y?: number }, p1: typeof p0, p2: typeof p0, p3: typeof p0, t: number) {
  // centripetal parameterisation on xz distance
  const alpha = 0.5
  const d = (a: typeof p0, b: typeof p0) => Math.pow(Math.hypot(b.x - a.x, b.z - a.z), alpha) || 1e-4
  const t0 = 0,
    t1 = t0 + d(p0, p1),
    t2 = t1 + d(p1, p2),
    t3 = t2 + d(p2, p3)
  const tt = t1 + (t2 - t1) * t
  const comp = (a: number, b: number, c: number, e: number) => {
    const A1 = ((t1 - tt) / (t1 - t0)) * a + ((tt - t0) / (t1 - t0)) * b
    const A2 = ((t2 - tt) / (t2 - t1)) * b + ((tt - t1) / (t2 - t1)) * c
    const A3 = ((t3 - tt) / (t3 - t2)) * c + ((tt - t2) / (t3 - t2)) * e
    const B1 = ((t2 - tt) / (t2 - t0)) * A1 + ((tt - t0) / (t2 - t0)) * A2
    const B2 = ((t3 - tt) / (t3 - t1)) * A2 + ((tt - t1) / (t3 - t1)) * A3
    return ((t2 - tt) / (t2 - t1)) * B1 + ((tt - t1) / (t2 - t1)) * B2
  }
  return [comp(p0.x, p1.x, p2.x, p3.x), comp(p0.y ?? 0, p1.y ?? 0, p2.y ?? 0, p3.y ?? 0), comp(p0.z, p1.z, p2.z, p3.z)] as const
}

/** circular moving average in place */
export function smoothArray(a: Float32Array | Float64Array, radius: number) {
  const n = a.length
  const src = Float64Array.from(a)
  let acc = 0
  for (let k = -radius; k <= radius; k++) acc += src[(k + n) % n]
  const w = 2 * radius + 1
  for (let i = 0; i < n; i++) {
    a[i] = acc / w
    acc += src[(i + radius + 1) % n] - src[(i - radius + n) % n]
  }
}
