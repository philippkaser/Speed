// Robust contrast-adaptive sharpening (AMD FidelityFX FSR 1 "RCAS", Lottes 2021), after the temporal
// upscaler and the tone curve. TAA averages every pixel over many frames with a reconstruction
// filter, which softens the finest detail (asphalt grain, decals, the edges of distant cars); RCAS
// restores it with a negative-lobe 5-tap filter whose strength is limited per pixel so that it can
// neither ring nor clip: the lobe is the largest that keeps the result inside the neighbourhood's
// range. It works on display-referred values, where its limits are perceptually even.
import * as tsl from 'three/tsl'

type N = any

const { Fn, ivec2, int, max, min, clamp, float, uniform, vec2, vec3, floor, uv } = tsl as N

export const sharpenU = {
  /** 0 = off, 1 = the strongest RCAS allows (FSR's "0 stops") */
  amount: uniform(0.6),
}

/** FSR's limit on the negative lobe (keeps the filter from ringing). */
const RCAS_LIMIT = 0.25 - 1 / 16

/**
 * @param tex texture node of the display-linear image in [0, 1]
 */
export function rcas(tex: N): N {
  return Fn(() => {
    const size = ivec2(tex.size(int(0)))
    const ip = ivec2(floor(uv().mul(vec2(size))))
    const maxI = ivec2(size.x.sub(1), size.y.sub(1))
    const at = (dx: number, dy: number) => tex.load(clamp(ip.add(ivec2(dx, dy)), ivec2(0), maxI)).rgb
    const b = at(0, -1)
    const d = at(-1, 0)
    const e = at(0, 0)
    const f = at(1, 0)
    const h = at(0, 1)
    const mn4 = min(min(b, d), min(f, h))
    const mx4 = max(max(b, d), max(f, h))
    // the largest negative lobe that keeps every channel inside [min, max] of the neighbourhood
    const hitMin = min(mn4, e).div(mx4.mul(4).add(1e-5))
    const hitMax = vec3(1).sub(mx4).div(mn4.mul(4).sub(4).sub(1e-5))
    const lobeRGB = max(hitMin.negate(), hitMax)
    const lobe = max(float(-RCAS_LIMIT), min(max(max(lobeRGB.x, lobeRGB.y), lobeRGB.z), float(0))).mul(sharpenU.amount)
    const rcpL = float(1).div(lobe.mul(4).add(1))
    return clamp(b.add(d).add(f).add(h).mul(lobe).add(e).mul(rcpL), vec3(0), vec3(1))
  })()
}
