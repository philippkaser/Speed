// Materials of the procedural architecture (kit.ts): one opaque material for every building part
// (albedo, roughness, metalness, emission, ao and a procedural pattern per vertex), the curtain-wall
// glass with interior mapping, and the signage atlas.
import * as THREE from 'three/webgpu'
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  dot,
  float,
  floor,
  fract,
  fwidth,
  max,
  min,
  mix,
  mx_cell_noise_float,
  mx_noise_float,
  normalize,
  positionWorld,
  pow,
  smoothstep,
  step,
  texture,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import { bumpView } from '../materials'

type N = any

const isPat = (pat: N, k: number) => float(1).sub(min(abs(pat.sub(k)), 1))

/** anti-aliased grid lines (seams) of a cell size, x and y in metres; 1 on a seam */
function seams(p: N, cell: N, halfWidth: number) {
  const q = p.div(cell)
  // distance to the nearest seam, m
  const f: N = fract(q).sub(0.5).abs().sub(0.5).abs().mul(cell)
  const w: N = fwidth(p).add(0.002)
  const l: N = (smoothstep as N)(vec2(halfWidth, halfWidth), w.add(halfWidth), f)
  return float(1).sub(min(l.x, l.y))
}

/**
 * Buildings: concrete (mottled, weathered), aluminium cladding panels (seams, a tone per panel),
 * ribbed metal (roller doors, roof sheeting), painted steel, epoxy floors, plastic. Patterns are in
 * the faces' own metres (uv), the seams and ribs bumped into the shading.
 */
export function archMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const c: N = attribute('color', 'vec3')
  const pbr: N = attribute('aPbr', 'vec4')
  const pat: N = attribute('aPat', 'float')
  const p = uv()
  const pw = positionWorld
  const conc = isPat(pat, 1),
    clad = isPat(pat, 2),
    rib = isPat(pat, 3),
    steel = isPat(pat, 4),
    floorP = isPat(pat, 5)
  // concrete: large mottling, fine speckle, darker water stains running down
  const n1 = mx_noise_float(pw.mul(0.35)).mul(0.5).add(0.5)
  const n2 = mx_noise_float(pw.mul(3.1)).mul(0.5).add(0.5)
  const stain = smoothstep(0.55, 0.85, mx_noise_float(vec3(pw.x.mul(1.7), pw.y.mul(0.12), pw.z.mul(1.7))).mul(0.5).add(0.5))
  const concTone = mix(float(0.82), float(1.12), n1).mul(mix(float(0.94), float(1.05), n2)).mul(float(1).sub(stain.mul(0.18)))
  // cladding: 1.5 x 0.75 m panels, each a slightly different tone, dark seams
  const cell = vec2(1.5, 0.75)
  const panel = mx_cell_noise_float(vec3(floor(p.x.div(1.5)), floor(p.y.div(0.75)), floor(pw.y.mul(0.01))))
  const seam = seams(p, cell, 0.012)
  const cladTone = mix(float(0.94), float(1.06), panel).mul(float(1).sub(seam.mul(0.55)))
  // ribbed metal: 0.2 m ribs across the face's v
  const ribPhase = fract(p.y.div(0.2))
  const ribH = smoothstep(0.0, 0.5, ribPhase).mul(smoothstep(1.0, 0.5, ribPhase))
  const ribTone = mix(float(0.8), float(1.04), ribH)
  // steel and floors: subtle mottling (paint and epoxy)
  const softTone = mix(float(0.9), float(1.06), n1)
  const tone = float(1)
    .add(conc.mul(concTone.sub(1)))
    .add(clad.mul(cladTone.sub(1)))
    .add(rib.mul(ribTone.sub(1)))
    .add(steel.add(floorP).mul(softTone.sub(1)))
  m.colorNode = c.mul(tone)
  // floors: darker tyre marks
  const rough: N = pbr.x.mul(mix(float(1), mix(float(0.9), float(1.1), n2), conc.add(floorP)))
  m.roughnessNode = clamp(rough, 0.04, 1)
  m.metalnessNode = pbr.y
  m.emissiveNode = c.mul(pbr.z)
  m.aoNode = pbr.w
  const height = seam.mul(-0.004).mul(clad).add(ribH.mul(0.012).mul(rib)).add(n2.mul(0.002).mul(conc))
  m.normalNode = bumpView(height)
  return m
}

/**
 * Curtain-wall glass: a dielectric mirror for the sky (the IBL: roughness ~0, F0 ~0.08 with a cool
 * tint) in front of an interior that is ray-cast per pixel ("interior mapping"): each storey is a row
 * of rooms 6 m wide and `depth` deep behind the glass, with a floor, a ceiling with light panels, side
 * walls and a back wall, lit or dark per room, some with blinds down. No textures, no geometry: it
 * reads as rooms with parallax from any angle.
 *
 * aRoom: floor height (world y), ceiling height, depth (m), style (0..1, per facade).
 */
export function glassMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const room: N = attribute('aRoom', 'vec4')
  const n: N = normalize(attribute('normal', 'vec3'))
  const p = positionWorld
  const V = normalize(p.sub(cameraPosition))
  const nh = normalize(vec3(n.x, 0, n.z))
  const T = vec3(nh.z, 0, nh.x.negate())
  const W = float(6)
  const u = dot(p, T)
  const cellU = floor(u.div(W))
  const seed = mx_cell_noise_float(vec3(cellU, room.x.mul(0.37), room.w.mul(13)))
  const seed2 = mx_cell_noise_float(vec3(cellU, room.x.mul(0.53).add(4.1), 7.7))
  const vIn = max(dot(V, nh.negate()), 0.02)
  const tBack = room.z.div(vIn)
  const vy = V.y
  const vyS = vy.abs().max(1e-3)
  const tY = vy.greaterThan(0).select(room.y.sub(p.y), p.y.sub(room.x)).div(vyS)
  const uLoc = fract(u.div(W)).mul(W)
  const vt = dot(V, T)
  const vtS = vt.abs().max(1e-3)
  const tSide = vt.greaterThan(0).select(W.sub(uLoc), uLoc).div(vtS)
  const t = min(tBack, min(tY, tSide))
  const hit = p.add(V.mul(t))
  const depthIn = dot(hit.sub(p), nh.negate())
  const isBack = step(tBack, min(tY, tSide).add(1e-4))
  const isY = step(tY, min(tBack, tSide).add(1e-4)).mul(float(1).sub(isBack))
  const isCeil = isY.mul(step(0, vy))
  const isFloor = isY.mul(float(1).sub(step(0, vy)))
  const isSide = float(1).sub(isBack).sub(isY).max(0)
  const lit = smoothstep(0.18, 0.3, seed)
  const level = mix(float(0.12), float(1), lit)
  // ceiling: light panels in a grid
  const hu = dot(hit, T)
  const la = fract(hu.div(1.2)).sub(0.5).abs(),
    lb = fract(depthIn.div(1.8)).sub(0.5).abs()
  const lp = float(1).sub(smoothstep(0.09, 0.12, la)).mul(float(1).sub(smoothstep(0.24, 0.28, lb)))
  const ceiling = vec3(0.5, 0.5, 0.48).mul(0.35).add(vec3(1.0, 0.97, 0.9).mul(lp).mul(2.6)).mul(level)
  // floor: dark carpet, brighter under the lights
  const floorC = vec3(0.07, 0.065, 0.06).mul(level).mul(1.4)
  // back wall: tone per room, a darker band of furniture and people
  const wallTone = mix(vec3(0.55, 0.53, 0.5), vec3(0.42, 0.46, 0.52), seed2)
  const hy = hit.y.sub(room.x)
  const furniture = smoothstep(0.7, 0.75, hy).mul(float(1).sub(smoothstep(1.15, 1.2, hy)))
  const people = smoothstep(0.55, 0.7, mx_noise_float(vec3(hu.mul(1.7), 2.3, cellU))).mul(float(1).sub(smoothstep(1.5, 1.75, hy)))
  const back = wallTone.mul(float(1).sub(furniture.mul(0.6)).sub(people.mul(0.5))).mul(0.45).mul(level)
  const side = wallTone.mul(0.32).mul(level)
  // darker deep inside the room
  const fall = float(1).sub(smoothstep(0, room.z, depthIn).mul(0.35))
  let interior: N = ceiling.mul(isCeil).add(floorC.mul(isFloor)).add(back.mul(isBack)).add(side.mul(isSide)).mul(fall)
  // blinds down over the upper part of some windows (lit by the daylight through the glass)
  const gy = p.y.sub(room.x).div(room.y.sub(room.x))
  const blindDown = step(0.62, seed2).mul(step(mix(float(0.35), float(0.85), fract(seed2.mul(7.3))), gy))
  interior = mix(interior, vec3(0.32, 0.31, 0.3).mul(0.35), blindDown)
  // through the glass: its transmittance and the light the Fresnel term reflects away
  const cosT = max(dot(V.negate(), n), 0)
  const F = float(0.08).add(float(0.92).mul(pow(float(1).sub(cosT), 5)))
  // metalness 1 with a dark colour: no diffuse at all, a Schlick reflectance from F0 ~0.08 (coated
  // architectural glass) to 1 at grazing angles
  m.colorNode = vec3(0.07, 0.085, 0.092)
  m.metalnessNode = float(1)
  m.roughnessNode = float(0.035)
  m.emissiveNode = interior.mul(float(1).sub(F)).mul(vec3(0.55, 0.62, 0.62))
  return m
}

/** The signage atlas: printed boards (and LED panels: aSign.x emission). */
export function signMaterial(atlas: THREE.Texture) {
  const m = new THREE.MeshStandardNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  const t = texture(atlas, uv())
  const e: N = attribute('aSign', 'vec2')
  m.colorNode = t.rgb
  m.roughnessNode = mix(float(0.55), float(0.3), e.y)
  m.metalnessNode = float(0)
  m.emissiveNode = t.rgb.mul(e.x)
  return m
}
