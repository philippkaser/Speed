// Depth of field of a physical lens, in one gather pass (scatter-as-gather, after D. Gustafsson,
// "Bokeh depth of field in a single pass", 2018), used by the cinematic cameras only (PostFX.tsx).
//
// The circle of confusion of a point at distance z, with the lens focused at zf, is
//   c = f^2 / (N (zf - f)) * |z - zf| / z
// on the sensor (f the focal length, N the f-number); dofU.k carries it in output pixels (radius) per
// unit of |z - zf| / z. Every pixel gathers taps on a Vogel spiral out to the largest blur radius; a tap
// at radius r contributes where its own blur disc reaches the pixel (its CoC > r), so out-of-focus
// objects spread over what is around them, and a tap BEHIND the pixel may spread at most as far as the
// pixel's own blur allows (a sharp car in front of a blurred background stays crisp at its outline,
// the background does not bleed over it). The result is a disc-shaped (bokeh) blur whose highlights keep
// their energy.
import * as THREE from 'three/webgpu'
import * as tsl from 'three/tsl'

type N = any

const { Fn, float, max, min, mix, smoothstep, uniform, uniformArray, uv, vec3, vec4, Loop, select, perspectiveDepthToViewZ } = tsl as N

/** taps of the gather (a Vogel spiral; radius sqrt(i / TAPS) of the largest blur) */
const TAPS = 48
const GOLDEN = 2.39996323
const spiral = Array.from({ length: TAPS }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / TAPS)
  return new THREE.Vector2(r * Math.cos(i * GOLDEN), r * Math.sin(i * GOLDEN))
})

export const dofU = {
  /** blur radius (output pixels) per unit of |z - zf| / z */
  k: uniform(0),
  /** focus distance (m) */
  focus: uniform(10),
  /** largest blur radius (output pixels) */
  maxPx: uniform(14),
  near: uniform(0.1),
  far: uniform(12000),
  /** one output pixel in uv */
  texel: uniform(new THREE.Vector2(1 / 1920, 1 / 1080)),
}

/**
 * @param color texture node of the (linear HDR) image to blur
 * @param depth the scene pass's depth texture node
 */
export function bokehDof(color: N, depth: N): N {
  const taps = uniformArray(spiral, 'vec2')
  return Fn(() => {
    const p = uv()
    const coc = (d: N) => {
      const z = perspectiveDepthToViewZ(d, dofU.near, dofU.far).negate().max(0.01)
      return min(z.sub(dofU.focus).abs().div(z).mul(dofU.k), dofU.maxPx)
    }
    const dC = depth.sample(p).r
    const cC = coc(dC)
    const acc = vec3(color.sample(p).rgb).toVar()
    const tot = float(1).toVar()
    Loop(TAPS, ({ i }: { i: N }) => {
      const o = taps.element(i)
      const r = o.length().mul(dofU.maxPx)
      const q = p.add(o.mul(dofU.maxPx).mul(dofU.texel))
      const dS = depth.sample(q).r
      // a tap behind this pixel spreads at most as far as this pixel's own blur
      const cS = select(dS.greaterThan(dC), min(coc(dS), cC.mul(2)), coc(dS))
      const m = smoothstep(r.sub(0.5), r.add(0.5), cS)
      const s = color.sample(q).rgb
      acc.addAssign(mix(acc.div(tot), s, m))
      tot.addAssign(1)
    })
    const out = acc.div(tot)
    // never let a non-finite value through (the lens scatter would spread it over the frame)
    const ok = (x: N) => select(x.lessThan(65000), max(x, 0), float(0))
    return vec4(ok(out.x), ok(out.y), ok(out.z), 1)
  })()
}
