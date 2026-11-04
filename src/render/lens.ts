// The camera's lens: what a real camera adds between the scene and the sensor.
//
//  - Lens scatter (bloom): every lens spreads a small share of all the light it passes over a wide,
//    long-tailed point-spread function (scattering in the glass and coatings, reflections inside the
//    barrel). There is no threshold in that: a sunlit kerb gets the same few percent as the sun, but
//    only something hundreds of times brighter than white makes a visible halo. Energy is conserved
//    (the scattered share is taken from the image). PostFX does it with three's mip-chain bloom.
//  - Aperture glare (starburst): diffraction at the edges of the aperture's blades turns very bright
//    points (the sun, its glints in paint, chrome and glass) into spikes, two per pair of parallel
//    blade edges: a six-bladed iris gives a six-pointed star. A bright pass at quarter resolution
//    keeps only what is well beyond white; it is streaked along the three axes, the spikes fading
//    exponentially with a faint diffraction colour.
//  - Lens flare ghosts: reflections between the lens elements, fed from the same bright pass so only
//    real light sources ghost (not the bright sky).
//  - Lateral chromatic aberration: the lens focuses red slightly further out than blue, growing with
//    the square of the distance from the centre.
//  - Natural vignetting: the cos^4 law of the off-axis angle (taken from the lens's real field of
//    view, so a TV camera's long lens barely darkens its corners and a wide chase camera does),
//    partly corrected as real lenses are.
import * as THREE from 'three/webgpu'
import { cos, exp, float, Fn, length, max, mix, rtt, sin, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'

type N = any

export const lensU = {
  /** tan of half the vertical field of view */
  tanHalfFov: uniform(Math.tan((58 * Math.PI) / 360)),
  aspect: uniform(16 / 9),
  /** quarter-resolution texel (uv) for the starburst */
  texel: uniform(new THREE.Vector2(4 / 1920, 4 / 1080)),
}

/** Share of the light the lens scatters into its wide halo (bloom). */
export const SCATTER = 0.07
/** Bright-pass threshold of the glare and ghosts, in display terms (1 = the tone curve's white). */
export const GLARE_THRESHOLD = 3
/** How much of what passes the threshold ends up in the starburst's spikes. */
const STAR_GAIN = 0.5
/** Iris blades (six: three spike axes) and their orientation. */
const STAR_AXES = 3
const STAR_ROTATION = 0.31
const STAR_TAPS = 20
const STAR_STEP = 1.5

/**
 * Bright pass at quarter resolution: what lies beyond GLARE_THRESHOLD, keeping its colour. Thresholded
 * per tap before averaging, so a one-pixel glint is not averaged away.
 */
export function brightPass(exposed: N) {
  const node = Fn(() => {
    const p = uv()
    const t = lensU.texel.mul(0.25)
    const acc = vec3(0).toVar()
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const c = exposed.sample(p.add(t.mul(vec2(dx, dy)))).rgb
      const l = max(c.dot(vec3(0.2126, 0.7152, 0.0722)), 1e-4)
      acc.addAssign(c.mul(max(l.sub(GLARE_THRESHOLD), 0).div(l)))
    }
    return vec4(acc.mul(0.25), 1)
  })()
  return rtt(node, null, null, { type: THREE.HalfFloatType, resolutionScale: 0.25 })
}

/** Six-pointed diffraction star of the bright pass (quarter resolution). */
export function starburst(bright: N) {
  const node = Fn(() => {
    const p = uv()
    const acc = vec3(0).toVar()
    let wsum = 0
    for (let a = 0; a < STAR_AXES; a++) {
      const ang = STAR_ROTATION + (a * Math.PI) / STAR_AXES
      const dir = vec2(Math.cos(ang), Math.sin(ang)).mul(lensU.texel).mul(STAR_STEP)
      for (let k = 1; k <= STAR_TAPS; k++) {
        const w = Math.exp((-k * 4) / STAR_TAPS)
        // diffraction colour: the fringes drift through the spectrum along the spike
        const tint = vec3(1).add(vec3(sin(float(k * 0.9)), sin(float(k * 0.9 + 2.1)), sin(float(k * 0.9 + 4.2))).mul(0.12))
        const s = bright.sample(p.add(dir.mul(k))).rgb.add(bright.sample(p.sub(dir.mul(k))).rgb)
        acc.addAssign(s.mul(tint).mul(w))
        wsum += 2 * w
      }
    }
    return vec4(acc.mul(STAR_GAIN / wsum), 1)
  })()
  return rtt(node, null, null, { type: THREE.HalfFloatType, resolutionScale: 0.25 })
}

/** Lateral chromatic aberration: red and blue sampled at slightly different radii. */
export function lateralCA(exposed: N, strength = 0.0035): N {
  const p = uv()
  const d = p.sub(0.5)
  const r2 = d.mul(vec2(lensU.aspect, 1)).dot(d.mul(vec2(lensU.aspect, 1))).div(lensU.aspect.mul(lensU.aspect).add(1).mul(0.25))
  const k = r2.mul(strength)
  const r = exposed.sample(d.mul(float(1).add(k)).add(0.5)).r
  const g = exposed.sample(p).g
  const b = exposed.sample(d.mul(float(1).sub(k)).add(0.5)).b
  return vec3(r, g, b)
}

/** Natural vignetting: cos^4 of the off-axis angle, `amount` of it (real lenses correct the rest). */
export function naturalVignette(amount: N = 0.4): N {
  const d = uv().sub(0.5).mul(2)
  const tanTheta = length(d.mul(vec2(lensU.aspect, 1)).mul(lensU.tanHalfFov))
  const c2 = float(1).div(tanTheta.mul(tanTheta).add(1))
  return mix(float(1), c2.mul(c2), amount)
}

/** Keeps the lens uniforms in step with the camera and the drawing buffer. */
export function updateLens(camera: THREE.Camera, width: number, height: number) {
  const pc = camera as THREE.PerspectiveCamera
  if (pc.isPerspectiveCamera) lensU.tanHalfFov.value = Math.tan((pc.fov * Math.PI) / 360) / pc.zoom
  lensU.aspect.value = width / Math.max(1, height)
  lensU.texel.value.set(4 / Math.max(1, width), 4 / Math.max(1, height))
}

void cos
void exp
