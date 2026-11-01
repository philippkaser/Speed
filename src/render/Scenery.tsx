// Trackside scenery: forests, grandstands with crowds, pit building, start gantry, bridge,
// billboards, braking distance boards and marshal posts. All procedural & instanced.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { color, cos, float, Fn, instanceIndex, mix, positionLocal, sin, time, uniform, vec3, mx_noise_float, positionWorld, step, fract, smoothstep } from 'three/tsl'
import { game } from '../game/game'
import { valueNoise2 } from '../physics/math'
import { useSettings } from '../state/settings'
import { DS, type Track } from '../track/track'
import { canvasTexture } from './textures'
import type { TerrainHeight } from './trackGeometry'

const tmp = { x: 0, y: 0, z: 0 }

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
}

function paint(g: THREE.BufferGeometry, c: THREE.Color, jitter = 0, r = Math.random) {
  const geo = g.index ? g.toNonIndexed() : g
  const n = geo.getAttribute('position').count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i += 3) {
    const j = 1 + (r() - 0.5) * jitter
    for (let k = 0; k < 3; k++) {
      col[(i + k) * 3] = c.r * j
      col[(i + k) * 3 + 1] = c.g * j
      col[(i + k) * 3 + 2] = c.b * j
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  if (geo.getAttribute('uv')) geo.deleteAttribute('uv')
  return geo
}

function displace(g: THREE.BufferGeometry, amp: number, freq: number, seed: number, center?: THREE.Vector3, sphereNormals = false) {
  const p = g.getAttribute('position')
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i)
    const n = valueNoise2(x * freq + seed, z * freq + y * freq * 0.7 - seed) - 0.5
    const s = 1 + n * amp
    if (center) p.setXYZ(i, center.x + (x - center.x) * s, center.y + (y - center.y) * s, center.z + (z - center.z) * s)
  }
  g.computeVertexNormals()
  if (sphereNormals && center) {
    const nrm = g.getAttribute('normal')
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3(p.getX(i) - center.x, (p.getY(i) - center.y) * 0.8, p.getZ(i) - center.z).normalize()
      const o = new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i))
      v.lerp(o, 0.35).normalize()
      nrm.setXYZ(i, v.x, v.y, v.z)
    }
  }
  return g
}

function coniferGeometry(seed: number) {
  const r = rng(seed)
  const parts: THREE.BufferGeometry[] = []
  const trunk = new THREE.CylinderGeometry(0.12, 0.26, 4, 6)
  trunk.translate(0, 2, 0)
  parts.push(paint(trunk, new THREE.Color(0.09, 0.06, 0.04), 0.2, r))
  const layers = 6
  for (let k = 0; k < layers; k++) {
    const rad = 2.5 * (1 - k / (layers + 0.6)) + 0.3
    const cone = new THREE.ConeGeometry(rad, 3.0, 11, 2)
    cone.translate(0, 2.4 + k * 1.75, 0)
    displace(cone, 0.35, 1.3, seed + k * 3, new THREE.Vector3(0, 2.4 + k * 1.75, 0))
    const g = 0.75 + r() * 0.4
    parts.push(paint(cone, new THREE.Color(0.025 * g, 0.055 * g, 0.03 * g), 0.35, r))
  }
  return mergeGeometries(parts)!
}

function broadleafGeometry(seed: number) {
  const r = rng(seed)
  const parts: THREE.BufferGeometry[] = []
  const trunk = new THREE.CylinderGeometry(0.16, 0.3, 4.2, 6)
  trunk.translate(0, 2.1, 0)
  parts.push(paint(trunk, new THREE.Color(0.1, 0.075, 0.05), 0.2, r))
  const blobs = 5
  const tint = new THREE.Color(0.045 + r() * 0.02, 0.075 + r() * 0.025, 0.028)
  for (let k = 0; k < blobs; k++) {
    const rad = 1.6 + r() * 1.3
    const s = new THREE.IcosahedronGeometry(rad, 2)
    const c = new THREE.Vector3((r() - 0.5) * 3, 4.6 + r() * 3.2, (r() - 0.5) * 3)
    s.translate(c.x, c.y, c.z)
    displace(s, 0.55, 0.9, seed + k * 7, c, true)
    parts.push(paint(s, tint.clone().multiplyScalar(0.8 + r() * 0.45), 0.3, r))
  }
  return mergeGeometries(parts)!
}

function foliageMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true })
  const phase = instanceIndex.toFloat().mul(1.731)
  const h = positionLocal.y.max(0)
  const sway = h.mul(h).mul(0.0018)
  m.positionNode = positionLocal.add(vec3(sin(time.mul(1.1).add(phase)).mul(sway), 0, cos(time.mul(0.83).add(phase.mul(1.3))).mul(sway)))
  m.roughnessNode = float(0.88)
  // per-instance hue variation
  const v = mx_noise_float(vec3(phase, 0.5, 0.1)).mul(0.3).add(1)
  m.colorNode = color(1, 1, 1).mul(v)
  return m
}

function placeTrees(track: Track, heights: TerrainHeight, density: number) {
  const r = rng(track.def.seed)
  const conifers: THREE.Matrix4[] = []
  const broad: THREE.Matrix4[] = []
  const margin = 560
  const step = 11 / Math.sqrt(Math.max(density, 0.1))
  const s = heights.sample
  for (let z = track.minZ - margin; z < track.maxZ + margin; z += step) {
    s.hint = -1
    for (let x = track.minX - margin; x < track.maxX + margin; x += step) {
      const px = x + (r() - 0.5) * step,
        pz = z + (r() - 0.5) * step
      const forest = valueNoise2(px * 0.006 + 3.1, pz * 0.006 - 7.7) * 0.7 + valueNoise2(px * 0.02, pz * 0.02) * 0.3
      if (forest < 0.48) continue
      track.sample(px, pz, s)
      const S = s.d >= 0 ? track.L : track.R
      const wall = S.wall[track.idx(s.s)]
      const ad = Math.abs(s.d)
      if (ad < wall + 14 + r() * 10) continue
      // keep the inside of the start straight clear for the grandstands & pits
      if ((s.s > track.length - 420 || s.s < 460) && ad < wall + 90) continue
      if (r() > (forest - 0.4) * 2.2) continue
      const y = heights.height(px, pz)
      const scale = 0.8 + r() * 0.75
      const m = new THREE.Matrix4().compose(new THREE.Vector3(px, y - 0.3, pz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), new THREE.Vector3(scale, scale * (0.85 + r() * 0.4), scale))
      if (valueNoise2(px * 0.004, pz * 0.004) > 0.45) conifers.push(m)
      else broad.push(m)
    }
  }
  return { conifers, broad }
}

// ---------------------------------------------------------------------------------- structures

function grandstand(length: number, rows: number, seed: number) {
  const r = rng(seed)
  const parts: THREE.BufferGeometry[] = []
  const concrete = new THREE.Color(0.38, 0.38, 0.37)
  const crowd: { m: THREE.Matrix4; c: THREE.Color }[] = []
  for (let k = 0; k < rows; k++) {
    const step = new THREE.BoxGeometry(length, 0.45 * (k + 1), 0.85)
    step.translate(0, (0.45 * (k + 1)) / 2, -k * 0.85)
    parts.push(paint(step, concrete, 0.05, r))
    for (let x = -length / 2 + 0.4; x < length / 2 - 0.4; x += 0.55) {
      if (r() < 0.22) continue
      const pal = [0xd8d8d8, 0x202020, 0xb02020, 0x2050a0, 0xe0c040, 0x307030, 0xe07030, 0x806050, 0xf0f0f0, 0x404860]
      const c = new THREE.Color(pal[Math.floor(r() * pal.length)])
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x + (r() - 0.5) * 0.15, 0.45 * (k + 1) + 0.42, -k * 0.85 - 0.1), new THREE.Quaternion(), new THREE.Vector3(1, 0.9 + r() * 0.25, 1))
      crowd.push({ m, c })
    }
  }
  const back = new THREE.BoxGeometry(length, 0.45 * rows + 4, 0.3)
  back.translate(0, (0.45 * rows + 4) / 2, -rows * 0.85 - 0.2)
  parts.push(paint(back, concrete.clone().multiplyScalar(0.8), 0, r))
  // roof & pillars
  const roofH = 0.45 * rows + 4.2
  const roof = new THREE.BoxGeometry(length + 2, 0.3, rows * 0.85 + 3)
  roof.rotateX(-0.08)
  roof.translate(0, roofH, -rows * 0.85 * 0.5 + 0.8)
  parts.push(paint(roof, new THREE.Color(0.75, 0.76, 0.78), 0, r))
  for (let x = -length / 2; x <= length / 2; x += 12) {
    const p = new THREE.BoxGeometry(0.3, roofH, 0.3)
    p.translate(x, roofH / 2, -rows * 0.85 - 0.1)
    parts.push(paint(p, new THREE.Color(0.6, 0.6, 0.62), 0, r))
  }
  return { geo: mergeGeometries(parts)!, crowd }
}

function pitBuilding(length: number) {
  const parts: THREE.BufferGeometry[] = []
  const r = rng(99)
  const base = new THREE.BoxGeometry(length, 7, 16)
  base.translate(0, 3.5, 0)
  parts.push(paint(base, new THREE.Color(0.8, 0.8, 0.79), 0, r))
  const roof = new THREE.BoxGeometry(length + 4, 0.5, 21)
  roof.translate(0, 11.3, -1)
  parts.push(paint(roof, new THREE.Color(0.85, 0.86, 0.88), 0, r))
  // control tower
  const tower = new THREE.BoxGeometry(26, 14, 14)
  tower.translate(-length * 0.3, 13, 0)
  parts.push(paint(tower, new THREE.Color(0.82, 0.82, 0.83), 0, r))
  return mergeGeometries(parts)!
}

function pitMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true })
  // garage doors and glazing patterns in world space on the track facing side
  const y = positionWorld.y
  const along = positionWorld.x
  const door = step(0.5, fract(along.div(12))).mul(step(y, 4.5)).mul(0.6)
  const glass = smoothstep(7.4, 7.6, y).mul(smoothstep(10.6, 10.4, y))
  m.colorNode = mix(mix(color(1, 1, 1), color(0.12, 0.13, 0.14), door), color(0.04, 0.06, 0.08), glass)
  m.metalnessNode = glass.mul(0.9)
  m.roughnessNode = mix(float(0.7), float(0.06), glass)
  return m
}

function billboardTexture(text: string, bg: string, fg: string, sub = '') {
  return canvasTexture(1024, 256, (ctx) => {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, 1024, 256)
    ctx.fillStyle = fg
    ctx.font = '900 150px Inter, Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 512, sub ? 112 : 132)
    if (sub) {
      ctx.font = '600 44px Inter, Arial, sans-serif'
      ctx.globalAlpha = 0.8
      ctx.fillText(sub, 512, 210)
    }
  })
}

const BRANDS: [string, string, string, string][] = [
  ['SPEED', '#0b0d10', '#ffffff', 'RACING SERIES'],
  ['HELIX', '#f5b800', '#111111', 'ENGINE OILS'],
  ['VANTA', '#c8102e', '#ffffff', 'PERFORMANCE'],
  ['NORDKAP', '#0d47a1', '#ffffff', 'TYRES'],
  ['AUREL', '#111111', '#d4af37', 'GRAND TOURING'],
  ['VOLTARA', '#ffffff', '#00897b', 'ENERGY'],
]

function boardTexture(n: number) {
  return canvasTexture(256, 512, (ctx) => {
    ctx.fillStyle = '#f4f4f2'
    ctx.fillRect(0, 0, 256, 512)
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 18
    ctx.strokeRect(9, 9, 238, 494)
    ctx.fillStyle = '#111'
    ctx.font = '900 230px Inter, Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), 128, 270)
  })
}

export const gantryLights = uniform(0) // number of lit red pairs (0..5); -1 = green

export function Scenery({ track, heights }: { track: Track; heights: TerrainHeight }) {
  const density = useSettings((s) => s.graphics.trees)
  const trees = useMemo(() => {
    const g = new THREE.Group()
    const { conifers, broad } = placeTrees(track, heights, density)
    const mat = foliageMaterial()
    const variants = 3
    const add = (list: THREE.Matrix4[], geoFn: (seed: number) => THREE.BufferGeometry) => {
      for (let v = 0; v < variants; v++) {
        const subset = list.filter((_, i) => i % variants === v)
        if (!subset.length) continue
        const geo = geoFn(17 + v * 31)
        const m = new THREE.InstancedMesh(geo, mat, subset.length)
        subset.forEach((mx, i) => m.setMatrixAt(i, mx))
        m.castShadow = true
        m.receiveShadow = true
        m.computeBoundingSphere()
        g.add(m)
      }
    }
    add(conifers, coniferGeometry)
    add(broad, broadleafGeometry)
    console.info(`[scenery] ${conifers.length + broad.length} trees`)
    return g
  }, [track, heights, density])

  const structures = useMemo(() => {
    const g = new THREE.Group()
    const L = track.length
    const at = (s: number, d: number) => track.pointAt(s, d, { x: 0, y: 0, z: 0 })
    const yawAt = (s: number) => track.headingAt(s)

    // ---- grandstands on the inside (right side) of the main straight
    for (const [s0, len] of [
      [-170, 110],
      [-30, 130],
      [130, 90],
    ] as const) {
      const sMid = s0 + len / 2
      const i = track.idx(sMid)
      const off = -(track.R.wall[i] + 7)
      const p = at(sMid, off)
      const { geo, crowd } = grandstand(len, 14, Math.round(sMid * 7))
      const stand = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85 }))
      const yaw = yawAt(sMid)
      stand.position.set(p.x, p.y - 0.2, p.z)
      // stand faces the track: local +z (front) must point to the left of travel (towards the track)
      stand.rotation.y = yaw + Math.PI / 2
      stand.castShadow = true
      stand.receiveShadow = true
      g.add(stand)
      const cm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.85, 0.34), new THREE.MeshStandardNodeMaterial({ roughness: 0.9 }), crowd.length)
      crowd.forEach((c, k) => {
        cm.setMatrixAt(k, c.m)
        cm.setColorAt(k, c.c)
      })
      cm.position.copy(stand.position)
      cm.rotation.copy(stand.rotation)
      cm.receiveShadow = true
      cm.castShadow = false
      g.add(cm)
    }

    // ---- pit building on the outside (left side) of the main straight
    {
      const sMid = -110
      const i = track.idx(sMid)
      const off = track.L.wall[i] + 26
      const p = at(sMid, off)
      const b = new THREE.Mesh(pitBuilding(300), pitMaterial())
      b.position.set(p.x, p.y - 0.05, p.z)
      b.rotation.y = yawAt(sMid) - Math.PI / 2
      b.castShadow = true
      b.receiveShadow = true
      g.add(b)
      // pit lane surface
      const laneGeo = new THREE.PlaneGeometry(300, 18)
      laneGeo.rotateX(-Math.PI / 2)
      const lane = new THREE.Mesh(laneGeo, new THREE.MeshStandardNodeMaterial({ color: 0x2a2b2c, roughness: 0.82 }))
      const lp = at(sMid, track.L.wall[i] + 9.5)
      lane.position.set(lp.x, lp.y + 0.01, lp.z)
      lane.rotation.y = yawAt(sMid) - Math.PI / 2
      lane.receiveShadow = true
      g.add(lane)
    }

    // ---- start light gantry
    {
      const s = -3
      const i = track.idx(s)
      const wl = track.L.wall[i] + 0.8,
        wr = track.R.wall[i] + 0.8
      const pl = at(s, wl),
        pr = at(s, -wr)
      const frameMat = new THREE.MeshStandardNodeMaterial({ color: 0x1a1c1f, metalness: 0.6, roughness: 0.4 })
      for (const p of [pl, pr]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 8.5, 0.6), frameMat)
        post.position.set(p.x, p.y + 4.25, p.z)
        post.castShadow = true
        g.add(post)
      }
      const span = Math.hypot(pl.x - pr.x, pl.z - pr.z)
      const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.9, 0.7), frameMat)
      const mid = at(s, (wl - wr) / 2)
      beam.position.set(mid.x, mid.y + 8.1, mid.z)
      beam.rotation.y = yawAt(s) - Math.PI / 2
      beam.castShadow = true
      g.add(beam)
      const panel = new THREE.Mesh(new THREE.BoxGeometry(5.2, 1.4, 0.4), frameMat)
      panel.position.set(mid.x, mid.y + 7.1, mid.z)
      panel.rotation.y = beam.rotation.y
      g.add(panel)
      // lamps: 5 columns x 2 red, plus green state
      const lampMat = new THREE.MeshStandardNodeMaterial({ color: 0x050505, roughness: 0.3 })
      const idx = Fn(() => instanceIndex.toFloat())()
      const col = idx.mod(5)
      const lit = step(col.add(0.5), gantryLights).mul(step(0, gantryLights))
      const green = step(gantryLights, -0.5)
      lampMat.emissiveNode = mix(color(0, 0, 0), color(14, 0.2, 0.05), lit).add(color(0.2, 10, 1).mul(green))
      const lamps = new THREE.InstancedMesh(new THREE.CircleGeometry(0.2, 16), lampMat, 10)
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawAt(s) + Math.PI)
      for (let k = 0; k < 10; k++) {
        const c = k % 5,
          row = Math.floor(k / 5)
        const local = new THREE.Vector3(-2 + c, 7.35 - row * 0.5, 0)
        local.applyAxisAngle(new THREE.Vector3(0, 1, 0), beam.rotation.y)
        const m = new THREE.Matrix4().compose(new THREE.Vector3(mid.x + local.x, mid.y + local.y, mid.z + local.z).addScaledVector(new THREE.Vector3(-track.tx[i], 0, -track.tz[i]), 0.22), q, new THREE.Vector3(1, 1, 1))
        lamps.setMatrixAt(k, m)
      }
      g.add(lamps)
    }

    // ---- bridge over the main straight
    {
      const s = 300
      const i = track.idx(s)
      const wl = track.L.wall[i] + 3,
        wr = track.R.wall[i] + 3
      const mid = at(s, (wl - wr) / 2)
      const span = wl + wr
      const yaw = yawAt(s) - Math.PI / 2
      const bridgeMat = new THREE.MeshStandardNodeMaterial({ color: 0xe8e8e8, roughness: 0.6 })
      const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 1.4, 4), bridgeMat)
      deck.position.set(mid.x, mid.y + 7.4, mid.z)
      deck.rotation.y = yaw
      deck.castShadow = true
      deck.receiveShadow = true
      g.add(deck)
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(2.2, 7.4, 4.4), bridgeMat)
        const p = at(s, side > 0 ? wl : -wr)
        leg.position.set(p.x, p.y + 3.7, p.z)
        leg.rotation.y = yaw
        leg.castShadow = true
        g.add(leg)
      }
      const tex = billboardTexture('SPEED', '#0b0d10', '#ffffff', 'WORLD GT CHAMPIONSHIP')
      for (const face of [1, -1]) {
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(span * 0.7, span * 0.7 * 0.25), new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.5 }))
        sign.position.set(mid.x + track.tx[i] * 2.05 * -face, mid.y + 7.4, mid.z + track.tz[i] * 2.05 * -face)
        sign.rotation.y = yawAt(s) + (face > 0 ? Math.PI : 0)
        g.add(sign)
      }
    }

    // ---- billboards along straights and braking zones
    const textures = BRANDS.map(([t, bg, fg, sub]) => billboardTexture(t, bg, fg, sub))
    const boardMats = textures.map((t) => new THREE.MeshStandardNodeMaterial({ map: t, roughness: 0.55 }))
    const legMat = new THREE.MeshStandardNodeMaterial({ color: 0x333333, metalness: 0.5, roughness: 0.5 })
    let bi = 0
    for (let s = 120; s < L - 60; s += 150) {
      const i = track.idx(s)
      if (track.speed[i] < 40) continue
      const side = (Math.floor(s / 150) % 2) * 2 - 1
      const S = side > 0 ? track.L : track.R
      const off = side * (S.wall[i] + 3.5)
      const p = at(s, off)
      const mat = boardMats[bi++ % boardMats.length]
      const board = new THREE.Mesh(new THREE.BoxGeometry(12, 3, 0.15), [legMat, legMat, legMat, legMat, mat, mat])
      board.position.set(p.x, p.y + 2.4, p.z)
      board.rotation.y = yawAt(s) - Math.PI / 2
      board.castShadow = true
      g.add(board)
    }

    // ---- braking boards (300/200/100 m) before heavy braking zones
    const boardTex = [1, 2, 3].map((n) => new THREE.MeshStandardNodeMaterial({ map: boardTexture(n), roughness: 0.5 }))
    const sp = track.speed
    const n = track.n
    for (let i = 0; i < n; i++) {
      // local minimum of speed with a big drop before it
      const v = sp[i]
      if (v > sp[(i - 1 + n) % n] || v > sp[(i + 1) % n]) continue
      let vmax = 0
      for (let k = 1; k < 400; k++) vmax = Math.max(vmax, sp[(i - k + n) % n])
      if (vmax - v < 18) continue
      // find braking point: where speed starts to drop
      let b = i
      for (let k = 1; k < 400; k++) {
        const j = (i - k + n) % n
        if (sp[j] >= vmax - 1) {
          b = j
          break
        }
      }
      const turnSide = track.curv[i] > 0 ? 1 : -1
      const side = -turnSide // boards on the outside of the corner approach
      for (let k = 1; k <= 3; k++) {
        const s = b * DS - (k - 1) * 100 + 30
        const ii = track.idx(s)
        const S = side > 0 ? track.L : track.R
        const p = at(s, side * (track.hw[ii] + S.kerb[ii] + 2.2))
        const brd = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 0.08), [legMat, legMat, legMat, legMat, boardTex[k - 1], legMat])
        brd.position.set(p.x, p.y + 1.15, p.z)
        brd.rotation.y = yawAt(s) + Math.PI
        brd.castShadow = true
        g.add(brd)
      }
      i += 200
    }

    // ---- marshal posts
    const hutMat = new THREE.MeshStandardNodeMaterial({ color: 0xd9d9d6, roughness: 0.7 })
    const roofMat = new THREE.MeshStandardNodeMaterial({ color: 0xff6a00, roughness: 0.6 })
    for (let s = 200; s < L; s += 420) {
      const i = track.idx(s)
      const side = track.curv[i] > 0 ? -1 : 1
      const S = side > 0 ? track.L : track.R
      const p = at(s, side * (S.wall[i] + 2.2))
      const hut = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.3, 2.0), hutMat)
      hut.position.set(p.x, p.y + 1.15, p.z)
      hut.rotation.y = yawAt(s)
      hut.castShadow = true
      g.add(hut)
      const roof = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 2.4), roofMat)
      roof.position.set(p.x, p.y + 2.4, p.z)
      roof.rotation.y = yawAt(s)
      g.add(roof)
    }
    g.traverse((o) => {
      o.matrixAutoUpdate = false
      o.updateMatrix()
    })
    return g
  }, [track])

  useEffect(
    () => () => {
      trees.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
    },
    [trees],
  )

  useFrame(() => {
    // start lights follow the race countdown
    if (game.phase === 'grid' || game.phase === 'countdown') {
      const c = game.countdown
      gantryLights.value = c > 3.5 ? 0 : Math.min(5, Math.floor((3.5 - c) / 0.6) + 1)
    } else if (game.phase === 'racing' && game.raceTime < 4) gantryLights.value = -1
    else gantryLights.value = 0
  })

  return (
    <>
      <primitive object={trees} />
      <primitive object={structures} />
    </>
  )
}

