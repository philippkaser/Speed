// Trackside scenery: grandstands with crowds, pit building, start gantry, bridge, billboards, braking
// distance boards and marshal posts (procedural & instanced), and the vegetation (Vegetation.tsx).
import { useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import { Vegetation } from './Vegetation'
import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { color, cos, float, Fn, instanceIndex, mix, positionLocal, positionPrevious, sin, uniform, uv, vec3, mx_noise_float, step, texture } from 'three/tsl'
import { motionTime } from './motionHistory'
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
  parts.push(paint(roof, new THREE.Color(0.55, 0.56, 0.58), 0, r))
  for (let x = -length / 2; x <= length / 2; x += 12) {
    const p = new THREE.BoxGeometry(0.3, roofH, 0.3)
    p.translate(x, roofH / 2, -rows * 0.85 - 0.1)
    parts.push(paint(p, new THREE.Color(0.6, 0.6, 0.62), 0, r))
  }
  return { geo: mergeGeometries(parts)!, crowd }
}

function pitBuilding(length: number) {
  const solid: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []
  const r = rng(99)
  const concrete = new THREE.Color(0.42, 0.43, 0.44)
  const dark = new THREE.Color(0.08, 0.085, 0.09)
  const white = new THREE.Color(0.6, 0.61, 0.62)
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, isGlass = false) => {
    const b = new THREE.BoxGeometry(w, h, d)
    b.translate(x, y, z)
    if (isGlass) {
      const g = b.toNonIndexed()
      g.deleteAttribute('uv')
      glass.push(g)
    } else solid.push(paint(b, c, 0.04, r))
  }
  // local frame: x along the straight, +z towards the track
  box(length, 5.2, 14, 0, 2.6, -1, concrete)
  const bays = Math.floor(length / 11)
  for (let i = 0; i < bays; i++) {
    const x = -length / 2 + 5.5 + i * 11
    box(9.4, 4.2, 0.3, x, 2.1, 6.05, dark) // garage door recess
    box(1.2, 5.4, 0.6, x + 5.5, 2.7, 6.2, white) // pillar
  }
  // first floor hospitality with continuous glazing
  box(length, 0.5, 15, 0, 5.45, -0.5, white)
  box(length - 1, 3.0, 0.15, 0, 7.2, 6.3, dark, true)
  box(length, 3.2, 12, 0, 7.3, -1.5, concrete)
  // cantilevered roof with fins
  box(length + 6, 0.45, 19, 0, 9.1, 1.5, white)
  for (let x = -length / 2; x <= length / 2; x += 12) box(0.25, 3.4, 4, x, 7.3, 8.6, white)
  // control tower
  const tx = -length * 0.3
  box(22, 10, 14, tx, 14.2, -1, concrete)
  box(23, 3.6, 0.15, tx, 17.2, 6.1, dark, true)
  box(0.15, 3.6, 14, tx - 11.5, 17.2, -1, dark, true)
  box(0.15, 3.6, 14, tx + 11.5, 17.2, -1, dark, true)
  box(25, 0.5, 17, tx, 19.4, -0.5, white)
  return { solid: mergeGeometries(solid)!, glass: mergeGeometries(glass)! }
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
      cm.userData.noProbe = true // small: not in the reflection probes
      g.add(cm)
    }

    // ---- pit building on the outside (left side) of the main straight
    {
      const sMid = -110
      const i = track.idx(sMid)
      const off = track.L.wall[i] + 26
      const p = at(sMid, off)
      const pb = pitBuilding(300)
      const solid = new THREE.Mesh(pb.solid, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.75 }))
      const glassMesh = new THREE.Mesh(pb.glass, new THREE.MeshPhysicalNodeMaterial({ color: 0x0b1015, metalness: 0.2, roughness: 0.04, clearcoat: 1 }))
      for (const m of [solid, glassMesh]) {
        m.position.set(p.x, p.y - 0.05, p.z)
        // local +z (the garage fronts) faces the track, i.e. the right-hand side of the travel direction
        m.rotation.y = yawAt(sMid) - Math.PI / 2
        m.castShadow = true
        m.receiveShadow = true
        g.add(m)
      }
      // the pit lane surface, boxes and crews are built by PitLaneScene
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
      // local x spans across the track (along the track's left vector)
      beam.rotation.y = yawAt(s)
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
      lamps.userData.noProbe = true // small: not in the reflection probes
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
      const yaw = yawAt(s) // local x across the track
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
        brd.userData.noProbe = true // small: not in the reflection probes
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
      hut.userData.noProbe = true // small: not in the reflection probes
      g.add(hut)
      const roof = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 2.4), roofMat)
      roof.position.set(p.x, p.y + 2.4, p.z)
      roof.rotation.y = yawAt(s)
      roof.userData.noProbe = true // small: not in the reflection probes
      g.add(roof)
    }
    g.traverse((o) => {
      o.matrixAutoUpdate = false
      o.updateMatrix()
    })
    return g
  }, [track])

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
      <primitive object={structures} />
      <Vegetation track={track} heights={heights} />
    </>
  )
}

