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
import { breakUpRoughness, detailAt, detailHeight, dust, wearMask } from '../surfaceDetail'

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
 * Buildings: concrete (mottled, porous, weathered, the odd spall, damp and algae near the ground),
 * aluminium cladding panels (seams, a tone per panel, the panels' faint bulge, smudges), ribbed metal
 * (roller doors, roof sheeting: scratched, rust at the foot and streaks from the fixings), painted
 * steel (chipped to primer and bare metal, rust streaks, dust on what faces up), epoxy floors (tyre
 * scuffs, oil stains, scratches in the gloss), plastic (sun-faded on top, scuffed, dirty). Patterns are
 * in the faces' own metres (uv); the detail maps (surfaceDetail.ts) give every surface its grain,
 * pores, scratches and the breathing of its roughness and normal.
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
    floorP = isPat(pat, 5),
    plastic = isPat(pat, 6)
  const metalP = pbr.y
  const d = detailAt(p)
  // concrete: large mottling, fine speckle, darker water stains running down
  const n1 = mx_noise_float(pw.mul(0.35)).mul(0.5).add(0.5)
  const stain = smoothstep(0.55, 0.85, mx_noise_float(vec3(pw.x.mul(1.7), pw.y.mul(0.12), pw.z.mul(1.7))).mul(0.5).add(0.5))
  const concTone = mix(float(0.82), float(1.12), n1).mul(mix(float(0.94), float(1.05), d.grain)).mul(float(1).sub(stain.mul(0.18))).mul(float(1).sub(d.pits.mul(0.4)))
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
  // precast concrete panels and the cladding's structural bays: wider, darker joints every few metres
  const bays = seams(p, vec2(6, 3), 0.025)
  // weathering on every wall: rain streaks running down from the edges, broad mottling, and the
  // grime splashed up from the ground (darker, browner, ragged upper edge); none on floors and roofs
  const nW: N = normalize(attribute('normal', 'vec3'))
  const nY: N = abs(nW.y)
  const wall = float(1).sub(smoothstep(0.35, 0.6, nY))
  const top = smoothstep(0.6, 0.9, nW.y)
  const lh: N = attribute('aLh', 'float')
  const streaks = smoothstep(0.5, 0.9, mx_noise_float(vec3(pw.x.mul(2.3).add(pw.z.mul(2.3)), pw.y.mul(0.09), 5.3)).mul(0.5).add(0.5))
  const splashTop = float(1.3).add(mx_noise_float(vec3(pw.x.mul(0.9), 1.3, pw.z.mul(0.9))).mul(0.45))
  const splash = float(1).sub(smoothstep(0.05, splashTop, lh)).mul(wall)
  const contact = float(1).sub(smoothstep(0.0, 0.45, lh)).mul(wall)
  const weather = float(1)
    .sub(streaks.mul(0.22).mul(wall))
    .sub(bays.mul(0.35).mul(conc.add(clad)))
    .mul(mix(float(0.9), float(1.04), n1))
    .mul(float(1).sub(contact.mul(0.45)))
    .mul(mix(float(0.95), float(1.04), d.macro))
  const grime = vec3(0.62, 0.56, 0.48)
  // white paint and cladding weather to ~0.6-0.7, not a fresh 0.8+
  const cW = c.mul(mix(float(1), float(0.8), smoothstep(0.55, 0.85, max(c.x, max(c.y, c.z)))))
  let col: N = mix(cW.mul(tone).mul(weather), cW.mul(tone).mul(grime).mul(0.7), splash.mul(0.8))
  let rough: N = pbr.x
  let metal: N = metalP
  let height: N = seam.mul(-0.004).sub(bays.mul(0.006).mul(conc.add(clad))).mul(clad).add(ribH.mul(0.012).mul(rib))

  // ---- concrete: pores, grain, the odd spall (lighter, coarser aggregate), damp and algae low down,
  // whitish efflorescence bleeding from the joints
  const spall = wearMask(d, 0.06).mul(conc)
  const damp = splash.mul(smoothstep(0.45, 0.75, d.mottle)).mul(conc)
  const efflo = bays.max(smoothstep(0.7, 0.9, d.streaks).mul(0.4)).mul(smoothstep(0.55, 0.8, d.streaks)).mul(conc).mul(wall).mul(0.5)
  col = mix(col, col.mul(1.12).add(vec3(0.02, 0.02, 0.015)), spall.mul(0.8))
  col = mix(col, col.mul(vec3(0.72, 0.78, 0.62)), damp.mul(0.45))
  col = mix(col, max(col, vec3(0.5, 0.5, 0.48)), efflo)
  rough = mix(rough, breakUpRoughness(rough, d, { k: 0.1, mottle: 0.08 }).add(spall.mul(0.08)), conc)
  height = height.add(detailHeight(d, { grain: 0.0009, pits: 0.0016 }).sub(spall.mul(0.004)).mul(conc))

  // ---- cladding (painted aluminium): the panels' faint bulge, the paint's peel and grain, smudges
  // and wiping marks, dirt collecting under the horizontal seams
  const bulge = mx_noise_float(vec3(floor(p.x.div(1.5)).add(fract(p.x.div(1.5)).mul(0.9)), fract(p.y.div(0.75)).mul(1.4), panel.mul(9))).mul(0.0025)
  const underSeam = smoothstep(0.75, 0.0, fract(p.y.div(0.75))).mul(smoothstep(0.45, 0.85, d.streaks)).mul(wall)
  col = mix(col, col.mul(0.8), underSeam.mul(0.35).mul(clad))
  rough = mix(rough, breakUpRoughness(rough, d, { k: 0.1, scratch: 0.6, smudge: 0.7 }), clad)
  height = height.add(bulge.add(detailHeight(d, { grain: 0.00008 })).mul(clad))

  // ---- ribbed metal and painted steel: chips through the paint to primer and to bare metal, rust
  // at the foot and streaks running down from the fixings, scratches, dust on what faces up
  const painted = rib.add(steel).clamp(0, 1)
  const chip = wearMask(d, float(0.06).add(contact.mul(0.25)).add(top.mul(0.05)))
  const deep = wearMask(d, float(0.03).add(contact.mul(0.2)))
  const primer = vec3(0.24, 0.06, 0.03)
  const bare = vec3(0.32, 0.3, 0.28)
  const rustCol = vec3(0.2, 0.075, 0.025).mul(mix(float(0.7), float(1.2), d.grain))
  const fixings = smoothstep(0.82, 0.95, d.spangle).mul(smoothstep(0.55, 0.8, d.streaks))
  const rustStreak = smoothstep(0.62, 0.9, d.streaks).mul(wall).mul(smoothstep(0.35, 0.65, d.macro)).mul(0.5)
  const footRust = float(1).sub(smoothstep(0.05, 0.6, lh)).mul(wearMask(d, 0.35)).mul(wall)
  const rust = clamp(rustStreak.add(footRust).add(fixings.mul(0.4)).add(deep.mul(0.6)), 0, 1).mul(painted)
  col = mix(col, mix(primer, bare, deep), chip.mul(painted).mul(float(1).sub(metalP.mul(0.5))))
  col = mix(col, rustCol, rust.mul(0.75))
  metal = mix(metal, float(0.6), deep.mul(painted))
  metal = mix(metal, float(0), rust)
  rough = mix(rough, breakUpRoughness(rough, d, { k: 0.12, scratch: 0.65, smudge: 0.4 }), painted)
  rough = mix(rough, float(0.85), rust.mul(0.8))
  rough = mix(rough, float(0.55), chip.mul(painted).mul(0.6))
  height = height.add(detailHeight(d, { grain: 0.00012, scratch: 0.0002 }).sub(chip.mul(0.00025)).add(rust.mul(d.grain.sub(0.5)).mul(0.0012)).mul(painted))

  // ---- epoxy floors: tyre scuffs (black arcs), oil stains (dark, glossier), scratches in the gloss
  const scuff = smoothstep(0.6, 0.85, detailAt(vec2(p.x.mul(0.9).add(p.y.mul(0.4)), p.y.mul(0.9).sub(p.x.mul(0.4)))).streaks)
  const oil = smoothstep(0.25, 0.7, d.smudges)
  col = mix(col, col.mul(0.25), scuff.mul(0.35).mul(floorP))
  col = mix(col, col.mul(0.55), oil.mul(0.6).mul(floorP))
  rough = mix(rough, breakUpRoughness(rough, d, { k: 0.15, mottle: 0.15, scratch: 0.55 }).mul(mix(float(1), float(0.6), oil)), floorP)
  height = height.add(detailHeight(d, { grain: 0.00006, scratch: 0.0001 }).mul(floorP))

  // ---- plastic (seats): sun-faded and chalky on what faces up, scuffed, dirt in the low spots
  const faded = top.add(wall.mul(0.3)).mul(smoothstep(0.3, 0.8, d.mottle)).clamp(0, 1)
  col = mix(col, mix(col, vec3(dot(col, vec3(0.3, 0.55, 0.15))), 0.45).mul(1.18).add(0.015), faded.mul(0.6).mul(plastic))
  col = mix(col, col.mul(0.7), smoothstep(0.4, 0.8, d.smudges).mul(0.5).mul(plastic))
  rough = mix(rough, breakUpRoughness(mix(rough, float(0.75), faded.mul(0.7)), d, { k: 0.1, scratch: 0.7, smudge: 0.6 }), plastic)
  height = height.add(detailHeight(d, { grain: 0.00015, scratch: 0.00025 }).mul(plastic))

  // ---- everything else (plain paint, trim, bare aluminium): grain in the roughness, smudges and
  // wiping, brushed streaks in the metal
  const plain = float(1).sub(conc).sub(clad).sub(rib).sub(steel).sub(floorP).sub(plastic).clamp(0, 1)
  const brushed = detailAt(vec2(p.y.mul(6), p.x.mul(0.2))).streaks
  rough = mix(rough, breakUpRoughness(rough.mul(mix(float(1), mix(float(0.85), float(1.2), brushed), metalP)), d, { k: 0.1, scratch: 0.5, smudge: 0.6 }), plain)
  height = height.add(detailHeight(d, { grain: 0.0001 }).mul(plain))

  // dust settled on what faces up, outdoors (the emissive interiors' floors stay clean)
  const outdoors = float(1).sub(smoothstep(0.05, 0.2, pbr.z))
  const dd = dust(col, rough, d, nW.y.mul(outdoors).mul(float(1).sub(floorP)), 0.3)
  m.colorNode = dd.albedo
  m.roughnessNode = clamp(dd.rough, 0.04, 1)
  m.metalnessNode = metal
  m.emissiveNode = c.mul(pbr.z)
  m.aoNode = pbr.w
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
  // the glass is not clean: a film of dust and dried rain, thicker towards the bottom of each pane
  // and in the streaks under the frames, smears where it was wiped; it blurs the reflection a little
  // and scatters some light of its own
  const gd = detailAt(vec2(u, p.y))
  const film = clamp(smoothstep(0.35, 0.85, gd.smudges).mul(0.5).add(smoothstep(0.55, 0.9, gd.streaks).mul(0.45)).add(float(1).sub(smoothstep(0.0, 0.3, gy)).mul(0.45)).add(gd.pits.mul(0.3)), 0, 1)
  // metalness 1 with a dark colour: no diffuse at all, a Schlick reflectance from F0 ~0.08 (coated
  // architectural glass) to 1 at grazing angles
  m.colorNode = mix(vec3(0.07, 0.085, 0.092), vec3(0.11, 0.11, 0.105), film.mul(0.5))
  m.metalnessNode = float(1)
  m.roughnessNode = mix(float(0.03), float(0.14), film).mul(mix(float(0.9), float(1.1), gd.grain))
  m.emissiveNode = interior.mul(float(1).sub(F)).mul(vec3(0.55, 0.62, 0.62)).mul(float(1).sub(film.mul(0.2)))
  return m
}

/**
 * The signage atlas: printed vinyl boards (and LED panels: aSign.x emission). The vinyl is stretched
 * over a frame, never quite flat (a slow waviness in the normal); it carries the grain of the print,
 * rain streaks, smudges and a slight sheen that varies across it.
 */
export function signMaterial(atlas: THREE.Texture) {
  const m = new THREE.MeshStandardNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  const t = texture(atlas, uv())
  const e: N = attribute('aSign', 'vec2')
  // the board's own metres (any vertical board: along x + z, y up)
  const d = detailAt(vec2(positionWorld.x.add(positionWorld.z), positionWorld.y))
  const vinyl = float(1).sub(e.y)
  m.colorNode = t.rgb.mul(mix(float(1), mix(float(0.93), float(1.04), d.mottle).mul(float(1).sub(smoothstep(0.55, 0.9, d.streaks).mul(0.12))), vinyl))
  m.roughnessNode = mix(breakUpRoughness(0.5, d, { k: 0.12, mottle: 0.12, smudge: 0.6 }), float(0.3), e.y)
  m.metalnessNode = float(0)
  m.emissiveNode = t.rgb.mul(e.x)
  m.normalNode = bumpView(d.mottle.sub(0.5).mul(0.004).add(d.grain.sub(0.5).mul(0.00008)).mul(vinyl))
  return m
}
