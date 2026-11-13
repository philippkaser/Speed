// The sensor and the picture: from the light the lens delivers to the values on the display.
//
//  - Sensor noise: photon shot noise (variance proportional to the signal) plus a little read noise
//    (constant), new every frame, mostly in luminance (as a camera's processing leaves it). It is a
//    few percent of the signal in the mid-tones, more in the shadows, nothing in the highlights; at
//    this level it reads as the fine texture of a real image, not as an overlay.
//
//  - The picture (display rendering): what a camera's processing does between the sensor and the file.
//    A filmic tone curve applied per channel inside an inset gamut (the approach of Troy Sobotka's
//    AgX, here with our own curve). Per-channel curves alone skew bright saturated colours towards the
//    secondaries (red -> orange -> yellow, blue -> purple: the "notorious six") and luminance-based
//    ones turn them pastel abruptly or clip them; in the inset gamut every channel carries a little of
//    the others, so a bright colour keeps its hue, desaturates smoothly and only the brightest light
//    reaches white, the way an over-exposed colour does on film or a sensor. The outset afterwards (in
//    the encoded domain, as AgX does) restores the saturation of everything below the highlights.
//
//    Nothing is added on top: no saturation boost, and a contrast inside the range of cameras'
//    standard renderings. More than that is what makes a rendered frame read as a game: shadows go to
//    black, sunlit colours run into the gamut's edge and clip to pure primaries.
//
//    The curve: y = (1 + (k / x)^(c d))^(-1 / d), a log-logistic sigmoid. c is the contrast of the
//    shadows and mid-tones (log-log slope), d the sharpness of the shoulder. It is anchored so the
//    exposed asphalt in the sun (KEY_IN) lands at KEY_OUT of display white.
//
//    What is still outside the display's gamut after that (the purest colours, a little) is brought in
//    towards its own grey, hue and luminance kept, instead of clipping each channel separately.
//
//  - Encoding: the sRGB curve, then triangular dither of one code value, so gradients (the sky, the
//    glare's halo) show no 8-bit banding.
import * as tsl from 'three/tsl'

type N = any

const { Fn, float, hash, max, min, mix, pow, screenCoordinate, step, uint, uniform, vec3 } = tsl as N

/** Tone curve: contrast, shoulder sharpness, and its anchor (exposed value -> display-linear value). */
// Contrast 1.5: between a still camera's standard rendering (~1.3-1.4) and a cinema camera's display
// LUT or ACES (~1.55). A hard shadow on asphalt (2.5 stops under the sunlit asphalt that anchors the
// key) lands 3.75 stops below it on the display: deep, with its detail (sRGB ~20-25 of 255 with the
// lens's flare), where 1.95 put it at black. A grey card lands at half of the sRGB range.
// Shoulder 1.2: a sunlit white panel (1.2 exposed) at 0.84 of display white (sRGB 235) and sunlit paint
// (0.8) at 0.71, clouds a little under white with their shading; 4 -> 0.98, white only stops above that.
export const CURVE = { contrast: 1.5, shoulder: 1.2, keyIn: 0.13, keyOut: 0.11 }
/** Saturation of the picture (1 = as the inset gamut renders it), applied to the scene-linear colour. */
export const SATURATION = 1

export const sensorU = {
  /** relative noise at the key (shot noise; 0 = none) */
  noise: uniform(0.02),
  frame: uniform(0),
  /** HDR output: the display's peak over its paper white (1 = SDR) */
  hdrPeak: uniform(1),
}

/**
 * HDR output (an extended-range rgba16float canvas, Settings -> HDR): the same picture, its tone
 * curve re-targeted to the display's peak. Shadows and mid-tones land exactly where the SDR picture
 * puts them relative to paper white (sunlit asphalt at the same brightness); only the shoulder opens
 * up, so highlights (the sun, glints on the clear coat, sunlit clouds) keep their colour and detail
 * up to `peak` times paper white instead of rolling into white. Values above 1 are brighter than SDR
 * white, encoded with the extended sRGB curve (sign-preserving), as the canvas expects.
 */
export const hdrState = { active: false, peakNits: 1000, paperWhiteNits: 203 }

/** The key that the sensor noise is relative to (exposed units, ~ sunlit asphalt). */
const NOISE_KEY = 0.15

const row = (m: number[], i: number) => vec3(m[i * 3], m[i * 3 + 1], m[i * 3 + 2])
const mul3 = (m: number[], v: N) => vec3(row(m, 0).dot(v), row(m, 1).dot(v), row(m, 2).dot(v))

// linear Rec.709 -> Rec.2020 -> AgX inset (one matrix); AgX outset (exact inverse of the inset); Rec.2020 -> Rec.709
/**
 * How far the inset/outset gamut goes (1 = AgX's full inset). Less than 1 keeps bright colours purer
 * and nearer the gamut's edge (0.8: a sunlit red car's red channel sat at the display's limit with the
 * other two near zero, a flat plastic red).
 */
const INSET = 1
function towardIdentity(m: number[], t = INSET) {
  return m.map((v, i) => (i % 4 === 0 ? 1 : 0) + (v - (i % 4 === 0 ? 1 : 0)) * t)
}

const PRE = towardIdentity([0.5448148158838267, 0.3737864660846888, 0.08139819451206926, 0.14041675882690663, 0.7541371002874192, 0.10544469543469456, 0.0888105397580592, 0.17887152236561357, 0.7323175926176142])
const OUTSET = towardIdentity([1.1974410768877046, -0.1442615126980006, -0.05317956418970419, -0.19647462632134563, 1.3540951314697305, -0.15762050514838483, -0.14655741710660064, -0.10828405878846943, 1.254841475895071])
const POST = towardIdentity([1.660490295800891, -0.5876391057500187, -0.07285159817546362, -0.1245499700689642, 1.1328999220134244, -0.008347964214181441, -0.018151118872901384, -0.10057872392134827, 1.1187298782380746])

/** The tone curve on plain numbers (tests, calibration). */
export function toneCurve(x: number, c = CURVE) {
  const cd = c.contrast * c.shoulder
  const k = c.keyIn * (c.keyOut ** -c.shoulder - 1) ** (1 / cd)
  return (1 + (k / Math.max(x, 1e-6)) ** cd) ** (-1 / c.shoulder)
}

const curveNode = (x: N) => {
  const c = CURVE
  const cd = c.contrast * c.shoulder
  const k = c.keyIn * (c.keyOut ** -c.shoulder - 1) ** (1 / cd)
  const u = pow(max(x, vec3(1e-6)).div(k), vec3(-cd))
  return pow(u.add(1), vec3(-1 / c.shoulder))
}

/**
 * The tone curve with its asymptote at P (HDR): y = P (1 + (k_P / x)^(c d))^(-1 / d), k_P chosen so
 * the key still lands at keyOut. P = 1 is the SDR curve exactly.
 */
const curveNodeHDR = (x: N, P: N) => {
  const c = CURVE
  const cd = c.contrast * c.shoulder
  const kP = pow(pow(float(c.keyOut).div(P), float(-c.shoulder)).sub(1), float(1 / cd)).mul(c.keyIn)
  const u = pow(max(x, vec3(1e-6)).div(kP), vec3(-cd))
  return pow(u.add(1), vec3(-1 / c.shoulder)).mul(P)
}

/** The HDR tone curve on plain numbers (asymptote P times paper white; P = 1 is toneCurve). */
export function toneCurveHDR(x: number, P: number, c = CURVE) {
  const cd = c.contrast * c.shoulder
  const k = c.keyIn * ((c.keyOut / P) ** -c.shoulder - 1) ** (1 / cd)
  return P * (1 + (k / Math.max(x, 1e-6)) ** cd) ** (-1 / c.shoulder)
}

const mul3n = (m: number[], v: number[]) => [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2])

/** displayTransform on plain numbers (tests, calibration): the same steps as the shader. */
export function pictureRGB(rgb: [number, number, number]): [number, number, number] {
  const L = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  const sat = rgb.map((x) => Math.max(0, L + (x - L) * SATURATION))
  const inset = mul3n(PRE, sat).map((x) => Math.max(0, x))
  const e = mul3n(
    OUTSET,
    inset.map((x) => toneCurve(x) ** (1 / 2.2)),
  )
  const out = mul3n(
    POST,
    e.map((x) => Math.max(0, x) ** 2.2),
  )
  // into the display's gamut towards the colour's own grey (as fitGamut below)
  const Lo = Math.min(1, Math.max(0, 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2]))
  const mn = Math.min(...out),
    mx = Math.max(...out)
  const t = Math.min(1, Math.max(0, Math.min(Lo / Math.max(Lo - mn, 1e-6), (1 - Lo) / Math.max(mx - Lo, 1e-6))))
  return out.map((x) => Math.min(1, Math.max(0, Lo + (x - Lo) * t))) as [number, number, number]
}

/**
 * A display-linear colour brought inside [0, 1]: scaled towards its own grey just far enough that no
 * channel is below 0 or above 1. Hue and luminance stay; a per-channel clip shifts both.
 */
const fitGamut = (c: N) => {
  const L = min(max(c.dot(vec3(0.2126, 0.7152, 0.0722)), float(0)), float(1))
  const mn = min(min(c.x, c.y), c.z)
  const mx = max(max(c.x, c.y), c.z)
  const t = min(L.div(max(L.sub(mn), float(1e-6))), float(1).sub(L).div(max(mx.sub(L), float(1e-6))))
  return min(max(mix(vec3(L), c, min(max(t, float(0)), float(1))), vec3(0)), vec3(1))
}

/** Scene-linear exposed Rec.709 -> display-linear Rec.709 in [0, 1]. */
export const displayTransform = Fn(([rgb]: [N]) => {
  const L = rgb.dot(vec3(0.2126, 0.7152, 0.0722))
  const sat = max(mix(vec3(L), rgb, SATURATION), vec3(0))
  const inset = max(mul3(PRE, sat), vec3(0))
  const y = curveNode(inset)
  const e = mul3(OUTSET, pow(y, vec3(1 / 2.2)))
  const lin = pow(max(e, vec3(0)), vec3(2.2))
  return fitGamut(mul3(POST, lin))
})

/**
 * HDR: scene-linear exposed Rec.709 -> display-linear Rec.709 in [0, peak] (1 = paper white). The
 * inset/outset run on the curve normalised to [0, 1], so colours desaturate towards the HDR peak the
 * way the SDR picture does towards white.
 */
export const displayTransformHDR = Fn(([rgb]: [N]) => {
  const P = max(sensorU.hdrPeak, float(1))
  const L = rgb.dot(vec3(0.2126, 0.7152, 0.0722))
  const sat = max(mix(vec3(L), rgb, SATURATION), vec3(0))
  const inset = max(mul3(PRE, sat), vec3(0))
  const y = curveNodeHDR(inset, P).div(P)
  const e = mul3(OUTSET, pow(y, vec3(1 / 2.2)))
  const lin = pow(max(e, vec3(0)), vec3(2.2))
  return fitGamut(mul3(POST, lin)).mul(P)
})

/** Display-linear [0, peak] -> extended sRGB code values (the HDR canvas), with dither. */
export function encodeDisplayHDR(y: N): N {
  return Fn(() => {
    const c = max(y, vec3(0))
    const lo = c.mul(12.92)
    const hi = pow(c, vec3(1 / 2.4)).mul(1.055).sub(0.055)
    const e = mix(hi, lo, step(c, vec3(0.0031308)))
    const r = rand3()
    // half floats have ~11 bits of mantissa: a quarter of an 8-bit step hides any banding
    const d = r.x.add(r.y).sub(1).div(1020)
    return max(e.add(d), vec3(0))
  })()
}

/** Three independent uniform random numbers per pixel and frame. */
const rand3 = () => {
  const p = screenCoordinate
  const seed = uint(p.x).add(uint(p.y).mul(uint(4099))).add(uint(sensorU.frame).mul(uint(1103515245)))
  return vec3(hash(seed), hash(seed.add(uint(0x68e31da4))), hash(seed.add(uint(0x1b873593))))
}

/** Sensor noise on the exposed signal (before the picture rendering). */
export function sensorNoise(rgb: N): N {
  return Fn(() => {
    const r = rand3()
    // ~Gaussian (sum of three uniforms, unit variance): luminance noise and a little chroma
    const gl = r.x.add(r.y).add(r.z).sub(1.5).mul(2)
    const chroma = vec3(r.x, r.y, r.z).sub(0.5).mul(Math.sqrt(12) * 0.35)
    const n = vec3(gl).add(chroma)
    const x = max(rgb, vec3(0))
    // shot noise (variance ~ signal) + read noise; relative noise = sensorU.noise at the key
    const sigma = pow(x.mul(NOISE_KEY).add(0.002 * NOISE_KEY * NOISE_KEY), vec3(0.5)).mul(sensorU.noise)
    return max(x.add(n.mul(sigma)), vec3(0))
  })()
}

/** Display-linear -> sRGB code values with triangular dither of one 8-bit step. */
export function encodeDisplay(y: N): N {
  return Fn(() => {
    const c = min(max(y, vec3(0)), vec3(1))
    const lo = c.mul(12.92)
    const hi = pow(c, vec3(1 / 2.4)).mul(1.055).sub(0.055)
    // per channel: the linear segment below 0.0031308 (step: 1 where c <= the edge)
    const e = mix(hi, lo, step(c, vec3(0.0031308)))
    const r = rand3()
    const d = r.x.add(r.y).sub(1).div(255)
    return min(max(e.add(d), vec3(0)), vec3(1))
  })()
}

