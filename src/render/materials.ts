// Physically based materials for the circuit, written in TSL (work on WebGPU and the WebGL2 fallback).
import * as THREE from 'three/webgpu'
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  mod,
  mx_cell_noise_float,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  normalMap,
  normalView,
  normalWorld,
  positionView,
  positionWorld,
  sign,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
} from 'three/tsl'
import { getTextures } from './textures'
import { debugFlag } from '../util/debug'
import { groundSet, type GroundSet } from './worldAssets'
import { farTreeShadow, GRASS_CONTACT, setContactStrength, setSunShadowTerm } from './sunShadow'
import { photoSkyHorizon } from './photoSky'
import { RUBBER_HALF, RUBBER_ROW, type Track } from '../track/track'
import { bakeSkidMarks, SKID_COLS, SKID_HALF } from '../track/skidMarks'
import { breakUpRoughness, detailAt, detailHeight, detailTri, dust, weathering, wearMask, type Detail } from './surfaceDetail'

type N = any

const LUM = vec3(0.2126, 0.7152, 0.0722)

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
  return { col, nxy, rough, mean }
}

/** Tangent-space normal for normalMap() from a stored x/y pair (z rebuilt). */
function normalFromXY(nxy: N) {
  const xy = nxy.mul(2).sub(1)
  const z = max(float(1).sub(xy.dot(xy)), 0).sqrt()
  return vec3(nxy, z.mul(0.5).add(0.5))
}

/**
 * A sward's effective normal at a grazing view: the camera sees the blades side-on, not a level
 * plane, so the shading normal leans towards the viewer (no flat-plane Fresnel mirror of the sky).
 */
function swardNormal(n: N, graze: N) {
  return normalize(mix(n, normalize(positionView.negate()), graze.mul(0.5)))
}

/**
 * View-space normal bumped by a procedural height (Mikkelsen's surface gradient, from the screen
 * derivatives of the height and the position): for detail that has no texture of its own.
 */
export function bumpView(height: N, n: N = normalView): N {
  const p = positionView
  const dpdx = dFdx(p),
    dpdy = dFdy(p)
  const r1 = cross(dpdy, n),
    r2 = cross(n, dpdx)
  const det = dot(dpdx, r1)
  const grad = sign(det).mul(dFdx(height).mul(r1).add(dFdy(height).mul(r2)))
  return normalize(abs(det).mul(n).sub(grad))
}

/** Summer verge: the scan's straw shifted towards green. */
const greenGrass = (c: N) => {
  const lum = c.dot(LUM)
  return mix(c, vec3(lum.mul(0.68), lum.mul(1.14), lum.mul(0.42)), 0.7).mul(0.78)
}

/**
 * The grass ground's colour around a point, averaged over about a metre (explicit mip level, so it
 * also works in a vertex shader): the 3D grass takes its colour from the ground it stands on.
 */
export function grassGroundColour(xz: N) {
  const t = groundSet('grass').colour
  const p = swardPatches(xz)
  return mix(greenGrass(texture(t, xz.div(2.6)).level(float(7)).rgb).mul(lawnTone(xz)).mul(dryTone(xz)).mul(p.tint), SOIL, p.bare.mul(0.6))
}

/** Sun direction (towards the sun) for the ground's canopy response; set each frame (Vegetation.tsx). */
export const groundSun = uniform(new THREE.Vector3(0.3, 0.4, 0.2).normalize())

/** Dry topsoil between thin grass: albedo ~0.12, warm brown. */
const SOIL = vec3(0.135, 0.105, 0.075)

/**
 * What makes a real verge patchy rather than a carpet, at the scale a camera resolves out to 40 m:
 * clover and lush spots (darker, bluer green), and thin, worn spots where the soil shows through
 * (shared with the 3D grass standing there, so blades and ground agree). Never faded by distance.
 */
function swardPatches(xz: N) {
  const zone = mx_noise_float(vec3(xz.x.mul(0.07), 12.1, xz.y.mul(0.07)))
  const clover = smoothstep(0.18, 0.5, mx_noise_float(vec3(xz.x.mul(0.42), 5.3, xz.y.mul(0.42)))).mul(smoothstep(-0.35, 0.25, zone))
  const worn = smoothstep(0.42, 0.72, mx_noise_float(vec3(xz.x.mul(0.26), 9.7, xz.y.mul(0.26)))).mul(smoothstep(0.0, 0.4, zone.negate()))
  const tint = mix(vec3(1), vec3(0.6, 0.78, 0.74), clover)
  return { tint, bare: worn.mul(0.75) }
}

/**
 * Slow tonal variation of the lawns (lusher and drier patches), shared by the ground and the 3D grass
 * standing on it so both read as one sward.
 */
function lawnTone(xz: N): N {
  const n = mx_noise_float(vec3(xz.x.mul(0.006), 0.5, xz.y.mul(0.006))).mul(0.5).add(0.5)
  const n2 = mx_noise_float(vec3(xz.x.mul(0.035), 4.5, xz.y.mul(0.035))).mul(0.5).add(0.5)
  // and patches a few metres across: clover, thinner and lusher spots
  const n3 = mx_noise_float(vec3(xz.x.mul(0.21), 7.5, xz.y.mul(0.21))).mul(0.5).add(0.5)
  return mix(vec3(0.84, 0.93, 0.8), vec3(1.08, 1.03, 0.84), n).mul(mix(float(0.84), float(1.08), n2)).mul(mix(vec3(0.8, 0.88, 0.8), vec3(1.1, 1.07, 0.92), n3))
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
function band(x: N, a: number, b: number) {
  const w = fwidth(x).mul(1.2).add(0.002)
  return smoothstep(float(a).sub(w), float(a).add(w), x).mul(float(1).sub(smoothstep(float(b).sub(w), float(b).add(w), x)))
}

/** anti-aliased thin line where |x| < halfWidth (x in metres) */
function line(x: N, halfWidth: number | N) {
  const fw = fwidth(x)
  const w = fw.add(0.003)
  // thinner than a pixel at a distance: fade instead of widening (the line keeps its share of the pixel)
  const cover = clamp(float(halfWidth).mul(2).div(fw.add(1e-4)), 0, 1)
  return float(1).sub(smoothstep(float(halfWidth), float(halfWidth).add(w), abs(x))).mul(cover)
}

/** The dynamic track (track.ts: rubber in red, marbles in green, cells RUBBER_ROW m x RUBBER_CELL m)
 *  as a texture, refreshed while the cars lay rubber. */
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
    for (let k = 0; k < track.rubber.length; k++) {
      data[k * 4] = Math.round(track.rubber[k] * 255)
      data[k * 4 + 1] = Math.round(track.marbles[k] * 255)
    }
    tex.needsUpdate = true
    track.rubberDirty = false
  }
  refresh()
  return { tex, refresh, rows }
}

/**
 * Tyre rubber laid on the track, one material wherever it lies: the rubbered line and the baked skid
 * marks on the asphalt (as factors on the asphalt's own albedo and roughness), the rubber on the
 * kerbs and the marks the cars lay live (render/Effects.tsx). Fresh rubber is nearly black and, worked
 * into the surface, glossier than what is around it.
 */
export const RUBBER_ALBEDO = 0.025
export const RUBBER_ROUGHNESS = 0.42

/**
 * The skid marks a race weekend has left (track/skidMarks.ts), baked once into a single-channel map in
 * track coordinates: across the road (SKID_COLS over +-SKID_HALF m) and along the lap (one row per
 * ~0.5 m). Mipmapped and anisotropic: seen along the road at a grazing angle, its rows squeeze into a
 * few pixels.
 */
export function skidTexture(track: Track) {
  const t0 = performance.now()
  const map = bakeSkidMarks(track)
  const tex = new THREE.DataTexture(map.data, SKID_COLS, map.rows, THREE.RedFormat, THREE.UnsignedByteType)
  tex.magFilter = THREE.LinearFilter
  const mips = !debugFlag('skidnomip')
  tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  tex.generateMipmaps = mips
  tex.anisotropy = 8
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.needsUpdate = true
  console.info(`[track] skid marks baked in ${(performance.now() - t0).toFixed(0)} ms: ${map.tracks} tyre tracks, ${map.offLine} of them well off the racing line`)
  return tex
}

// ------------------------------------------------------------------------------------------ road

/**
 * Photo-scanned race asphalt (Poly Haven asphalt_track, 3 m per tile). Weathered race tarmac is dark
 * (albedo ~0.055 before the dust and rubber below: ~0.06-0.07 off line, ~0.03 on it): the scan is brought up from its fresh near-black, its aggregate contrast kept crisp
 * (stones and binder are what reads as asphalt up close) and only lightly desaturated.
 */
function trackAsphalt(uvMetres: N) {
  const a = scanned(groundSet('asphalt'), uvMetres.div(3))
  const c = a.col.sub(a.mean).mul(1.6).add(a.mean).max(vec3(0))
  const col = mix(c, vec3(c.dot(LUM)), 0.3).mul(4.3)
  return { col, nxy: a.nxy, rough: a.rough }
}

/**
 * Race asphalt: the scan, broken up by what a circuit's surface really carries: paving strips with
 * sealed cold joints between them, transverse expansion joints, repair patches with sealed edges, tar
 * snakes (crack sealant, black and glossy), the rubbered-in racing line, skid marks in the braking
 * zones and corner exits, dust and marbles off line, worn white edge lines. The rubber and sealant are
 * smoother than the aggregate: the sun's sheen picks them out at grazing angles.
 *
 * aTrack: d (lateral, + left), s, racing line offset, half width; aTrack2: braking zone, traction zone.
 */
/**
 * Rubber as the tyres lay it, brush strokes along the lap (s, d in metres; 0..~1.3, mean ~0.85): long
 * strokes a tread wide and tens of metres long, of every weight (each car, each lap, presses a little
 * differently), fine striations from the tread's grooves, and pulses where the pressure changed;
 * more contrast where the cars brake (lock-ups, the ABS's pulses).
 */
function tyreStrokes(s: N, d: N, brake: N, fine = 0.28) {
  const strokes = mx_fractal_noise_float(vec3(s.mul(0.022), d.mul(3.3), 7.3), 3, 2.1, 0.55).mul(0.5).add(0.5)
  const grooves = mx_noise_float(vec3(s.mul(0.16), d.mul(13), 2.9)).mul(0.5).add(0.5)
  const pulses = mx_noise_float(vec3(s.mul(0.09), d.mul(0.7), 4.4)).mul(0.5).add(0.5)
  const contrast = mix(float(1), float(1.6), clamp(brake, 0, 1))
  return clamp(strokes.sub(0.5).mul(contrast.mul(1.9)).add(0.62 + 0.28 - fine).add(grooves.mul(fine)).add(pulses.mul(0.18)), 0, 1.3)
}

/**
 * The baked skid marks at a point of the track (s along the lap, d across it): 0..1, with the tread's
 * streaks along them (the marks run along the road to within ~15 degrees, so streaks stretched along s).
 */
function skidMarks(tex: THREE.Texture, s: N, d: N, length: number) {
  const k = texture(tex, vec2(d.add(SKID_HALF).div(2 * SKID_HALF), s.div(length))).r
  const streak = mx_noise_float(vec3(s.mul(0.7), d.mul(16), 3.3)).mul(0.5).add(0.5)
  return k.mul(mix(float(0.62), float(1.08), streak)).clamp(0, 1)
}

export function roadMaterial(rubber?: { tex: THREE.Texture; rows: number }, track?: { length: number }, skidTex?: THREE.Texture) {
  const m = new THREE.MeshStandardNodeMaterial()
  const tr = aTrack()
  const tr2 = attribute('aTrack2', 'vec4')
  const d = tr.x,
    s = tr.y,
    racing = tr.z,
    hw = tr.w
  const brake = tr2.x,
    traction = tr2.y
  // the ribbon's uv is world x/z over 4
  const asphalt = trackAsphalt(uv().mul(4))
  const pw = positionWorld
  // macro variation: patches of fresher / older tarmac, breaks visible tiling
  const macro = mx_noise_float(vec3(pw.x.mul(0.018), 0, pw.z.mul(0.018))).mul(0.5).add(0.5)
  const macro2 = mx_noise_float(vec3(pw.x.mul(0.11), 1.7, pw.z.mul(0.11))).mul(0.5).add(0.5)
  let albedo: N = asphalt.col.mul(mix(float(0.8), float(1.18), macro)).mul(mix(float(0.88), float(1.12), macro2))
  // race tarmac is a little smoother than the scan's road (0.83): the sun's sheen at grazing angles
  let rough: N = asphalt.rough.mul(mix(float(0.82), float(0.94), macro2))

  // resurfacing sections along the lap (120-260 m): newer, blacker binder or older, greyer, warmer tarmac
  const secLen = 190
  const sec = floor(s.div(secLen).add(mx_noise_float(vec3(d.mul(0.05), 4.4, 0)).mul(0.03)))
  const secTone = mx_cell_noise_float(vec3(sec, 9.1, 2.7))
  albedo = albedo.mul(mix(vec3(0.92, 0.92, 0.94), vec3(1.08, 1.065, 1.03), secTone))
  rough = rough.mul(mix(float(0.95), float(1.04), secTone))

  // paving strips (three across the width), each its own tone, cold joints between them
  const laneW = hw.mul(2 / 3)
  const lanePos = d.add(hw).div(laneW)
  const lane = floor(lanePos)
  const laneTone = mx_cell_noise_float(vec3(lane, 3.7, floor(s.div(380))))
  albedo = albedo.mul(mix(float(0.92), float(1.08), laneTone))
  const wob = mx_noise_float(vec3(s.mul(0.31), 1.1, lane)).mul(0.04)
  const jointD = lanePos.sub(lanePos.round()).mul(laneW).add(wob)
  const inner = step(0.5, lanePos).mul(step(lanePos, 2.5))
  let seal: N = line(jointD, 0.025).mul(inner).mul(0.6)
  // transverse expansion joints (every 47.3 m, where the physics has its little bump)
  const sj = fract(s.div(47.3).add(0.002)).sub(0.5).abs().sub(0.5).abs().mul(47.3)
  seal = max(seal, line(sj, 0.025))

  // repair patches: rectangles of fresher, darker tarmac in some strip cells, sealed round the edge
  const cellS = floor(s.div(17))
  const h0 = mx_cell_noise_float(vec3(cellS, lane, 11.3))
  const h1 = mx_cell_noise_float(vec3(cellS, lane, 23.9))
  const ls = s.sub(cellS.mul(17))
  const ld = fract(lanePos).mul(laneW)
  const a0 = h1.mul(5).add(1.5),
    a1 = float(15.5).sub(h0.mul(6))
  // ragged edges (hand-cut), never on the start straight (where every frame of a race begins)
  const rag = mx_noise_float(vec3(s.mul(0.9), d.mul(0.9), 6.1)).mul(0.12)
  const e = min(min(ls.sub(a0), a1.sub(ls)), min(ld.sub(0.3), laneW.sub(0.3).sub(ld))).add(rag)
  const offStraight = step(460, s).mul(step(s, float((track?.length ?? 1e6) - 430)))
  const hasPatch = step(0.93, h0).mul(offStraight)
  const patch = smoothstep(-0.02, 0.02, e).mul(hasPatch)
  albedo = mix(albedo, albedo.mul(0.86).mul(mix(float(0.94), float(1.06), h1)), patch)
  rough = mix(rough, rough.mul(0.96), patch)
  seal = max(seal, line(e, 0.025).mul(hasPatch).mul(0.7))

  // tar snakes: crack sealant along the iso-lines of a slow noise, in some stretches only
  const cn = mx_noise_float(vec3(s.mul(0.17), d.mul(0.45), 5.1))
  // sparse stretches, and broken into short runs within them
  const snakeZone = smoothstep(0.5, 0.7, mx_noise_float(vec3(s.mul(0.009), d.mul(0.04), 9.7))).mul(smoothstep(0.0, 0.25, mx_noise_float(vec3(s.mul(0.5), d.mul(0.8), 2.3))))
  const snake = float(1).sub(smoothstep(0.004, fwidth(cn).mul(1.2).add(0.007), abs(cn))).mul(snakeZone)
  seal = max(seal, snake.mul(0.7))

  // the dynamic track (track.ts): the rubber the tyres have laid, in two wheel tracks either side of
  // the lines the cars drive, heaviest where they brake and put the power down out of slow corners,
  // building up through a race; and the marbles they shed, off the line on the outside of the corners
  const dyn = rubber ? texture(rubber.tex, vec2(d.add(RUBBER_HALF).div(2 * RUBBER_HALF), s.div(RUBBER_ROW).div(rubber.rows))) : null
  // (0.1: a green track; ~0.25 a straight; ~0.6 through a corner; 0.8 and more in a braking zone)
  const rl = dyn ? smoothstep(0.12, 0.88, dyn.r) : exp(d.sub(racing).div(1.25).pow(2).negate())
  // the tyres are brushes: each pass paints a stroke along the direction of travel, heavier where it
  // presses harder (braking, the corners); a field of cars leaves overlapping strokes of every weight.
  // The cars travel along their lines, not along the track: where the racing line crosses the track
  // (into and out of a corner, at up to ~15 degrees) the strokes follow it, so they are laid out across
  // the offset from the racing line (strokes along the track's own direction crossed the marks)
  const lineRubber = rl.mul(tyreStrokes(s, d.sub(racing), brake)).clamp(0, 1)
  // skid marks: a race weekend's lock-ups, slides, scrubs, wheelspin and moments (track/skidMarks.ts),
  // each on its own car's line, many of them well off the racing line; the heaviest crop through the
  // corners. The same rubber as the line, laid in one go: one layer, one material
  const skid = skidTex ? skidMarks(skidTex, s, d, track?.length ?? 1) : float(0)
  const rubberAmt = float(1).sub(float(1).sub(lineRubber).mul(float(1).sub(skid)))
  // fresh rubber (albedo ~0.025, RUBBER_ALBEDO) over grey, dusty aggregate (~0.08): the line and the
  // marks read dark
  albedo = albedo.mul(mix(float(1.15), float(0.38), rubberAmt))
  if (skidTex && debugFlag('skiddebug')) albedo = mix(albedo, vec3(0.8, 0.02, 0.02), skid)
  // rubber polishes the aggregate and fills its pores: the line and the marks are the glossiest parts
  // of the road (~0.42, RUBBER_ROUGHNESS), the dusty tarmac off them the most matte
  rough = mix(rough.mul(1.08).min(0.95), rough.mul(0.58), rubberAmt)

  // marbles: pellets of rubber thrown off line, thickest on the outside of the corners (the dynamic
  // track's map; without it, near the edges in the braking and traction zones)
  const edge = clamp(abs(d).div(hw), 0, 1)
  const marbleZone = dyn
    ? smoothstep(0.03, 0.6, dyn.g)
    : smoothstep(0.55, 0.85, edge).mul(float(1).sub(smoothstep(0.97, 1, edge))).mul(float(1).sub(rl)).mul(clamp(brake.add(traction).mul(1.5).add(0.25), 0, 1))
  // dusty areas off line near the edges (where marbles lie, their black rubber dust instead)
  const dust = smoothstep(0.62, 1.0, edge).mul(float(1).sub(rl)).mul(float(1).sub(marbleZone.mul(0.85)))
  albedo = mix(albedo, albedo.mul(1.35).add(vec3(0.016, 0.014, 0.011)), dust.mul(0.75))
  rough = mix(rough, float(0.95), dust.mul(0.6))
  albedo = albedo.mul(float(1).sub(marbleZone.mul(0.35)))
  // the pellets: 1-2 cm, one at a random place in some 5 cm cells, a sparse scatter where a few lie and
  // a carpet where they have piled up; averaged once a pixel is wider than a pellet
  const pwm = pw.xz.mul(20)
  const cellM = vec3(floor(pwm.x), floor(pwm.y), 4.2)
  const present = smoothstep(mix(float(0.92), float(0.3), marbleZone), mix(float(0.98), float(0.45), marbleZone), mx_cell_noise_float(cellM))
  const pellet = vec2(mx_cell_noise_float(cellM.add(vec3(0, 0, 7.7))), mx_cell_noise_float(cellM.add(vec3(0, 0, 13.1)))).mul(0.4).add(0.3)
  const dots = present.mul(float(1).sub(smoothstep(0.2, 0.3, length(fract(pwm).sub(pellet)))))
  const dotFade = smoothstep(0.3, 0.9, fwidth(pwm.x).add(fwidth(pwm.y)))
  const marbles = mix(dots, marbleZone.mul(0.3), dotFade).mul(smoothstep(0, 0.15, marbleZone))
  albedo = mix(albedo, vec3(0.018, 0.017, 0.017), marbles.mul(0.9))
  rough = mix(rough, float(0.62), marbles.mul(0.6))

  // sealant: black, smooth bitumen
  albedo = mix(albedo, vec3(0.011, 0.011, 0.012), seal.mul(0.92))
  // (dusty sealant keeps the aggregate's relief and roughness: flattened, it mirrored the sky at
  // grazing angles and read as light lines)
  rough = mix(rough, rough.mul(0.92), seal)

  // white edge lines: 13.5 cm, 0.1 m inside the asphalt edge, hand-laid (the edges wander a few
  // millimetres and are soft), the paint worn through in patches and in fine scuffs, the aggregate
  // showing through it, grubby with tyre rubber
  const fromEdge = hw.sub(abs(d)).add(mx_noise_float(vec3(s.mul(0.7), 3.3, 0)).mul(0.008))
  const pfw = fwidth(fromEdge).mul(1.2).add(0.006)
  const paintLine = smoothstep(float(0.1).sub(pfw), float(0.1).add(pfw), fromEdge).mul(float(1).sub(smoothstep(float(0.235).sub(pfw), float(0.235).add(pfw), fromEdge)))
  const wear = smoothstep(0.25, 0.65, mx_noise_float(vec3(s.mul(0.9), d.mul(4.0), 0.2)).mul(0.5).add(0.5)).mul(0.3)
  const scuffFade = float(1).sub(smoothstep(0.01, 0.05, fwidth(s)))
  const scuff = smoothstep(0.35, 0.75, mx_noise_float(vec3(s.mul(6), d.mul(14), 1.9))).mul(0.45).mul(scuffFade)
  const paint = paintLine.mul(float(1).sub(wear)).mul(float(1).sub(scuff))
  const grain = clamp(asphalt.col.dot(LUM).div(0.05), 0.6, 1.4)
  const grime = mx_noise_float(vec3(s.mul(0.05), 7.7, 0)).mul(0.5).add(0.5)
  const blotch = mx_noise_float(vec3(s.mul(0.35), d.mul(0.2), 5.5)).mul(0.5).add(0.5)
  albedo = mix(albedo, vec3(0.6, 0.6, 0.58).mul(mix(float(0.86), float(1.06), grain)).mul(mix(float(0.76), float(1), grime)).mul(mix(float(0.82), float(1.04), blotch)).mul(mix(float(1), float(0.55), rl)), paint)
  rough = mix(rough, float(0.6), paint)

  // the start grid: each slot's tarmac stained by oil and coolant drips under the car (darker, glossy
  // blotches) and the launches' rubber, two black wheelspin streaks from the rear wheels forwards
  if (track) {
    const L = track.length
    const sg = s.sub(step(L / 2, s).mul(L))
    const left = step(0, d)
    const base = mix(float(-27.5), float(-14), left)
    const ls = fract(sg.sub(base).div(18).add(0.5)).sub(0.5).mul(18)
    const slot = sg.sub(base).sub(ls).div(-18)
    const onGrid = step(-0.5, slot).mul(step(slot, 9.5))
    const ld2 = d.sub(mix(float(-2.6), float(2.6), left))
    const sn = mx_noise_float(vec3(ls.mul(1.3), ld2.mul(1.3), slot.mul(3.1)))
    const oil = smoothstep(0.75, 0.25, vec2(ls.add(0.6).div(1.5), ld2.div(0.75)).length().add(sn.mul(0.35))).mul(onGrid)
    const launch = exp(abs(ld2).sub(0.8).div(0.13).pow(2).negate()).mul(smoothstep(-2.4, -1.6, ls)).mul(smoothstep(7, 0, ls)).mul(onGrid)
    const launchK = launch.mul(smoothstep(-0.2, 0.4, mx_noise_float(vec3(ls.mul(0.5), slot.mul(1.7), 6.3)))).mul(0.85)
    const stain = clamp(oil.mul(0.75).add(launchK), 0, 1)
    albedo = albedo.mul(float(1).sub(stain.mul(0.55)))
    rough = mix(rough, rough.mul(0.62), stain)
  }

  // the verge's soil, dust and grass creeping over the asphalt's last decimetres: no ruler-straight
  // edge (the 3D grass leans over it; this is what lies on the tarmac)
  const rag2 = mx_noise_float(vec3(s.mul(1.1), d.mul(0.5), 7.3)).mul(0.14).add(mx_noise_float(vec3(s.mul(4.3), d.mul(2), 1.4)).mul(0.06)).add(0.09)
  // (only where the verge itself adjoins the asphalt: no kerb or paved runoff on this side)
  const adj = mix(tr2.w, tr2.z, step(0, d))
  const creep = float(1).sub(smoothstep(float(0), rag2.max(0.005), fromEdge)).mul(step(0.5, edge)).mul(float(1).sub(step(0.05, adj)))
  const tuft = smoothstep(0.15, 0.45, mx_noise_float(vec3(s.mul(2.2), d.mul(2.2), 3.9)))
  const verge = mix(vec3(0.12, 0.098, 0.074), vec3(0.055, 0.075, 0.03), tuft.mul(creep))
  albedo = mix(albedo, verge, creep.mul(0.85))
  // and a haze of that soil a little further in
  albedo = mix(albedo, vec3(0.11, 0.095, 0.075), float(1).sub(smoothstep(0, 0.7, fromEdge)).mul(0.3).mul(step(0.5, edge)))
  rough = mix(rough, float(0.97), creep)
  // specular anti-aliasing: where a pixel covers many stones, the normal detail it averages away
  // becomes roughness (no sparkle in the distance, a broad sheen instead)
  const uvm = uv().mul(4)
  const foot = fwidth(uvm.x).add(fwidth(uvm.y))
  rough = rough.mul(rough).add(smoothstep(0.004, 0.06, foot).mul(0.06)).sqrt()
  m.colorNode = albedo
  m.roughnessNode = clamp(rough, 0.28, 1)
  m.metalnessNode = float(0)
  m.normalNode = normalMap(normalFromXY(asphalt.nxy), vec2(mix(float(1.15), float(0.4), paint).mul(mix(float(1), float(0.6), smoothstep(0.004, 0.06, foot)))))
  return m
}

/** Older, lighter asphalt with coarser aggregate (Poly Haven asphalt_pit_lane): runoff and pit lane. */
export function pitAsphaltSample(uvMetres: N) {
  const a = scanned(groundSet('pitlane'), uvMetres.div(2.5), 0.05)
  const c = a.col.sub(a.mean).mul(1.3).add(a.mean).max(vec3(0))
  const lum = c.dot(LUM)
  return { col: mix(c, vec3(lum), 0.35).mul(1.4), nxy: a.nxy, rough: a.rough }
}

/**
 * Paved runoff: older asphalt than the track's (the pit lane scan), its tone patchy over metres, crack
 * sealant snaking across it and the odd repair patch; marbles swept off the track onto its first few
 * metres; and the black marks of the cars that ran wide or locked up off the track: pairs of tyre
 * tracks arcing away from the kerb, the fresher darker, sparse along the lap. Grass and soil creep in
 * over its outer edge.
 */
export function runoffMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const a = pitAsphaltSample(uv().mul(4))
  const pw = positionWorld
  const macro = mx_noise_float(vec3(pw.x.mul(0.03), 2.3, pw.z.mul(0.03))).mul(0.5).add(0.5)
  const tr = aTrack()
  const s = tr.y
  const off = abs(tr.x).sub(tr.w)
  const d = detailAt(vec2(tr.x, s))
  // the cars that ran wide: in stretches of 23 and 37 m (two grids, so they overlap), now and then a
  // car's two tyre tracks (1.6 m apart) leaving the kerb at a shallow angle, fading as it slowed or
  // came back; the older ones grey
  const runWide = (len: number, seed: number) => {
    const j = floor(s.div(len))
    const h = mx_cell_noise_float(vec3(j, seed, 1.3))
    const h2 = mx_cell_noise_float(vec3(j, seed, 4.7))
    const u = s.sub(j.mul(len)).div(len)
    const path = h2.mul(1.5).add(u.mul(u).mul(mix(float(2), float(7), h)))
    // (both tyres: 0.8 m either side of the car's path, 0.24 m wide)
    const e = abs(off.sub(path).sub(0.4))
    const track = smoothstep(0.16, 0.08, abs(e.sub(0.8)))
    return track.mul(step(0.55, h)).mul(smoothstep(0, 0.08, u)).mul(float(1).sub(smoothstep(0.55, 1, u))).mul(mix(float(0.4), float(0.95), h2))
  }
  const broken = smoothstep(0.3, 0.6, d.streaks)
  const marks = max(runWide(23, 3.1), runWide(37, 8.9)).mul(broken)
  // marbles on the first metres beyond the kerb
  const marbles = smoothstep(0.35, 0.6, d.pits).mul(float(1).sub(smoothstep(0.5, 4, off)))
  // crack sealant: thin glossy black lines along the iso-lines of a slow noise, in some stretches
  const cn = mx_noise_float(vec3(s.mul(0.11), tr.x.mul(0.3), 9.1))
  const sealZone = smoothstep(0.45, 0.65, mx_noise_float(vec3(s.mul(0.012), tr.x.mul(0.02), 2.2)).mul(0.5).add(0.5))
  const seal = float(1).sub(smoothstep(0.006, fwidth(cn).mul(1.2).add(0.009), abs(cn))).mul(sealZone)
  // repair patches: fresher, darker rectangles of asphalt
  const cellS = floor(s.div(9)),
    cellD = floor(off.div(4))
  const ph = mx_cell_noise_float(vec3(cellS, cellD, 5.5))
  const patch = step(0.9, ph).mul(smoothstep(0.0, 0.05, fract(s.div(9)).sub(0.12)).mul(smoothstep(0.0, 0.05, float(0.88).sub(fract(s.div(9)))))).mul(smoothstep(0, 0.05, fract(off.div(4)).sub(0.1)).mul(smoothstep(0, 0.05, float(0.9).sub(fract(off.div(4))))))
  let col: N = a.col.mul(mix(float(0.82), float(1.12), macro)).mul(mix(float(0.92), float(1.06), d.mottle))
  col = mix(col, col.mul(0.78), patch.mul(0.8))
  col = mix(col, vec3(0.025, 0.025, 0.027), max(marks.mul(0.85), seal.mul(0.8)))
  col = mix(col, vec3(0.02, 0.02, 0.022), marbles.mul(0.7))
  // the verge's soil and grass creeping over the outer edge (aTrack.z: that edge's distance), and its
  // dust a little further in: no ruler-straight line where the grass begins
  const fromOuter = tr.z.sub(abs(tr.x))
  const rag = mx_noise_float(vec3(s.mul(1.1), tr.x.mul(0.5), 7.3)).mul(0.16).add(mx_noise_float(vec3(s.mul(4.3), tr.x.mul(2), 1.4)).mul(0.07)).add(0.12)
  const creep = float(1).sub(smoothstep(float(0), rag.max(0.005), fromOuter))
  const tuft = smoothstep(0.1, 0.4, mx_noise_float(vec3(s.mul(2.2), tr.x.mul(2.2), 3.9)))
  col = mix(col, vec3(0.11, 0.095, 0.075), float(1).sub(smoothstep(0, 0.9, fromOuter)).mul(0.35))
  m.colorNode = mix(col, mix(vec3(0.12, 0.098, 0.074), vec3(0.055, 0.075, 0.03), tuft), creep.mul(0.9))
  // rubber and sealant are glossier than the dusty old asphalt
  const rough = mix(clamp(a.rough.add(0.04), 0, 1), float(0.55), max(marks.mul(0.6), seal.mul(0.8)))
  m.roughnessNode = mix(rough, float(0.97), creep)
  m.normalNode = normalMap(normalFromXY(a.nxy), vec2(0.9))
  return m
}

/**
 * Kerbs: sun-faded red and white paint on concrete, the rumble ridges across them and the hump's
 * profile in the shading, the paint chipped at the edges of the blocks, black rubber where the cars
 * ride over the inner half, grass and dirt thrown onto the outer edge.
 */
export function kerbMaterial(rubber?: { tex: THREE.Texture; rows: number }, skid?: { tex: THREE.Texture; length: number }) {
  const m = new THREE.MeshStandardNodeMaterial()
  const tr = aTrack()
  const u = tr.x,
    s = tr.y
  // the kerb's lateral position on the track (z: side x half width, w: the kerb's width)
  const dk = tr.z.sign().mul(tr.z.abs().add(u.mul(tr.w)))
  const stripe = mod(floor(s.div(1.5)), 2)
  const block = floor(s.div(1.5))
  const fade = mx_cell_noise_float(vec3(block, 1.3, tr.z))
  const red = mix(vec3(0.46, 0.03, 0.026), vec3(0.56, 0.05, 0.035), fade)
  const white = mix(vec3(0.66, 0.66, 0.63), vec3(0.78, 0.78, 0.75), fade)
  let col: N = mix(red, white, stripe)
  // chipped paint: concrete shows through, mostly near the block ends and the edges
  const fs = fract(s.div(1.5))
  const endDist = min(fs, float(1).sub(fs)).mul(1.5)
  const chipN = mx_noise_float(vec3(s.mul(3.1), u.mul(6.0), 2.7)).mul(0.5).add(0.5)
  const chip = smoothstep(0.74, 0.8, chipN.add(float(0.2).sub(endDist).max(0)).add(abs(u.sub(0.5)).mul(0.12)))
  col = mix(col, vec3(0.24, 0.235, 0.22), chip)
  // tyre rubber where the cars ride the kerb (the dynamic track's map: the apexes and exits the field
  // uses, more as a race goes on), brushed on in strokes; some old grime on the inner edge regardless
  const n = mx_noise_float(vec3(s.mul(0.5), u.mul(3), 0)).mul(0.5).add(0.5)
  const laid = rubber
    ? smoothstep(0.1, 0.6, texture(rubber.tex, vec2(dk.add(RUBBER_HALF).div(2 * RUBBER_HALF), s.div(RUBBER_ROW).div(rubber.rows))).r).mul(tyreStrokes(s, dk, float(0), 0.04))
    : float(0)
  // and the skid marks of the cars that slid or locked up over them
  const marks = skid ? skidMarks(skid.tex, s, dk, skid.length).mul(0.85) : float(0)
  const rub = max(max(smoothstep(0.45, 0.0, u).mul(n).mul(0.3), laid.mul(0.9)), marks).clamp(0, 0.92)
  col = mix(col, vec3(RUBBER_ALBEDO, RUBBER_ALBEDO, RUBBER_ALBEDO * 1.05), rub)
  const dirt = smoothstep(0.75, 1.0, u).mul(mx_noise_float(vec3(s.mul(1.3), 5.1, 0)).mul(0.5).add(0.5))
  col = mix(col, vec3(0.07, 0.06, 0.035), dirt.mul(0.6))
  // gaps between blocks
  const gap = float(1).sub(smoothstep(0.0, 0.012, fs).mul(smoothstep(1.0, 0.988, fs)))
  col = mix(col, col.mul(0.35), gap)
  m.colorNode = col
  m.roughnessNode = mix(mix(float(0.42), float(0.78), chip), float(RUBBER_ROUGHNESS), rub)
  m.metalnessNode = float(0)
  // rumble ridges across the kerb (deeper than the physics' few millimetres, for the eye) and the
  // block gaps, as a height for the shading
  const ridge = abs(sin(s.mul(Math.PI / 0.42))).mul(0.012).add(gap.mul(-0.006))
  m.normalNode = bumpView(ridge)
  return m
}

/**
 * Grass verges and gravel traps. The lawns are mown in stripes parallel to the track (the mower runs
 * along the verge), with a worn, darker strip next to the kerbs and longer grass behind the barrier.
 */
export function vergeMaterial() {
  const tex = getTextures()
  const m = new THREE.MeshStandardNodeMaterial()
  const tr = aTrack()
  const gravelW = tr.x
  // distance past the barrier (negative inside)
  const behind = tr.z
  const pw = positionWorld
  const grass = grassColor(smoothstep(1, 6, behind).mul(0.6))
  const gtex = texture(tex.gravel.map, uv().mul(8 / 3))
  const w = smoothstep(0.3, 0.7, gravelW)
  // the grass tufts' contact shadows on the lawn are partial (sunShadow.ts); the gravel takes them in full
  setContactStrength(m, mix(float(GRASS_CONTACT), float(1), w))
  // mowing stripes: 2.5 m bands along the track, alternating light and dark (the 3D grass standing on
  // them carries the same tone, Vegetation.tsx placeGrass)
  const stripe = smoothstep(-0.3, 0.3, sin(behind.mul(Math.PI / 2.5)))
  const inside = float(1).sub(smoothstep(-0.5, 0.5, behind))
  let col: N = grass.color.mul(mix(float(1), mix(float(0.84), float(1.16), stripe), inside))
  // longer, darker grass behind the barrier
  col = mix(col, col.mul(vec3(0.82, 0.88, 0.8)), smoothstep(0, 3, behind))
  // the worn margin next to the track: a ragged strip of bare, dusty soil (cars cutting the edge,
  // the mower's wheel), then thin, dry grass before the sward closes up
  const fromIn = tr.w
  const rag = mx_noise_float(vec3(pw.x.mul(1.1), 8.1, pw.z.mul(1.1)))
    .mul(0.3)
    .add(mx_noise_float(vec3(pw.x.mul(4.7), 2.2, pw.z.mul(4.7))).mul(0.08))
  // the worn margin's width wanders from nothing to ~0.7 m (where the cars run wide most)
  const wide = smoothstep(-0.1, 0.6, mx_noise_float(vec3(pw.x.mul(0.06), 3.7, pw.z.mul(0.06)))).mul(0.45)
  const e = fromIn.add(rag).sub(wide)
  const bare = float(1).sub(smoothstep(0.02, 0.22, e)).mul(float(1).sub(w))
  const thin = float(1).sub(smoothstep(0.1, 1.3, e)).mul(float(1).sub(w))
  // tyre ruts where cars dropped two wheels off: parallel to the edge, fragments a few tens of metres
  // long, the grass flattened and worn to soil in the wheel tracks
  const rutZone = smoothstep(0.35, 0.6, mx_noise_float(vec3(pw.x.mul(0.035), 14.2, pw.z.mul(0.035))))
  const rutD = fromIn.sub(0.55).sub(mx_noise_float(vec3(pw.x.mul(0.08), 1.9, pw.z.mul(0.08))).mul(0.5))
  const rut = smoothstep(0.2, 0.06, abs(rutD)).mul(rutZone).mul(float(1).sub(w))
  const soil = mix(gtex.rgb.mul(0.55), vec3(0.085, 0.068, 0.05), 0.6).mul(mix(float(0.85), float(1.1), rag.mul(3).add(0.5).clamp(0, 1)))
  col = mix(col, mix(col.mul(vec3(1.1, 0.98, 0.72)), soil, 0.25), thin.mul(0.8))
  col = mix(col, soil, bare)
  col = mix(col, mix(col.mul(vec3(1.05, 0.95, 0.7)), soil, 0.55), rut.mul(0.85))
  m.colorNode = mix(col, gtex.rgb, w)
  const wn = max(w, max(bare, rut.mul(0.6)).mul(0.7))
  m.roughnessNode = mix(grass.rough, float(0.95), wn)
  const n = normalMap(mix(normalFromXY(grass.nxy), texture(tex.gravel.normal, uv().mul(8 / 3)).rgb, wn), vec2(0.8))
  // the sward's clumps in the lighting too (a centimetre or two of relief), fading with the footprint
  m.normalNode = swardNormal(bumpView(grass.relief.mul(float(1).sub(wn)), n), grass.graze.mul(float(1).sub(wn)))
  return m
}

/** Drier, straw-coloured patches a couple of metres across (shared with the 3D grass standing there). */
function dryTone(xz: N): N {
  // straw-coloured patches (dry grass is paler and yellower: albedo ~0.15-0.2), more of them in the
  // drier zones of the field
  const zone = smoothstep(-0.3, 0.35, mx_noise_float(vec3(xz.x.mul(0.05), 2.4, xz.y.mul(0.05))))
  const dry = smoothstep(0.12, 0.55, mx_noise_float(vec3(xz.x.mul(0.45), 6.2, xz.y.mul(0.45)))).mul(mix(float(0.45), float(1), zone))
  return mix(vec3(1), vec3(1.42, 1.2, 0.62), dry.mul(0.85))
}

/**
 * Turf detail finer than the scan can hold at a grazing view: clumps (~0.5 m) and tufts (~0.15 m) as
 * tone and relief, faded out where a pixel covers them (no aliasing), and drier, straw-coloured patches
 * a couple of metres across.
 */
function turfDetail(xz: N) {
  const fw = fwidth(xz.x).add(fwidth(xz.y))
  const c1 = mx_noise_float(vec3(xz.x.mul(2.1), 1.3, xz.y.mul(2.1)))
  const c2 = mx_noise_float(vec3(xz.x.mul(6.5), 2.9, xz.y.mul(6.5)))
  const a1 = float(1).sub(smoothstep(0.3, 1.2, fw))
  const a2 = float(1).sub(smoothstep(0.08, 0.35, fw))
  // tussocks a metre or two across, which a camera still resolves at 40 m (the finer octaves have
  // averaged away there): faded only where a pixel covers them
  const c0 = mx_noise_float(vec3(xz.x.mul(0.75), 4.1, xz.y.mul(0.75)))
  const a0 = float(1).sub(smoothstep(1.2, 4.5, fw))
  const k = float(1).add(c0.mul(0.32).mul(a0)).add(c1.mul(0.3).mul(a1)).add(c2.mul(0.22).mul(a2))
  return { tone: dryTone(xz).mul(k), relief: c0.mul(0.04).mul(a0).add(c1.mul(0.02).mul(a1)).add(c2.mul(0.006).mul(a2)) }
}

/**
 * Grass ground with the photo scan up close; far away it settles to its mean colour (a tiled scan
 * shimmers and repeats at a distance), with slow colour variation.
 */
function grassColor(leafy: N = float(0)) {
  const g = scannedGrass(positionWorld.xz, leafy)
  const n = mx_noise_float(vec3(positionWorld.x.mul(0.006), 0.5, positionWorld.z.mul(0.006))).mul(0.5).add(0.5)
  const t = turfDetail(positionWorld.xz)
  const pt = swardPatches(positionWorld.xz)
  let col: N = mix(g.col.mul(lawnTone(positionWorld.xz)).mul(t.tone).mul(pt.tint), SOIL.mul(t.tone.dot(LUM)), pt.bare.mul(0.6))
  // a sward is a canopy, not a painted plane: at a grazing view the camera looks between the blades
  // into their shadows when it faces the sun (darker, the blades' translucent edges glowing
  // yellow-green), and at sunlit blade tops with the sun behind it (the hot spot, lighter)
  const V = normalize(cameraPosition.sub(positionWorld))
  const graze = float(1).sub(V.y.clamp(0, 1)).pow(2)
  const phase = dot(V, groundSun)
  const intoShade = smoothstep(0.1, -0.85, phase).mul(graze)
  col = col.mul(mix(float(1), float(0.62), intoShade)).add(col.mul(vec3(0.28, 0.34, 0.06)).mul(intoShade))
  col = col.mul(float(1).add(smoothstep(0.4, 1, phase).mul(graze).mul(0.18)))
  const dist = length(positionWorld.sub(cameraPosition))
  const far = smoothstep(120, 900, dist)
  col = mix(col, col.mul(0.25).add(vec3(0.05, 0.065, 0.026).mul(mix(float(0.85), float(1.15), n))), far.mul(0.6))
  // living blades are waxy: a lawn seen towards the sun is clearly lighter, a silvery sheen at grazing
  // angles (the scan's roughness is the dry, matte photographed ground's)
  // (but a canopy is no flat mirror: at grazing angles into the sun the blades shadow and hide
  // each other's highlights, so the plane's Fresnel sheen must not read as frost)
  const rough = mix(g.rough.mul(0.68).max(0.5), float(0.85), intoShade.mul(0.8))
  return { color: col, rough, nxy: mix(g.nxy, vec2(0.5, 0.5), far), relief: t.relief, graze }
}

export function terrainMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  // beyond the shadow cascades, the distant forests' shadows on the ground (sunShadow.ts)
  setSunShadowTerm(m, farTreeShadow())
  // grass grows on it: the tufts' contact shadows are partial
  setContactStrength(m, GRASS_CONTACT)
  // forest floor (leaf litter in the canopy's shade) exactly where the trees stand: aTrack.y is the
  // canopy cover baked from the tree placement (scenery/forest.ts)
  const tr = aTrack()
  const cover = tr.y
  const g = grassColor(cover.mul(0.9))
  // rocky slopes on steep terrain far from the track
  const farRock = smoothstep(80, 400, tr.x)
  const rock = mx_noise_float(vec3(positionWorld.x.mul(0.05), positionWorld.y.mul(0.05), positionWorld.z.mul(0.05))).mul(0.5).add(0.5)
  const rockMask = smoothstep(0.62, 0.8, rock).mul(farRock).mul(0.7).mul(float(1).sub(cover))
  // under the canopy little skylight reaches the ground (the trees' own shadows do the sun)
  m.aoNode = mix(float(1), float(0.45), cover)
  // the lawns around the circuit are mown in wide stripes that follow the track (aTrack.x: distance
  // past the barrier), fading out into the wilder meadows further away
  const stripe = smoothstep(-0.35, 0.35, sin(tr.x.mul(Math.PI / 4.5)))
  const mown = float(1).sub(smoothstep(60, 170, tr.x)).mul(float(1).sub(cover))
  const lawn = mix(float(1), mix(float(0.86), float(1.1), stripe), mown)
  m.colorNode = mix(g.color.mul(lawn), vec3(0.16, 0.15, 0.13).mul(rock.add(0.5)), rockMask).mul(mix(float(1), float(0.7), cover))
  m.roughnessNode = max(g.rough, 0.85)
  m.normalNode = swardNormal(normalMap(normalFromXY(g.nxy), vec2(0.7)), g.graze.mul(float(1).sub(rockMask)))
  return m
}

// ------------------------------------------------------------------------------------- mountains

/**
 * The mountains (scenery/mountains.ts): conifer forest on the lower slopes up to a ragged treeline
 * (lower in the avalanche gullies), alpine meadow and scree above it, rock wherever it is steep, in
 * strata, darker down the gullies, and snow by altitude AND slope (it slides off the steep faces and
 * gathers in the couloirs and on the shaded side). Noise in world space (no projection, so no
 * stretching on cliffs) breaks the zones up and bumps the rock; the baked sun visibility lets ridges
 * shade the valleys behind them and the relief darkens the hollows' sky light.
 *
 * Aerial perspective: the air between the camera and the mountain dims it and adds the sky's own
 * horizon light (the photographic sky's, so the haze has exactly the sky's colour behind it), thicker
 * low down; the scene's fog adds the rest.
 */
export function mountainMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const mt: N = attribute('aMtn', 'vec4')
  const drain = mt.x,
    ao = mt.z
  setSunShadowTerm(m, varying(mt.y, 'vMtnSun'))
  const p = positionWorld
  const h = p.y
  const toCam = p.sub(cameraPosition)
  const dist = length(toCam)
  const nW: N = normalize(attribute('normal', 'vec3'))
  const slope = float(1).sub(nW.y)
  const n1 = mx_noise_float(p.mul(0.0045))
  const n2 = mx_noise_float(p.mul(0.021).add(vec3(3.1, 0, 1.7)))
  const near = float(1).sub(smoothstep(1800, 4200, dist))
  const n3 = mx_noise_float(p.mul(0.09).add(vec3(7.3, 2.1, 0))).mul(near)
  const det = n1.mul(0.55).add(n2.mul(0.3)).add(n3.mul(0.15))

  // zones
  const treeLine = float(690).add(n1.mul(150)).add(n2.mul(40)).sub(drain.mul(160))
  const forest = float(1).sub(smoothstep(treeLine.sub(50), treeLine.add(30), h)).mul(float(1).sub(smoothstep(0.48, 0.66, slope.add(n2.mul(0.08)))))
  const rocky = smoothstep(0.36, 0.56, slope.add(det.mul(0.14)).add(drain.mul(0.12)))
  const snowLine = float(840).add(n1.mul(120)).add(n2.mul(35)).sub(drain.mul(90))
  const snowSlope = float(1).sub(smoothstep(0.46, 0.7, slope.sub(drain.mul(0.18)).add(n3.mul(0.06))))
  const snow = smoothstep(snowLine.sub(35), snowLine.add(55), h).mul(snowSlope)

  // colours (linear albedo)
  // conifer forest seen from afar ~0.04-0.06 (crowns and their shadows), a little bluer in the gullies
  const canopy = mix(vec3(0.03, 0.043, 0.026), vec3(0.052, 0.066, 0.036), smoothstep(-0.4, 0.5, n2.add(n3.mul(0.6)))).mul(float(1).sub(drain.mul(0.25)))
  const meadow = mix(vec3(0.075, 0.085, 0.04), vec3(0.12, 0.115, 0.075), smoothstep(-0.3, 0.6, n2))
  const strata = sin(h.mul(0.085).add(n2.mul(4)).add(n1.mul(2))).mul(0.5).add(0.5)
  const rock = mix(vec3(0.13, 0.125, 0.115), vec3(0.23, 0.215, 0.195), strata.mul(0.6).add(n3.mul(0.2)).add(0.2)).mul(float(1).sub(drain.mul(0.35)))
  const scree = vec3(0.19, 0.185, 0.17).mul(n3.mul(0.15).add(0.95))
  let col: N = mix(meadow, scree, smoothstep(0.2, 0.42, slope).mul(smoothstep(treeLine, treeLine.add(150), h)))
  col = mix(col, rock, rocky)
  col = mix(col, canopy, forest)
  col = mix(col, vec3(0.74, 0.77, 0.82), snow)
  m.colorNode = col
  m.roughnessNode = mix(mix(float(0.92), float(0.8), rocky), float(0.6), snow)
  m.metalnessNode = float(0)
  m.aoNode = ao.mul(mix(float(1), float(0.8), forest))
  // rock and canopy relief below the mesh's resolution (fades out with distance)
  const relief = n2.mul(15).add(n3.mul(5)).mul(mix(float(0.4), float(1), rocky)).mul(float(1).sub(snow.mul(0.6))).mul(near.mul(0.7).add(0.3))
  m.normalNode = bumpView(relief)

  // aerial perspective (before the scene's fog): extinction and the sky's horizon light
  const dir = toCam.div(max(dist, 1))
  // aerosol + Rayleigh extinction of hazy summer air (visibility ~30 km at the valley floor), the
  // density falling with a ~1.8 km scale height along a path that climbs from the camera to the point
  const k = float(0.000105).mul(exp(max(h, 0).div(-1800)).mul(0.7).add(0.3))
  const T = exp(dist.mul(k).negate())
  const haze = photoSkyHorizon(dir).mul(vec3(0.86, 0.93, 1.06))
  m.colorNode = col.mul(T)
  m.emissiveNode = haze.mul(float(1).sub(T)).mul(0.9)
  return m
}

// ------------------------------------------------------------------------------------- barriers

/**
 * Hot-dip galvanised steel (armco, posts, the catch fence): fresh zinc is a metal whose crystals
 * ("spangle", 1-2 cm) each catch the light a little differently; with the years it dulls under a
 * grey-white patina (zinc carbonate), patchy, more of it where the rain runs. Scratches cut through
 * the patina to bright zinc.
 */
function galvanised(d: Detail, ageing: N) {
  const crystal = d.spangle
  // how far the patina has taken over here (0: fresh zinc)
  const patina = clamp(ageing.add(d.mottle.sub(0.5).mul(0.7)).add(d.streaks.sub(0.5).mul(0.35)), 0, 1)
  const bright = smoothstep(0.25, 0.7, d.scratch).mul(0.9)
  const p = patina.mul(float(1).sub(bright))
  const zinc = vec3(0.66, 0.68, 0.7).mul(mix(float(0.86), float(1.06), crystal))
  const oxide = vec3(0.5, 0.51, 0.5).mul(mix(float(0.86), float(1.08), d.mottle)).mul(mix(float(0.96), float(1.03), crystal))
  return {
    col: mix(zinc, oxide, p),
    metal: mix(float(1), float(0.3), p),
    rough: mix(mix(float(0.2), float(0.4), crystal), breakUpRoughness(0.62, d, { k: 0.15, mottle: 0.12 }), p),
  }
}

/** Sparse stretches along the lap where cars have hit or leant on a barrier (0..1), and a hue per stretch for the paint they left. */
function contactZones(s: N) {
  const z = smoothstep(0.42, 0.62, mx_noise_float(vec3(s.mul(0.045), 1.7, 0)).mul(0.5).add(0.5))
  const hue = mx_cell_noise_float(vec3(floor(s.div(9)), 2.3, 0))
  return { z, hue }
}

/** Paint transferred from the cars: red, white, blue, yellow or black, by the stretch. */
function transferPaint(hue: N) {
  return mix(mix(vec3(0.42, 0.03, 0.03), vec3(0.62, 0.62, 0.6), step(0.3, hue)), mix(vec3(0.04, 0.12, 0.42), vec3(0.62, 0.45, 0.04), step(0.75, hue)), step(0.55, hue))
}

export function armcoMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide })
  const s = uv().x,
    h = uv().y
  const d = detailAt(vec2(s, h))
  const g = galvanised(d, float(0.62))
  let col: N = g.col,
    rough: N = g.rough,
    metal: N = g.metal
  // road spray on the lower beam and the bottom of each: grey-brown film, thickest low down
  const spray = float(1).sub(smoothstep(0.25, 0.95, h)).mul(mix(float(0.45), float(1), d.streaks)).mul(0.7)
  col = mix(col, col.mul(vec3(0.62, 0.58, 0.52)), spray)
  rough = mix(rough, float(0.8), spray.mul(0.6))
  metal = mix(metal, float(0.1), spray.mul(0.5))
  // where cars touched: black rubber smeared along the beams, paint left behind, the zinc scraped bright
  const { z, hue } = contactZones(s)
  const smear = detailAt(vec2(h.mul(3.1), s.mul(0.07)).add(vec2(0.2, 0.6))).streaks
  const rubber = smoothstep(0.58, 0.82, smear).mul(z).mul(band(h, 0.35, 0.95))
  const paintT = smoothstep(0.7, 0.86, smear).mul(z).mul(step(0.5, fract(hue.mul(5.3)))).mul(band(h, 0.4, 0.9))
  const scrape = smoothstep(0.35, 0.7, d.scratch).mul(z)
  col = mix(col, vec3(0.66, 0.68, 0.7), scrape.mul(0.8))
  metal = mix(metal, float(1), scrape.mul(0.8))
  rough = mix(rough, float(0.3), scrape.mul(0.8))
  col = mix(col, transferPaint(hue), paintT.mul(0.85))
  col = mix(col, vec3(0.03, 0.03, 0.032), rubber.mul(0.9))
  metal = mix(metal, float(0), max(rubber, paintT))
  rough = mix(rough, float(0.5), max(rubber, paintT))
  m.colorNode = col
  m.metalnessNode = metal
  m.roughnessNode = rough
  // the zinc's grain and pinholes, and the dents of the hits (broad and shallow)
  const dents = z.mul(detailAt(vec2(s.mul(0.4), h.mul(0.8))).mottle.sub(0.5)).mul(0.012)
  m.normalNode = bumpView(detailHeight(d, { grain: 0.00025, pits: 0.0002 }).add(dents))
  return m
}

/** The armco's posts: galvanised steel, splashed with road dirt. */
export function postMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const d = detailTri(positionWorld, normalWorld)
  const g = galvanised(d, float(0.7))
  // (their height above the ground is not known here: the dirt by the mottle and the streaks)
  const grime = smoothstep(0.45, 0.8, d.streaks).mul(0.35)
  m.colorNode = mix(g.col, g.col.mul(vec3(0.6, 0.56, 0.5)), grime)
  m.metalnessNode = g.metal
  m.roughnessNode = mix(g.rough, float(0.8), grime)
  m.normalNode = bumpView(detailHeight(d, { grain: 0.0003, pits: 0.0002 }))
  return m
}

/**
 * Concrete wall: the precast concrete's pores and mottling, its upper half painted in 4 m red and
 * white blocks, the paint chalky and chipped (more on the edges of the blocks and where the cars
 * rub), black rubber and paint scuffs from contact, rain streaks from the top, grime splashed up from
 * the road, dust on the top face.
 */
export function concreteWallMaterial() {
  const t = getTextures().concrete
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide })
  const s = uv().x,
    h = uv().y
  const d = detailAt(vec2(s, h))
  const tex = texture(t.map, vec2(s.div(4), h.div(4)))
  const up = normalWorld.y
  const wall = float(1).sub(smoothstep(0.5, 0.8, abs(up)))
  // concrete: the canvas's mottling, pores darker, a little lighter and warmer in patches
  let conc: N = tex.rgb.mul(mix(float(0.88), float(1.08), d.mottle)).mul(float(1).sub(d.pits.mul(0.45)))
  // painted blocks on the upper part, the paint worn back at the block ends and near the base of the paint
  const blocks = mod(floor(s.div(4)), 2)
  const fs = fract(s.div(4))
  const endWear = smoothstep(0.08, 0.0, min(fs, float(1).sub(fs)))
  const painted = step(0.35, h)
  const wear = wearMask(d, float(0.12).add(endWear.mul(0.35)).add(smoothstep(0.55, 0.35, h).mul(0.25)))
  const paintCol = mix(vec3(0.5, 0.045, 0.035), vec3(0.72, 0.72, 0.7), blocks)
  // chalked (UV-faded) paint in the mottle's high spots: lighter, flatter, rougher
  const chalk = smoothstep(0.45, 0.85, d.mottle).mul(0.35)
  const paint = mix(paintCol, paintCol.add(vec3(0.12, 0.12, 0.12)).min(0.8), chalk).mul(mix(float(0.94), float(1.04), d.grain))
  const paintAmt = painted.mul(float(1).sub(wear))
  let col: N = mix(conc, paint, paintAmt)
  let rough: N = mix(breakUpRoughness(0.86, d, { k: 0.1, mottle: 0.06 }), breakUpRoughness(mix(float(0.48), float(0.7), chalk), d, { k: 0.12, scratch: 0.7, smudge: 0.5 }), paintAmt)
  // contact: rubber and paint scuffs along the lower half, scrapes through the paint
  const { z, hue } = contactZones(s)
  const smear = detailAt(vec2(h.mul(3.1), s.mul(0.07)).add(vec2(0.7, 0.1))).streaks
  const rubber = smoothstep(0.6, 0.85, smear).mul(z).mul(band(h, 0.12, 0.75))
  const paintT = smoothstep(0.72, 0.88, smear).mul(z).mul(step(0.5, fract(hue.mul(5.3)))).mul(band(h, 0.2, 0.7))
  col = mix(col, transferPaint(hue), paintT.mul(0.8))
  col = mix(col, vec3(0.03, 0.03, 0.032), rubber.mul(0.85))
  rough = mix(rough, float(0.5), max(rubber, paintT))
  // weathering: streaks down the faces, grime from the road below 0.5 m, dust on the top
  col = weathering(col, d, { wall, h, streak: 0.16, splashH: 0.5, mottle: 0.04 })
  const dd = dust(col, rough, d, up, 0.35)
  m.colorNode = dd.albedo
  m.roughnessNode = dd.rough
  m.metalnessNode = float(0)
  // pores and grain in the concrete, the paint's edge a step above it
  m.normalNode = bumpView(detailHeight(d, { grain: 0.0008, pits: 0.0018 }).mul(float(1).sub(paintAmt.mul(0.6))).add(paintAmt.mul(0.0003)))
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
  // galvanised, older and duller than the armco
  const d = detailAt(vec2(s, h))
  const g = galvanised(d, float(0.75))
  m.colorNode = g.col.mul(0.85)
  m.metalnessNode = g.metal
  m.roughnessNode = g.rough
  const frame = clamp(post.add(top), 0, 1)
  m.opacityNode = solid ? frame : clamp(wire.mul(0.55), 0, 1).mul(frame.oneMinus())
  return m
}

/**
 * Road paint (the start line's chequers): worn through to the asphalt's tone in patches, the grain of
 * the road under it, rubber from the tyres over it; the paint's own beads make it a little glossier.
 */
export function markingMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  const checker = uv().x
  const pw = positionWorld
  const d = detailAt(vec2(pw.x, pw.z), 2)
  const paint = mix(vec3(0.03, 0.03, 0.03), vec3(0.7, 0.7, 0.68), checker).mul(mix(float(0.92), float(1.05), d.grain))
  const worn = wearMask(d, 0.2)
  const asphalt = vec3(0.07, 0.07, 0.072).mul(mix(float(0.75), float(1.2), d.grain))
  const rubber = smoothstep(0.5, 0.85, d.streaks).mul(0.5)
  let col: N = mix(paint, asphalt, worn)
  col = mix(col, vec3(0.025, 0.025, 0.027), rubber)
  m.colorNode = col
  m.roughnessNode = mix(breakUpRoughness(0.5, d, { k: 0.15 }), float(0.75), worn).mul(mix(float(1), float(0.85), rubber))
  m.normalNode = bumpView(detailHeight(d, { grain: 0.0012, pits: 0.001 }).add(float(1).sub(worn).mul(0.0004)))
  return m
}

/**
 * The conveyor belt that faces a tyre wall: thick black rubber with the fabric ply's fine horizontal
 * grain, faded by the sun in patches, galvanised strips bolted through it every 1.4 m (three bolts
 * each), scuffed and marked where cars went in, and gravel dust thrown up from the trap in front,
 * thickest at its foot.
 */
export function beltMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide })
  const s = uv().x,
    h = uv().y
  const d = detailAt(vec2(s, h))
  const ply = detailAt(vec2(h.mul(14), s.mul(0.4)).add(vec2(0.3, 0.8))).streaks
  const fade = smoothstep(0.35, 0.85, d.macro.mul(0.6).add(d.mottle.mul(0.4)))
  let col: N = mix(vec3(0.028, 0.028, 0.03), vec3(0.07, 0.068, 0.066), fade).mul(mix(float(0.9), float(1.1), ply))
  let rough: N = breakUpRoughness(mix(float(0.7), float(0.86), fade), d, { k: 0.1, scratch: 0.55 })
  // the bolted strips
  const fs = fract(s.div(1.4))
  const strip = smoothstep(0.03, 0.025, abs(fs.sub(0.5)).sub(0.5).abs().mul(1.4))
  const bolts = max(max(smoothstep(0.02, 0.014, vec2(fs.sub(0.5).abs().sub(0.5).abs().mul(1.4), h.sub(0.15)).length()), smoothstep(0.02, 0.014, vec2(fs.sub(0.5).abs().sub(0.5).abs().mul(1.4), h.sub(0.4)).length())), smoothstep(0.02, 0.014, vec2(fs.sub(0.5).abs().sub(0.5).abs().mul(1.4), h.sub(0.62)).length()))
  const steel = vec3(0.45, 0.46, 0.46).mul(mix(float(0.8), float(1.05), d.spangle))
  col = mix(col, steel, max(strip, bolts).mul(0.9))
  rough = mix(rough, float(0.5), max(strip, bolts))
  const metal = max(strip, bolts).mul(0.7)
  // impacts: torn, lighter rubber, tyre and paint marks, in the contact stretches
  const { z, hue } = contactZones(s)
  const smear = detailAt(vec2(h.mul(3.1), s.mul(0.07)).add(vec2(0.5, 0.2))).streaks
  const torn = smoothstep(0.4, 0.75, d.scratch).mul(z)
  col = mix(col, col.mul(1.9).add(0.02), torn.mul(0.6))
  col = mix(col, transferPaint(hue), smoothstep(0.74, 0.88, smear).mul(z).mul(step(0.5, fract(hue.mul(5.3)))).mul(0.8))
  // gravel dust from the trap, thick at the foot, splashed higher in places
  const dustTop = float(0.25).add(d.streaks.sub(0.5).mul(0.35))
  const dusty = float(1).sub(smoothstep(float(0), dustTop, h)).mul(mix(float(0.5), float(1), d.mottle))
  col = mix(col, vec3(0.3, 0.27, 0.22), dusty.mul(0.65))
  rough = mix(rough, float(0.95), dusty.mul(0.6))
  m.colorNode = col
  m.roughnessNode = rough
  m.metalnessNode = metal
  m.normalNode = bumpView(ply.sub(0.5).mul(0.0004).add(strip.mul(0.003)).add(bolts.mul(0.006)).add(z.mul(d.mottle.sub(0.5)).mul(0.02)))
  return m
}

/**
 * Tyre walls: old tyres, the rubber faded grey by the sun (more on some than others), dust and
 * grit settled on their tops and in the treads, scuffed where they were hit.
 */
export function tyreWallMaterial() {
  const m = new THREE.MeshStandardNodeMaterial()
  const pw = positionWorld
  const d = detailTri(pw, normalWorld, 2)
  // faded per tyre (the macro field changes over metres: neighbouring tyres differ)
  const fade = smoothstep(0.3, 0.8, d.macro.mul(0.6).add(d.mottle.mul(0.4)))
  let col: N = mix(vec3(0.022, 0.022, 0.024), vec3(0.075, 0.072, 0.068), fade).mul(mix(float(0.85), float(1.12), d.grain))
  let rough: N = breakUpRoughness(mix(float(0.62), float(0.86), fade), d, { k: 0.12, scratch: 0.5 })
  const dd = dust(col, rough, d, normalWorld.y, 0.55)
  col = dd.albedo
  rough = dd.rough
  // scuffs: lighter, shinier rubber where the surface was torn
  col = mix(col, col.mul(1.6), smoothstep(0.4, 0.8, d.scratch).mul(0.6))
  m.colorNode = col
  m.roughnessNode = rough
  m.metalnessNode = float(0)
  m.normalNode = bumpView(detailHeight(d, { grain: 0.0015, pits: 0.001, scratch: 0.0006 }))
  return m
}
