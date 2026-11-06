// Geometry generation for the circuit: road, kerbs, runoff, verges, terrain, barriers, markings.
import * as THREE from 'three/webgpu'
import { inPitGap } from '../track/pitlane'
import { makeSample, Surface } from '../physics/ground'
import { clamp, lerp, smoothstep, valueNoise2 } from '../physics/math'
import { DS, type Track } from '../track/track'

const tmp = { x: 0, y: 0, z: 0 }

function finish(pos: number[], uv: number[], idx: number[], extra?: Record<string, { data: number[]; size: number }>) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  if (extra) for (const k in extra) g.setAttribute(k, new THREE.Float32BufferAttribute(extra[k].data, extra[k].size))
  g.setIndex(idx)
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

/** Generic ribbon along s with columns at lateral offsets returned by `cols(i)` */
function ribbon(track: Track, step: number, cols: (i: number) => number[] | null, lift = 0, extraFn?: (i: number, d: number, c: number, unwrapped: number) => number[], extraSize = 0, planarUV = 4) {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const ex: number[] = []
  let prevRow = -1
  let prevCount = 0
  const n = track.n
  for (let i = 0; i <= n; i += step) {
    const ii = i % n
    const c = cols(ii)
    if (!c) {
      prevRow = -1
      continue
    }
    const base = pos.length / 3
    for (let k = 0; k < c.length; k++) {
      track.pointAt(i * DS, c[k], tmp)
      pos.push(tmp.x, tmp.y + lift, tmp.z)
      uv.push(tmp.x / planarUV, tmp.z / planarUV)
      if (extraFn) ex.push(...extraFn(ii, c[k], k, i))
    }
    if (prevRow >= 0 && prevCount === c.length) {
      // columns increasing in d (towards the left) give upward-facing CCW triangles
      const flip = c[c.length - 1] < c[0]
      for (let k = 0; k < c.length - 1; k++) {
        const a = prevRow + k,
          b = prevRow + k + 1,
          cc = base + k,
          d = base + k + 1
        if (flip) idx.push(a, b, cc, b, d, cc)
        else idx.push(a, cc, b, b, cc, d)
      }
    }
    prevRow = base
    prevCount = c.length
  }
  return finish(pos, uv, idx, extraFn ? { aTrack: { data: ex, size: extraSize } } : undefined)
}

/**
 * Where tyres leave their marks: braking zones (the physics' own weights) and traction zones (hard
 * acceleration out of slow corners: wheelspin), per centreline sample.
 */
function skidZones(track: Track) {
  const n = track.n
  const traction = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = track.speed[i]
    const dv = track.speed[(i + 4) % n] - v
    traction[i] = clamp(dv / 0.9, 0, 1) * (1 - smoothstep(24, 46, v))
  }
  // spread over ~15 m
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = -8; k <= 8; k++) s += traction[(i + k + n) % n]
    out[i] = Math.min(1, (s / 17) * 1.6)
  }
  return out
}

export function buildRoad(track: Track) {
  // aTrack = (d, s, racingLineOffset, halfWidth); aTrack2 = (braking zone, traction zone, 0, 0)
  const g = buildRoadRibbon(track)
  const tr = g.getAttribute('aTrack') as THREE.BufferAttribute
  const zones = skidZones(track)
  const a2 = new Float32Array(tr.count * 4)
  for (let v = 0; v < tr.count; v++) {
    const i = track.idx(tr.getY(v))
    a2[v * 4] = track.brakeZone[i]
    a2[v * 4 + 1] = zones[i]
  }
  g.setAttribute('aTrack2', new THREE.BufferAttribute(a2, 4))
  return g
}

function buildRoadRibbon(track: Track) {
  return ribbon(
    track,
    2,
    (i) => {
      const hw = track.hw[i]
      const c: number[] = []
      const N = 12
      for (let k = 0; k <= N; k++) c.push(-hw + (2 * hw * k) / N)
      return c
    },
    0,
    // s unwrapped: continuous across the start line (the last row is s = length, not 0)
    (i, d, _c, u) => [d, u * DS, track.racing[i], track.hw[i]],
    4,
  )
}

export function buildKerbs(track: Track) {
  const geoms: THREE.BufferGeometry[] = []
  for (const side of [1, -1]) {
    const S = side > 0 ? track.L : track.R
    // u across 0..1, s along
    geoms.push(
      ribbon(
        track,
        1,
        (i) => {
          const k = S.kerb[i]
          if (k <= 0) return null
          const hw = track.hw[i]
          const c: number[] = []
          const N = 6
          for (let j = 0; j <= N; j++) c.push(side * (hw + (k * j) / N - (j === 0 ? 0.02 : 0)))
          return c
        },
        0.002,
        (i, d, _c, u) => [(Math.abs(d) - track.hw[i]) / Math.max(S.kerb[i], 0.01), u * DS, side, S.kerb[i]],
        4,
      ),
    )
  }
  return mergeGeoms(geoms)
}

export function buildRunoff(track: Track) {
  const geoms: THREE.BufferGeometry[] = []
  for (const side of [1, -1]) {
    const S = side > 0 ? track.L : track.R
    geoms.push(
      ribbon(
        track,
        2,
        (i) => {
          const p = S.paved[i]
          if (p < 0.4) return null
          const e = track.hw[i] + S.kerb[i]
          return [side * (e - 0.05), side * (e + p * 0.5), side * (e + p)]
        },
        -0.002,
        (i, d, _c, u) => [d, u * DS, side, track.hw[i] + S.kerb[i]],
        4,
      ),
    )
  }
  return mergeGeoms(geoms)
}

/** Grass/gravel verge from the end of the paved area out past the barrier. aTrack.x = gravel weight */
export function buildVerge(track: Track) {
  const geoms: THREE.BufferGeometry[] = []
  for (const side of [1, -1]) {
    const S = side > 0 ? track.L : track.R
    geoms.push(
      ribbon(
        track,
        2,
        (i) => {
          const e = track.hw[i] + S.kerb[i]
          const p = Math.max(S.paved[i], 0)
          const start = e + (p >= 0.4 ? p - 0.05 : -0.02)
          const end = S.wall[i] + 10
          const c: number[] = []
          const N = 8
          for (let k = 0; k <= N; k++) c.push(side * lerp(start, end, Math.pow(k / N, 1.3)))
          return c
        },
        0,
        (i, d) => {
          const gravel = S.outer[i] === Surface.Gravel ? 1 : 0
          const ad = Math.abs(d)
          const inTrap = ad < S.wall[i] - 1.5 ? gravel : 0
          return [inTrap, i * DS, ad - S.wall[i], 0]
        },
        4,
        8,
      ),
    )
  }
  return mergeGeoms(geoms)
}

export function mergeGeoms(geoms: THREE.BufferGeometry[]) {
  const pos: number[] = [],
    uv: number[] = [],
    nrm: number[] = [],
    idx: number[] = []
  const extra: Record<string, number[]> = {}
  const sizes: Record<string, number> = {}
  let off = 0
  for (const g of geoms) {
    const p = g.getAttribute('position')
    if (!p) continue
    pos.push(...(p.array as Float32Array))
    uv.push(...((g.getAttribute('uv')?.array as Float32Array) ?? new Float32Array(p.count * 2)))
    nrm.push(...(g.getAttribute('normal').array as Float32Array))
    for (const name of Object.keys(g.attributes)) {
      if (name === 'position' || name === 'uv' || name === 'normal') continue
      const a = g.getAttribute(name)
      ;(extra[name] ??= []).push(...(a.array as Float32Array))
      sizes[name] = a.itemSize
    }
    const ix = g.getIndex()
    if (ix) for (let k = 0; k < ix.count; k++) idx.push(ix.getX(k) + off)
    off += p.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  for (const k in extra) out.setAttribute(k, new THREE.Float32BufferAttribute(extra[k], sizes[k]))
  out.setIndex(idx)
  out.computeBoundingSphere()
  return out
}

// ------------------------------------------------------------------------------------ terrain

/** Smooth base height field from the track elevation (inverse distance weighting), cached on a coarse grid. */
export class TerrainHeight {
  cx: Float32Array
  cz: Float32Array
  cy: Float32Array
  sample = makeSample()
  private gStep = 24
  private gx0: number
  private gz0: number
  private gnx: number
  private gnz: number
  private gBase: Float32Array
  private gDist: Float32Array
  constructor(
    public track: Track,
    margin = 900,
  ) {
    const step = 20
    const m = Math.floor(track.n / step)
    this.cx = new Float32Array(m)
    this.cz = new Float32Array(m)
    this.cy = new Float32Array(m)
    for (let k = 0; k < m; k++) {
      const i = k * step
      this.cx[k] = track.px[i]
      this.cz[k] = track.pz[i]
      this.cy[k] = track.py[i]
    }
    this.gx0 = track.minX - margin
    this.gz0 = track.minZ - margin
    this.gnx = Math.ceil((track.maxX - track.minX + 2 * margin) / this.gStep) + 2
    this.gnz = Math.ceil((track.maxZ - track.minZ + 2 * margin) / this.gStep) + 2
    this.gBase = new Float32Array(this.gnx * this.gnz)
    this.gDist = new Float32Array(this.gnx * this.gnz)
    for (let j = 0; j < this.gnz; j++)
      for (let i = 0; i < this.gnx; i++) {
        const r = this.baseExact(this.gx0 + i * this.gStep, this.gz0 + j * this.gStep)
        this.gBase[j * this.gnx + i] = r.h
        this.gDist[j * this.gnx + i] = r.dist
      }
  }

  private baseExact(x: number, z: number) {
    let ws = 0,
      hs = 0,
      dmin = Infinity
    const cx = this.cx,
      cz = this.cz,
      cy = this.cy
    for (let k = 0; k < cx.length; k++) {
      const dx = cx[k] - x,
        dz = cz[k] - z
      const d2 = dx * dx + dz * dz
      if (d2 < dmin) dmin = d2
      const q = d2 + 400
      const w = 1 / (q * Math.sqrt(q))
      ws += w
      hs += w * cy[k]
    }
    return { h: hs / ws, dist: Math.sqrt(dmin) }
  }

  /** bilinear lookup of the cached base height and track distance */
  base(x: number, z: number) {
    const fx = clamp((x - this.gx0) / this.gStep, 0, this.gnx - 1.001)
    const fz = clamp((z - this.gz0) / this.gStep, 0, this.gnz - 1.001)
    const i = Math.floor(fx),
      j = Math.floor(fz)
    const tx = fx - i,
      tz = fz - j
    const k = j * this.gnx + i
    const bl = (a: Float32Array) => lerp(lerp(a[k], a[k + 1], tx), lerp(a[k + this.gnx], a[k + this.gnx + 1], tx), tz)
    return { h: bl(this.gBase), dist: bl(this.gDist) }
  }

  hills(x: number, z: number) {
    let v = 0,
      a = 1,
      f = 1 / 420
    for (let o = 0; o < 5; o++) {
      v += (valueNoise2(x * f + 31.7, z * f - 11.3) - 0.5) * a
      a *= 0.5
      f *= 2.03
    }
    return v
  }

  /** Final terrain height */
  height(x: number, z: number) {
    const tr = this.track
    const b = this.base(x, z)
    const far = b.h + this.hills(x, z) * 34 * smoothstep(40, 420, b.dist) + Math.max(0, b.dist - 700) * 0.12
    // far from the circuit the exact track query is unnecessary
    if (b.dist > 200) {
      this.lastWallDist = b.dist
      return far
    }
    // global nearest lookup: a hint carried along a grid row can stay latched onto another part of
    // the circuit (two sections ~100 m apart at s 1390-1530), which raised the ground over the road
    this.sample.hint = -1
    tr.sample(x, z, this.sample)
    const s = this.sample
    const i = tr.idx(s.s)
    const side = s.d >= 0 ? 1 : -1
    const S = side > 0 ? tr.L : tr.R
    const ad = Math.abs(s.d)
    const wallEnd = S.wall[i] + 10
    this.lastWallDist = ad - S.wall[i]
    const t = smoothstep(wallEnd, wallEnd + 70, ad)
    if (t >= 1) return far
    // height continuing the verge (track profile) up to the end of the verge strip
    const nearH = tr.pointAt(s.s, side * Math.min(ad, wallEnd), tmp).y - 0.06
    return lerp(nearH, far, t)
  }
  lastWallDist = 0
}

export function buildTerrain(track: Track, res = 6, margin = 650) {
  const th = new TerrainHeight(track)
  const x0 = track.minX - margin,
    x1 = track.maxX + margin
  const z0 = track.minZ - margin,
    z1 = track.maxZ + margin
  const nx = Math.ceil((x1 - x0) / res) + 1,
    nz = Math.ceil((z1 - z0) / res) + 1
  const pos = new Float32Array(nx * nz * 3)
  const uv = new Float32Array(nx * nz * 2)
  const ex = new Float32Array(nx * nz * 4)
  for (let j = 0; j < nz; j++) {
    th.sample.hint = -1
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * res,
        z = z0 + j * res
      const k = j * nx + i
      const y = th.height(x, z)
      pos[k * 3] = x
      pos[k * 3 + 1] = y
      pos[k * 3 + 2] = z
      uv[k * 2] = x / 8
      uv[k * 2 + 1] = z / 8
      ex[k * 4] = th.lastWallDist
    }
  }
  const idx: number[] = []
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i,
        b = a + 1,
        c = a + nx,
        d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setAttribute('aTrack', new THREE.BufferAttribute(ex, 4))
  g.setIndex(idx)
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return { geometry: g, heights: th, bounds: { x0, x1, z0, z1 } }
}

/** The mountains around the valley (scenery/mountains.ts). */
export { buildMountains, type MountainSet } from './scenery/mountains'

// ------------------------------------------------------------------------------------ barriers

export interface BarrierRun {
  side: number
  start: number
  end: number
  kind: 'armco' | 'concrete' | 'tyres'
}

/** Decide barrier type per sample: concrete pit wall on the main straight, tyre walls on slow corner outsides */
export function barrierKinds(track: Track) {
  const kinds: Record<number, Uint8Array> = { 1: new Uint8Array(track.n), [-1]: new Uint8Array(track.n) }
  for (const side of [1, -1]) {
    const S = side > 0 ? track.L : track.R
    const k = kinds[side]
    for (let i = 0; i < track.n; i++) {
      const s = i * DS
      const onStraight = s > track.length - 380 || s < 420
      if (side > 0 && inPitGap(track, s)) k[i] = 3 // opening for the pit road
      else if (onStraight) k[i] = 1 // concrete
      else if (S.outer[i] === Surface.Gravel && track.speed[i] < 46) k[i] = 2 // tyre wall
      else k[i] = 0
    }
  }
  return kinds
}

/** Armco W-beam rails (double) + concrete walls as one ribbon geometry each. */
export function buildBarriers(track: Track) {
  const kinds = barrierKinds(track)
  const armco: THREE.BufferGeometry[] = []
  const concrete: THREE.BufferGeometry[] = []
  const posts: THREE.Matrix4[] = []
  const tyres: THREE.Matrix4[] = []
  const fence: THREE.BufferGeometry[] = []
  for (const side of [1, -1]) {
    const S = side > 0 ? track.L : track.R
    const K = kinds[side]
    // W-beam profile (lateral offset outward, height) for two stacked beams
    const beam = (h0: number) => [
      [0, h0],
      [0.04, h0 + 0.05],
      [0.0, h0 + 0.1],
      [0.04, h0 + 0.15],
      [0, h0 + 0.2],
    ]
    const prof = [...beam(0.42), ...beam(0.72)]
    const make = (kind: number, profile: number[][], step: number, target: THREE.BufferGeometry[], closed = false) => {
      const pos: number[] = [],
        uv: number[] = [],
        idx: number[] = []
      let prev = -1
      for (let i = 0; i <= track.n; i += step) {
        const ii = i % track.n
        if (K[ii] !== kind) {
          prev = -1
          continue
        }
        const base = pos.length / 3
        const w = S.wall[ii]
        track.pointAt(i * DS, side * w, tmp)
        const gy = tmp.y
        for (const [o, h] of profile) {
          const ox = track.px[ii] + track.lx[ii] * side * (w + o),
            oz = track.pz[ii] + track.lz[ii] * side * (w + o)
          pos.push(ox, gy + h, oz)
          uv.push(i * DS, h)
        }
        if (prev >= 0) {
          const m = profile.length
          for (let k = 0; k < m - 1; k++) {
            if (!closed && k === 4) continue // gap between the two beams
            const a = prev + k,
              b = prev + k + 1,
              c = base + k,
              d = base + k + 1
            idx.push(a, b, c, b, d, c)
          }
        }
        prev = base
      }
      if (pos.length) target.push(finish(pos, uv, idx))
    }
    make(0, prof, 2, armco)
    // concrete wall: trapezoid section
    make(
      1,
      [
        [-0.25, -0.2],
        [-0.25, 0.75],
        [-0.12, 0.95],
        [0.18, 0.95],
        [0.25, 0.75],
        [0.25, -0.2],
      ],
      2,
      concrete,
      true,
    )
    // posts every 2 m for armco, tyre stacks for tyre walls
    for (let i = 0; i < track.n; i += 2) {
      const w = S.wall[i]
      if (K[i] === 0) {
        track.pointAt(i * DS, side * (w + 0.12), tmp)
        const m = new THREE.Matrix4().makeRotationY(Math.atan2(track.tx[i], track.tz[i]))
        m.setPosition(tmp.x, tmp.y, tmp.z)
        posts.push(m)
      } else if (K[i] === 2) {
        for (let row = 0; row < 2; row++)
          for (let lvl = 0; lvl < 3; lvl++) {
            const o = w - 0.35 + row * 0.62
            track.pointAt(i * DS + (row % 2) * 0.3, side * o, tmp)
            const m = new THREE.Matrix4().makeTranslation(tmp.x, tmp.y + 0.11 + lvl * 0.22, tmp.z)
            tyres.push(m)
          }
      }
    }
    // catch fence on fast sections & the straight
    const fpos: number[] = [],
      fuv: number[] = [],
      fidx: number[] = []
    let prev = -1
    for (let i = 0; i <= track.n; i += 4) {
      const ii = i % track.n
      const want = (track.speed[ii] > 45 || K[ii] === 1) && K[ii] !== 3
      if (!want) {
        prev = -1
        continue
      }
      const w = S.wall[ii] + 0.6
      track.pointAt(i * DS, side * w, tmp)
      const base = fpos.length / 3
      fpos.push(tmp.x, tmp.y + 0.9, tmp.z, tmp.x, tmp.y + 4.2, tmp.z)
      fuv.push(i * DS, 0.9, i * DS, 4.2)
      if (prev >= 0) fidx.push(prev, prev + 1, base, prev + 1, base + 1, base)
      prev = base
    }
    if (fpos.length) fence.push(finish(fpos, fuv, fidx))
  }
  return { armco: mergeGeoms(armco), concrete: mergeGeoms(concrete), posts, tyres, fence: mergeGeoms(fence) }
}

// ------------------------------------------------------------------------------------ markings

/** Painted markings: start/finish line, grid slots. White decals lying on the asphalt. */
export function buildMarkings(track: Track, gridSlots: number) {
  const pos: number[] = [],
    uv: number[] = [],
    idx: number[] = []
  const quad = (s0: number, s1: number, d0: number, d1: number, u = 0) => {
    const base = pos.length / 3
    for (const [s, d] of [
      [s0, d0],
      [s0, d1],
      [s1, d0],
      [s1, d1],
    ]) {
      track.pointAt(s, d, tmp)
      pos.push(tmp.x, tmp.y + 0.006, tmp.z)
      uv.push(u, 0)
    }
    idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
  }
  const hw = track.hw[0]
  // start/finish: checkered band
  const cells = 14
  for (let c = 0; c < cells; c++)
    for (let r = 0; r < 2; r++) {
      const d0 = -hw + ((2 * hw) / cells) * c
      const d1 = d0 + (2 * hw) / cells
      quad(r * 0.6 - 0.6, r * 0.6, d0, d1, (c + r) % 2)
    }
  // grid slots: "[" shaped boxes
  for (let i = 0; i < gridSlots; i++) {
    const s = -14 - i * 9 - (i % 2) * 4.5
    const d = i % 2 === 0 ? 2.6 : -2.6
    quad(s + 2.2, s + 2.4, d - 1.4, d + 1.4, 1)
    quad(s - 2.6, s + 2.4, d - 1.4, d - 1.25, 1)
    quad(s - 2.6, s + 2.4, d + 1.25, d + 1.4, 1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

export { clamp }
