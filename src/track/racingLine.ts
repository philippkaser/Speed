// Racing line: minimum-curvature path inside the usable width (asphalt plus flat kerbs), solved as the
// linearised QP  min Σ (n_j · (P_{j-1} - 2 P_j + P_{j+1}) / h_j²)²  over the lateral offsets α of the stations
// P_j = C_j + N_j α_j, under box bounds, by projected Gauss-Seidel / SOR, coarse to fine; the path normals n_j
// and spacings h_j are re-linearised around the current line every few sweeps.

import type { SideInfo } from './track'

/** half the car's width (widest GT3, 2.04 m) plus a margin for the AI's tracking error (~0.3 m at speed):
 *  the line runs the wheels to within a hand's width of the edge and over the flat kerbs */
export const LINE_EDGE_MARGIN = 1.02 + 0.35

export interface LineGeom {
  n: number
  px: ArrayLike<number>
  pz: ArrayLike<number>
  lx: ArrayLike<number>
  lz: ArrayLike<number>
  hw: ArrayLike<number>
  L: SideInfo
  R: SideInfo
}

/** Usable flat kerb width: the kerb (all kerbs here are 34 mm rumble strips a car can run over) with its ends
 *  eased in over ~15 m, so the line's bound never steps and the curvature stays continuous. */
function usableKerb(kerb: ArrayLike<number>) {
  const n = kerb.length
  const R1 = 7,
    R2 = 7
  const ero = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let m = Infinity
    for (let k = -R1; k <= R1; k++) m = Math.min(m, kerb[(i + k + n) % n])
    ero[i] = m
  }
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let a = 0
    for (let k = -R2; k <= R2; k++) a += ero[(i + k + n) % n]
    out[i] = a / (2 * R2 + 1)
  }
  return out
}

/** Per-sample bounds of the racing line's lateral offset (+ left). */
export function lineBounds(t: LineGeom) {
  const kl = usableKerb(t.L.kerb),
    kr = usableKerb(t.R.kerb)
  const lo = new Float32Array(t.n),
    hi = new Float32Array(t.n)
  for (let i = 0; i < t.n; i++) {
    hi[i] = t.hw[i] + kl[i] - LINE_EDGE_MARGIN
    lo[i] = -(t.hw[i] + kr[i] - LINE_EDGE_MARGIN)
  }
  return { lo, hi }
}

/** Minimum-curvature offsets at stations every `step` samples (m = n / step stations), from `init` if given. */
export function minCurvature(t: LineGeom, lo: Float32Array, hi: Float32Array, step: number, init?: Float64Array, sweeps = 600) {
  const m = Math.floor(t.n / step)
  const cx = new Float64Array(m),
    cz = new Float64Array(m),
    nx = new Float64Array(m),
    nz = new Float64Array(m),
    blo = new Float64Array(m),
    bhi = new Float64Array(m)
  for (let k = 0; k < m; k++) {
    const i = k * step
    cx[k] = t.px[i]
    cz[k] = t.pz[i]
    nx[k] = t.lx[i]
    nz[k] = t.lz[i]
    blo[k] = lo[i]
    bhi[k] = hi[i]
  }
  const a = init ?? new Float64Array(m)
  const X = new Float64Array(m),
    Z = new Float64Array(m),
    pnx = new Float64Array(m),
    pnz = new Float64Array(m),
    w = new Float64Array(m)
  const relinearise = () => {
    for (let k = 0; k < m; k++) {
      X[k] = cx[k] + nx[k] * a[k]
      Z[k] = cz[k] + nz[k] * a[k]
    }
    for (let k = 0; k < m; k++) {
      const p = (k - 1 + m) % m,
        q = (k + 1) % m
      const tx = X[q] - X[p],
        tz = Z[q] - Z[p]
      const l = Math.hypot(tx, tz) || 1
      pnx[k] = tz / l
      pnz[k] = -tx / l
      const h = 0.5 * l
      w[k] = 1 / (h * h)
    }
  }
  const omega = 1.85
  for (let sw = 0; sw < sweeps; sw++) {
    if (sw % 20 === 0) relinearise()
    for (let k = 0; k < m; k++) {
      let num = 0,
        den = 0
      for (let c = -1; c <= 1; c++) {
        const j = (k + c + m) % m,
          jp = (j - 1 + m) % m,
          jq = (j + 1) % m
        const rx = cx[jp] + nx[jp] * a[jp] - 2 * (cx[j] + nx[j] * a[j]) + cx[jq] + nx[jq] * a[jq]
        const rz = cz[jp] + nz[jp] * a[jp] - 2 * (cz[j] + nz[j] * a[j]) + cz[jq] + nz[jq] * a[jq]
        const e = w[j] * (pnx[j] * rx + pnz[j] * rz)
        const aj = (c === 0 ? -2 : 1) * w[j] * (pnx[j] * nx[k] + pnz[j] * nz[k])
        num += aj * e
        den += aj * aj
      }
      const v = a[k] - (omega * num) / den
      a[k] = v < blo[k] ? blo[k] : v > bhi[k] ? bhi[k] : v
    }
  }
  return a
}

/** Resample closed-loop station offsets to `mOut` stations by cubic interpolation. */
function resample(a: Float64Array, mOut: number) {
  const m = a.length
  const out = new Float64Array(mOut)
  for (let q = 0; q < mOut; q++) out[q] = cubic(a, (q * m) / mOut)
  return out
}

function cubic(a: ArrayLike<number>, x: number) {
  const m = a.length
  const k = Math.floor(x),
    f = x - k
  const p = a[(((k - 1) % m) + m) % m],
    b = a[k % m],
    c = a[(k + 1) % m],
    d = a[(k + 2) % m]
  const f2 = f * f,
    f3 = f2 * f
  return 0.5 * (2 * b + (-p + c) * f + (2 * p - 5 * b + 4 * c - d) * f2 + (-p + 3 * b - 3 * c + d) * f3)
}

/** Station offsets to per-sample offsets (Catmull-Rom), clamped to the per-sample bounds. */
export function expandStations(a: ArrayLike<number>, step: number, n: number, lo: Float32Array, hi: Float32Array, out = new Float32Array(n)) {
  const m = a.length
  for (let i = 0; i < n; i++) {
    const k = Math.min(Math.floor(i / step), m - 1)
    const span = k === m - 1 ? n - k * step : step
    const v = cubic(a, k + (i - k * step) / span)
    out[i] = Math.min(hi[i], Math.max(lo[i], v))
  }
  return out
}

export const LINE_STEP = 4

/** The minimum-curvature line at LINE_STEP stations, coarse (16 m) to fine (4 m). */
export function minCurvatureLine(t: LineGeom, lo: Float32Array, hi: Float32Array) {
  let a = minCurvature(t, lo, hi, 16, undefined, 1500)
  a = minCurvature(t, lo, hi, 8, resample(a, Math.floor(t.n / 8)), 600)
  return minCurvature(t, lo, hi, LINE_STEP, resample(a, Math.floor(t.n / LINE_STEP)), 400)
}
