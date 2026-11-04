// Physically based materials for the circuit, written in TSL (work on WebGPU and the WebGL2 fallback).
import * as THREE from 'three/webgpu'
import {
  abs,
  attribute,
  clamp,
  exp,
  float,
  floor,
  fract,
  fwidth,
  mix,
  mod,
  mx_noise_float,
  normalMap,
  positionWorld,
  smoothstep,
  step,
  texture,
  uv,
  vec2,
  vec3,
  cameraPosition,
  length,
  max,
  min,
  sin,
} from 'three/tsl'
import { getTextures } from './textures'
import { groundSet, type GroundSet } from './worldAssets'
import type { Track } from '../track/track'

type N = any

// ------------------------------------------------------------------------------ photo-scanned ground

/**
 * One photo-scanned set (colour + normal/roughness) without visible tiling: two decorrelated samples
 * (the second rotated, scaled and shifted) blended by a slow noise, the blend variance-preserving so
 * the mix regions keep the texture's contrast instead of turning into a smooth average.
 */
function scanned(set: GroundSet, p: N, maskScale = 0.07) {
  const a = texture(set.colour, p)
  const da = texture(set.data, p)
  const c = Math.cos(0.83),
    sn = Math.sin(0.83)
  const q = vec2(p.x.mul(c).sub(p.y.mul(sn)), p.x.mul(sn).add(p.y.mul(c))).mul(0.773).add(vec2(0.37, 0.71))
  const b = texture(set.colour, q)
  const db = texture(set.data, q)
  const w = smoothstep(-0.35, 0.35, mx_noise_float(vec3(positionWorld.x.mul(maskScale), 3.3, positionWorld.z.mul(maskScale))))
  const mean = texture(set.colour, vec2(0.5, 0.5)).level(float(14)).rgb
  const k = float(1).div(w.mul(w).add(w.oneMinus().mul(w.oneMinus())).sqrt())
  const col = max(a.rgb.sub(mean).mul(w.oneMinus()).add(b.rgb.sub(mean).mul(w)).mul(k).add(mean), vec3(0))
  const nxy = mix(da.xy, db.xy, w)
  const rough = mix(da.z, db.z, w)
  return { col, nxy, rough }
}

/** Tangent-space normal for normalMap() from a stored x/y pair (z rebuilt). */
function normalFromXY(nxy: N) {
  const xy = nxy.mul(2).sub(1)
  const z = max(float(1).sub(xy.dot(xy)), 0).sqrt()
  return vec3(nxy, z.mul(0.5).add(0.5))
}

/** Summer verge: the scan's straw shifted towards green. */
const greenGrass = (c: N) => {
  const lum = c.dot(vec3(0.2126, 0.7152, 0.0722))
  return mix(c, vec3(lum.mul(0.66), lum.mul(1.2), lum.mul(0.4)), 0.7).mul(0.9)
}

/**
 * The grass ground's colour around a point, averaged over about a metre (explicit mip level, so it
 * also works in a vertex shader): the 3D grass takes its colour from the ground it stands on.
 */
export function grassGroundColour(xz: N) {
  const t = groundSet('grass').colour
  return greenGrass(texture(t, xz.div(2.6)).level(float(7)).rgb)
}

/** Grass ground (photo-scanned), a little greener than the dry scan, with patches of leafy ground. */
export function scannedGrass(uvMetres: N, leafyAmount: N = float(0)) {
  const g = scanned(groundSet('grass'), uvMetres.div(2.6))
  const l = scanned(groundSet('leafy'), uvMetres.div(2.2), 0.05)
  const green = greenGrass(g.col)
  const leafy = l.col.mul(vec3(0.62, 0.66, 0.6))
  const w = clamp(leafyAmount, 0, 1)
  return { col: mix(green, leafy, w), nxy: mix(g.nxy, l.nxy, w), rough: mix(g.rough, l.rough, w) }
}

const aTrack = () => attribute('aTrack', 'vec4')

/** anti-aliased band mask between a and b of x */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function band(x: any, a: number, b: number) {
  const w = fwidth(x).mul(1.2).add(0.002)
  return smoothstep(float(a).sub(w), float(a).add(w), x).mul(float(1).sub(smoothstep(float(b).sub(w), float(b).add(w), x)))
}

/** Track rubber map (2 m x 1 m cells) as a texture, refreshed while cars lay rubber. */
export function rubberTexture(track: Track) {
  const cols = track.rubberCols
  const rows = track.rubber.length / cols
  const data = new Uint8Array(cols * rows * 4)
  const tex = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.RepeatWrapping
  const refresh = () => {
    for (let k = 0; k < track.rubber.length; k++) data[k * 4] = Math.round(track.rubber[k] * 255)
    tex.needsUpdate = true
    track.rubberDirty = false
  }
  refresh()
  return { tex, refresh, rows }
}

/** Photo-scanned race asphalt (Poly Haven asphalt_track, 3 m per tile), aged to a mid grey. */
function trackAsphalt(uvMetres: N) {
  const a = scanned(groundSet('asphalt'), uvMetres.div(3))
  // the scan is fresh, near-black asphalt (albedo 0.013): weathered race tarmac is ~0.07 and greyer
  const lum = a.col.dot(vec3(0.2126, 0.7152, 0.0722))
  const col = mix(a.col, vec3(lum), 0.45).mul(5.2)
  return { col, nxy: a.nxy, rough: a.rough }
}

export function roadMaterial(rubber?: { tex: THREE.Texture; rows: number }) {
  const m = new THREE.MeshStandardNodeMaterial()
  const tr = aTrack()
  const d = tr.x,
    s = tr.y,
    racing = tr.z,
    hw = tr.w
  // the ribbon's uv is world x/z over 4
  const asphalt = trackAsphalt(uv().mul(4))
  // macro variation: patches of fresh / older tarmac, breaks visible tiling
  const macro = mx_noise_float(vec3(positionWorld.x.mul(0.018), 0, positionWorld.z.mul(0.018))).mul(0.5).add(0.5)
  const macro2 = mx_noise_float(vec3(positionWorld.x.mul(0.11), 1.7, positionWorld.z.mul(0.11))).mul(0.5).add(0.5)
  let albedo = asphalt.col.mul(mix(float(0.84), float(1.14), macro)).mul(mix(float(0.95), float(1.05), macro2))
  let rough = asphalt.rough.mul(mix(float(0.94), float(1.03), macro2))
  // rubbered-in racing line: darker and a touch smoother
  // dynamic rubber map from the simulation (falls back to the static racing line)
  const rl = rubber
    ? smoothstep(0.14, 0.95, texture(rubber.tex, vec2(d.add(8).div(16), s.div(2).add(0.5).div(rubber.rows))).r)
    : exp(d.sub(racing).div(1.25).pow(2).negate())
  const rubberNoise = mx_noise_float(vec3(s.mul(0.08), d.mul(0.6), 3.1)).mul(0.25).add(0.75)
  albedo = albedo.mul(mix(float(1), float(0.55), rl.mul(rubberNoise)))
  rough = mix(rough, rough.mul(0.86), rl)
  // dusty, marbled areas off-line near the edges
  const edge = clamp(abs(d).div(hw), 0, 1)
  const dust = smoothstep(0.72, 1.0, edge).mul(float(1).sub(rl))
  albedo = mix(albedo, albedo.mul(1.35).add(vec3(0.012, 0.011, 0.009)), dust.mul(0.6))
  rough = mix(rough, float(0.95), dust.mul(0.5))
  // white edge lines (0.25 m wide, 0.1 m inside the asphalt edge)
  const fromEdge = hw.sub(abs(d))
  const line = band(fromEdge, 0.08, 0.33)
  // slightly worn paint
  const wear = smoothstep(0.25, 0.65, mx_noise_float(vec3(s.mul(0.9), d.mul(4.0), 0.2)).mul(0.5).add(0.5)).mul(0.25)
  const paint = line.mul(float(1).sub(wear))
  albedo = mix(albedo, vec3(0.72, 0.72, 0.7), paint)
  rough = mix(rough, float(0.62), paint)
  m.colorNode = albedo
  m.roughnessNode = clamp(rough, 0.3, 1)
  m.metalnessNode = float(0)
  m.normalNode = normalMap(normalFromXY(asphalt.nxy), vec2(mix(float(0.9), float(0.3), paint)))
  return m
}

/** Older, lighter asphalt with coarser aggregate (Poly Haven asphalt_pit_lane): runoff and pit lane. */
export function pitAsphaltSample(uvMetres: N) {
  const a = scanned(groundSet('pitlane'), uvMetres.div(2.5), 0.05)
  const lum = a.col.dot(vec3(0.2126, 0.7152, 0.0722))
  return { col: mix(a.col, vec3(lum), 0.4).mul(1.55), nxy: a.nxy, rough: a.rough }
}

export function runoffMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const a = pitAsphaltSample(uv().mul(4))
  const macro = mx_noise_float(vec3(positionWorld.x.mul(0.03), 2.3, positionWorld.z.mul(0.03))).mul(0.5).add(0.5)
  m.colorNode = a.col.mul(mix(float(0.88), float(1.1), macro))
  m.roughnessNode = clamp(a.rough.add(0.04), 0, 1)
  m.normalNode = normalMap(normalFromXY(a.nxy), vec2(0.9))
  return m
}

export function kerbMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const tr = aTrack()
  const u = tr.x,
    s = tr.y
  const stripe = mod(floor(s.div(1.5)), 2)
  const red = vec3(0.52, 0.035, 0.03)
  const white = vec3(0.78, 0.78, 0.76)
  let col = mix(red, white, stripe)
  // tyre rubber and dirt on the inner edge
  const n = mx_noise_float(vec3(s.mul(0.5), u.mul(3), 0)).mul(0.5).add(0.5)
  const dirt = smoothstep(0.55, 0.0, u).mul(n).mul(0.6)
  col = mix(col, vec3(0.05, 0.05, 0.05), dirt)
  // stripe edges darker (gaps)
  const fs = fract(s.div(1.5))
  const gap = float(1).sub(smoothstep(0.0, 0.02, fs).mul(smoothstep(1.0, 0.98, fs)))
  col = mix(col, col.mul(0.4), gap)
  m.colorNode = col
  m.roughnessNode = mix(float(0.42), float(0.75), dirt)
  m.metalnessNode = float(0)
  return m
}

export function vergeMaterial() {
  const tex = getTextures()
  const m = new THREE.MeshStandardNodeMaterial()
  const tr = aTrack()
  const gravelW = tr.x
  const grass = grassColor(tr.z)
  const gtex = texture(tex.gravel.map, uv().mul(8 / 3))
  const w = smoothstep(0.3, 0.7, gravelW)
  m.colorNode = mix(grass.color, gtex.rgb, w)
  m.roughnessNode = mix(grass.rough, float(0.95), w)
  m.normalNode = normalMap(mix(normalFromXY(grass.nxy), texture(tex.gravel.normal, uv().mul(8 / 3)).rgb, w), vec2(0.8))
  return m
}

/**
 * Grass ground with the photo scan up close; far away it settles to its mean colour (a tiled scan
 * shimmers and repeats at a distance), with slow colour variation and faint mowing stripes.
 */
function grassColor(leafy: N = float(0)) {
  const g = scannedGrass(positionWorld.xz, leafy)
  const n = mx_noise_float(vec3(positionWorld.x.mul(0.006), 0.5, positionWorld.z.mul(0.006))).mul(0.5).add(0.5)
  const n2 = mx_noise_float(vec3(positionWorld.x.mul(0.035), 4.5, positionWorld.z.mul(0.035))).mul(0.5).add(0.5)
  // mowing stripes (subtle) near the track
  const stripes = sin(positionWorld.x.add(positionWorld.z.mul(0.3)).mul(0.35)).mul(0.5).add(0.5)
  let col = g.col.mul(mix(vec3(0.88, 0.96, 0.84), vec3(1.1, 1.04, 0.88), n))
  col = col.mul(mix(float(0.9), float(1.1), n2)).mul(mix(float(0.96), float(1.04), stripes))
  const dist = length(positionWorld.sub(cameraPosition))
  const far = smoothstep(120, 900, dist)
  col = mix(col, col.mul(0.25).add(vec3(0.05, 0.065, 0.026).mul(mix(float(0.85), float(1.15), n))), far.mul(0.6))
  return { color: col, rough: g.rough, nxy: mix(g.nxy, vec2(0.5, 0.5), far) }
}

export function terrainMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  // forest floor (leaves) away from the track, where the forests grow
  const tr = aTrack()
  const farFromTrack = smoothstep(20, 120, tr.x)
  const forest = mx_noise_float(vec3(positionWorld.x.mul(0.006).add(3.1), 1.9, positionWorld.z.mul(0.006).sub(7.7))).mul(0.5).add(0.5)
  const leafy = smoothstep(0.45, 0.62, forest).mul(farFromTrack).mul(0.8)
  const g = grassColor(leafy)
  // rocky slopes on steep terrain far from the track
  const farRock = smoothstep(80, 400, tr.x)
  const rock = mx_noise_float(vec3(positionWorld.x.mul(0.05), positionWorld.y.mul(0.05), positionWorld.z.mul(0.05))).mul(0.5).add(0.5)
  const rockMask = smoothstep(0.62, 0.8, rock).mul(farRock).mul(0.7)
  m.colorNode = mix(g.color, vec3(0.16, 0.15, 0.13).mul(rock.add(0.5)), rockMask)
  m.roughnessNode = max(g.rough, 0.85)
  m.normalNode = normalMap(normalFromXY(g.nxy), vec2(0.7))
  return m
}

export function mountainMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const h = positionWorld.y
  const n = mx_noise_float(positionWorld.mul(0.004)).mul(0.5).add(0.5)
  const n2 = mx_noise_float(positionWorld.mul(0.02)).mul(0.5).add(0.5)
  const forest = vec3(0.03, 0.05, 0.025).mul(n2.add(0.6))
  const rock = vec3(0.2, 0.19, 0.18).mul(n.add(0.5))
  const snow = vec3(0.55, 0.57, 0.61)
  let col = mix(forest, rock, smoothstep(140, 300, h.add(n.mul(80))))
  col = mix(col, snow, smoothstep(420, 500, h.add(n2.mul(60))))
  m.colorNode = col
  m.roughnessNode = float(0.9)
  return m
}

export function armcoMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide })
  const n = mx_noise_float(vec3(uv().x.mul(0.3), uv().y.mul(8), 0)).mul(0.5).add(0.5)
  m.colorNode = vec3(0.62, 0.63, 0.64).mul(mix(float(0.75), float(1.05), n))
  m.metalnessNode = float(0.85)
  m.roughnessNode = mix(float(0.28), float(0.55), n)
  return m
}

export function concreteWallMaterial() {
  const t = getTextures().concrete
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide })
  const s = uv().x,
    h = uv().y
  const tex = texture(t.map, vec2(s.div(4), h.div(4)))
  // painted red/white blocks on the upper half
  const blocks = mod(floor(s.div(4)), 2)
  const painted = step(0.35, h)
  const paintCol = mix(vec3(0.6, 0.05, 0.04), vec3(0.8, 0.8, 0.78), blocks)
  m.colorNode = mix(tex.rgb, paintCol.mul(tex.rgb.mul(1.6).add(0.3)), painted.mul(0.85))
  m.roughnessNode = mix(tex.a, float(0.6), painted)
  return m
}

/**
 * Catch fence in two layers: the posts and the top rail are solid (alpha tested, so they write depth
 * and motion and streak with the barriers), the wire mesh is a blended veil that keeps the motion of
 * whatever is seen through it.
 */
export function fenceMaterial(part: 'wire' | 'frame' = 'wire') {
  const solid = part === 'frame'
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, transparent: !solid, depthWrite: solid, alphaTest: solid ? 0.5 : 0 })
  const s = uv().x,
    h = uv().y
  // diamond wire mesh
  const a = fract(s.add(h).mul(9)),
    b = fract(s.sub(h).mul(9))
  const wire = max(smoothstep(0.88, 0.97, a), smoothstep(0.88, 0.97, b))
  const post = smoothstep(0.96, 0.99, fract(s.div(4)))
  const top = smoothstep(4.05, 4.15, h)
  m.colorNode = vec3(0.35, 0.36, 0.37)
  m.metalnessNode = float(0.7)
  m.roughnessNode = float(0.45)
  const frame = clamp(post.add(top), 0, 1)
  m.opacityNode = solid ? frame : clamp(wire.mul(0.55), 0, 1).mul(frame.oneMinus())
  return m
}

export function markingMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  const checker = uv().x
  m.colorNode = mix(vec3(0.03, 0.03, 0.03), vec3(0.75, 0.75, 0.73), checker)
  m.roughnessNode = float(0.6)
  return m
}

export function tyreWallMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const band = smoothstep(0.43, 0.47, abs(fract(positionWorld.y.mul(4.55)).sub(0.5)))
  m.colorNode = mix(vec3(0.025, 0.025, 0.028), vec3(0.75, 0.75, 0.75), band.mul(0.0))
  m.roughnessNode = float(0.85)
  return m
}
