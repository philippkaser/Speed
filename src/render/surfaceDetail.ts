// Small imperfections for the procedural materials: the baked detail maps (scripts/build-detail-maps.ts)
// sampled in a surface's own metres, and the weathering that real surfaces carry. Every man-made
// surface in the scene builds on these: its roughness breaks up (grain, wiping, scratches), its normal
// breathes (pores, orange peel, dents, the grooves of scratches), its colour picks up mottling, rain
// streaks, splashed grime, dust on what faces up and wear where hands, tools and tyres reach.
//
// Detail maps (linear data), one tile ~ 1 m:
//   a: grain (1-30 mm), mottle (5-60 cm), scratches    b: streaks, smudges, chips    c: pits, spangle, peel
import { abs, float, max, mix, smoothstep, texture, vec2, vec3 } from 'three/tsl'
import { detailMaps } from './worldAssets'

type N = any

export interface Detail {
  /** fine grain, mean 0.5 */
  grain: N
  /** broad mottling, mean 0.5 */
  mottle: N
  /** scratches, 0 (none) .. 1 */
  scratch: N
  /** pits and pores (depth), 0 .. 1 */
  pits: N
  /** rain streaks (v up), mean 0.5 */
  streaks: N
  /** soft blots, 0 .. 1, mostly 0 */
  smudges: N
  /** the wear field: threshold it (wearMask) for more or less wear */
  chips: N
  /** galvanising crystals, a value per crystal */
  spangle: N
  /** smooth round bumps (~1.6 cm at one tile per metre): orange peel when sampled finer, mean 0.5 */
  peel: N
  /** very broad variation (a tile every ~7 m), mean 0.5 */
  macro: N
}

/**
 * The detail at a point given in a surface's own metres (`p`: vec2; v up on walls), `scale` tiles
 * per metre. The b map (streaks, smudges, chips) at half that rate, its features being larger.
 */
export function detailAt(p: N, scale = 1): Detail {
  const { a, b, c } = detailMaps()
  const A = texture(a, p.mul(scale))
  const B = texture(b, p.mul(scale * 0.5).add(vec2(0.31, 0.17)))
  const C = texture(c, p.mul(scale).add(vec2(0.67, 0.43)))
  const M = texture(a, p.mul(0.137).add(vec2(0.53, 0.29)))
  return { grain: A.r, mottle: A.g, scratch: A.b, pits: C.r, streaks: B.r, smudges: B.g, chips: B.b, spangle: C.g, peel: C.b, macro: M.g }
}

/**
 * The detail on a surface without a metric unwrap (the procedural cars): three planar samples along
 * the axes of `pos` (metres), blended by the normal `n` (same space). v is up on the side projections.
 */
export function detailTri(pos: N, n: N, scale = 1): Detail {
  const w0: N = (abs(n) as N).pow(4)
  const w: N = w0.div(w0.x.add(w0.y).add(w0.z).max(1e-4))
  const X = detailAt(vec2(pos.z, pos.y), scale)
  const Y = detailAt(vec2(pos.x, pos.z).add(vec2(0.41, 0.77)), scale)
  const Z = detailAt(vec2(pos.x, pos.y).add(vec2(0.13, 0.59)), scale)
  const blend = (k: keyof Detail) => X[k].mul(w.x).add(Y[k].mul(w.y)).add(Z[k].mul(w.z))
  return {
    grain: blend('grain'),
    mottle: blend('mottle'),
    scratch: blend('scratch'),
    pits: blend('pits'),
    streaks: blend('streaks'),
    smudges: blend('smudges'),
    chips: blend('chips'),
    spangle: blend('spangle'),
    peel: blend('peel'),
    macro: blend('macro'),
  }
}

/** Worn areas for a wear amount (0: none, ~0.3: well used, 0.6: battered), with a sharp but anti-aliased edge. */
export function wearMask(d: Detail, amount: N | number, edge = 0.025): N {
  const t = float(1).sub(amount)
  return smoothstep(t.sub(edge), t.add(edge), d.chips)
}

/**
 * Height (m) for bumpView: the surface's grain and its pits and scratches pressed in. `grain`,
 * `pits` and `scratch` are depths in metres at full value.
 */
export function detailHeight(d: Detail, o: { grain?: number; pits?: number; scratch?: number; mottle?: number }): N {
  let h: N = float(0)
  if (o.grain) h = h.add(d.grain.sub(0.5).mul(o.grain))
  if (o.mottle) h = h.add(d.mottle.sub(0.5).mul(o.mottle))
  if (o.pits) h = h.sub(d.pits.mul(o.pits))
  if (o.scratch) h = h.sub(d.scratch.mul(o.scratch))
  return h
}

/**
 * Roughness broken up as real surfaces are: the grain's spread (`k`, a fraction), polished and
 * dulled patches (the mottle), scratches rougher than the surface around them (`scratch`: their
 * roughness, blended by their weight), smudges (oily: glossier on a matte surface, duller on a glossy one).
 */
export function breakUpRoughness(rough: N | number, d: Detail, o: { k?: number; mottle?: number; scratch?: number; smudge?: number } = {}): N {
  const r0 = float(rough)
  let r: N = r0.mul(mix(float(1 - (o.k ?? 0.12)), float(1 + (o.k ?? 0.12)), d.grain))
  if (o.mottle) r = r.mul(mix(float(1 - o.mottle), float(1 + o.mottle), d.mottle))
  if (o.scratch !== undefined) r = mix(r, float(o.scratch), d.scratch.mul(0.85))
  if (o.smudge) r = mix(r, mix(r0, float(0.45), 0.6), d.smudges.mul(o.smudge))
  return r.clamp(0.03, 1)
}

/**
 * Weathering of a wall-like surface, as a factor on its albedo: broad mottling, rain streaks running
 * down (stronger on `wall` faces), and grime splashed up from the ground below `splashH` metres of
 * `h` (height above the ground), browner and ragged at its top.
 */
export function weathering(albedo: N, d: Detail, o: { wall: N; h?: N; streak?: number; splashH?: number; mottle?: number }): N {
  const streak = smoothstep(0.5, 0.85, d.streaks).mul(o.streak ?? 0.18).mul(o.wall)
  let c: N = albedo.mul(mix(float(1 - (o.mottle ?? 0.08)), float(1 + (o.mottle ?? 0.08)), d.mottle)).mul(mix(float(0.92), float(1.06), d.macro))
  c = c.mul(float(1).sub(streak))
  if (o.h !== undefined) {
    const top = float(o.splashH ?? 0.6).mul(mix(float(0.6), float(1.3), d.streaks))
    const splash = float(1).sub(smoothstep(float(0), top, o.h)).mul(o.wall)
    c = mix(c, c.mul(vec3(0.62, 0.56, 0.47)).mul(0.75), splash.mul(0.7))
  }
  return c
}

/** Dust settled on what faces up (`up`: the normal's world y), lighter and duller, thicker in the mottle's low spots. */
export function dust(albedo: N, rough: N, d: Detail, up: N, amount = 0.3) {
  const k = smoothstep(0.5, 0.95, up).mul(mix(float(0.4), float(1), d.mottle)).mul(amount)
  const dustCol = vec3(0.34, 0.31, 0.27)
  return { albedo: mix(albedo, max(albedo, dustCol), k), rough: mix(rough, float(0.9), k) }
}
