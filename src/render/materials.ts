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
import type { Track } from '../track/track'

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

export function roadMaterial(rubber?: { tex: THREE.Texture; rows: number }) {
  const t = getTextures().asphalt
  const m = new THREE.MeshStandardNodeMaterial()
  const tr = aTrack()
  const d = tr.x,
    s = tr.y,
    racing = tr.z,
    hw = tr.w
  const tex = texture(t.map, uv())
  // macro variation: patches of fresh / older tarmac, breaks visible tiling
  const macro = mx_noise_float(vec3(positionWorld.x.mul(0.018), 0, positionWorld.z.mul(0.018))).mul(0.5).add(0.5)
  const macro2 = mx_noise_float(vec3(positionWorld.x.mul(0.11), 1.7, positionWorld.z.mul(0.11))).mul(0.5).add(0.5)
  let albedo = tex.rgb.mul(mix(float(0.82), float(1.18), macro)).mul(mix(float(0.94), float(1.06), macro2))
  let rough = tex.a.mul(mix(float(0.94), float(1.04), macro2))
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
  m.normalNode = normalMap(texture(t.normal, uv()), vec2(mix(float(0.7), float(0.3), paint)))
  return m
}

export function runoffMaterial() {
  const t = getTextures().asphalt
  const m = new THREE.MeshStandardNodeMaterial()
  const tex = texture(t.map, uv())
  const macro = mx_noise_float(vec3(positionWorld.x.mul(0.03), 2.3, positionWorld.z.mul(0.03))).mul(0.5).add(0.5)
  m.colorNode = tex.rgb.mul(1.35).add(vec3(0.02, 0.019, 0.016)).mul(mix(float(0.85), float(1.1), macro))
  m.roughnessNode = clamp(tex.a.add(0.08), 0, 1)
  m.normalNode = normalMap(texture(t.normal, uv()), vec2(0.7))
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
  const grass = grassColor()
  const gtex = texture(tex.gravel.map, uv().mul(8 / 3))
  const w = smoothstep(0.3, 0.7, gravelW)
  m.colorNode = mix(grass.color, gtex.rgb, w)
  m.roughnessNode = mix(grass.rough, float(0.95), w)
  m.normalNode = normalMap(mix(texture(tex.grass.normal, uv()), texture(tex.gravel.normal, uv().mul(8 / 3)), w), vec2(0.8))
  return m
}

function grassColor() {
  const tex = getTextures().grass
  const t1 = texture(tex.map, uv())
  const t2 = texture(tex.map, uv().mul(0.137).add(vec2(0.31, 0.77)))
  const n = mx_noise_float(vec3(positionWorld.x.mul(0.006), 0.5, positionWorld.z.mul(0.006))).mul(0.5).add(0.5)
  const n2 = mx_noise_float(vec3(positionWorld.x.mul(0.035), 4.5, positionWorld.z.mul(0.035))).mul(0.5).add(0.5)
  // mowing stripes (subtle) near the track
  const stripes = sin(positionWorld.x.add(positionWorld.z.mul(0.3)).mul(0.35)).mul(0.5).add(0.5)
  let col = mix(t1.rgb, t2.rgb, 0.35)
  col = col.mul(mix(vec3(0.85, 0.95, 0.8), vec3(1.15, 1.05, 0.85), n))
  col = col.mul(mix(float(0.9), float(1.1), n2)).mul(mix(float(0.95), float(1.05), stripes))
  // reduce visible tiling far away
  const dist = length(positionWorld.sub(cameraPosition))
  const far = smoothstep(60, 600, dist)
  col = mix(col, vec3(0.055, 0.08, 0.03).mul(mix(float(0.9), float(1.15), n)), far.mul(0.55))
  return { color: col, rough: t1.a }
}

export function terrainMaterial() {
  const tex = getTextures().grass
  const m = new THREE.MeshStandardNodeMaterial()
  const g = grassColor()
  // rocky slopes on steep terrain far from the track
  const tr = aTrack()
  const farFromTrack = smoothstep(80, 400, tr.x)
  const rock = mx_noise_float(vec3(positionWorld.x.mul(0.05), positionWorld.y.mul(0.05), positionWorld.z.mul(0.05))).mul(0.5).add(0.5)
  const rockMask = smoothstep(0.62, 0.8, rock).mul(farFromTrack).mul(0.7)
  m.colorNode = mix(g.color, vec3(0.16, 0.15, 0.13).mul(rock.add(0.5)), rockMask)
  m.roughnessNode = max(g.rough, 0.85)
  m.normalNode = normalMap(texture(tex.normal, uv()), vec2(0.6))
  return m
}

export function mountainMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const h = positionWorld.y
  const n = mx_noise_float(positionWorld.mul(0.004)).mul(0.5).add(0.5)
  const n2 = mx_noise_float(positionWorld.mul(0.02)).mul(0.5).add(0.5)
  const forest = vec3(0.03, 0.05, 0.025).mul(n2.add(0.6))
  const rock = vec3(0.2, 0.19, 0.18).mul(n.add(0.5))
  const snow = vec3(0.85, 0.87, 0.9)
  let col = mix(forest, rock, smoothstep(120, 260, h.add(n.mul(80))))
  col = mix(col, snow, smoothstep(330, 420, h.add(n2.mul(60))))
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
