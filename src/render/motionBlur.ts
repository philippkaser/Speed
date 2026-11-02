// Camera and object motion blur as a reconstruction filter (after McGuire et al. 2012, "A
// reconstruction filter for plausible motion blur"), gathering along each pixel's own motion.
//
// three's `motionBlur` helper adds raw NDC motion vectors to UVs: the streaks come out twice as long
// as the motion and mirrored vertically (radial flow from the vanishing point is bent the wrong way),
// it sums N+1 samples over N (the image brightens), and it has no notion of depth, so a fast
// background drags the sharp car in front of it into halos. Here:
//  - motion vectors are converted to UV space (x 0.5, y -0.5), scaled to a constant shutter and
//    clamped to a maximum streak length;
//  - every tap is weighted by depth and velocity: a nearer tap only contributes if its own motion
//    reaches this pixel (a sharp foreground car never smears into the moving background behind it),
//    a farther tap contributes along this pixel's motion (fast foreground reveals what is behind it);
//  - tap positions are jittered per pixel and per frame (interleaved gradient noise), so a short
//    tap count produces fine noise instead of ghost copies.
import { Fn, If, Loop, abs, float, fract, int, max, min, mix, perspectiveDepthToViewZ, screenCoordinate, smoothstep, uniform, uv, vec2, vec4 } from 'three/tsl'

type N = any

export const motionBlurUniforms = {
  /** exposure time as a multiple of one frame's motion */
  shutter: uniform(0.5),
  near: uniform(0.1),
  far: uniform(1000),
  /** longest streak as a fraction of the image width */
  maxLength: uniform(0.05),
  frame: uniform(0),
}

const TAPS = 14

/**
 * @param color   texture node of the image to blur (output resolution)
 * @param velocity texture node with NDC motion vectors of the scene pass
 * @param depth   texture node with the scene pass depth
 */
export function reconstructMotionBlur(color: N, velocity: N, depth: N) {
  const U = motionBlurUniforms
  return Fn(() => {
    const uvC = uv()
    const size = vec2(color.size(int(0)))
    const maxLen = size.x.mul(U.maxLength)

    // motion in pixels for a tap, shutter-scaled and length-clamped
    const motionAt = (p: N) => {
      const m = velocity.sample(p).xy.mul(vec2(0.5, -0.5)).mul(U.shutter).mul(size)
      const len = m.length()
      return m.mul(min(float(1), maxLen.div(max(len, 1e-4))))
    }
    const distAt = (p: N) => perspectiveDepthToViewZ(depth.sample(p).r, U.near, U.far).negate()

    const mC = motionAt(uvC).toVar()
    const lenC = mC.length().toVar()
    const centre = color.sample(uvC)
    const result = vec4(centre).toVar()

    If(lenC.greaterThan(0.75), () => {
      const zC = distAt(uvC).toVar()
      const ext = max(float(0.25), zC.mul(0.03))
      // interleaved gradient noise, animated per frame
      const ign = fract(float(52.9829189).mul(fract(screenCoordinate.xy.dot(vec2(0.06711056, 0.00583715)))))
      const jitter = fract(ign.add(U.frame.mul(0.618034)))
      const sum = vec4(centre).toVar()
      const wsum = float(1).toVar()
      Loop(TAPS, ({ i }: { i: N }) => {
        const t = float(i).add(jitter).div(TAPS).sub(0.5)
        const p = uvC.add(mC.mul(t).div(size)).clamp(0, 1)
        const dist = abs(t).mul(lenC)
        const lenS = motionAt(p).length()
        const zS = distAt(p)
        const nearer = smoothstep(0, 1, zC.sub(zS).div(ext))
        const farther = smoothstep(0, 1, zS.sub(zC).div(ext))
        const same = float(1).sub(nearer).sub(farther).max(0)
        const coverS = float(1).sub(dist.div(max(lenS, 1e-3))).clamp(0, 1)
        const coverC = float(1).sub(dist.div(max(lenC, 1e-3))).clamp(0, 1)
        const w = nearer.mul(coverS).add(farther.mul(coverC)).add(same.mul(max(coverC, coverS)))
        sum.addAssign(color.sample(p).mul(w))
        wsum.addAssign(w)
      })
      // fade in over the first pixels of motion so the threshold is invisible
      result.assign(mix(centre, sum.div(wsum), smoothstep(0.75, 2.5, lenC)))
    })
    return result
  })()
}
