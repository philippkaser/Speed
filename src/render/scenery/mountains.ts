// The mountains around the valley: a dense polar height field (1536 directions x 112 rings, ~170k
// vertices) from a domain-warped ridged multifractal, carved by its own drainage (flow accumulation
// along the steepest descent cuts gullies and valleys whose depth grows with the area they drain: the
// look of fluvial erosion), the high range standing behind forested foothills.
//
// Built as 12 sectors (frustum culling: the main view draws about a third of the ring), and the whole
// ring once more at every 4th vertex each way as one small mesh for the cars' reflection probes.
//
// aMtn per vertex: x drainage (0 on ridges .. 1 in the main valleys), y sun visibility (baked by
// marching the height field towards the sun: ridges cast their shadows into the valleys), z sky
// visibility (ambient occlusion from the local relief), w the ring parameter (0 at the valley, 1 at the
// far edge).
import * as THREE from 'three/webgpu'
import { fbm2, ridged2, smooth } from './noise'

export interface MountainSet {
  sectors: THREE.BufferGeometry[]
  /** the whole ring at every 4th vertex each way, one compact mesh: the reflection probes' level */
  probe: THREE.BufferGeometry
  /** re-bakes the sun visibility (aMtn.y) for a sun direction (towards the sun) */
  bakeSun(dir: { x: number; y: number; z: number }): void
  heightAt(x: number, z: number): number
}

export function buildMountains(center: THREE.Vector3, inner: number, outer: number, seed = 3): MountainSet {
  const A = 1536,
    K = 128,
    SECT = 12
  const per = A / SECT
  const radius = new Float64Array(K + 1)
  for (let k = 0; k <= K; k++) radius[k] = inner + (outer - inner) * Math.pow(k / K, 1.35)
  const N = A * (K + 1)
  const H = new Float32Array(N)
  const X = new Float32Array(N),
    Z = new Float32Array(N)
  const cosA = new Float64Array(A),
    sinA = new Float64Array(A)
  for (let a = 0; a < A; a++) {
    cosA[a] = Math.cos((a / A) * Math.PI * 2)
    sinA[a] = Math.sin((a / A) * Math.PI * 2)
  }
  const ox = seed * 13.7,
    oz = -seed * 7.1
  for (let k = 0; k <= K; k++) {
    const r = radius[k]
    const t = (r - inner) / (outer - inner)
    const far = 1 - smooth(0.84, 1.0, t)
    // foothills rise slowly from the valley; the high range stands behind them
    const footAmp = smooth(0.0, 0.4, t) * far
    // two ranges one behind the other: a lower front range, a saddle, the main range behind it
    // (the haze then layers them: the far one paler and flatter in tone)
    const high = (0.62 * smooth(0.24, 0.42, t) * (1 - 0.45 * smooth(0.5, 0.62, t)) + 0.45 * smooth(0.6, 0.8, t)) * far
    for (let a = 0; a < A; a++) {
      const i = k * A + a
      const x = center.x + cosA[a] * r,
        z = center.z + sinA[a] * r
      X[i] = x
      Z[i] = z
      const px = x / 2300 + ox,
        pz = z / 2300 + oz
      // domain warp: the ranges bend and branch instead of following the noise lattice
      const wx = fbm2(px * 0.8 + 5.2, pz * 0.8 + 1.3, 3),
        wz = fbm2(px * 0.8 - 3.1, pz * 0.8 + 7.7, 3)
      const qx = px + 0.42 * wx,
        qz = pz + 0.42 * wz
      // (the finest octave ~2-3 grid cells: finer noise would only alias)
      const rid = ridged2(qx * 0.85, qz * 0.85, 6)
      // the body of the massif: broad, slowly varying, so ridgelines run on at similar heights
      const body = 0.5 + 0.5 * fbm2(qx * 0.45 - 2.7, qz * 0.45 + 6.1, 4)
      // where the high massifs stand along the ring (with saddles between them)
      const massif = smooth(-0.35, 0.5, fbm2(px * 0.33 + 9.1, pz * 0.33 - 4.4, 3))
      // rolling forested foothills in front of the range
      const roll = 0.5 + 0.5 * fbm2(qx * 2.6 + 3.3, qz * 2.6 - 1.7, 4)
      const foot = footAmp * (25 + 190 * roll * (0.6 + 0.4 * rid))
      // broad eroded ridges, not needles: the ridged noise only sculpts a broad body, and the summits
      // are compressed towards a common level (accordant summits of an old, eroded range)
      const raw = high * (0.4 + 0.6 * massif) * 2300 * (0.4 * body + 0.6 * Math.pow(rid, 1.15))
      const range = 1250 * Math.tanh(raw / 1250)
      H[i] = foot + range - 12
    }
  }

  // ---- drainage: flow accumulation along the steepest descent, then carving by stream power
  const area = new Float32Array(K + 1)
  for (let k = 0; k <= K; k++) area[k] = ((radius[Math.min(K, k + 1)] - radius[Math.max(0, k - 1)]) / 2) * ((radius[k] * Math.PI * 2) / A)
  const flow = new Float32Array(N)
  const order = new Uint32Array(N)
  const carve = new Float32Array(N)
  const slope = new Float32Array(N)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N; i++) order[i] = i
    order.sort((p, q) => H[q] - H[p])
    for (let i = 0; i < N; i++) flow[i] = area[(i / A) | 0]
    for (let n = 0; n < N; n++) {
      const i = order[n]
      const k = (i / A) | 0,
        a = i - k * A
      let best = -1,
        bestS = 0
      for (let dk = -1; dk <= 1; dk++) {
        const kk = k + dk
        if (kk < 0 || kk > K) continue
        for (let da = -1; da <= 1; da++) {
          if (!dk && !da) continue
          const j = kk * A + ((a + da + A) % A)
          const dx = X[j] - X[i],
            dz = Z[j] - Z[i]
          const s = (H[i] - H[j]) / Math.sqrt(dx * dx + dz * dz)
          if (s > bestS) {
            bestS = s
            best = j
          }
        }
      }
      slope[i] = bestS
      if (best >= 0) flow[best] += flow[i]
    }
    // stream power: deeper where more ground drains through, on steeper ground
    for (let i = 0; i < N; i++) carve[i] = Math.min(pass ? 55 : 130, 0.045 * Math.sqrt(flow[i]) * Math.pow(slope[i], 0.8))
    // widen the incisions into valleys (slumping of the banks)
    for (let it = 0; it < 2; it++) {
      const c2 = Float32Array.from(carve)
      for (let k = 0; k <= K; k++)
        for (let a = 0; a < A; a++) {
          const i = k * A + a
          const l = k * A + ((a + A - 1) % A),
            r = k * A + ((a + 1) % A)
          const u = k > 0 ? i - A : i,
            d = k < K ? i + A : i
          carve[i] = Math.max(c2[i], (c2[l] + c2[r] + c2[u] + c2[d]) * 0.2 + c2[i] * 0.2)
        }
    }
    for (let i = 0; i < N; i++) {
      const k = (i / A) | 0
      const t = (radius[k] - inner) / (outer - inner)
      // the valley floor and the far edge stay as they are
      H[i] -= carve[i] * smooth(0, 0.08, t) * Math.min(1, Math.max(0, (H[i] + 12) / 60))
    }
  }
  const drain = new Float32Array(N)
  for (let i = 0; i < N; i++) drain[i] = Math.min(1, Math.max(0, (Math.log(flow[i] / area[(i / A) | 0]) - 1.5) / 7))

  // ---- normals (central differences over the whole ring: no seams between sectors)
  const nrm = new Float32Array(N * 3)
  for (let k = 0; k <= K; k++)
    for (let a = 0; a < A; a++) {
      const i = k * A + a
      const l = k * A + ((a + A - 1) % A),
        r = k * A + ((a + 1) % A)
      const u = k > 0 ? i - A : i,
        d = k < K ? i + A : i
      const ax = X[r] - X[l],
        ay = H[r] - H[l],
        az = Z[r] - Z[l]
      const bx = X[d] - X[u],
        by = H[d] - H[u],
        bz = Z[d] - Z[u]
      let nx = ay * bz - az * by,
        ny = az * bx - ax * bz,
        nz = ax * by - ay * bx
      if (ny < 0) {
        nx = -nx
        ny = -ny
        nz = -nz
      }
      const len = Math.hypot(nx, ny, nz) || 1
      nrm[i * 3] = nx / len
      nrm[i * 3 + 1] = ny / len
      nrm[i * 3 + 2] = nz / len
    }

  // ---- sky visibility from the local relief (blurred height minus height)
  const blur = Float32Array.from(H)
  const tmpB = new Float32Array(N)
  for (let it = 0; it < 3; it++) {
    for (let k = 0; k <= K; k++)
      for (let a = 0; a < A; a++) {
        let s = 0
        for (let o = -4; o <= 4; o++) s += blur[k * A + ((a + o + A) % A)]
        tmpB[k * A + a] = s / 9
      }
    for (let k = 0; k <= K; k++)
      for (let a = 0; a < A; a++) {
        let s = 0
        for (let o = -2; o <= 2; o++) s += tmpB[Math.min(K, Math.max(0, k + o)) * A + a]
        blur[k * A + a] = s / 5
      }
  }
  const ao = new Float32Array(N)
  for (let i = 0; i < N; i++) ao[i] = 0.42 + 0.58 * smooth(-170, 50, H[i] - blur[i])

  // ---- height lookup (polar grid, bilinear)
  const heightAt = (x: number, z: number) => {
    const dx = x - center.x,
      dz = z - center.z
    const r = Math.sqrt(dx * dx + dz * dz)
    if (r <= inner || r >= outer) return -12
    const fk = Math.pow((r - inner) / (outer - inner), 1 / 1.35) * K
    let fa = (Math.atan2(dz, dx) / (Math.PI * 2)) * A
    if (fa < 0) fa += A
    const a0 = Math.floor(fa) % A,
      a1 = (a0 + 1) % A,
      ta = fa - Math.floor(fa)
    const k0 = Math.min(K - 1, Math.floor(fk)),
      tk = fk - k0
    const h00 = H[k0 * A + a0],
      h01 = H[k0 * A + a1],
      h10 = H[(k0 + 1) * A + a0],
      h11 = H[(k0 + 1) * A + a1]
    return (h00 * (1 - ta) + h01 * ta) * (1 - tk) + (h10 * (1 - ta) + h11 * ta) * tk
  }

  // ---- sector geometries (shared index buffer: full mesh, then the coarse one)
  const vpr = per + 1
  const fineIdx: number[] = []
  for (let k = 0; k < K; k++)
    for (let a = 0; a < per; a++) {
      const p = k * vpr + a,
        q = p + 1,
        c = p + vpr,
        d = c + 1
      fineIdx.push(p, q, c, q, d, c)
    }
  const index = new THREE.BufferAttribute(new Uint32Array(fineIdx), 1)
  const sectors: THREE.BufferGeometry[] = []
  const attrs: THREE.BufferAttribute[] = []
  for (let sct = 0; sct < SECT; sct++) {
    const nv = vpr * (K + 1)
    const pos = new Float32Array(nv * 3),
      nr = new Float32Array(nv * 3),
      mt = new Float32Array(nv * 4)
    for (let k = 0; k <= K; k++)
      for (let a = 0; a <= per; a++) {
        const v = k * vpr + a
        const i = k * A + ((sct * per + a) % A)
        pos[v * 3] = X[i]
        pos[v * 3 + 1] = H[i]
        pos[v * 3 + 2] = Z[i]
        nr[v * 3] = nrm[i * 3]
        nr[v * 3 + 1] = nrm[i * 3 + 1]
        nr[v * 3 + 2] = nrm[i * 3 + 2]
        mt[v * 4] = drain[i]
        mt[v * 4 + 1] = 1
        mt[v * 4 + 2] = ao[i]
        mt[v * 4 + 3] = (radius[k] - inner) / (outer - inner)
      }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(nr, 3))
    const m = new THREE.BufferAttribute(mt, 4)
    g.setAttribute('aMtn', m)
    attrs.push(m)
    g.setIndex(index)
    g.computeBoundingSphere()
    sectors.push(g)
  }

  // ---- the probes' ring: every 4th vertex each way, one compact mesh (one draw per probe face)
  const CA = A / 4,
    CK = K / 4
  const pv = (CA + 1) * (CK + 1)
  const ppos = new Float32Array(pv * 3),
    pnr = new Float32Array(pv * 3),
    pmt = new Float32Array(pv * 4)
  const probeSrc = new Int32Array(pv)
  for (let k = 0; k <= CK; k++)
    for (let a = 0; a <= CA; a++) {
      const v = k * (CA + 1) + a
      const i = k * 4 * A + ((a * 4) % A)
      probeSrc[v] = i
      ppos.set([X[i], H[i], Z[i]], v * 3)
      pnr.set([nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]], v * 3)
      pmt.set([drain[i], 1, ao[i], (radius[k * 4] - inner) / (outer - inner)], v * 4)
    }
  const pidx: number[] = []
  for (let k = 0; k < CK; k++)
    for (let a = 0; a < CA; a++) {
      const p = k * (CA + 1) + a,
        q = p + 1,
        c = p + CA + 1,
        d = c + 1
      pidx.push(p, q, c, q, d, c)
    }
  const probe = new THREE.BufferGeometry()
  probe.setAttribute('position', new THREE.BufferAttribute(ppos, 3))
  probe.setAttribute('normal', new THREE.BufferAttribute(pnr, 3))
  const probeMt = new THREE.BufferAttribute(pmt, 4)
  probe.setAttribute('aMtn', probeMt)
  probe.setIndex(pidx)
  probe.computeBoundingSphere()

  const bakeSun = (dir: { x: number; y: number; z: number }) => {
    const hl = Math.hypot(dir.x, dir.z) || 1e-6
    const hx = dir.x / hl,
      hz = dir.z / hl
    const tanEl = dir.y / hl
    const vis = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const y0 = H[i] + 2
      let occ = 0
      let s = 25
      for (let step = 0; step < 30 && s < 5000; step++) {
        const h = heightAt(X[i] + hx * s, Z[i] + hz * s)
        // soft: how far the ground stands above the sun's ray, against a penumbra growing with distance
        const o = (h - (y0 + s * tanEl)) / (s * 0.035 + 8)
        if (o > occ) occ = o
        if (occ >= 1) break
        s *= 1.2
      }
      vis[i] = 1 - smooth(0, 1, occ)
    }
    for (let sct = 0; sct < SECT; sct++) {
      const m = attrs[sct]
      const arr = m.array as Float32Array
      for (let k = 0; k <= K; k++) for (let a = 0; a <= per; a++) arr[(k * vpr + a) * 4 + 1] = vis[k * A + ((sct * per + a) % A)]
      m.needsUpdate = true
    }
    const parr = probeMt.array as Float32Array
    for (let v = 0; v < pv; v++) parr[v * 4 + 1] = vis[probeSrc[v]]
    probeMt.needsUpdate = true
  }

  return { sectors, probe, bakeSun, heightAt }
}
