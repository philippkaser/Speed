// Trackside scenery: forests, grandstands with crowds, pit building, start gantry, bridge,
// billboards, braking distance boards and marshal posts. All procedural & instanced.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
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

// ---------------------------------------------------------------------------------- trees
// Card-based trees: trunk + alpha-tested foliage cards (procedural needle / leaf atlases).

function foliageTexture(kind: 'needle' | 'leaf') {
  return canvasTexture(512, 512, (ctx) => {
    ctx.clearRect(0, 0, 512, 512)
    const r = rng(kind === 'needle' ? 5 : 9)
    if (kind === 'needle') {
      // a drooping spruce branch: central twig with dense needles
      for (let b = 0; b < 3; b++) {
        const y0 = 120 + b * 120
        ctx.strokeStyle = 'rgba(40,28,18,1)'
        ctx.lineWidth = 5
        ctx.beginPath()
        ctx.moveTo(10, y0)
        ctx.quadraticCurveTo(250, y0 - 30, 500, y0 + 40)
        ctx.stroke()
        for (let k = 0; k < 900; k++) {
          const t = r()
          const x = 10 + t * 490
          const yc = y0 - 30 * Math.sin(t * Math.PI) + t * 40
          const len = (1 - t) * 60 + 18
          const a = (r() - 0.5) * 2.4 + (r() < 0.5 ? -0.9 : 0.9)
          const g = 70 + r() * 70
          ctx.strokeStyle = `rgb(${(g * 0.35) | 0},${g | 0},${(g * 0.4) | 0})`
          ctx.lineWidth = 2.2
          ctx.beginPath()
          ctx.moveTo(x, yc)
          ctx.lineTo(x + Math.cos(a) * len * 0.5, yc + Math.sin(a) * len)
          ctx.stroke()
        }
      }
    } else {
      // leaf cluster
      for (let k = 0; k < 520; k++) {
        const ang = r() * Math.PI * 2
        const rad = Math.sqrt(r()) * 220
        const x = 256 + Math.cos(ang) * rad,
          y = 256 + Math.sin(ang) * rad * 0.9
        const s = 10 + r() * 14
        const g = 60 + r() * 90
        ctx.fillStyle = `rgb(${(g * 0.55) | 0},${g | 0},${(g * 0.3) | 0})`
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(r() * Math.PI * 2)
        ctx.beginPath()
        ctx.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }
  })
}

let foliageTex: { needle: THREE.Texture; leaf: THREE.Texture } | null = null
function getFoliage() {
  if (!foliageTex) foliageTex = { needle: foliageTexture('needle'), leaf: foliageTexture('leaf') }
  return foliageTex
}

/** Builds a card (quad) with normals bent away from the canopy centre for soft volumetric shading. */
function card(parts: THREE.BufferGeometry[], w: number, h: number, pos: THREE.Vector3, rotY: number, tiltX: number, center: THREE.Vector3, tint: THREE.Color, uvRect = [0, 0, 1, 1]) {
  const g = new THREE.PlaneGeometry(w, h)
  const uvA = g.getAttribute('uv')
  for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvRect[0] + uvA.getX(i) * (uvRect[2] - uvRect[0]), uvRect[1] + uvA.getY(i) * (uvRect[3] - uvRect[1]))
  g.translate(w / 2, 0, 0) // pivot at the branch base
  g.rotateX(tiltX)
  g.rotateY(rotY)
  g.translate(pos.x, pos.y, pos.z)
  const p = g.getAttribute('position')
  const n = g.getAttribute('normal')
  const col = new Float32Array(p.count * 3)
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i) - center.x, (p.getY(i) - center.y) * 0.7, p.getZ(i) - center.z).normalize()
    v.y += 0.35
    v.normalize()
    n.setXYZ(i, v.x, v.y, v.z)
    col.set([tint.r, tint.g, tint.b], i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  parts.push(g.index ? g.toNonIndexed() : g)
}

function trunkGeo(h: number, r0: number, r1: number, segs: number, color: THREE.Color) {
  const t = new THREE.CylinderGeometry(r1, r0, h, segs, 1, true)
  t.translate(0, h / 2, 0)
  const g = t.toNonIndexed()
  const col = new Float32Array(g.getAttribute('position').count * 3)
  for (let i = 0; i < col.length; i += 3) col.set([color.r, color.g, color.b], i)
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  // zero UVs mark trunk vertices as opaque in the foliage shader
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
  return g
}

function coniferGeometry(seed: number, lod = 0) {
  const r = rng(seed)
  const parts: THREE.BufferGeometry[] = []
  const H = 13 + r() * 5
  parts.push(trunkGeo(H * 0.9, 0.28, 0.06, lod ? 4 : 6, new THREE.Color(0.07, 0.05, 0.035)))
  const tiers = lod ? 7 : 14
  const center = new THREE.Vector3(0, H * 0.45, 0)
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1)
    const y = 2.2 + t * (H - 2.6)
    const len = (1 - t) * 3.4 + 0.6
    const n = lod ? 4 : 6
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2 + r() * 0.8 + k * 0.7
      const shade = 0.75 + r() * 0.35 + t * 0.15
      card(parts, len, len * 0.55, new THREE.Vector3(0, y, 0), a, -0.35 - r() * 0.25, center, new THREE.Color(shade, shade, shade), [0, 0.02 + (j % 3) * 0.32, 1, 0.3 + (j % 3) * 0.32])
    }
  }
  return mergeGeometries(parts.map((g) => {
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k)
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
    return g
  }))!
}

function broadleafGeometry(seed: number, lod = 0) {
  const r = rng(seed)
  const parts: THREE.BufferGeometry[] = []
  const H = 9 + r() * 4
  parts.push(trunkGeo(H * 0.62, 0.32, 0.14, lod ? 4 : 6, new THREE.Color(0.09, 0.07, 0.05)))
  const center = new THREE.Vector3(0, H * 0.68, 0)
  const rad = 3.2 + r() * 1.2
  const cards = lod ? 18 : 46
  for (let k = 0; k < cards; k++) {
    // points on a squashed sphere, cards facing outwards
    const u = r() * 2 - 1,
      phi = r() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const p = new THREE.Vector3(Math.cos(phi) * s * rad * (0.55 + r() * 0.5), center.y + u * rad * 0.7, Math.sin(phi) * s * rad * (0.55 + r() * 0.5))
    const size = 2.6 + r() * 1.6
    const shade = 0.7 + r() * 0.45 + (u + 1) * 0.1
    card(parts, size, size, p.clone().add(new THREE.Vector3(-Math.cos(phi) * size * 0.5, 0, -Math.sin(phi) * size * 0.5)), -phi, (r() - 0.5) * 1.2, center, new THREE.Color(shade, shade, shade))
  }
  return mergeGeometries(parts.map((g) => {
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k)
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
    return g
  }))!
}

function foliageMaterial(kind: 'needle' | 'leaf') {
  const tex = getFoliage()[kind]
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.45 })
  const phase = instanceIndex.toFloat().mul(1.731)
  const h = positionLocal.y.max(0)
  const sway = h.mul(h).mul(0.0012)
  const wind = (t: any) => vec3(sin(t.mul(1.1).add(phase)).mul(sway), 0, cos(t.mul(0.83).add(phase.mul(1.3))).mul(sway))
  // the previous position sways too, with last frame's clock: motion vectors see the wind's motion,
  // not the whole displacement (which smeared every tree)
  m.positionNode = Fn(() => {
    positionPrevious.assign(positionPrevious.add(wind(motionTime.prev)))
    return positionLocal.add(wind(motionTime.now))
  })()
  m.roughnessNode = float(0.85)
  const t = texture(tex, uv())
  // trunk vertices have uv (0,0) -> sample is transparent; keep them opaque via vertex colour darkness
  const isTrunk = step(uv().x.add(uv().y), 0.0001)
  const v = mx_noise_float(vec3(phase, 0.5, 0.1)).mul(0.25).add(1)
  m.colorNode = mix(t.rgb.mul(color(1, 1, 1)).mul(v), color(0.08, 0.06, 0.045), isTrunk)
  m.opacityNode = mix(t.a, float(1), isTrunk)
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
  const density = useSettings((s) => s.graphics.trees)
  const trees = useMemo(() => {
    const g = new THREE.Group()
    const { conifers, broad } = placeTrees(track, heights, density)
    const mats = { conifer: foliageMaterial('needle'), broad: foliageMaterial('leaf') }
    const variants = 3
    const CHUNK = 180
    // spatial chunks, each a THREE.LOD with a detailed and a cheap instanced mesh:
    // frustum culling per chunk, distance LOD, and shadow passes pick the cheap level
    const add = (list: THREE.Matrix4[], geoFn: (seed: number, lod?: number) => THREE.BufferGeometry, mat: THREE.Material) => {
      const geos = Array.from({ length: variants }, (_, v) => [geoFn(17 + v * 31, 0), geoFn(17 + v * 31, 1)])
      const chunks = new Map<string, THREE.Matrix4[][]>()
      const pos = new THREE.Vector3()
      list.forEach((mx, i) => {
        pos.setFromMatrixPosition(mx)
        const key = Math.floor(pos.x / CHUNK) + ':' + Math.floor(pos.z / CHUNK)
        let c = chunks.get(key)
        if (!c) chunks.set(key, (c = Array.from({ length: variants }, () => [])))
        c[i % variants].push(mx)
      })
      for (const [key, perVariant] of chunks) {
        const [cx, cz] = key.split(':').map(Number)
        const lod = new THREE.LOD()
        const center = new THREE.Vector3((cx + 0.5) * CHUNK, 0, (cz + 0.5) * CHUNK)
        const hi = new THREE.Group(),
          lo = new THREE.Group()
        perVariant.forEach((mats, v) => {
          if (!mats.length) return
          for (const [level, grp] of [
            [0, hi],
            [1, lo],
          ] as const) {
            const m = new THREE.InstancedMesh(geos[v][level], mat, mats.length)
            mats.forEach((mx, k) => {
              const local = mx.clone()
              local.elements[12] -= center.x
              local.elements[14] -= center.z
              m.setMatrixAt(k, local)
            })
            m.castShadow = true
            m.receiveShadow = level === 0
            m.computeBoundingSphere()
            grp.add(m)
          }
        })
        lod.position.copy(center)
        lod.addLevel(hi, 0)
        lod.addLevel(lo, 340)
        g.add(lod)
      }
    }
    add(conifers, coniferGeometry, mats.conifer)
    add(broad, broadleafGeometry, mats.broad)
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

