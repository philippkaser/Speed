// Procedural architecture kit: buildings are assembled from boxes, quads, beams, extruded profiles and
// cylinders into ONE merged geometry per material, the surface of every face described per vertex:
//   color  linear albedo
//   aPbr   roughness, metalness, emission (radiance per unit albedo: lit interiors, light panels), ao
//   aPat   procedural pattern (archMaterial: concrete, cladding panels, ribbed metal, ...)
//   uv     metres along the face (patterns) or atlas coordinates (signs)
// Faces are flat (own vertices), so normals are exact and nothing needs computeVertexNormals.
import * as THREE from 'three/webgpu'
import type { Track } from '../../track/track'

export const enum Pat {
  Plain = 0,
  Concrete = 1,
  Cladding = 2,
  Ribbed = 3,
  Steel = 4,
  Floor = 5,
  Plastic = 6,
}

export interface Surf {
  /** linear albedo */
  c: readonly [number, number, number]
  r: number
  m?: number
  /** emission: radiance = albedo * e */
  e?: number
  ao?: number
  p?: Pat
}

export const surf = (c: readonly [number, number, number], r: number, o: Partial<Surf> = {}): Surf => ({ c, r, ...o })

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _d = new THREE.Vector3()
const _n = new THREE.Vector3()
const _u = new THREE.Vector3()
const _v = new THREE.Vector3()
const _w = new THREE.Vector3()

export class Kit {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  col: number[] = []
  pbr: number[] = []
  pat: number[] = []
  /** height above the frame's ground (local y): the grime splashed up from the ground */
  lh: number[] = []
  idx: number[] = []
  /** extra per-vertex attributes (e.g. the glass' rooms), set by the caller per face */
  extra: Record<string, { size: number; data: number[]; cur: number[] }> = {}
  /** local -> world */
  m = new THREE.Matrix4()
  private nm = new THREE.Matrix3()

  setFrame(m: THREE.Matrix4) {
    this.m.copy(m)
    this.nm.getNormalMatrix(m)
    return this
  }

  defineExtra(name: string, size: number, init: number[]) {
    this.extra[name] = { size, data: [], cur: init.slice() }
  }

  get vertexCount() {
    return this.pos.length / 3
  }

  private vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, s: Surf) {
    this.lh.push(p.y)
    _w.copy(p).applyMatrix4(this.m)
    this.pos.push(_w.x, _w.y, _w.z)
    _w.copy(n).applyMatrix3(this.nm).normalize()
    this.nrm.push(_w.x, _w.y, _w.z)
    this.uv.push(u, v)
    this.col.push(s.c[0], s.c[1], s.c[2])
    this.pbr.push(s.r, s.m ?? 0, s.e ?? 0, s.ao ?? 1)
    this.pat.push(s.p ?? 0)
    for (const k in this.extra) this.extra[k].data.push(...this.extra[k].cur)
  }

  /**
   * Quad a b c d (counter-clockwise seen from the front), local coordinates. uv: metres along a->b and
   * a->d, or explicit corner uvs [ua, va, ub, vb, uc, vc, ud, vd].
   */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, s: Surf, uvs?: number[]) {
    _u.subVectors(b, a)
    _v.subVectors(d, a)
    _n.crossVectors(_u, _v)
    if (_n.lengthSq() < 1e-12) _n.crossVectors(_u, _c.subVectors(c, a))
    _n.normalize()
    const base = this.vertexCount
    if (uvs) {
      this.vert(a, _n, uvs[0], uvs[1], s)
      this.vert(b, _n, uvs[2], uvs[3], s)
      this.vert(c, _n, uvs[4], uvs[5], s)
      this.vert(d, _n, uvs[6], uvs[7], s)
    } else {
      // metres in the face's own plane, anchored at the local origin (continuous across faces)
      const ul = _u.length() || 1
      _u.divideScalar(ul)
      _v.crossVectors(_n, _u)
      const uv = (p: THREE.Vector3) => [p.dot(_u), p.dot(_v)] as const
      for (const p of [a, b, c, d]) {
        const [x, y] = uv(p)
        this.vert(p, _n, x, y, s)
      }
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  /** Axis-aligned box; faces: bit mask of +x -x +y -y +z -z (default all). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, s: Surf, faces = 0b111111) {
    const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    if (faces & 1) this.quad(P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), s)
    if (faces & 2) this.quad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), s)
    if (faces & 4) this.quad(P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), s)
    if (faces & 8) this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), s)
    if (faces & 16) this.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), s)
    if (faces & 32) this.quad(P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), s)
  }

  /** Box by centre and size. */
  boxC(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, s: Surf, faces = 0b111111) {
    this.box(cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2, s, faces)
  }

  /** A straight member from p0 to p1 with a w x h section (h along `up` projected off the axis). */
  beam(p0: THREE.Vector3, p1: THREE.Vector3, w: number, h: number, s: Surf, up = new THREE.Vector3(0, 1, 0), caps = false) {
    const ax = _a.subVectors(p1, p0)
    const len = ax.length()
    if (len < 1e-6) return
    ax.divideScalar(len)
    const upv = _b.copy(up)
    if (Math.abs(upv.dot(ax)) > 0.95) upv.set(1, 0, 0)
    const side = _c.crossVectors(ax, upv).normalize()
    const vup = _d.crossVectors(side, ax).normalize()
    const S = side.clone().multiplyScalar(w / 2),
      U = vup.clone().multiplyScalar(h / 2)
    const corner = (p: THREE.Vector3, sx: number, sy: number) => p.clone().addScaledVector(S, sx).addScaledVector(U, sy)
    const c0 = [corner(p0, -1, -1), corner(p0, 1, -1), corner(p0, 1, 1), corner(p0, -1, 1)]
    const c1 = [corner(p1, -1, -1), corner(p1, 1, -1), corner(p1, 1, 1), corner(p1, -1, 1)]
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4
      this.quad(c0[k], c1[k], c1[k2], c0[k2], s)
    }
    if (caps) {
      this.quad(c0[3], c0[2], c0[1], c0[0], s)
      this.quad(c1[0], c1[1], c1[2], c1[3], s)
    }
  }

  /**
   * A 2D profile in the local y-z plane ([y, z] points) extruded along x from x0 to x1. Faces point
   * outwards for a counter-clockwise profile seen from +x; `closed` joins the last point to the first,
   * `caps` closes the ends (convex profiles only).
   */
  extrudeX(profile: [number, number][], x0: number, x1: number, s: Surf | ((seg: number) => Surf), closed = false, caps = false) {
    const n = profile.length
    const P = (x: number, k: number) => new THREE.Vector3(x, profile[k][0], profile[k][1])
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const k2 = (k + 1) % n
      const sf = typeof s === 'function' ? s(k) : s
      this.quad(P(x0, k2), P(x1, k2), P(x1, k), P(x0, k), sf)
    }
    if (caps) {
      const sf = typeof s === 'function' ? s(-1) : s
      for (let k = 1; k < n - 1; k++) {
        this.tri(P(x1, 0), P(x1, k), P(x1, k + 1), sf)
        this.tri(P(x0, 0), P(x0, k + 1), P(x0, k), sf)
      }
    }
  }

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, s: Surf) {
    _u.subVectors(b, a)
    _v.subVectors(c, a)
    _n.crossVectors(_u, _v).normalize()
    const base = this.vertexCount
    const ul = _u.length() || 1
    _u.divideScalar(ul)
    _v.crossVectors(_n, _u)
    for (const p of [a, b, c]) this.vert(p, _n, p.dot(_u), p.dot(_v), s)
    this.idx.push(base, base + 1, base + 2)
  }

  /** Vertical cylinder (smooth sides, flat top cap). */
  cylinderY(x: number, z: number, y0: number, y1: number, r: number, segs: number, s: Surf, top = true) {
    const base = this.vertexCount
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * Math.PI * 2
      const cx = Math.cos(a),
        cz = Math.sin(a)
      _n.set(cx, 0, cz)
      this.vert(_a.set(x + cx * r, y0, z + cz * r), _n, (k / segs) * Math.PI * 2 * r, y0, s)
      this.vert(_a.set(x + cx * r, y1, z + cz * r), _n, (k / segs) * Math.PI * 2 * r, y1, s)
    }
    for (let k = 0; k < segs; k++) {
      const i = base + k * 2
      this.idx.push(i, i + 1, i + 3, i, i + 3, i + 2)
    }
    if (top) {
      const c = this.vertexCount
      _n.set(0, 1, 0)
      this.vert(_a.set(x, y1, z), _n, x, z, s)
      for (let k = 0; k <= segs; k++) {
        const a = (k / segs) * Math.PI * 2
        this.vert(_a.set(x + Math.cos(a) * r, y1, z + Math.sin(a) * r), _n, x + Math.cos(a) * r, z + Math.sin(a) * r, s)
      }
      for (let k = 0; k < segs; k++) this.idx.push(c, c + 2 + k, c + 1 + k)
    }
  }

  /** Horizontal cylinder along x (tyres in a rack, pipes). */
  cylinderX(x0: number, x1: number, y: number, z: number, r: number, segs: number, s: Surf) {
    const base = this.vertexCount
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * Math.PI * 2
      const cy = Math.cos(a),
        cz = Math.sin(a)
      _n.set(0, cy, cz)
      this.vert(_a.set(x0, y + cy * r, z + cz * r), _n, x0, (k / segs) * 6.283 * r, s)
      this.vert(_a.set(x1, y + cy * r, z + cz * r), _n, x1, (k / segs) * 6.283 * r, s)
    }
    for (let k = 0; k < segs; k++) {
      const i = base + k * 2
      this.idx.push(i, i + 3, i + 1, i, i + 2, i + 3)
    }
  }

  toGeometry() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setAttribute('aPbr', new THREE.Float32BufferAttribute(this.pbr, 4))
    g.setAttribute('aPat', new THREE.Float32BufferAttribute(this.pat, 1))
    g.setAttribute('aLh', new THREE.Float32BufferAttribute(this.lh, 1))
    for (const k in this.extra) g.setAttribute(k, new THREE.Float32BufferAttribute(this.extra[k].data, this.extra[k].size))
    const n = this.vertexCount
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1))
    g.computeBoundingSphere()
    return g
  }

  get triangles() {
    return this.idx.length / 3
  }
}

const _p = { x: 0, y: 0, z: 0 }

/**
 * A local frame on the track: origin at (s, d) on the ground, local +y up and local +z pointing along
 * +left (`towards` = 1: an object on the right of the track facing it) or -left (-1: on the left,
 * facing the track). Local +x follows (right-handed).
 */
export function trackFrame(track: Track, s: number, d: number, towards: 1 | -1, yLift = 0) {
  track.pointAt(s, d, _p)
  const i = track.idx(s)
  const lx = track.lx[i] * towards,
    lz = track.lz[i] * towards
  // X = Y x Z
  const X = new THREE.Vector3(lz, 0, -lx)
  const Y = new THREE.Vector3(0, 1, 0)
  const Z = new THREE.Vector3(lx, 0, lz)
  const m = new THREE.Matrix4().makeBasis(X, Y, Z)
  m.setPosition(_p.x, _p.y + yLift, _p.z)
  return m
}

/** sRGB hex -> linear albedo triple */
export function lin(hex: number, scale = 1): [number, number, number] {
  const c = new THREE.Color(hex)
  return [c.r * scale, c.g * scale, c.b * scale]
}
