// Minimal allocation-free math for the physics hot loop.
// Conventions (car local frame): +x = left, +y = up, +z = forward. World is three.js Y-up.

export class V3 {
  x: number
  y: number
  z: number
  constructor(x = 0, y = 0, z = 0) {
    this.x = x
    this.y = y
    this.z = z
  }
  set(x: number, y: number, z: number) {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
  copy(v: V3) {
    this.x = v.x
    this.y = v.y
    this.z = v.z
    return this
  }
  add(v: V3) {
    this.x += v.x
    this.y += v.y
    this.z += v.z
    return this
  }
  sub(v: V3) {
    this.x -= v.x
    this.y -= v.y
    this.z -= v.z
    return this
  }
  scale(s: number) {
    this.x *= s
    this.y *= s
    this.z *= s
    return this
  }
  addScaled(v: V3, s: number) {
    this.x += v.x * s
    this.y += v.y * s
    this.z += v.z * s
    return this
  }
  dot(v: V3) {
    return this.x * v.x + this.y * v.y + this.z * v.z
  }
  len() {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z)
  }
  lenSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z
  }
  normalize() {
    const l = this.len()
    if (l > 1e-12) this.scale(1 / l)
    return this
  }
  /** this = a x b */
  crossVectors(a: V3, b: V3) {
    const ax = a.x,
      ay = a.y,
      az = a.z,
      bx = b.x,
      by = b.y,
      bz = b.z
    this.x = ay * bz - az * by
    this.y = az * bx - ax * bz
    this.z = ax * by - ay * bx
    return this
  }
  subVectors(a: V3, b: V3) {
    this.x = a.x - b.x
    this.y = a.y - b.y
    this.z = a.z - b.z
    return this
  }
  isFinite() {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z)
  }
}

export class Quat {
  x = 0
  y = 0
  z = 0
  w = 1
  set(x: number, y: number, z: number, w: number) {
    this.x = x
    this.y = y
    this.z = z
    this.w = w
    return this
  }
  copy(q: Quat) {
    this.x = q.x
    this.y = q.y
    this.z = q.z
    this.w = q.w
    return this
  }
  setFromAxisAngle(ax: number, ay: number, az: number, angle: number) {
    const h = angle / 2
    const s = Math.sin(h)
    this.x = ax * s
    this.y = ay * s
    this.z = az * s
    this.w = Math.cos(h)
    return this
  }
  multiply(q: Quat) {
    const ax = this.x,
      ay = this.y,
      az = this.z,
      aw = this.w
    const bx = q.x,
      by = q.y,
      bz = q.z,
      bw = q.w
    this.x = ax * bw + aw * bx + ay * bz - az * by
    this.y = ay * bw + aw * by + az * bx - ax * bz
    this.z = az * bw + aw * bz + ax * by - ay * bx
    this.w = aw * bw - ax * bx - ay * by - az * bz
    return this
  }
  normalize() {
    let l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w)
    if (l < 1e-12) {
      this.set(0, 0, 0, 1)
      return this
    }
    l = 1 / l
    this.x *= l
    this.y *= l
    this.z *= l
    this.w *= l
    return this
  }
  /** Integrate angular velocity (world frame) over dt. */
  integrate(w: V3, dt: number) {
    const hx = w.x * dt * 0.5,
      hy = w.y * dt * 0.5,
      hz = w.z * dt * 0.5
    const x = this.x,
      y = this.y,
      z = this.z,
      qw = this.w
    this.x += hx * qw + hy * z - hz * y
    this.y += hy * qw + hz * x - hx * z
    this.z += hz * qw + hx * y - hy * x
    this.w += -hx * x - hy * y - hz * z
    return this.normalize()
  }
}

/** Row-major 3x3 rotation matrix. Columns are the body axes in world space. */
export class M3 {
  e = new Float64Array(9)
  constructor() {
    this.e[0] = this.e[4] = this.e[8] = 1
  }
  setFromQuat(q: Quat) {
    const { x, y, z, w } = q
    const x2 = x + x,
      y2 = y + y,
      z2 = z + z
    const xx = x * x2,
      xy = x * y2,
      xz = x * z2
    const yy = y * y2,
      yz = y * z2,
      zz = z * z2
    const wx = w * x2,
      wy = w * y2,
      wz = w * z2
    const e = this.e
    e[0] = 1 - (yy + zz)
    e[1] = xy - wz
    e[2] = xz + wy
    e[3] = xy + wz
    e[4] = 1 - (xx + zz)
    e[5] = yz - wx
    e[6] = xz - wy
    e[7] = yz + wx
    e[8] = 1 - (xx + yy)
    return this
  }
  /** out = M * (x,y,z) (body -> world) */
  apply(x: number, y: number, z: number, out: V3) {
    const e = this.e
    out.x = e[0] * x + e[1] * y + e[2] * z
    out.y = e[3] * x + e[4] * y + e[5] * z
    out.z = e[6] * x + e[7] * y + e[8] * z
    return out
  }
  /** out = M^T * v (world -> body) */
  applyT(v: V3, out: V3) {
    const e = this.e
    const x = v.x,
      y = v.y,
      z = v.z
    out.x = e[0] * x + e[3] * y + e[6] * z
    out.y = e[1] * x + e[4] * y + e[7] * z
    out.z = e[2] * x + e[5] * y + e[8] * z
    return out
  }
  col(i: number, out: V3) {
    const e = this.e
    out.x = e[i]
    out.y = e[3 + i]
    out.z = e[6 + i]
    return out
  }
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}
export const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0)
export const RPM_TO_RADS = (2 * Math.PI) / 60
export const RADS_TO_RPM = 60 / (2 * Math.PI)
export const DEG = Math.PI / 180

/** Piecewise-linear lookup over sorted [x, y] pairs. */
export function lookup(table: ReadonlyArray<readonly [number, number]>, x: number) {
  const n = table.length
  if (x <= table[0][0]) return table[0][1]
  if (x >= table[n - 1][0]) return table[n - 1][1]
  let lo = 0,
    hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (table[mid][0] <= x) lo = mid
    else hi = mid
  }
  const [x0, y0] = table[lo]
  const [x1, y1] = table[hi]
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
}

/** Deterministic hash noise used by procedural surfaces (shared by physics and visuals). */
export function hash2(ix: number, iz: number) {
  let h = (ix * 374761393 + iz * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

export function valueNoise2(x: number, z: number) {
  const ix = Math.floor(x),
    iz = Math.floor(z)
  const fx = x - ix,
    fz = z - iz
  const ux = fx * fx * (3 - 2 * fx),
    uz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz),
    b = hash2(ix + 1, iz),
    c = hash2(ix, iz + 1),
    d = hash2(ix + 1, iz + 1)
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz
}
