// Vegetation: forests of modelled trees and 3D grass on the verges (public/world/veg, built by
// scripts/build-world-assets.ts).
//
// Every kind of vegetation is ONE draw call, however many plants there are:
//  - each tree model (pine, broadleaf) is a single merged mesh with a single material (trunk, branches
//    and leaves share one texture atlas), drawn as one instanced draw for the whole forest within
//    ~300 m;
//  - beyond that, every tree of every model is an impostor: one quad per tree in one instanced draw,
//    with views of the real tree baked at load time (16 directions, colour and normals), lit like the
//    meshes;
//  - the grass is one patch mesh (clumps of Poly Haven's grass_medium_01) instanced along the verges
//    around the camera, in one draw.
// Instances live in a grid of cells. Each frame the visible cells are packed into the instance buffer
// nearest first; only a change in that set uploads anything. The shadow cascades draw the prefix of
// instances their range needs, and the meshes cross-fade into the impostors with a dither (no pop).
// Wind sway moves the previous position with last frame's clock, so the motion blur sees the wind's
// motion only.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three/webgpu'
import {
  atan,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cos,
  float,
  floor,
  fract,
  Fn,
  max,
  mix,
  mod,
  normalLocal,
  normalViewGeometry,
  positionPrevious,
  screenCoordinate,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uniformArray,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { motionTime } from './motionHistory'
import { csmState, sunState } from './Environment'
import { cascadesFar, farTreeShadow, setSunShadowTerm, setTreeShadows, type TreeShadowCaster } from './sunShadow'
import { valueNoise2 } from '../physics/math'
import { Surface } from '../physics/ground'
import { useSettings } from '../state/settings'
import { DS, type Track } from '../track/track'
import { pitLane } from '../track/pitlane'
import { debugFlag } from '../util/debug'
import type { TerrainHeight } from './trackGeometry'
import { loadVegetation, vegState, type VegMesh } from './worldAssets'
import { grassGroundColour } from './materials'

type N = any

const VEG_DEBUG = debugFlag('vegdebug')

/** Main camera position (the shadow and probe passes fade and pick LODs by the player's view). */
const vegCam = uniform(new THREE.Vector3())
/**
 * Lens factor: distances are judged by size on screen, like the cars' levels of detail (a tree 600 m
 * away through a TV camera's 5 degree lens is as big as one 60 m away through a normal lens).
 */
const vegLens = uniform(1)
const REF_TAN = Math.tan((50 * Math.PI) / 360)
const lensOf = (camera: THREE.Camera) => {
  const pc = camera as THREE.PerspectiveCamera
  return pc.isPerspectiveCamera ? Math.min(1.5, Math.max(0.05, Math.tan((pc.fov * Math.PI) / 360) / REF_TAN / pc.zoom)) : 1
}

/**
 * The geometry's own vertex position. (positionLocal is overwritten with a material's positionNode
 * result, here the instance's world position: anything read per vertex after it, varyings included,
 * must use the attribute.)
 */
const vertexPos = (): N => attribute('position', 'vec3')

/** Interleaved gradient noise: the dither of the cross-fades (stable per pixel). */
const ign = (p: N) => fract(float(52.9829189).mul(fract(p.x.mul(0.06711056).add(p.y.mul(0.00583715)))))

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
}

/** Per instance: x, y, z, yaw | scale, scaleY, tint (0..1), phase/kind */
const STRIDE = 8

// ------------------------------------------------------------------------------------- placement

function placeTrees(track: Track, heights: TerrainHeight, density: number) {
  const r = rng(track.def.seed)
  const conifers: number[] = []
  const broad: number[] = []
  const margin = 560
  // forests: closed canopies in their cores (a tree every ~8 m), thinning out to the edges and to
  // scattered trees in the meadows
  const step = 8 / Math.sqrt(Math.max(density, 0.1))
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
      if (r() > Math.min(1, (forest - 0.46) * 7) ** 1.5 * 0.92 + 0.04) continue
      const y = heights.height(px, pz)
      const conifer = valueNoise2(px * 0.004, pz * 0.004) > 0.45
      const scale = conifer ? 0.72 + r() * 0.6 : 0.58 + r() * 0.42
      const sy = scale * (0.88 + r() * 0.3)
      ;(conifer ? conifers : broad).push(px, y - 0.25, pz, r() * Math.PI * 2, scale, sy, r(), r() * 6.283)
    }
  }
  return { conifers: new Float32Array(conifers), broad: new Float32Array(broad) }
}

/** Grass patches on the verges: from the end of the kerb or paved runoff to the barrier, and a strip behind it. */
function placeGrass(track: Track, density: number) {
  const r = rng(track.def.seed * 7 + 3)
  const out: number[] = []
  const step = 1.0 / Math.sqrt(Math.max(density, 0.2))
  const p = { x: 0, y: 0, z: 0 }
  const lane = pitLane(track)
  const L = track.length
  const wrap = (s: number) => ((s % L) + L + L / 2) % L - L / 2
  for (let s = 0; s < L; s += step) {
    const i = track.idx(s)
    for (const side of [1, -1]) {
      const S = side > 0 ? track.L : track.R
      const edge = track.hw[i] + S.kerb[i] + (S.paved[i] >= 0.4 ? S.paved[i] : 0) + 0.25
      const wall = S.wall[i]
      const gravel = S.outer[i] === Surface.Gravel
      const sw = wrap(s)
      for (let d = edge; d < wall + 9; d += step) {
        const dd = d + (r() - 0.5) * step * 0.9
        // the barrier itself, gravel traps, the pit road and lane, the grandstands
        if (Math.abs(dd - wall) < 0.9) continue
        if (gravel && dd < wall - 1.5) continue
        if (dd < edge) continue
        if (side > 0 && sw > -830 && sw < 330 && Math.abs(dd - lane.roadD(sw)) < 7) continue
        if (side > 0 && sw > -270 && sw < 80 && dd > wall - 1) continue
        if (side < 0 && sw > -190 && sw < 240 && dd > wall) continue
        const ss = s + (r() - 0.5) * step * 0.9
        track.pointAt(ss, side * dd, p)
        // wide, low clumps that close up into a sward; mown short inside the barrier, longer behind it
        const sc = 1.45 + r() * 0.5
        const sy = (dd > wall ? 1.05 : 0.68) + r() * 0.3
        out.push(p.x, p.y - 0.02, p.z, r() * Math.PI * 2, sc, sy, r(), r() * 6.283)
      }
    }
  }
  void DS
  return new Float32Array(out)
}

/**
 * The grass's far level of detail: three crossed cards per patch, each showing one of the clump
 * billboards Poly Haven ships in the grass atlas (the bottom of grass.webp). 6 triangles instead of the
 * patch's 1800; same instances, same material (ground colour, canopy shading, wind by height).
 */
function grassCards() {
  // sprite rectangles in the atlas, pixels from the top-left of the 1024 x 1024 image
  const sprites: [number, number, number, number][] = [
    [201, 770, 499, 902],
    [599, 778, 839, 890],
    [26, 905, 205, 1016],
    [240, 914, 519, 1016],
    [590, 888, 808, 1016],
  ]
  const pos: number[] = [],
    nrm: number[] = [],
    uvs: number[] = [],
    wind: number[] = [],
    idx: number[] = []
  const H = 0.4
  const cards: [number, number, number, number][] = [
    // sprite, angle, offset x, offset z
    [0, 0.2, -0.15, 0.1],
    [3, 1.25, 0.2, -0.1],
    [4, 2.3, 0.0, 0.25],
  ]
  for (const [si, ang, ox, oz] of cards) {
    const [x0, y0, x1, y1] = sprites[si]
    const w = (H * (x1 - x0)) / (y1 - y0)
    const c = Math.cos(ang),
      s = Math.sin(ang)
    const base = pos.length / 3
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]) {
      const lx = (u - 0.5) * w
      pos.push(ox + lx * c, v * H, oz + lx * s)
      // lit mostly from above, like the patches' blades
      const nx = -s * 0.45,
        nz = c * 0.45
      const l = Math.hypot(nx, 0.9, nz)
      nrm.push(nx / l, 0.9 / l, nz / l)
      uvs.push((x0 + u * (x1 - x0)) / 1024, (y1 - v * (y1 - y0)) / 1024)
      wind.push(v, 1)
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.setAttribute('wind', new THREE.Float32BufferAttribute(wind, 2))
  g.setIndex(idx)
  return g
}

// ------------------------------------------------------------------------------------- cells

interface Cell {
  x: number
  y: number
  z: number
  r: number
  start: number
  count: number
}

/**
 * Sorts instances into square cells (contiguous ranges) with bounding spheres. Within a cell the order
 * is random, so any prefix of a cell is an even thinning of it.
 */
function buildCells(inst: Float32Array, size: number, height: number) {
  const n = inst.length / STRIDE
  const keyOf = (i: number) => Math.floor(inst[i * STRIDE] / size) * 65536 + Math.floor(inst[i * STRIDE + 2] / size)
  const r = rng(977)
  const rank = Float32Array.from({ length: n }, () => r())
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => keyOf(a) - keyOf(b) || rank[a] - rank[b])
  const data = new Float32Array(inst.length)
  const cells: Cell[] = []
  let cur: Cell | null = null
  let curKey = NaN
  let ymin = 0,
    ymax = 0
  order.forEach((src, k) => {
    data.set(inst.subarray(src * STRIDE, src * STRIDE + STRIDE), k * STRIDE)
    const key = keyOf(src)
    if (key !== curKey) {
      if (cur) finish(cur)
      curKey = key
      cur = { x: (Math.floor(inst[src * STRIDE] / size) + 0.5) * size, y: 0, z: (Math.floor(inst[src * STRIDE + 2] / size) + 0.5) * size, r: 0, start: k, count: 0 }
      ymin = Infinity
      ymax = -Infinity
      cells.push(cur)
    }
    cur!.count++
    ymin = Math.min(ymin, inst[src * STRIDE + 1])
    ymax = Math.max(ymax, inst[src * STRIDE + 1])
  })
  if (cur) finish(cur)
  function finish(c: Cell) {
    c.y = (ymin + ymax + height) / 2
    c.r = Math.hypot(size * 0.7072, (ymax - ymin + height) / 2)
  }
  return { data, cells }
}

const _frustum = new THREE.Frustum()
const _m = new THREE.Matrix4()
const _sphere = new THREE.Sphere()
const _cp = new THREE.Vector3()

interface LayerOpts {
  name: string
  instances: Float32Array
  geometry: THREE.BufferGeometry
  material: THREE.Material
  cell: number
  /** draw distance (m); instances fade out (dither) over the last part */
  maxDist: number
  /** model height at scale 1, for the cells' bounds */
  height: number
  castShadow: boolean
  /** extra margin around the view for shadow casters just outside it */
  shadowMargin: number
  /** how far the car's reflection probe sees this layer (0: not at all) */
  probeRange: number
  /** share of a cell's instances drawn at a distance (1: all); far grass thins out */
  keep?: (dist: number) => number
  /**
   * per-instance draw distance (m, on-screen terms): only instances this close are packed (the near
   * level of detail of the grass). The cells near the camera are few, so this is cheap; the buffer is
   * re-packed as the camera moves.
   */
  instanceRange?: number
}

/** One kind of vegetation: one mesh, one draw call; per-frame cell culling into the instance buffer. */
class VegLayer {
  mesh: THREE.Mesh
  geometry: THREE.InstancedBufferGeometry
  private a: THREE.InstancedBufferAttribute
  private b: THREE.InstancedBufferAttribute
  private data: Float32Array
  private cells: Cell[]
  private visible: number[] = []
  /** cumulative instance count and distance of each packed cell (for the shadow prefixes) */
  private prefixCount: number[] = []
  private prefixDist: number[] = []
  private key = ''
  total = 0
  triangles = 0
  mainCamera: THREE.Camera | null = null

  constructor(public o: LayerOpts) {
    const { data, cells } = buildCells(o.instances, o.cell, o.height)
    this.data = data
    this.cells = cells
    const g = new THREE.InstancedBufferGeometry()
    g.index = o.geometry.index
    for (const [k, v] of Object.entries(o.geometry.attributes)) g.setAttribute(k, v)
    const max = Math.max(1, data.length / STRIDE)
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4)
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4)
    this.a.setUsage(THREE.DynamicDrawUsage)
    this.b.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('iA', this.a)
    g.setAttribute('iB', this.b)
    g.instanceCount = 0
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.geometry = g
    const mesh = new THREE.Mesh(g, o.material)
    mesh.name = 'veg:' + o.name
    mesh.frustumCulled = false
    mesh.castShadow = o.castShadow
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    // shadow cascades and the reflection probe draw only the instances they need: the nearest ones
    mesh.onBeforeRender = (_r, scene, camera) => {
      const shadowPass = !!(scene.overrideMaterial as { isShadowPassMaterial?: boolean } | null)?.isShadowPassMaterial
      if (camera === this.mainCamera && !shadowPass) g.instanceCount = this.total
      else g.instanceCount = this.countWithin((shadowPass ? shadowRange(camera) : this.o.probeRange) * vegLens.value)
      if (VEG_DEBUG) {
        const w = window as unknown as { __vegShadowAll?: boolean; __vegLog?: Record<string, string> }
        if (w.__vegShadowAll && shadowPass) g.instanceCount = this.total
        if (shadowPass) (w.__vegLog ??= {})[o.name + ':' + camera.uuid.slice(0, 6)] = `${g.instanceCount}/${this.total} range ${shadowRange(camera).toFixed(0)} override ${(scene.overrideMaterial as { type?: string } | null)?.type}`
      }
    }
    this.mesh = mesh
  }

  private countWithin(dist: number) {
    if (dist === Infinity) return this.total
    if (dist <= 0) return 0
    let lo = 0,
      hi = this.prefixDist.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.prefixDist[mid] <= dist) lo = mid + 1
      else hi = mid
    }
    return lo > 0 ? this.prefixCount[lo - 1] : 0
  }

  update(camera: THREE.Camera) {
    this.mainCamera = camera
    camera.updateMatrixWorld()
    _cp.setFromMatrixPosition(camera.matrixWorld)
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    _frustum.setFromProjectionMatrix(_m, (camera as THREE.PerspectiveCamera).coordinateSystem)
    const list: { i: number; d: number }[] = []
    // in on-screen terms (see vegLens)
    const max = this.o.maxDist / lensOf(camera)
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i]
      const d = Math.hypot(c.x - _cp.x, c.y - _cp.y, c.z - _cp.z) - c.r
      if (d > max) continue
      _sphere.center.set(c.x, c.y, c.z)
      _sphere.radius = c.r + this.o.shadowMargin
      if (d > 0 && !_frustum.intersectsSphere(_sphere)) continue
      list.push({ i, d: Math.max(0, d) })
    }
    list.sort((p, q) => p.d - q.d)
    const range = this.o.instanceRange ? this.o.instanceRange / lensOf(camera) : 0
    // the near layer re-packs when the camera has moved half a metre
    const key = list.map((x) => x.i).join(',') + (range ? `|${Math.round(_cp.x * 2)},${Math.round(_cp.y * 2)},${Math.round(_cp.z * 2)},${range.toFixed(1)}` : '')
    if (key === this.key) return
    this.key = key
    const A = this.a.array as Float32Array,
      B = this.b.array as Float32Array
    let n = 0
    this.prefixCount.length = 0
    this.prefixDist.length = 0
    const lens = lensOf(camera)
    const r2 = (range + 0.8) * (range + 0.8)
    for (const { i, d } of list) {
      const c = this.cells[i]
      const count = this.o.keep ? Math.ceil(c.count * Math.min(1, this.o.keep(d * lens))) : c.count
      for (let k = 0; k < count; k++) {
        const s = (c.start + k) * STRIDE
        if (range) {
          const dx = this.data[s] - _cp.x,
            dy = this.data[s + 1] - _cp.y,
            dz = this.data[s + 2] - _cp.z
          if (dx * dx + dy * dy + dz * dz > r2) continue
        }
        A[n * 4] = this.data[s]
        A[n * 4 + 1] = this.data[s + 1]
        A[n * 4 + 2] = this.data[s + 2]
        A[n * 4 + 3] = this.data[s + 3]
        B[n * 4] = this.data[s + 4]
        B[n * 4 + 1] = this.data[s + 5]
        B[n * 4 + 2] = this.data[s + 6]
        B[n * 4 + 3] = this.data[s + 7]
        n++
      }
      this.prefixCount.push(n)
      this.prefixDist.push(d)
    }
    this.total = n
    this.triangles = n * ((this.geometry.index?.count ?? 0) / 3)
    this.geometry.instanceCount = n
    for (const at of [this.a, this.b]) {
      at.clearUpdateRanges()
      at.addUpdateRange(0, Math.max(1, n) * 4)
      at.needsUpdate = true
    }
  }

  dispose() {
    this.geometry.dispose()
    this.o.material.dispose()
  }
}

/** How far from the player's camera a shadow pass needs casters (CSM cascade far + a tree's shadow). */
function shadowRange(camera: THREE.Camera) {
  const csm = csmState.csm as { lights: { shadow: { camera: THREE.Camera } }[]; breaks: number[]; maxFar: number; camera?: THREE.PerspectiveCamera } | null
  if (!csm) return Infinity
  for (let i = 0; i < csm.lights.length; i++) {
    if (csm.lights[i].shadow.camera !== camera) continue
    const far = Math.min(csm.camera?.far ?? csm.maxFar, csm.maxFar)
    return (csm.breaks[i] ?? 1) * far + 40
  }
  return Infinity
}

// ------------------------------------------------------------------------------------- materials

interface WindOpts {
  /** sway amplitude at the top (m, at scale 1) */
  sway: number
  /** leaf flutter amplitude (m) */
  flutter: number
  speed: number
}

/** The instance transform (yaw, scale) with wind, for this frame and (positionPrevious) the last. */
function instanceTransform(wind: WindOpts, shrink?: N, scaleAll?: N, widen?: N) {
  const iA: N = attribute('iA', 'vec4'),
    iB: N = attribute('iB', 'vec4'),
    w: N = attribute('wind', 'vec2')
  const yaw = iA.w,
    phase = iB.w
  let sc: N = iB.x
  let sy: N = iB.y
  if (shrink) sy = sy.mul(shrink)
  if (scaleAll) {
    sc = sc.mul(scaleAll)
    sy = sy.mul(scaleAll)
  }
  if (widen) sc = sc.mul(widen)
  const cs = cos(yaw),
    sn = sin(yaw)
  const rot = (v: N) => vec3(v.x.mul(cs).sub(v.z.mul(sn)), v.y, v.x.mul(sn).add(v.z.mul(cs)))
  const offset = (t: N): N => {
    const h = w.x
    const amp = h.mul(h).mul(wind.sway).mul(sy)
    const gust = sin(t.mul(0.31).add(phase.mul(0.7))).mul(0.35).add(0.75)
    const sx: N = sin(t.mul(wind.speed).add(phase)).mul(amp).mul(gust)
    const sz: N = cos(t.mul(wind.speed * 0.77).add(phase.mul(1.37))).mul(amp).mul(0.55).mul(gust)
    const f: N = w.y.mul(wind.flutter).mul(sin(t.mul(5.3).add(vertexPos().x.mul(2.7)).add(vertexPos().y.mul(1.9)).add(phase)))
    return vec3(sx.add(f), f.mul(0.4), sz.sub(f))
  }
  const pl: N = vertexPos()
  const base: N = rot(vec3(pl.x.mul(sc), pl.y.mul(sy), pl.z.mul(sc))).add(iA.xyz)
  const node = Fn(() => {
    positionPrevious.assign(base.add(offset(motionTime.prev)))
    normalLocal.assign(rot(normalLocal))
    return base.add(offset(motionTime.now))
  })()
  return { node, iA, iB, w }
}

interface VegMaterialOpts {
  atlas: THREE.Texture
  wind: WindOpts
  alphaTest: number
  /** dithered fade-out between these distances from the player's camera */
  fadeOut: [number, number]
  /** and fade-in (the impostors' counterpart) */
  fadeIn?: [number, number]
  tintA: THREE.Color
  tintB: THREE.Color
  roughTrunk: number
  roughLeaf: number
  /** crown radius for the canopy's ambient occlusion (0: none) */
  crown: number
  /** grass: shrink with the fade instead of only dithering */
  shrink?: boolean
  /** grass: colour from the ground under the patch, detail from the blades */
  groundColour?: (xz: N) => N
  /**
   * grass: a dense canopy shades itself. Towards the roots the blades see less of the sky (ambient
   * occlusion, `root` at the ground) and less of the sun (`selfShadow` at the ground): the light that
   * reaches the bottom of a lawn has passed between the blades above it. The height in the patch (0 at
   * the ground, 1 at the tips) comes from the mesh.
   */
  canopy?: { root: number; selfShadow: number }
  /**
   * collapse instances that are fully faded (in or out) to nothing in the vertex shader: no fragments
   * are shaded only to be discarded (the grass cards overlap the near grass)
   */
  collapse?: boolean
  /** cards: grow wider with distance (0..1 over the fade-out range) as they thin out, keeping cover */
  widen?: number
}

function vegMaterial(o: VegMaterialOpts) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: o.alphaTest })
  const iA: N = attribute('iA', 'vec4')
  const dist = iA.xyz.sub(vegCam).length().mul(vegLens)
  const fade = smoothstep(o.fadeOut[0], o.fadeOut[1], dist)
  let alive: N = undefined
  if (o.collapse) {
    alive = step(fade, 0.999)
    if (o.fadeIn) alive = alive.mul(step(0.001, smoothstep(o.fadeIn[0], o.fadeIn[1], dist)))
  }
  const widen: N = o.widen ? float(1).add(smoothstep(o.fadeOut[0] * 0.4, o.fadeOut[1], dist).mul(o.widen)) : undefined
  const tf = instanceTransform(o.wind, o.shrink ? float(1).sub(fade.mul(0.6)) : undefined, alive, widen)
  m.positionNode = tf.node
  const vFade = varying(fade, 'vVegFade')
  const tex = texture(o.atlas, uv())
  const tint = mix(vec3(o.tintA.r, o.tintA.g, o.tintA.b), vec3(o.tintB.r, o.tintB.g, o.tintB.b), tf.iB.z)
  const leaf = tf.w.y
  let albedo: N = tex.rgb.mul(mix(vec3(1), tint, leaf))
  if (o.groundColour) {
    // the blade texture's relative detail on the ground's own colour (read once per vertex)
    const ground: N = varying(o.groundColour(iA.xz), 'vVegGround')
    const mean = texture(o.atlas, vec2(0.5, 0.5)).level(float(12)).rgb.max(vec3(0.02))
    albedo = ground.mul(tex.rgb.div(mean)).mul(tint)
  }
  m.colorNode = vec4(albedo, tex.a)
  m.roughnessNode = mix(float(o.roughTrunk), float(o.roughLeaf), leaf)
  m.metalnessNode = float(0)
  // card canopies: the baked, crown-shaped normals on both faces (no flipping on the back face)
  m.normalNode = normalViewGeometry
  if (o.crown > 0) {
    // ambient occlusion inside the crown: darker towards the trunk and the bottom of the canopy
    const radial = vertexPos().xz.length().div(o.crown).clamp(0, 1)
    m.aoNode = mix(float(1), mix(float(0.45), float(1), radial).mul(mix(float(0.75), float(1), tf.w.x)), leaf)
  }
  if (o.canopy) {
    const h = tf.w.x.clamp(0, 1)
    m.aoNode = mix(float(o.canopy.root), float(1), smoothstep(0, 0.85, h))
    setSunShadowTerm(m, mix(float(o.canopy.selfShadow), float(1), smoothstep(0.05, 0.9, h)))
  }
  const d = ign(screenCoordinate.xy)
  let keep: N = d.greaterThanEqual(vFade)
  if (o.fadeIn) keep = keep.and(d.lessThan(varying(smoothstep(o.fadeIn[0], o.fadeIn[1], dist), 'vVegFadeIn')))
  m.maskNode = keep
  return m
}

// ------------------------------------------------------------------------------------- impostors

const VIEWS = 16
const FRAME = 256

interface Impostors {
  albedo: THREE.Texture
  normal: THREE.Texture
  /** per species: half width, half height, centre height (m, at scale 1) */
  frames: THREE.Vector4[]
  /** the bake's render targets (read back into the textures above, then released) */
  targets: THREE.RenderTarget[]
  /** resolves when the textures hold the bake */
  ready: Promise<void>
  dispose: () => void
}

/**
 * Mip chain of an RGBA8 image (rows bottom-up). Colour is averaged by coverage (no dark fringes). For
 * the albedo, coverage is preserved: each level's alpha is scaled so as many texels pass the alpha
 * test as at full size. Plain averaging thins alpha-tested trees out with distance until they vanish.
 */
function mipChain(src: Uint8Array, W: number, H: number, preserveCoverage: boolean, alphaTest: number) {
  const levels: { data: Uint8Array; width: number; height: number }[] = [{ data: src, width: W, height: H }]
  const t = alphaTest * 255
  let covered = 0
  for (let i = 3; i < src.length; i += 4) if (src[i] > t) covered++
  const coverage0 = covered / (W * H)
  let prev = levels[0]
  while (prev.width > 1 || prev.height > 1) {
    const w = Math.max(1, prev.width >> 1),
      h = Math.max(1, prev.height >> 1)
    const d = new Uint8Array(w * h * 4)
    const alpha = new Float32Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0,
          n = 0,
          pr = 0,
          pg = 0,
          pb = 0
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(prev.width - 1, x * 2 + dx),
              sy = Math.min(prev.height - 1, y * 2 + dy)
            const k = (sy * prev.width + sx) * 4
            const wa = prev.data[k + 3]
            r += prev.data[k] * wa
            g += prev.data[k + 1] * wa
            b += prev.data[k + 2] * wa
            pr += prev.data[k]
            pg += prev.data[k + 1]
            pb += prev.data[k + 2]
            a += wa
            n++
          }
        const o = (y * w + x) * 4
        if (a > 0) {
          d[o] = r / a
          d[o + 1] = g / a
          d[o + 2] = b / a
        } else {
          d[o] = pr / n
          d[o + 1] = pg / n
          d[o + 2] = pb / n
        }
        alpha[y * w + x] = a / n
      }
    let scale = 1
    if (preserveCoverage && coverage0 > 0) {
      // the smallest scale whose share of passing texels reaches the full-size coverage
      let lo = 1,
        hi = 16
      const passing = (sc: number) => {
        let c = 0
        for (let i = 0; i < alpha.length; i++) if (alpha[i] * sc > t) c++
        return c / alpha.length
      }
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2
        if (passing(mid) < coverage0) lo = mid
        else hi = mid
      }
      scale = hi
    }
    for (let i = 0; i < alpha.length; i++) d[i * 4 + 3] = Math.min(255, Math.round(alpha[i] * scale))
    const lvl = { data: d, width: w, height: h }
    levels.push(lvl)
    prev = lvl
  }
  return levels
}

/**
 * Bakes each tree from 16 directions (orthographic, side on) into two atlases: albedo with coverage
 * and the canopy normal. Rows are species, columns directions.
 */
function bakeImpostors(renderer: THREE.WebGPURenderer, species: VegMesh[]): Impostors {
  const W = VIEWS * FRAME,
    H = species.length * FRAME
  const mk = () => {
    const rt = new THREE.RenderTarget(W, H, { depthBuffer: true, type: THREE.UnsignedByteType })
    rt.texture.generateMipmaps = true
    rt.texture.minFilter = THREE.LinearMipmapLinearFilter
    rt.texture.magFilter = THREE.LinearFilter
    rt.texture.colorSpace = THREE.NoColorSpace
    return rt
  }
  const rtA = mk(),
    rtB = mk()
  const scene = new THREE.Scene()
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200)
  const frames: THREE.Vector4[] = []
  const prevTarget = renderer.getRenderTarget()
  const prevClear = renderer.autoClear
  const prevColor = renderer.getClearColor(new THREE.Color())
  const prevAlpha = renderer.getClearAlpha()
  const prevTone = renderer.toneMapping
  renderer.toneMapping = THREE.NoToneMapping
  for (const rt of [rtA, rtB]) {
    renderer.setRenderTarget(rt)
    // transparent texels take a mid colour (filtering at the edges)
    renderer.setClearColor(rt === rtA ? 0x3a4a2a : 0x8080ff, 0)
    renderer.clear()
  }
  renderer.autoClear = false
  species.forEach((sp, row) => {
    const b = sp.info.bounds
    const halfW = Math.max(-b.min[0], b.max[0], -b.min[2], b.max[2]) * 1.02
    const halfH = ((b.max[1] - Math.max(b.min[1], -0.5)) / 2) * 1.02
    const cy = (b.max[1] + Math.max(b.min[1], -0.5)) / 2
    frames.push(new THREE.Vector4(halfW, halfH, cy, 0))
    const tex = texture(sp.atlas, uv())
    const leaf = (attribute('wind', 'vec2') as N).y
    const albedo = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 })
    // sqrt-encoded linear albedo (8-bit precision in the shadows)
    albedo.colorNode = vec4(tex.rgb.max(0).sqrt(), tex.a)
    const crown = halfW * 0.8
    const ao = mix(float(1), mix(float(0.5), float(1), vertexPos().xz.length().div(crown).clamp(0, 1)), leaf)
    albedo.colorNode = vec4(tex.rgb.mul(ao).max(0).sqrt(), tex.a)
    const normal = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 })
    // object-space normal of the (bent) canopy
    normal.colorNode = vec4(attribute('normal', 'vec3').mul(0.5).add(0.5), tex.a)
    for (const mat of [albedo, normal]) mat.toneMapped = false
    const mesh = new THREE.Mesh(sp.geometry, albedo)
    scene.add(mesh)
    cam.left = -halfW
    cam.right = halfW
    cam.top = halfH
    cam.bottom = -halfH
    cam.updateProjectionMatrix()
    for (let v = 0; v < VIEWS; v++) {
      const a = (v / VIEWS) * Math.PI * 2
      cam.position.set(Math.sin(a) * 100, cy, Math.cos(a) * 100)
      cam.lookAt(0, cy, 0)
      cam.updateMatrixWorld()
      for (const [rt, mat] of [
        [rtA, albedo],
        [rtB, normal],
      ] as const) {
        mesh.material = mat
        rt.viewport.set(v * FRAME, row * FRAME, FRAME, FRAME)
        rt.scissor.set(v * FRAME, row * FRAME, FRAME, FRAME)
        rt.scissorTest = true
        renderer.setRenderTarget(rt)
        renderer.render(scene, cam)
      }
    }
    scene.remove(mesh)
    albedo.dispose()
    normal.dispose()
  })
  renderer.autoClear = prevClear
  renderer.setClearColor(prevColor, prevAlpha)
  renderer.toneMapping = prevTone
  renderer.setRenderTarget(prevTarget)
  for (const rt of [rtA, rtB]) {
    rt.scissorTest = false
    rt.viewport.set(0, 0, W, H)
    rt.scissor.set(0, 0, W, H)
  }
  // The bake is read back once and uploaded as ordinary textures with a coverage-preserving mip chain:
  // sampling the render targets directly from a scene material came back empty, and their automatic
  // mipmaps averaged the trees' coverage away at a distance.
  const mkTex = () => {
    const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
    t.colorSpace = THREE.NoColorSpace
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
    t.magFilter = THREE.LinearFilter
    t.minFilter = THREE.LinearMipmapLinearFilter
    t.generateMipmaps = false
    t.flipY = false
    // not uploaded until the bake is in (a texture first uploaded at 1 x 1 is never re-created larger)
    return t
  }
  const albedo = mkTex(),
    normal = mkTex()
  const topDown = !!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
  const readBack = async (rt: THREE.RenderTarget, tex: THREE.DataTexture, preserve: boolean) => {
    const px = new Uint8Array((await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H)) as ArrayLike<number> as Uint8Array)
    // rows bottom-up (uv v = 0 at the bottom) on both backends; WebGPU reads back top-down
    if (topDown) {
      const row = W * 4,
        tmp = new Uint8Array(row)
      for (let y = 0; y < H >> 1; y++) {
        const a = y * row,
          b = (H - 1 - y) * row
        tmp.set(px.subarray(a, a + row))
        px.copyWithin(a, b, b + row)
        px.set(tmp, b)
      }
    }
    const mips = mipChain(px, W, H, preserve, 0.4)
    tex.image = { data: mips[0].data, width: W, height: H } as unknown as THREE.DataTexture['image']
    tex.mipmaps = mips as unknown as THREE.DataTexture['mipmaps']
    tex.needsUpdate = true
  }
  const ready = Promise.all([readBack(rtA, albedo, true), readBack(rtB, normal, false)])
    .then(() => {
      rtA.dispose()
      rtB.dispose()
    })
    .catch((e) => console.warn('[veg] impostor read-back failed', e))
  return {
    albedo,
    normal,
    frames,
    targets: [rtA, rtB],
    ready,
    dispose: () => {
      rtA.dispose()
      rtB.dispose()
      albedo.dispose()
      normal.dispose()
    },
  }
}

/** One quad per tree (all species), facing the camera about its vertical axis. */
function impostorMaterial(imp: Impostors, fadeIn: [number, number], maxDist: number, tints: THREE.Color[][]) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.4 })
  // distant trees stand in each other's shadows (sunShadow.ts)
  setSunShadowTerm(m, farTreeShadow())
  const iA: N = attribute('iA', 'vec4'),
    iB: N = attribute('iB', 'vec4')
  const species = iB.w.floor()
  const frames = uniformArray(imp.frames, 'vec4')
  const fr: N = frames.element(species.toInt())
  const sc = iB.x,
    sy = iB.y,
    yaw = iA.w
  // the camera's direction in the tree's own frame picks the baked view
  const toCam: N = cameraPosition.sub(iA.xyz)
  const flat = vec2(toCam.x, toCam.z)
  const flatN = flat.div(max(flat.length(), 1e-4))
  const right = vec3(flatN.y, 0, flatN.x.negate())
  const corner: N = vertexPos().xy // quad -1..1
  const world = iA.xyz.add(right.mul(corner.x.mul(fr.x).mul(sc))).add(vec3(0, fr.z.add(corner.y.mul(fr.y)).mul(sy), 0))
  m.positionNode = Fn(() => {
    positionPrevious.assign(world)
    return world
  })()
  // view angle about the tree: the bake's view v looks from (sin a, cos a); undo the instance's yaw
  const ang = atan(flatN.x, flatN.y).sub(yaw.negate())
  const f = ang.div(Math.PI * 2).mul(VIEWS)
  const v0 = mod(floor(f), VIEWS),
    v1 = mod(v0.add(1), VIEWS),
    t = fract(f)
  const local = corner.mul(0.5).add(0.5)
  // species rows were baked from the top of the atlas down (viewport y is top-origin on both backends)
  const rows = imp.frames.length
  const cell = (v: N) => vec2(v.add(local.x).div(VIEWS), float(rows - 1).sub(species).add(local.y).div(rows))
  const uv0 = varying(cell(v0), 'vImpUv0'),
    uv1 = varying(cell(v1), 'vImpUv1'),
    vt = varying(t, 'vImpT')
  const a0 = texture(imp.albedo, uv0),
    a1 = texture(imp.albedo, uv1)
  const n0 = texture(imp.normal, uv0),
    n1 = texture(imp.normal, uv1)
  const alb = mix(a0.rgb, a1.rgb, vt)
  const alpha = mix(a0.a, a1.a, vt)
  const tint = mix(vec3(tints[0][0].r, tints[0][0].g, tints[0][0].b), vec3(tints[0][1].r, tints[0][1].g, tints[0][1].b), iB.z)
  const tintB = mix(vec3(tints[1][0].r, tints[1][0].g, tints[1][0].b), vec3(tints[1][1].r, tints[1][1].g, tints[1][1].b), iB.z)
  const tn = mix(tint, tintB, species.clamp(0, 1))
  m.colorNode = vec4(alb.mul(alb).mul(tn), alpha)
  // baked object-space normal, turned with the tree, into view space
  const nObj = mix(n0.rgb, n1.rgb, vt).mul(2).sub(1)
  const cs = cos(yaw),
    sn = sin(yaw)
  const nWorld = vec3(nObj.x.mul(cs).sub(nObj.z.mul(sn)), nObj.y, nObj.x.mul(sn).add(nObj.z.mul(cs))).normalize()
  m.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize()
  m.roughnessNode = float(0.8)
  m.metalnessNode = float(0)
  const dist = iA.xyz.sub(vegCam).length().mul(vegLens)
  const vIn = varying(smoothstep(fadeIn[0], fadeIn[1], dist), 'vImpFade')
  const vOut = varying(smoothstep(maxDist * 0.85, maxDist, dist), 'vImpOut')
  const d = ign(screenCoordinate.xy)
  m.maskNode = d.lessThan(vIn).and(d.greaterThanEqual(vOut))
  if (debugFlag('impdebug')) {
    // ?impdebug: every quad, atlas colour where the coverage passes, red where it fails
    m.alphaTest = 0
    m.maskNode = null
    m.colorNode = vec4(mix(vec3(1, 0, 0), alb.mul(alb).mul(4), (alpha as N).greaterThan(0.4)), 1)
  }
  return m
}

// ------------------------------------------------------------------------------------- component

const NEAR_TREES = 170
const FADE: [number, number] = [140, 170]
const FAR_TREES = 2600

export function Vegetation({ track, heights }: { track: Track; heights: TerrainHeight }) {
  const density = useSettings((s) => s.graphics.trees)
  const { gl } = useThree()
  const renderer = gl as unknown as THREE.WebGPURenderer
  const [meshes, setMeshes] = useState(vegState.ready ? vegState.meshes : null)
  useEffect(() => {
    let alive = true
    loadVegetation().then((m) => alive && setMeshes(m))
    return () => {
      alive = false
    }
  }, [])

  const built = useMemo(() => {
    if (!meshes || !meshes.size) return null
    const t0 = performance.now()
    const group = new THREE.Group()
    group.name = 'vegetation'
    const layers: VegLayer[] = []
    const pine = meshes.get('pine'),
      broad = meshes.get('broadleaf'),
      grass = meshes.get('grass')
    const trees = placeTrees(track, heights, density)
    const tints = [
      [new THREE.Color(0.78, 0.86, 0.74), new THREE.Color(1.02, 1.04, 0.92)],
      [new THREE.Color(0.85, 0.9, 0.7), new THREE.Color(1.08, 1.05, 0.82)],
    ]
    const wind: WindOpts = { sway: 0.22, flutter: 0.035, speed: 0.9 }
    // ?impostorsonly: no meshes, impostors at every distance (to look at them up close)
    const withMeshes = !debugFlag('impostorsonly')
    if (pine && withMeshes && !debugFlag('notrees'))
      layers.push(
        new VegLayer({
          name: 'pine',
          instances: trees.conifers,
          geometry: pine.geometry,
          material: vegMaterial({ atlas: pine.atlas, wind, alphaTest: 0.5, fadeOut: FADE, tintA: tints[0][0], tintB: tints[0][1], roughTrunk: 0.92, roughLeaf: 0.7, crown: 5 }),
          cell: 64,
          maxDist: NEAR_TREES,
          height: 23,
          castShadow: true,
          shadowMargin: 30,
          probeRange: 90,
        }),
      )
    if (broad && withMeshes && !debugFlag('notrees'))
      layers.push(
        new VegLayer({
          name: 'broadleaf',
          instances: trees.broad,
          geometry: broad.geometry,
          material: vegMaterial({ atlas: broad.atlas, wind: { ...wind, sway: 0.3, flutter: 0.05 }, alphaTest: 0.5, fadeOut: FADE, tintA: tints[1][0], tintB: tints[1][1], roughTrunk: 0.9, roughLeaf: 0.6, crown: 6 }),
          cell: 64,
          maxDist: NEAR_TREES,
          height: 17,
          castShadow: true,
          shadowMargin: 30,
          probeRange: 90,
        }),
      )
    // impostors: every tree of every species in one quad draw (baked from the meshes above)
    let impostors: Impostors | null = null
    if (pine && broad && !debugFlag('notrees') && !debugFlag('noimpostors')) {
      impostors = bakeImpostors(renderer, [pine, broad])
      if (debugFlag('vegdebug')) (window as unknown as { __vegDebug?: object }).__vegDebug = { renderer, impostors, csmState, trees: Array.from(trees.broad.slice(0, 8 * 400)).concat(Array.from(trees.conifers.slice(0, 8 * 400))) }
      const quad = new THREE.PlaneGeometry(2, 2)
      const all = new Float32Array(trees.conifers.length + trees.broad.length)
      all.set(trees.conifers)
      all.set(trees.broad, trees.conifers.length)
      // kind in the last slot (the impostor has no wind phase)
      for (let i = trees.conifers.length / STRIDE; i < all.length / STRIDE; i++) all[i * STRIDE + 7] = 1.5
      for (let i = 0; i < trees.conifers.length / STRIDE; i++) all[i * STRIDE + 7] = 0.5
      const impostorLayer = new VegLayer({
          name: 'impostors',
          instances: all,
          geometry: quad,
          material: impostorMaterial(impostors, withMeshes ? FADE : [-2, -1], FAR_TREES, tints),
          cell: 160,
          maxDist: FAR_TREES,
          height: 23,
          castShadow: true,
          shadowMargin: 30,
          probeRange: Infinity,
        })
      // hidden until the bake has been read back into its textures
      impostorLayer.mesh.visible = false
      impostors.ready.then(() => (impostorLayer.mesh.visible = true))
      layers.push(impostorLayer)
    }
    if (grass && !debugFlag('nograss') && density >= 0.5) {
      const g = placeGrass(track, density)
      // two levels of detail over the same patches: the modelled clumps near the camera (each instance
      // packed only while within `near`), crossed cards beyond, out to `reach`, dithered into each other
      const near = 11 + 3 * Math.min(density, 1.4)
      const reach = 55 + 25 * Math.min(density, 1.4)
      const common = {
        atlas: grass.atlas,
        wind: { sway: 0.05, flutter: 0.008, speed: 1.6 },
        alphaTest: 0.4,
        tintA: new THREE.Color(0.9, 0.95, 0.88),
        tintB: new THREE.Color(1.04, 1.08, 0.96),
        groundColour: grassGroundColour,
        roughTrunk: 0.85,
        roughLeaf: 0.85,
        crown: 0,
        canopy: { root: 0.32, selfShadow: 0.28 },
        collapse: true,
      }
      const opts = { instances: g, height: 0.6, castShadow: false, shadowMargin: 0, probeRange: 0 }
      layers.push(
        new VegLayer({
          ...opts,
          name: 'grass',
          geometry: grass.geometry,
          material: vegMaterial({ ...common, fadeOut: [near - 2.5, near] }),
          cell: 8,
          maxDist: near,
          instanceRange: near,
        }),
      )
      layers.push(
        new VegLayer({
          ...opts,
          name: 'grass-cards',
          geometry: grassCards(),
          material: vegMaterial({ ...common, fadeIn: [near - 2.5, near], fadeOut: [reach * 0.72, reach], widen: 0.7 }),
          cell: 24,
          maxDist: reach,
          // full density to ~25 m, thinning beyond (the cards widen to keep the cover)
          keep: (d) => Math.max(0.3, Math.min(1, (26 / Math.max(d, 1)) ** 1.25)),
        }),
      )
      console.info(`[veg] ${g.length / STRIDE} grass patches`)
    }
    // the distant trees' shadows on the ground (sunShadow.ts): crown size and height from each
    // model's bounds, scaled per tree
    const casters: TreeShadowCaster[] = []
    const crown = (mesh: VegMesh | undefined, cy: number) => {
      if (!mesh) return { r: 0, h: 0 }
      const b = mesh.info.bounds
      return { r: 0.42 * Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]), h: b.min[1] + cy * (b.max[1] - b.min[1]) }
    }
    for (const [arr, c] of [
      [trees.conifers, crown(pine, 0.5)],
      [trees.broad, crown(broad, 0.62)],
    ] as const)
      for (let i = 0; i + STRIDE <= arr.length; i += STRIDE) casters.push({ x: arr[i], y: arr[i + 1], z: arr[i + 2], radius: c.r * arr[i + 4], height: c.h * arr[i + 5] })
    const margin = 600
    const treeBounds: [number, number, number, number] = [track.minX - margin, track.minZ - margin, track.maxX + margin, track.maxZ + margin]
    for (const l of layers) group.add(l.mesh)
    console.info(`[veg] ${trees.conifers.length / STRIDE} pines, ${trees.broad.length / STRIDE} broadleaf trees, ${layers.length} draw calls, built in ${(performance.now() - t0).toFixed(0)} ms`)
    return { group, layers, impostors, casters, treeBounds }
  }, [meshes, track, heights, density, renderer])
  const shadowsQ = useSettings((st) => st.graphics.shadows)
  const treeSun = useMemo(() => ({ dir: new THREE.Vector3(), built: null as unknown, q: -1 }), [])

  useEffect(
    () => () => {
      if (!built) return
      for (const l of built.layers) l.dispose()
      built.impostors?.dispose()
    },
    [built],
  )

  // after the camera rigs (0) and before the frame is drawn (1)
  useFrame(({ camera }) => {
    if (!built) return
    // (re)splat the trees' ground shadows when the sun has moved or the forest is new
    if (treeSun.built !== built || treeSun.q !== shadowsQ || treeSun.dir.dot(sunState.dir) < 0.99998) {
      treeSun.built = built
      treeSun.q = shadowsQ
      treeSun.dir.copy(sunState.dir)
      setTreeShadows(built.casters, sunState.dir, built.treeBounds, cascadesFar(shadowsQ))
    }
    camera.updateMatrixWorld()
    vegCam.value.setFromMatrixPosition(camera.matrixWorld)
    vegLens.value = lensOf(camera)
    for (const l of built.layers) l.update(camera)
    ;(window as unknown as { __veg?: object }).__veg = Object.fromEntries(built.layers.map((l) => [l.o.name, { instances: l.total, triangles: l.triangles }]))
  }, 0.6)

  return built ? <primitive object={built.group} /> : null
}
