// Assembles a complete car: SDF-sculpted body, wheels, aero parts, cockpit and driver.
import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { abs, clamp, color, float, fract, max, mix, mx_noise_vec3, normalize, normalLocal, normalView, normalViewGeometry, positionLocal, positionViewDirection, pow, smoothstep, step, texture, uniform, uv, vec2, vec3 } from 'three/tsl'
import { getCar, type CarSpec } from '../physics/spec'
import type { Vehicle } from '../physics/vehicle'
import { canvasTexture } from '../render/textures'
import { bumpView } from '../render/materials'
import { breakUpRoughness, detailAt, detailHeight, triMap } from '../render/surfaceDetail'
import { type BodyDef, makeBody, Mat, MAT_COUNT } from './bodies'
import { surfaceNets } from './sdf'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export interface CarModel {
  root: THREE.Group
  /** body extent along the car (model space); the procedural model passes its full definition */
  body: Pick<BodyDef, 'zFront' | 'zRear'>
  spec: CarSpec
  update: (v: Vehicle, entry?: { id: string }) => void
  dispose: () => void
  cockpitEye: THREE.Vector3 // in root (CoG) space
  bodyOffset: THREE.Vector3
  setVisibleParts: (opts: { body?: boolean; interior?: boolean; driver?: boolean }) => void
  /** the four wheels: pivot (steers, rides), spin (child of pivot, turns about +x), physics index */
  wheels?: { pivot: THREE.Object3D; spin: THREE.Object3D; radius: number; index: number }[]
}

const geometryCache = new Map<string, THREE.BufferGeometry>()

export function buildBodyGeometry(spec: CarSpec, cell: number) {
  const key = spec.id + ':' + cell
  const cached = geometryCache.get(key)
  if (cached) return cached
  const body = makeBody(spec)
  const t0 = performance.now()
  const mesh = surfaceNets(body.sdf, body.min, body.max, cell)
  // orientation check: triangle normals vs field gradient
  let agree = 0
  const P = mesh.positions,
    N = mesh.normals,
    I = mesh.indices
  for (let t = 0; t < Math.min(I.length, 3000 * 3); t += 3) {
    const a = I[t] * 3,
      b = I[t + 1] * 3,
      c = I[t + 2] * 3
    const ux = P[b] - P[a],
      uy = P[b + 1] - P[a + 1],
      uz = P[b + 2] - P[a + 2]
    const vx = P[c] - P[a],
      vy = P[c + 1] - P[a + 1],
      vz = P[c + 2] - P[a + 2]
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx
    agree += nx * N[a] + ny * N[a + 1] + nz * N[a + 2] > 0 ? 1 : -1
  }
  if (agree < 0) for (let t = 0; t < I.length; t += 3) [I[t + 1], I[t + 2]] = [I[t + 2], I[t + 1]]
  // classify triangles into material groups. A triangle takes the material at its centre, so a
  // material's edge was a staircase of whole triangles (~3 cm teeth along every window, lamp and
  // intake). Where a triangle's corners disagree, it is split along the edge: into four (the edges'
  // midpoints) and once more where the pieces' corners still disagree; each piece takes the material
  // at its own centre (steps of ~7 mm). Close up only (the finest level of detail: +50 % triangles);
  // from 30 m the teeth are a couple of pixels.
  const splitDepth = cell < 0.035 ? 2 : 0
  const buckets: number[][] = Array.from({ length: MAT_COUNT }, () => [])
  const pos: number[] = Array.from(P),
    nrm: number[] = Array.from(N)
  const classOf = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    const l = Math.hypot(nx, ny, nz) || 1
    return body.classify(x, y, z, nx / l, ny / l, nz / l)
  }
  const nV = P.length / 3
  const vClass = new Int8Array(nV)
  for (let v = 0; v < nV; v++) vClass[v] = classOf(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], N[v * 3], N[v * 3 + 1], N[v * 3 + 2])
  const mid = (a: number, b: number) => {
    pos.push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2)
    nrm.push(nrm[a * 3] + nrm[b * 3], nrm[a * 3 + 1] + nrm[b * 3 + 1], nrm[a * 3 + 2] + nrm[b * 3 + 2])
    const k = pos.length / 3 - 1
    const l = Math.hypot(nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]) || 1
    nrm[k * 3] /= l
    nrm[k * 3 + 1] /= l
    nrm[k * 3 + 2] /= l
    return k
  }
  const vc = (v: number) => (v < nV ? vClass[v] : classOf(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]))
  const centre = (a: number, b: number, c: number) =>
    classOf(
      (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3,
      (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3,
      (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3,
      nrm[a * 3] + nrm[b * 3] + nrm[c * 3],
      nrm[a * 3 + 1] + nrm[b * 3 + 1] + nrm[c * 3 + 1],
      nrm[a * 3 + 2] + nrm[b * 3 + 2] + nrm[c * 3 + 2],
    )
  let split = 0
  const emit = (a: number, b: number, c: number, ca: number, cb: number, cc: number, depth: number) => {
    if ((ca === cb && cb === cc) || depth === 0) {
      buckets[ca === cb && cb === cc ? ca : centre(a, b, c)].push(a, b, c)
      return
    }
    split++
    const ab = mid(a, b),
      bc = mid(b, c),
      ca2 = mid(c, a)
    const cab = vc(ab),
      cbc = vc(bc),
      cca = vc(ca2)
    emit(a, ab, ca2, ca, cab, cca, depth - 1)
    emit(ab, b, bc, cab, cb, cbc, depth - 1)
    emit(ca2, bc, c, cca, cbc, cc, depth - 1)
    emit(ab, bc, ca2, cab, cbc, cca, depth - 1)
  }
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t],
      b = I[t + 1],
      c = I[t + 2]
    const ca = vClass[a],
      cb = vClass[b],
      cc = vClass[c]
    if (ca === cb && cb === cc) {
      // (the centre decides, as before, where the corners agree: a feature narrower than a triangle)
      buckets[centre(a, b, c)].push(a, b, c)
    } else emit(a, b, c, ca, cb, cc, splitDepth)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3))
  const all: number[] = []
  let start = 0
  for (let m = 0; m < MAT_COUNT; m++) {
    const b = buckets[m]
    for (let k = 0; k < b.length; k++) all.push(b[k])
    if (b.length) g.addGroup(start, b.length, m)
    start += b.length
  }
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(all), 1))
  g.computeBoundingSphere()
  console.info(`[car] ${spec.id} body ${(all.length / 3) | 0} tris (${split} split along material edges) in ${(performance.now() - t0).toFixed(0)} ms`)
  geometryCache.set(key, g)
  return g
}

// ------------------------------------------------------------------------------------- materials

function contrastColor(c: THREE.Color) {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  return l > 0.35 ? new THREE.Color(0.02, 0.02, 0.025) : new THREE.Color(0.85, 0.85, 0.84)
}

function numberTexture(num: number) {
  return canvasTexture(256, 256, (ctx) => {
    ctx.clearRect(0, 0, 256, 256)
    ctx.fillStyle = '#f2f2f0'
    ctx.beginPath()
    ctx.arc(128, 128, 118, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#0b0b0d'
    ctx.font = '900 150px Inter, Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(num), 128, 138)
  })
}

export function paintMaterial(base: string, body: BodyDef, num: number, accentColor?: string) {
  const c = new THREE.Color(base)
  const accent = accentColor ? new THREE.Color(accentColor) : contrastColor(c)
  const m = new THREE.MeshPhysicalNodeMaterial({ clearcoat: 1, clearcoatRoughness: 0.035 })
  const p = positionLocal
  const ax = abs(p.x)
  // livery: twin stripes over the centreline + a sweeping side flash
  const stripes = smoothstep(0.105, 0.1, abs(ax.sub(0.16))).mul(step(0.7, p.y))
  const flashLine = p.y.sub(float(0.36).add(p.z.mul(0.07)))
  const flash = smoothstep(0.0, 0.01, flashLine).mul(smoothstep(0.075, 0.065, flashLine)).mul(step(0.75, ax))
  const accentMask = max(stripes.mul(0.95), flash)
  // number roundel on the doors
  const numTex = numberTexture(num)
  const nu = p.z.sub(body.style === 'coupe' ? 0.05 : 0.0).div(0.5).add(0.5)
  const nv = p.y.sub(0.55).div(0.5).add(0.5)
  const flipU = step(0, p.x) // mirror on the other side so the number reads correctly
  const uvN = vec2(mix(nu, float(1).sub(nu), flipU), nv)
  const inRect = step(0, uvN.x).mul(step(uvN.x, 1)).mul(step(0, uvN.y)).mul(step(uvN.y, 1)).mul(step(0.7, ax))
  const numSample = texture(numTex, uvN)
  const numMask = numSample.a.mul(inRect)
  let col = mix(color(c), color(accent), accentMask)
  col = mix(col, numSample.rgb, numMask)
  // panel gaps: door shut lines
  const doorF = smoothstep(0.004, 0.0, abs(p.z.sub(0.62))).mul(step(0.25, p.y)).mul(step(p.y, 0.8)).mul(step(0.75, ax))
  const doorR = smoothstep(0.004, 0.0, abs(p.z.add(body.style === 'coupe' ? 0.75 : 0.5))).mul(step(0.25, p.y)).mul(step(p.y, 0.8)).mul(step(0.75, ax))
  col = mix(col, col.mul(0.15), max(doorF, doorR))
  // ---- a race car after a few laps (surfaceDetail.ts): the fine detail at ~4 mm a bump (the clear
  // coat's orange peel, swirl marks and fine scratches from washing), the coarse at ~1 m a tile
  const nl = normalLocal
  const fine = triMap('a', p, nl, 4) // grain, mottle, scratch
  const peel = triMap('c', p, nl, 4).b
  const coarse = triMap('b', p, nl, 1) // streaks, smudges, chips
  const spots = triMap('c', p, nl, 1.5) // pits (marbles, chips, bugs)
  // road grime on the lower body, thickest on the sills and the lower rear, ragged at its top
  const grimeTop = float(0.32).add(coarse.r.sub(0.5).mul(0.25))
  const grime = float(1).sub(smoothstep(float(0.08), grimeTop, p.y)).mul(mix(float(0.55), float(1), coarse.r)).mul(0.75)
  // brake dust: the wheels spray it on the body behind and around them; rubber picked up from the
  // track (marbles) peppers the panels behind each wheel low down
  let brakeDust: N = float(0),
    marbles: N = float(0)
  for (const w of body.wheels) {
    const dy = p.y.sub(w.y),
      dz = p.z.sub(w.z)
    const r = dy.mul(dy).add(dz.mul(dz)).sqrt()
    const side = smoothstep(Math.abs(w.x) - 0.35, Math.abs(w.x) - 0.1, ax)
    const behind = smoothstep(0.15, -0.25, dz)
    brakeDust = max(brakeDust, smoothstep(w.r + 0.45, w.r + 0.02, r).mul(side).mul(mix(float(0.45), float(1), behind)))
    const zone = smoothstep(0.0, -0.15, dz.add(w.r)).mul(smoothstep(-1.1, -0.6, dz.add(w.r))).mul(smoothstep(w.y + 0.25, w.y - 0.05, p.y)).mul(side)
    marbles = max(marbles, zone.mul(smoothstep(0.3, 0.55, spots.r)))
  }
  // the nose: stone chips (to the primer) and flies
  const nose = smoothstep(body.zFront - 0.45, body.zFront - 0.05, p.z).mul(smoothstep(0.1, 0.6, nl.z))
  const chips = nose.mul(smoothstep(0.45, 0.7, spots.r))
  const bugs = nose.mul(smoothstep(0.75, 0.95, spots.g)).mul(step(0.6, coarse.g.add(spots.b)))
  const dirtCol = vec3(0.16, 0.145, 0.12)
  col = mix(col, dirtCol, grime.mul(0.55))
  col = mix(col, vec3(0.07, 0.058, 0.045), brakeDust.mul(0.6))
  col = mix(col, vec3(0.5, 0.5, 0.49), chips.mul(0.85))
  col = mix(col, vec3(0.04, 0.035, 0.02), bugs.mul(0.8))
  col = mix(col, vec3(0.02, 0.02, 0.022), marbles)
  // dirt and the rubber sit on top of the clear coat: matte, no clear coat there
  const covered = clamp(grime.mul(0.8).add(brakeDust.mul(0.7)).add(marbles).add(bugs), 0, 1)
  m.colorNode = col
  const metallic = c.getHSL({ h: 0, s: 0, l: 0 }).s > 0.2 ? 0.55 : 0.25
  m.metalnessNode = mix(mix(float(metallic), float(0.1), max(accentMask, numMask)), float(0), max(covered, chips))
  m.roughnessNode = mix(float(0.34), float(0.85), covered)
  // metallic flakes: high frequency normal perturbation under the clear coat; the marbles stand proud
  const flake = mx_noise_vec3(p.mul(700)).mul(0.055)
  m.normalNode = bumpView(marbles.mul(0.0008).add(chips.mul(-0.0002)), normalize(normalView.add(flake.mul(metallic))))
  // the clear coat: a mirror over the flakes, its surface not quite flat (orange peel, ~4 mm bumps a
  // few microns high: the reflections ripple), swirl marks and fine scratches dulling it in places,
  // dull where wiped or dirty; it reflects like the GT3 models' (gltfCars.ts): ~2.2x the physical 4%
  // head-on, the exact Fresnel towards grazing angles
  m.clearcoatNormalNode = bumpView(peel.sub(0.5).mul(0.000025).sub(fine.b.mul(0.000004)), normalViewGeometry)
  m.clearcoatRoughnessNode = mix(float(0.03), float(0.12), fine.b.mul(0.8)).add(coarse.g.mul(0.05)).mul(mix(float(0.85), float(1.15), fine.r))
  const nvc = normalViewGeometry.dot(positionViewDirection).abs().clamp(0, 1)
  m.clearcoatNode = mix(float(2.2), float(1), pow(float(1).sub(nvc), 5)).mul(float(1).sub(covered))
  return m
}

/**
 * Exhaust tips: stainless steel blued and golden by the heat towards the outlet (temper colours), sooted
 * black at the lip.
 */
function exhaustMaterial(zRear: number) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide })
  const p = positionLocal
  const a = triMap('a', p, normalLocal, 3)
  // 0 at the root of the tip, 1 at its lip
  const t = smoothstep(zRear + 0.13, zRear - 0.05, p.z)
  const temper = mix(mix(vec3(0.62, 0.6, 0.57), vec3(0.6, 0.45, 0.18), smoothstep(0.2, 0.5, t)), vec3(0.22, 0.2, 0.42), smoothstep(0.45, 0.8, t))
  const soot = smoothstep(0.7, 0.98, t.add(a.g.sub(0.5).mul(0.2)))
  m.colorNode = mix(temper.mul(mix(float(0.85), float(1.08), a.g)), vec3(0.02, 0.02, 0.02), soot)
  m.metalnessNode = mix(float(1), float(0), soot)
  m.roughnessNode = mix(mix(float(0.22), float(0.4), a.r).add(a.b.mul(0.15)), float(0.9), soot)
  return m
}

function carbonMaterial() {
  const m = new THREE.MeshPhysicalNodeMaterial({ clearcoat: 0.8, clearcoatRoughness: 0.08 })
  const p = positionLocal.mul(110)
  const a = fract(p.x.add(p.z)),
    b = fract(p.x.sub(p.z).add(p.y))
  const weave = step(0.5, fract(p.x.mul(0.5).add(p.z.mul(0.5)))).mul(0.5).add(smoothstep(0.2, 0.5, abs(a.sub(0.5))).mul(0.3)).add(b.mul(0.1))
  m.colorNode = vec3(0.02, 0.021, 0.023).mul(weave.add(0.6))
  m.metalnessNode = float(0.3)
  m.roughnessNode = float(0.38)
  // the weave's relief under the resin, the resin's own unevenness, and its lacquer scuffed and smeared
  const q = positionLocal
  const fine = triMap('a', q, normalLocal, 3)
  const smear = triMap('b', q, normalLocal, 1).g
  m.normalNode = bumpView(weave.mul(0.00004))
  m.clearcoatNormalNode = bumpView(fine.r.sub(0.5).mul(0.00003), normalViewGeometry)
  m.clearcoatRoughnessNode = mix(float(0.06), float(0.2), fine.b.mul(0.8)).add(smear.mul(0.08))
  return m
}

/** Textured black plastic (trim, splitters' edges, mirrors' stalks): grain, scuffs, dust. */
function trimMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const q = positionLocal
  const a = triMap('a', q, normalLocal, 2)
  m.colorNode = vec3(0.03, 0.032, 0.034).mul(mix(float(0.85), float(1.2), a.g)).add(smoothstep(0.4, 0.8, a.b).mul(0.02))
  m.roughnessNode = mix(float(0.42), float(0.62), a.r).add(a.b.mul(0.15))
  m.metalnessNode = float(0)
  m.normalNode = bumpView(a.r.sub(0.5).mul(0.0003))
  return m
}

function glassMaterial() {
  const m = new THREE.MeshPhysicalNodeMaterial({ color: 0x050607, metalness: 0, roughness: 0.02, transparent: true, opacity: 0.55, side: THREE.DoubleSide, clearcoat: 1, envMapIntensity: 1.5 })
  // smears where it was wiped, dust in its lower corners, flies on the screen
  const b = triMap('b', positionLocal, normalLocal, 1.5)
  const spots = triMap('c', positionLocal, normalLocal, 2).r
  const film = clamp(smoothstep(0.35, 0.85, b.g).mul(0.6).add(smoothstep(0.6, 0.9, b.r).mul(0.3)).add(smoothstep(0.5, 0.8, spots).mul(0.5)), 0, 1)
  m.roughnessNode = mix(float(0.02), float(0.16), film)
  m.clearcoatRoughnessNode = mix(float(0.01), float(0.12), film)
  return m
}

const _uNum = () => uniform(0)
type UNum = ReturnType<typeof _uNum>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body_hl_y = (z: any) => float(0.56).sub(z.sub(2.0).mul(0.25))

function headlightMaterial(emissive: UNum) {
  const m = new THREE.MeshPhysicalNodeMaterial({ color: 0x14161a, metalness: 0.9, roughness: 0.12, clearcoat: 1 })
  const p = positionLocal
  // LED strip DRL + projector
  // reflector housing with an LED daytime-running strip along the top edge
  const strip = smoothstep(0.02, 0.012, abs(p.y.sub(body_hl_y(p.z))))
  const projector = smoothstep(0.045, 0.035, p.x.abs().sub(0.62).abs().add(p.y.sub(0.5).abs()))
  m.emissiveNode = vec3(0.85, 0.9, 1.0).mul(emissive).mul(strip.add(projector.mul(0.6)))
  return m
}

function taillightMaterial(intensity: UNum) {
  const m = new THREE.MeshPhysicalNodeMaterial({ color: 0x220000, metalness: 0.2, roughness: 0.15, clearcoat: 1 })
  const p = positionLocal
  const segments = smoothstep(0.25, 0.35, fract(p.x.mul(14))).mul(0.5).add(0.5)
  m.emissiveNode = vec3(1, 0.02, 0.01).mul(intensity).mul(segments)
  return m
}

function grilleMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const p = positionLocal.mul(70)
  const hex = smoothstep(0.35, 0.45, abs(fract(p.x).sub(0.5)).add(abs(fract(p.y.add(p.z)).sub(0.5))))
  const a = triMap('a', positionLocal, normalLocal, 2)
  m.colorNode = mix(vec3(0.01, 0.01, 0.012), vec3(0.06, 0.06, 0.065), hex).mul(mix(float(0.8), float(1.25), a.g))
  m.roughnessNode = mix(float(0.5), float(0.72), a.r)
  // the mesh's relief
  m.normalNode = bumpView(hex.mul(0.0015))
  return m
}

// ------------------------------------------------------------------------------------- wheels

function tyreSidewallTexture(text: string) {
  return canvasTexture(2048, 128, (ctx) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, 2048, 128)
    ctx.fillStyle = '#d8d8d8'
    ctx.font = '800 64px Inter, Arial, sans-serif'
    ctx.textBaseline = 'middle'
    for (let k = 0; k < 2; k++) ctx.fillText(text, 80 + k * 1024, 64)
  })
}

const sidewallTex = { tex: null as THREE.Texture | null }

function tyreGeometry(r: number, w: number, rimR: number) {
  // profile in (radius, axial) — lathe around Y then rotate to X axis
  const pts: THREE.Vector2[] = []
  const hw = w / 2
  const prof: [number, number][] = [
    [rimR - 0.005, -hw * 0.82],
    [rimR + 0.012, -hw * 0.9],
    [rimR + (r - rimR) * 0.45, -hw * 1.0],
    [r - 0.035, -hw * 0.98],
    [r - 0.008, -hw * 0.9],
    [r, -hw * 0.75],
    [r, hw * 0.75],
    [r - 0.008, hw * 0.9],
    [r - 0.035, hw * 0.98],
    [rimR + (r - rimR) * 0.45, hw * 1.0],
    [rimR + 0.012, hw * 0.9],
    [rimR - 0.005, hw * 0.82],
  ]
  for (const [rad, ax] of prof) pts.push(new THREE.Vector2(rad, ax))
  const g = new THREE.LatheGeometry(pts, 64)
  g.rotateZ(Math.PI / 2)
  return g
}

function tyreMaterial() {
  if (!sidewallTex.tex) sidewallTex.tex = tyreSidewallTexture('NORDKAP  ·  RACING SLICK  ·  305/680 R18')
  const m = new THREE.MeshStandardNodeMaterial()
  // uv.x around the circumference, uv.y along the profile (0..1)
  const v = uv().y
  const side = max(smoothstep(0.32, 0.22, v), smoothstep(0.68, 0.78, v))
  const label = texture(sidewallTex.tex, vec2(uv().x.mul(2), mix(v.mul(4.4).sub(0.2), float(1).sub(v).mul(4.4).sub(0.2), step(0.5, v)))).r
  const lettering = label.mul(side).mul(smoothstep(0.05, 0.12, v).mul(smoothstep(0.95, 0.88, v)))
  const tread = float(1).sub(side)
  // the rubber's grain; on the tread, rubber picked up from the track (marbles) and the graining of a
  // worked slick; brake dust greying the sidewall near the rim
  const d = detailAt(vec2(uv().x.mul(2.1), v.mul(0.3)), 2)
  const pickup = smoothstep(0.35, 0.6, d.pits).mul(tread)
  const graining = smoothstep(0.55, 0.85, detailAt(vec2(uv().x.mul(2.1), v.mul(0.3).mul(6))).streaks).mul(tread)
  const dustNear = smoothstep(0.3, 0.12, abs(v.sub(0.5)).sub(0.38).abs()).mul(side)
  let col: N = mix(vec3(0.028, 0.028, 0.03), vec3(0.6, 0.6, 0.6), lettering.mul(0.85)).mul(mix(float(0.85), float(1.15), d.grain))
  col = mix(col, vec3(0.06, 0.052, 0.045), dustNear.mul(0.5).mul(float(1).sub(lettering)))
  col = mix(col, vec3(0.018, 0.018, 0.02), pickup)
  m.colorNode = col
  m.roughnessNode = breakUpRoughness(mix(float(0.86), float(0.62), tread.mul(0.8)).sub(lettering.mul(0.2)).add(graining.mul(0.12)), d, { k: 0.1 })
  m.normalNode = bumpView(detailHeight(d, { grain: 0.0004 }).add(pickup.mul(0.0012)).sub(graining.mul(0.0003)))
  return m
}

function rimGeometry(rimR: number, w: number, spokes: number, side: number) {
  const parts: THREE.BufferGeometry[] = []
  const barrel = new THREE.CylinderGeometry(rimR, rimR, w * 0.86, 48, 1, true)
  barrel.rotateZ(Math.PI / 2)
  parts.push(barrel)
  const lip = new THREE.TorusGeometry(rimR - 0.006, 0.012, 8, 48)
  lip.rotateY(Math.PI / 2)
  lip.translate((side * w * 0.43), 0, 0)
  parts.push(lip)
  const face = side * (w * 0.43 - 0.03)
  for (let k = 0; k < spokes; k++) {
    for (const off of [-0.07, 0.07]) {
      const sp = new THREE.BoxGeometry(0.03, rimR - 0.075, 0.022)
      sp.translate(0, (rimR - 0.075) / 2 + 0.055, 0)
      sp.rotateZ(side * 0.12) // dished
      sp.rotateX((k / spokes) * Math.PI * 2 + off)
      sp.translate(face - side * 0.02, 0, 0)
      parts.push(sp)
    }
  }
  const hub = new THREE.CylinderGeometry(0.075, 0.085, 0.06, 24)
  hub.rotateZ(Math.PI / 2)
  hub.translate(face, 0, 0)
  parts.push(hub)
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)).map((p) => {
    p.deleteAttribute('uv')
    return p
  }))!
}

function nutGeometry(w: number, side: number) {
  const g = new THREE.CylinderGeometry(0.035, 0.04, 0.05, 6)
  g.rotateZ(Math.PI / 2)
  g.translate(side * (w * 0.43 + 0.0), 0, 0)
  return g
}

function discGeometry(r: number) {
  const g = new THREE.CylinderGeometry(r, r, 0.034, 40, 1, false)
  g.rotateZ(Math.PI / 2)
  return g
}

function discMaterial(temp: UNum) {
  const m = new THREE.MeshStandardNodeMaterial()
  const p = positionLocal
  const rad = p.y.mul(p.y).add(p.z.mul(p.z)).sqrt()
  const ang = p.z.atan(p.y)
  const holes = smoothstep(0.35, 0.3, abs(fract(ang.mul(36 / 6.283)).sub(0.5)).add(abs(fract(rad.mul(36)).sub(0.5))))
  const inner = smoothstep(0.1, 0.105, rad)
  m.colorNode = mix(vec3(0.05, 0.05, 0.05), vec3(0.32, 0.31, 0.3), inner).mul(float(1).sub(holes.mul(0.7)))
  m.metalnessNode = float(0.8)
  m.roughnessNode = float(0.45)
  const glow = smoothstep(380, 820, temp)
  m.emissiveNode = mix(vec3(0.5, 0.03, 0.0), vec3(1.0, 0.32, 0.04), glow).mul(glow.mul(glow).mul(9)).mul(inner)
  return m
}

// ------------------------------------------------------------------------------------- aero & details

function airfoil(chord: number, thick: number, camber: number) {
  const s = new THREE.Shape()
  const n = 20
  const upper: [number, number][] = []
  const lower: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const x = (1 - Math.cos((i / n) * Math.PI)) / 2
    const yt = 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4)
    const yc = camber * 4 * x * (1 - x)
    upper.push([x * chord, (yc + yt) * chord])
    lower.push([x * chord, (yc - yt) * chord])
  }
  s.moveTo(upper[0][0], upper[0][1])
  for (const [x, y] of upper) s.lineTo(x, y)
  for (let i = lower.length - 1; i >= 0; i--) s.lineTo(lower[i][0], lower[i][1])
  return s
}

function wingGeometry(width: number) {
  const parts: THREE.BufferGeometry[] = []
  // inverted cambered main plane + flap
  const main = new THREE.ExtrudeGeometry(airfoil(0.3, 0.12, 0.05), { depth: width, bevelEnabled: false, curveSegments: 4 })
  main.translate(0, 0, -width / 2)
  main.rotateY(Math.PI / 2) // extrude along x
  main.rotateX(Math.PI) // invert: suction side down
  main.rotateX(-0.12)
  parts.push(main)
  const flap = new THREE.ExtrudeGeometry(airfoil(0.12, 0.1, 0.06), { depth: width, bevelEnabled: false })
  flap.translate(0, 0, -width / 2)
  flap.rotateY(Math.PI / 2)
  flap.rotateX(Math.PI)
  flap.rotateX(-0.6)
  flap.translate(0, 0.045, -0.29)
  parts.push(flap)
  for (const sx of [-1, 1]) {
    const plate = new THREE.BoxGeometry(0.008, 0.26, 0.42)
    plate.translate(sx * (width / 2 + 0.004), -0.02, -0.16)
    parts.push(plate)
  }
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)).map((p) => {
    for (const k of Object.keys(p.attributes)) if (k !== 'position' && k !== 'normal') p.deleteAttribute(k)
    return p
  }))!
}

function strip(parts: THREE.BufferGeometry[]) {
  return mergeGeometries(
    parts
      .map((p) => (p.index ? p.toNonIndexed() : p))
      .map((p) => {
        for (const k of Object.keys(p.attributes)) if (k !== 'position' && k !== 'normal') p.deleteAttribute(k)
        return p
      }),
  )!
}

// ------------------------------------------------------------------------------------- assembly

let numberSeq = 3

export interface Livery {
  accent?: string
  number?: number
}

export function buildCarModel(carId: string, paint: string, lod = 0, livery?: Livery): CarModel {
  const spec = getCar(carId)
  const body = makeBody(spec)
  const root = new THREE.Group()
  root.name = 'car:' + carId
  const cell = lod === 0 ? 0.028 : 0.042
  const bodyGeo = buildBodyGeometry(spec, cell)

  const headU = uniform(3.5)
  const tailU = uniform(0.7)
  const num = livery?.number ?? numberSeq++ % 99
  const trimMat = trimMaterial()
  const wellMat = new THREE.MeshStandardNodeMaterial({ color: 0x030303, roughness: 0.95 })
  const carbon = carbonMaterial()
  const materials: THREE.Material[] = []
  materials[Mat.Paint] = paintMaterial(paint, body, num, livery?.accent)
  materials[Mat.Glass] = glassMaterial()
  materials[Mat.Trim] = trimMat
  materials[Mat.Carbon] = carbon
  materials[Mat.Headlight] = headlightMaterial(headU)
  materials[Mat.Taillight] = taillightMaterial(tailU)
  materials[Mat.WheelWell] = wellMat
  materials[Mat.Grille] = grilleMaterial()

  // body group: model space (ground at y=0, wheelbase centre at z=0) -> CoG space
  const bodyGroup = new THREE.Group()
  root.add(bodyGroup)
  const bodyMesh = new THREE.Mesh(bodyGeo, materials)
  bodyMesh.castShadow = true
  bodyMesh.receiveShadow = true
  bodyGroup.add(bodyMesh)
  // interior shell: the body seen from inside (roof lining, pillars, door cards), windows left open
  const lining = new THREE.MeshStandardNodeMaterial({ color: 0x0d0e10, roughness: 0.9, side: THREE.BackSide })
  const hidden = new THREE.MeshBasicNodeMaterial({ visible: false })
  const shellMats = Array.from({ length: MAT_COUNT }, (_, i) => (i === Mat.Glass ? hidden : lining))
  const shell = new THREE.Mesh(bodyGeo, shellMats)
  shell.castShadow = false
  shell.visible = lod === 0
  if (lod === 0) bodyGroup.add(shell)

  // ---- aero parts
  const details: THREE.BufferGeometry[] = []
  const splitter = new THREE.BoxGeometry(1.55, 0.016, 0.3)
  splitter.translate(0, 0.08, body.zFront - 0.17)
  details.push(splitter)
  for (const sx of [-1, 0, 1]) {
    const fin = new THREE.BoxGeometry(0.01, 0.2, 0.45)
    fin.translate(sx * 0.4, 0.18, body.zRear + 0.2)
    details.push(fin)
  }
  if (body.wing) {
    const wing = wingGeometry(1.78)
    wing.translate(0, 1.2, body.zRear + 0.32)
    details.push(wing)
    for (const sx of [-1, 1]) {
      // swan neck mounts
      const neck = new THREE.BoxGeometry(0.012, 0.36, 0.12)
      neck.rotateX(-0.35)
      neck.translate(sx * 0.32, 1.06, body.zRear + 0.26)
      details.push(neck)
    }
    // dive planes
    for (const sx of [-1, 1]) {
      const c = new THREE.BoxGeometry(0.16, 0.008, 0.12)
      c.rotateZ(sx * 0.25)
      c.translate(sx * 0.86, 0.38, body.zFront - 0.18)
      details.push(c)
    }
  } else {
    const lip = new THREE.BoxGeometry(1.3, 0.02, 0.07)
    lip.rotateX(-0.25)
    lip.translate(0, 1.0, body.zRear + 0.06)
    details.push(lip)
  }
  // mirrors
  for (const sx of [-1, 1]) {
    const housing = new THREE.SphereGeometry(0.075, 16, 10)
    housing.scale(1.25, 0.75, 1.1)
    housing.translate(sx * 1.0, body.beltY(0.5) + 0.12, 0.5)
    details.push(housing)
    const stalk = new THREE.BoxGeometry(0.12, 0.02, 0.05)
    stalk.translate(sx * 0.9, body.beltY(0.5) + 0.1, 0.5)
    details.push(stalk)
  }
  const detailMesh = new THREE.Mesh(strip(details), carbon)
  detailMesh.castShadow = true
  bodyGroup.add(detailMesh)

  // exhausts
  const exGeo: THREE.BufferGeometry[] = []
  for (const [x, y] of body.exhausts) {
    const pipe = new THREE.CylinderGeometry(0.045, 0.045, 0.18, 20, 1, true)
    pipe.rotateX(Math.PI / 2)
    pipe.translate(x, y, body.zRear + 0.04)
    exGeo.push(pipe)
  }
  const exMesh = new THREE.Mesh(strip(exGeo), exhaustMaterial(body.zRear))
  bodyGroup.add(exMesh)
  // exhaust flames
  const flameU = uniform(0)
  const flameMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  const fz = positionLocal.z.negate().div(0.35).clamp(0, 1)
  flameMat.colorNode = mix(vec3(0.6, 0.75, 2.5), vec3(3.5, 1.3, 0.2), fz).mul(flameU).mul(float(1).sub(fz)).mul(6)
  const flames: THREE.Mesh[] = []
  for (const [x, y] of body.exhausts) {
    const cone = new THREE.ConeGeometry(0.05, 0.38, 12, 1, true)
    cone.rotateX(-Math.PI / 2)
    cone.translate(0, 0, -0.19)
    const f = new THREE.Mesh(cone, flameMat)
    f.position.set(x, y, body.zRear - 0.02)
    f.visible = false
    flames.push(f)
    bodyGroup.add(f)
  }

  // ---- interior + driver
  const interior = new THREE.Group()
  const darkMat = new THREE.MeshStandardNodeMaterial({ color: 0x060607, roughness: 0.9 })
  const cageMat = new THREE.MeshStandardNodeMaterial({ color: 0x1b1c1e, roughness: 0.5, metalness: 0.5 })
  const ix: THREE.BufferGeometry[] = []
  const tub = new THREE.BoxGeometry(1.5, 0.05, 2.0)
  tub.translate(0, 0.2, -0.3)
  ix.push(tub)
  // dashboard: slanted top that stays below the driver's sight line
  const dashTop = body.eyeY - 0.24
  const dash = new THREE.BoxGeometry(1.4, 0.12, 0.42)
  dash.rotateX(0.18)
  dash.translate(0, dashTop - 0.06, body.eyeZ + 0.78)
  ix.push(dash)
  const binnacle = new THREE.BoxGeometry(0.34, 0.08, 0.16)
  binnacle.translate(body.driverX, dashTop + 0.0, body.eyeZ + 0.62)
  ix.push(binnacle)
  const seat = new THREE.BoxGeometry(0.5, 0.7, 0.1)
  seat.rotateX(-0.25)
  seat.translate(body.driverX, 0.52, body.eyeZ - 0.38)
  ix.push(seat)
  const seatBase = new THREE.BoxGeometry(0.5, 0.1, 0.5)
  seatBase.translate(body.driverX, 0.28, body.eyeZ - 0.15)
  ix.push(seatBase)
  const interiorMesh = new THREE.Mesh(strip(ix), darkMat)
  interior.add(interiorMesh)
  // roll cage
  const cage: THREE.BufferGeometry[] = []
  // smooth A-pillars and windscreen header (frame the cockpit view, hide classification steps)
  {
    const zBase = Math.min(body.zFront - 1.6, 0.66)
    const zTop = 0.02
    for (const sx of [-1, 1]) {
      const pts: THREE.Vector3[] = []
      for (let k = 0; k <= 8; k++) {
        const t = k / 8
        const z = zBase + (zTop - zBase) * t
        // the pillar follows the windscreen's side edge, just below the cabin roof line
        pts.push(new THREE.Vector3(sx * (body.cabinHalfWidth(z) - 0.035), Math.max(body.beltY(z), body.roofY(z) - 0.045), z))
      }
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.035, 8, false)
      cage.push(tube)
    }
    const header = new THREE.CylinderGeometry(0.03, 0.03, (body.cabinHalfWidth(zTop) - 0.03) * 2, 8)
    header.rotateZ(Math.PI / 2)
    header.translate(0, body.roofY(zTop) - 0.035, zTop)
    cage.push(header)
  }
  // main hoop behind the seats, kept inside the greenhouse
  const hoopZ = body.eyeZ - 0.5
  const hoopTop = body.roofY(hoopZ) - 0.08
  const hoopW = body.cabinHalfWidth(hoopZ) - 0.08
  for (const sx of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(0.02, 0.02, hoopTop - 0.3, 8)
    leg.translate(sx * hoopW, (hoopTop + 0.3) / 2, hoopZ)
    cage.push(leg)
  }
  const hoop = new THREE.CylinderGeometry(0.02, 0.02, hoopW * 2, 8)
  hoop.rotateZ(Math.PI / 2)
  hoop.translate(0, hoopTop, hoopZ)
  cage.push(hoop)
  interior.add(new THREE.Mesh(strip(cage), cageMat))
  // steering wheel
  const wheelPivot = new THREE.Group()
  wheelPivot.position.set(body.driverX, body.eyeY - 0.36, body.eyeZ + 0.46)
  wheelPivot.rotation.x = -0.3
  const rimG = new THREE.TorusGeometry(0.15, 0.018, 10, 32)
  const sw = new THREE.Mesh(rimG, new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 0.7 }))
  wheelPivot.add(sw)
  const swCenter = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.03), new THREE.MeshStandardNodeMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.4 }))
  wheelPivot.add(swCenter)
  const display = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.05), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.2, 0.6, 1.2) }))
  display.position.set(0, 0.0, 0.017)
  display.rotation.y = Math.PI
  wheelPivot.add(display)
  interior.add(wheelPivot)
  // driver
  const suit = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(paint).multiplyScalar(0.6), roughness: 0.8 })
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.32, 6, 12), suit)
  torso.position.set(body.driverX, body.eyeY - 0.38, body.eyeZ - 0.12)
  torso.rotation.x = -0.25
  interior.add(torso)
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 24, 16), new THREE.MeshPhysicalNodeMaterial({ color: 0xf2f2f2, roughness: 0.25, clearcoat: 1 }))
  helmet.position.set(body.driverX, body.eyeY + 0.02, body.eyeZ - 0.03)
  interior.add(helmet)
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.137, 24, 12, -0.9, 1.8, 1.1, 0.7), new THREE.MeshPhysicalNodeMaterial({ color: 0x050505, roughness: 0.05, metalness: 0.9 }))
  visor.position.copy(helmet.position)
  interior.add(visor)
  const dashDisplay = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.07), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.25, 0.7, 1.4) }))
  dashDisplay.position.set(body.driverX, dashTop + 0.042, body.eyeZ + 0.555)
  dashDisplay.rotation.set(-0.5, Math.PI, 0)
  interior.add(dashDisplay)
  bodyGroup.add(interior)

  // ---- wheels
  const wheelGroups: { pivot: THREE.Group; spin: THREE.Group; discU: UNum; radius: number }[] = []
  const rimMat = new THREE.MeshStandardNodeMaterial({ color: spec.bodyStyle === 'coupe' ? 0x9a9ea3 : 0x1c1d20, metalness: 1, roughness: spec.bodyStyle === 'coupe' ? 0.22 : 0.32 })
  const nutMat = new THREE.MeshStandardNodeMaterial({ color: 0xc0151a, metalness: 0.6, roughness: 0.35 })
  const caliperMat = new THREE.MeshStandardNodeMaterial({ color: spec.bodyStyle === 'coupe' ? 0xd4af37 : 0xc8102e, roughness: 0.4, metalness: 0.2 })
  const tyreMat = tyreMaterial()
  for (const w of body.wheels) {
    const side = w.x > 0 ? 1 : -1
    const pivot = new THREE.Group()
    const spin = new THREE.Group()
    pivot.add(spin)
    const rimR = w.r - (spec.bodyStyle === 'coupe' ? 0.095 : 0.105)
    const tyre = new THREE.Mesh(tyreGeometry(w.r, w.w, rimR), tyreMat)
    tyre.castShadow = true
    spin.add(tyre)
    const rim = new THREE.Mesh(rimGeometry(rimR, w.w, spec.bodyStyle === 'coupe' ? 5 : 10, side), rimMat)
    rim.castShadow = true
    spin.add(rim)
    if (spec.bodyStyle !== 'coupe') spin.add(new THREE.Mesh(nutGeometry(w.w, side), nutMat))
    const discU = uniform(100)
    const disc = new THREE.Mesh(discGeometry(rimR - 0.04), discMaterial(discU))
    disc.position.x = side * 0.02
    spin.add(disc)
    const cal = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.22, 0.11), caliperMat)
    cal.position.set(side * 0.06, (rimR - 0.07) * Math.sin(0.6), -(rimR - 0.07) * Math.cos(0.6))
    cal.rotation.x = 0.6
    pivot.add(cal)
    root.add(pivot)
    wheelGroups.push({ pivot, spin, discU, radius: w.r })
  }

  // body offset (model -> CoG space) computed on first update from the physics geometry
  const bodyOffset = new THREE.Vector3()
  let calibrated = false
  const cockpitEye = new THREE.Vector3()

  const update = (v: Vehicle) => {
    if (!calibrated) {
      const f = v.wheels[0]
      // model front wheel centre (body.wheels[0].y) must sit at the physics static hub height
      bodyOffset.set(0, f.yHubStatic - body.wheels[0].y, (v.a - v.b) / 2)
      bodyGroup.position.copy(bodyOffset)
      cockpitEye.set(body.driverX, body.eyeY, body.eyeZ).add(bodyOffset)
      calibrated = true
    }
    for (let i = 0; i < 4; i++) {
      const wh = v.wheels[i]
      const g = wheelGroups[i]
      g.pivot.position.set(wh.x, wh.yHubStatic + (wh.c - wh.cStatic), wh.z)
      // negative camber leans the top of each wheel towards the car centre
      g.pivot.rotation.set(0, wh.steer, wh.left ? -wh.camberStatic : wh.camberStatic)
      g.spin.rotation.x = wh.spin
      g.discU.value = wh.brakeTemp
    }
    tailU.value = 0.9 + v.brake * 9
    wheelPivot.rotation.z = -v.steerInput * 2.2
    const bf = v.engine.backfire
    for (const f of flames) {
      f.visible = bf > 0.05
      f.scale.set(1, 1, 0.6 + bf * 0.8)
    }
    flameU.value = bf
  }

  const setVisibleParts = (opts: { body?: boolean; interior?: boolean }) => {
    if (opts.body !== undefined) {
      bodyMesh.visible = opts.body
      detailMesh.visible = opts.body
      shell.visible = opts.body && lod === 0
    }
    if (opts.interior !== undefined) interior.visible = opts.interior
  }

  const dispose = () => {
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry && m.geometry !== bodyGeo) m.geometry.dispose()
    })
  }

  const wheels = wheelGroups.map((g, index) => ({ pivot: g.pivot, spin: g.spin, radius: g.radius, index }))
  return { root, body, spec, update, dispose, cockpitEye, bodyOffset, setVisibleParts, wheels }
}

