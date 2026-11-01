// Signed distance field toolkit + Surface Nets mesher used to sculpt car bodies procedurally.

export type SDF = (x: number, y: number, z: number) => number

export const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}
export const smax = (a: number, b: number, k: number) => -smin(-a, -b, k)

/** Fast evaluator for a smooth curve through (t, value) keys (Catmull-Rom, clamped ends). */
export function curve(input: [number, number][], res = 0.005) {
  const keys = [...input].sort((a, b) => a[0] - b[0])
  const t0 = keys[0][0],
    t1 = keys[keys.length - 1][0]
  const n = Math.ceil((t1 - t0) / res) + 1
  const lut = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = t0 + i * res
    let k = 0
    while (k < keys.length - 2 && keys[k + 1][0] < t) k++
    const p0 = keys[Math.max(0, k - 1)],
      p1 = keys[k],
      p2 = keys[k + 1],
      p3 = keys[Math.min(keys.length - 1, k + 2)]
    const u = Math.min(1, Math.max(0, (t - p1[0]) / (p2[0] - p1[0])))
    // non-uniform tangents
    const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0] || 1)) * (p2[0] - p1[0])
    const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0] || 1)) * (p2[0] - p1[0])
    const u2 = u * u,
      u3 = u2 * u
    lut[i] = (2 * u3 - 3 * u2 + 1) * p1[1] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2[1] + (u3 - u2) * m2
  }
  return (t: number) => {
    const f = (t - t0) / res
    if (f <= 0) return lut[0]
    if (f >= n - 1) return lut[n - 1]
    const i = Math.floor(f)
    const a = f - i
    return lut[i] * (1 - a) + lut[i + 1] * a
  }
}

/** 2D symmetric trapezoid (bottom half-width r1, top half-width r2, half-height he), centred. */
export function sdTrapezoid(px: number, py: number, r1: number, r2: number, he: number) {
  px = Math.abs(px)
  const k1x = r2,
    k1y = he
  const k2x = r2 - r1,
    k2y = 2 * he
  const cax = px - Math.min(px, py < 0 ? r1 : r2),
    cay = Math.abs(py) - he
  const t = Math.min(1, Math.max(0, ((k1x - px) * k2x + (k1y - py) * k2y) / (k2x * k2x + k2y * k2y)))
  const cbx = px - k1x + k2x * t,
    cby = py - k1y + k2y * t
  const s = cbx < 0 && cay < 0 ? -1 : 1
  return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby))
}

export function sdRoundTrapezoid(px: number, py: number, r1: number, r2: number, he: number, r: number) {
  return sdTrapezoid(px, py, Math.max(r1 - r, 0.001), Math.max(r2 - r, 0.001), Math.max(he - r, 0.001)) - r
}

/** capped cylinder along X, centred at (cx,cy,cz), radius r, half length h */
export function sdCylX(x: number, y: number, z: number, cx: number, cy: number, cz: number, r: number, h: number) {
  const dr = Math.hypot(y - cy, z - cz) - r
  const dx = Math.abs(x - cx) - h
  return Math.min(Math.max(dr, dx), 0) + Math.hypot(Math.max(dr, 0), Math.max(dx, 0))
}

export function sdEllipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz)
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz))
  return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz)
}

export function sdBox(x: number, y: number, z: number, bx: number, by: number, bz: number, r = 0) {
  const qx = Math.abs(x) - bx + r,
    qy = Math.abs(y) - by + r,
    qz = Math.abs(z) - bz + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r
}

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
}

/**
 * Surface Nets over a regular grid. Vertices are placed at the mean of edge crossings and then
 * projected onto the zero set with a Newton step; normals come from the field gradient.
 */
export function surfaceNets(f: SDF, min: [number, number, number], max: [number, number, number], cell: number): MeshData {
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1
  const ny = Math.ceil((max[1] - min[1]) / cell) + 1
  const nz = Math.ceil((max[2] - min[2]) / cell) + 1
  const field = new Float32Array(nx * ny * nz)
  const id = (i: number, j: number, k: number) => i + nx * (j + ny * k)
  for (let k = 0; k < nz; k++) {
    const z = min[2] + k * cell
    for (let j = 0; j < ny; j++) {
      const y = min[1] + j * cell
      for (let i = 0; i < nx; i++) field[id(i, j, k)] = f(min[0] + i * cell, y, z)
    }
  }
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1)
  const cid = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k)
  const pos: number[] = []
  const corner = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ]
  const edges = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ]
  const v = new Float32Array(8)
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0
        for (let c = 0; c < 8; c++) {
          const val = field[id(i + corner[c][0], j + corner[c][1], k + corner[c][2])]
          v[c] = val
          if (val < 0) mask |= 1 << c
        }
        if (mask === 0 || mask === 255) continue
        let sx = 0,
          sy = 0,
          sz = 0,
          cnt = 0
        for (const [a, b] of edges) {
          const va = v[a],
            vb = v[b]
          if (va < 0 === vb < 0) continue
          const t = va / (va - vb)
          sx += corner[a][0] + (corner[b][0] - corner[a][0]) * t
          sy += corner[a][1] + (corner[b][1] - corner[a][1]) * t
          sz += corner[a][2] + (corner[b][2] - corner[a][2]) * t
          cnt++
        }
        cellVert[cid(i, j, k)] = pos.length / 3
        pos.push(min[0] + (i + sx / cnt) * cell, min[1] + (j + sy / cnt) * cell, min[2] + (k + sz / cnt) * cell)
      }
  // faces: for every grid edge with a sign change, connect the 4 surrounding cells
  const idx: number[] = []
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const v0 = field[id(i, j, k)]
        const in0 = v0 < 0
        // x edge (i,j,k)-(i+1,j,k): cells (i, j-1..j, k-1..k)
        if (i < nx - 1) {
          const v1 = field[id(i + 1, j, k)]
          if (in0 !== v1 < 0) {
            const a = cellVert[cid(i, j - 1, k - 1)],
              b = cellVert[cid(i, j, k - 1)],
              c = cellVert[cid(i, j, k)],
              d = cellVert[cid(i, j - 1, k)]
            if (a >= 0 && b >= 0 && c >= 0 && d >= 0) quad(idx, a, b, c, d, in0)
          }
        }
        if (j < ny - 1) {
          const v1 = field[id(i, j + 1, k)]
          if (in0 !== v1 < 0) {
            const a = cellVert[cid(i - 1, j, k - 1)],
              b = cellVert[cid(i - 1, j, k)],
              c = cellVert[cid(i, j, k)],
              d = cellVert[cid(i, j, k - 1)]
            if (a >= 0 && b >= 0 && c >= 0 && d >= 0) quad(idx, a, b, c, d, in0)
          }
        }
        if (k < nz - 1) {
          const v1 = field[id(i, j, k + 1)]
          if (in0 !== v1 < 0) {
            const a = cellVert[cid(i - 1, j - 1, k)],
              b = cellVert[cid(i, j - 1, k)],
              c = cellVert[cid(i, j, k)],
              d = cellVert[cid(i - 1, j, k)]
            if (a >= 0 && b >= 0 && c >= 0 && d >= 0) quad(idx, a, b, c, d, in0)
          }
        }
      }
  // project onto surface & compute normals from gradient
  const positions = new Float32Array(pos)
  const normals = new Float32Array(pos.length)
  const e = cell * 0.25
  for (let p = 0; p < positions.length; p += 3) {
    let x = positions[p],
      y = positions[p + 1],
      z = positions[p + 2]
    for (let it = 0; it < 2; it++) {
      const d = f(x, y, z)
      let gx = f(x + e, y, z) - f(x - e, y, z)
      let gy = f(x, y + e, z) - f(x, y - e, z)
      let gz = f(x, y, z + e) - f(x, y, z - e)
      const gl = Math.hypot(gx, gy, gz) || 1
      gx /= gl
      gy /= gl
      gz /= gl
      const step = Math.max(-cell, Math.min(cell, d))
      x -= gx * step
      y -= gy * step
      z -= gz * step
      normals[p] = gx
      normals[p + 1] = gy
      normals[p + 2] = gz
    }
    positions[p] = x
    positions[p + 1] = y
    positions[p + 2] = z
  }
  return { positions, normals, indices: new Uint32Array(idx) }
}

function quad(idx: number[], a: number, b: number, c: number, d: number, flip: boolean) {
  if (flip) idx.push(a, b, c, a, c, d)
  else idx.push(a, c, b, a, d, c)
}
