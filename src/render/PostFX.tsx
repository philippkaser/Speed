// Post-processing pipeline (TSL / RenderPipeline):
//   scene pass with MRT (colour, normals, diffuse albedo, metal/rough, velocity)
//   -> SSGI (screen-space indirect diffuse + AO)  or  GTAO
//   -> SSR (screen-space reflections, incl. dielectrics like clear coat & asphalt sheen)
//   -> SMAA (or FXAA on low)  -> per-object motion blur  -> exposure -> bloom -> lens effects
//   -> grading -> filmic tone mapping (Gran Turismo curve, see gtToneMap)
// No temporal AA: TAA reuses earlier frames, and in tracking shots (a car still on screen, the track
// sliding past) it smeared and ghosted the cars. Every frame here stands on its own.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js'
import { ssgi } from 'three/addons/tsl/display/SSGINode.js'
import { ssr } from 'three/addons/tsl/display/SSRNode.js'
import { smaa } from 'three/addons/tsl/display/SMAANode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { lensflare } from 'three/addons/tsl/display/LensflareNode.js'
import {
  diffuseColor,
  float,
  metalness,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  roughness,
  sample,
  screenUV,
  uniform,
  unpackRGBToNormal,
  vec2,
  vec3,
  vec4,
  mix,
  smoothstep,
  length,
  hash,
  time,
  int,
  convertToTexture,
  rtt,
  luminance,
  max,
  screenSize,
  Fn,
  exp,
  pow,
  step,
} from 'three/tsl'
import { useSettings } from '../state/settings'
import { reportGpuError } from './gpuHealth'
import { debugFlag } from '../util/debug'
import { motionBlur, motionBlurUniforms } from './motionBlur'
import { beginMotionFrame, motionBlendMode, motionVelocityOutput } from './motionHistory'
import { particleScene, particleU, sceneDepth } from './particles'

/** Set frames > 0 when the camera jumps (a cut): the frame it is set on is not motion blurred. */
export const cameraCut = { frames: 0 }
/** cameraCut.frames after the previous frame's countdown: a larger value means a new cut */
let lastCutFrames = 0

export const postUniforms = {
  motionBlur: uniform(0.6),
  vignette: uniform(0.2),
  exposure: uniform(1),
  grain: uniform(0.012),
  saturation: uniform(1.06),
  /** eye adaptation multiplier (auto exposure) */
  adapt: uniform(1),
  meterTap: uniform(0),
}

/**
 * Absolute exposure: an 18% grey surface in full sun lands at ~0.22 on the display (the base exposure
 * in postUniforms.exposure follows the sun's height, see Environment.tsx).
 */
const EXPOSURE = 0.85

/**
 * Filmic tone curve of Gran Turismo Sport (H. Uchimura, "HDR theory and practice", 2017), per channel:
 * a toe that keeps the shadows' contrast, an exactly linear mid section (colours and greys as lit) and
 * a shoulder that runs into pure white. Per channel, bright colours lose their saturation on the way
 * up as film does: the sun, its glints in the paint and sunlit cloud edges blind to white.
 */
export const gtToneMap = Fn(([c]: [any]) => {
  const P = 1.0, // display white
    a = 1.0, // contrast of the linear section
    m = 0.22, // start of the linear section
    l = 0.4, // its length
    cc = 1.33, // toe tightness
    b = 0.0 // black pedestal
  const l0 = ((P - m) * l) / a
  const S0 = m + l0,
    S1 = m + a * l0
  const C2 = (a * P) / (P - S1),
    CP = -C2 / P
  const x = max(c, vec3(0))
  const w0 = float(1).sub(smoothstep(0, m, x))
  const w2 = step(S0, x)
  const w1 = float(1).sub(w0).sub(w2)
  const T = pow(x.div(m), vec3(cc)).mul(m).add(b)
  const S = float(P).sub(exp(x.sub(S0).mul(CP)).mul(P - S1))
  const L = x.sub(m).mul(a).add(m)
  return T.mul(w0).add(L.mul(w1)).add(S.mul(w2))
})

/** Eye adaptation: fast adaptation relative to a slowly drifting reference (partial, like an eye). */
const eye = { fast: 0, slow: 0, ready: false, frame: 0, pending: false }

export function PostFX() {
  const { gl, scene } = useThree()
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const renderer = gl as unknown as THREE.WebGPURenderer
  const gfx = useSettings((s) => s.graphics)
  const isWebGL = !!(renderer.backend as { isWebGLBackend?: boolean })?.isWebGLBackend
  // SSGI/SSR are heavy; on the WebGL fallback keep the cheaper path
  const useSSGI = gfx.ssgi && !isWebGL
  const useSSR = gfx.ssr
  const useAO = gfx.ao && !useSSGI
  const useMB = gfx.motionBlur > 0
  const useBloom = gfx.bloom
  const useSMAA = gfx.preset !== 'low'
  const useAE = gfx.autoExposure ?? false

  const pipeline = useMemo(() => {
    const rp = new THREE.RenderPipeline(renderer)
    const scenePass = pass(scene, camera)
    // G-buffer layout. WebGPU's default limit is 32 bytes of colour attachments per sample and every
    // RGBA8 / RGBA16F target counts as 8, so at most four targets: roughness rides in the normal
    // target's alpha and metalness in the albedo target's alpha (or a target of its own without SSGI).
    const outputs: Record<string, any> = { output }
    // velocity: NDC motion per frame, wheel slot, inverse depth of the surface that owns the motion
    if (useMB) outputs.velocity = motionVelocityOutput
    if (useSSGI || useSSR || useAO) outputs.normal = vec4(packNormalToRGB(normalView), useSSR ? roughness : float(1))
    if (useSSGI) outputs.diffuseColor = vec4(diffuseColor.rgb, useSSR ? metalness : float(0))
    else if (useSSR) outputs.metal = vec4(metalness, 0, 0, 1)
    // test switch: an over-budget G-buffer that WebGPU refuses, to exercise the WebGL2 fallback
    if (debugFlag('gpufail') && !isWebGL) for (let i = 0; i < 8; i++) outputs['fail' + i] = vec4(1)
    const mrtNode = mrt(outputs)
    if (outputs.velocity) {
      // transparent surfaces keep the motion of what is behind them; nothing drawn = infinitely far
      mrtNode.setBlendMode('velocity', motionBlendMode)
      mrtNode.setClearColor('velocity', 0x000000, 0)
    }
    scenePass.setMRT(mrtNode)
    if (outputs.fail0) for (let i = 0; i < 8; i++) scenePass.getTexture('fail' + i)
    const color = scenePass.getTextureNode('output')
    const depth = scenePass.getTextureNode('depth')
    for (const k of ['normal', 'diffuseColor', 'metal']) if (outputs[k]) scenePass.getTexture(k).type = THREE.UnsignedByteType
    const normalTex = outputs.normal ? scenePass.getTextureNode('normal') : null
    const sceneNormal = normalTex ? sample((uv) => unpackRGBToNormal(normalTex.sample(uv).xyz)) : null
    const vel = outputs.velocity ? scenePass.getTextureNode('velocity') : null
    if (vel) {
      // carries integer wheel slots: never filtered
      const vt = scenePass.getTexture('velocity')
      vt.minFilter = vt.magFilter = THREE.NearestFilter
    }

    let composite: any = color
    if (useSSGI && sceneNormal) {
      const gi = ssgi(color, depth, sceneNormal, camera)
      // three's presets for SSGI without temporal filtering (nothing accumulates its noise over frames)
      gi.sliceCount.value = gfx.preset === 'ultra' ? 4 : 3
      gi.stepCount.value = gfx.preset === 'ultra' ? 12 : 8
      gi.radius.value = 6
      gi.giIntensity.value = 6
      gi.aoIntensity.value = 1.15
      gi.thickness.value = 0.8
      gi.useTemporalFiltering = false
      const diffuse = scenePass.getTextureNode('diffuseColor')
      composite = vec4(color.rgb.mul(gi.getAONode()).add(diffuse.rgb.mul(gi.getGINode().rgb)), color.a)
    } else if (useAO && sceneNormal) {
      const a = gtao(depth, sceneNormal, camera)
      a.radius.value = 1.2
      a.resolutionScale = 0.5
      composite = vec4(color.rgb.mul(a.getTextureNode().r), color.a)
    }
    if (useSSR && sceneNormal) {
      const metalNode = useSSGI ? scenePass.getTextureNode('diffuseColor').a : scenePass.getTextureNode('metal').r
      const r = ssr(convertToTexture(composite), depth, sceneNormal, { metalnessNode: metalNode, roughnessNode: normalTex!.a, camera, reflectNonMetals: true })
      r.maxDistance.value = 60
      r.thickness.value = 0.35
      r.quality.value = gfx.preset === 'ultra' ? 0.6 : 0.4
      r.resolutionScale = gfx.preset === 'ultra' ? 1 : 0.5
      composite = vec4(composite.rgb.add(r.rgb), color.a)
    }
    let out: any = composite
    let blurDebug: any = null
    // luminance meter for auto exposure: tiny render target, read back asynchronously on the CPU
    let meter: any = null
    if (useAE) {
      meter = rtt(vec4(luminance(composite.rgb).max(1e-4).log(), 0, 0, 1), 48, 27, { type: THREE.FloatType })
      // keep the meter in the graph (its contribution is scaled by a zero uniform)
      composite = vec4(composite.rgb.add(meter.sample(vec2(0.5, 0.5)).r.mul(postUniforms.meterTap)), composite.a)
    }
    out = useSMAA ? smaa(composite) : fxaa(composite)
    if (useMB && vel) {
      const q = gfx.preset === 'ultra' ? { pairs: 16, denseTaps: 64 } : gfx.preset === 'high' ? { pairs: 12, denseTaps: 48 } : { pairs: 8, denseTaps: 32 }
      const src = typeof out.getTextureNode === 'function' ? out.getTextureNode() : convertToTexture(out)
      const node = motionBlur(src, vel, { ...q, wheels: true })
      out = node.getTextureNode()
      if (debugFlag('showtiles')) blurDebug = node.getTileDebugNode()
      else if (debugFlag('showvel')) blurDebug = node.getStreakDebugNode()
    }
    // particles (smoke, dust, sparks): own pass, soft against the scene depth, composited over the
    // lit image (premultiplied colour, transmittance in alpha). After anti-aliasing and motion blur, so they
    // neither ghost nor pick up the scene's motion vectors.
    sceneDepth.value = scenePass.getTexture('depth')
    particleU.soft.value = 1
    const particlePass = pass(particleScene, camera)
    particlePass.setResolutionScale(gfx.preset === 'high' || gfx.preset === 'ultra' ? 0.75 : 0.5)
    const parts = particlePass.getTextureNode('output')
    out = vec4(out.rgb.mul(parts.a).add(parts.rgb), 1)
    // exposure before the bloom: its threshold is in display terms (1 = the curve's white). Only what
    // is several times brighter than white glows: the sun, its glints, sunlit cloud edges, lamps
    out = vec4(out.rgb.mul(postUniforms.exposure).mul(postUniforms.adapt).mul(EXPOSURE), 1)
    if (useBloom) {
      const b = bloom(out, 0.2, 0.55, 1.6)
      out = vec4(out.rgb.add(b.rgb), 1)
      // anamorphic-free lens ghosts from the brightest highlights (low sun, headlights)
      if (gfx.preset === 'high' || gfx.preset === 'ultra') {
        const flare = lensflare(b, { ghostTint: vec3(1.0, 0.93, 0.82), threshold: float(0.85), ghostSamples: float(4), ghostSpacing: float(0.28), ghostAttenuationFactor: float(22) })
        out = vec4(out.rgb.add((flare as any).rgb.mul(0.35)), 1)
      }
    }
    // grading: saturation, vignette, fine grain (before tone mapping, applied in linear HDR)
    const lum = out.rgb.dot(vec3(0.2126, 0.7152, 0.0722))
    let graded = mix(vec3(lum), out.rgb, postUniforms.saturation)
    const vig = smoothstep(0.35, 1.1, length(screenUV.sub(0.5)).mul(1.4))
    graded = graded.mul(float(1).sub(vig.mul(postUniforms.vignette)))
    const n = hash(screenUV.mul(vec2(1931.3, 2711.7)).add(time.mul(37.1)).x.add(screenUV.y.mul(911.1)))
    graded = graded.mul(float(1).add(n.sub(0.5).mul(postUniforms.grain)))
    rp.outputNode = vec4(gtToneMap(graded), 1)
    // debug views: ?showvel (the streaks the blur uses), ?showtiles (its neighbour-max tiles)
    if (blurDebug) {
      rp.outputNode = blurDebug
      rp.outputColorTransform = false
    }
    ;(rp as any).__meter = meter
    return rp
  }, [renderer, scene, camera, useSSGI, useSSR, useAO, useSMAA, useMB, useBloom, gfx.preset, useAE])

  useEffect(() => () => pipeline.dispose(), [pipeline])

  useFrame((_, dt) => {
    // a cut is the frame cameraCut was (re)armed on; the following frames are an ordinary shot
    const cut = cameraCut.frames > lastCutFrames
    if (cameraCut.frames > 0) cameraCut.frames--
    lastCutFrames = cameraCut.frames
    // shutter angle: the share of each frame's own interval the shutter is open (motion vectors span
    // one frame). At 360 degrees every streak ends where the next frame's begins, so motion is
    // continuous from frame to frame at any frame rate; anything shorter leaves gaps that the eye
    // sees as separate copies (strobing) in fast pans.
    const frameDt = Math.max(dt, 1e-3)
    // a cut frame has no motion at all: nothing in the new shot has a previous frame to have moved
    // from. (Keeping only the objects' motion would be wrong too: a car the camera follows moves
    // fast through the world, so with the camera's motion gone it smeared into copies.)
    const shutter = cut ? 0 : Math.min(1, Math.max(0, gfx.motionBlur))
    postUniforms.motionBlur.value = shutter
    const mb = motionBlurUniforms
    mb.shutter.value = shutter
    mb.frame.value = (mb.frame.value + 1) % 1024
    particleU.near.value = camera.near
    particleU.far.value = camera.far
    // a cut drops the camera's motion for that frame; objects keep theirs
    beginMotionFrame(scene, camera, { cut, exposure: shutter * frameDt, dt: frameDt })
    if ((pipeline as any).__broken) {
      renderer.render(scene, camera)
      return
    }
    try {
      pipeline.render()
    } catch (e) {
      // never leave the screen black: drop to a plain render and report it
      ;(pipeline as any).__broken = true
      console.error(e)
      reportGpuError('Post-processing failed: ' + (e as Error)?.message)
      renderer.render(scene, camera)
      return
    }
    const meter = (pipeline as any).__meter
    if (meter && !eye.pending && eye.frame++ % 6 === 0) {
      eye.pending = true
      renderer
        .readRenderTargetPixelsAsync(meter.renderTarget, 0, 0, 48, 27)
        .then((px: ArrayLike<number>) => {
          let sum = 0,
            n = 0
          for (let i = 0; i < px.length; i += 4) {
            const v = px[i]
            if (Number.isFinite(v)) {
              sum += v
              n++
            }
          }
          if (n) {
            const logAvg = sum / n
            if (!eye.ready) {
              eye.fast = eye.slow = logAvg
              eye.ready = true
            }
            eye.fast = logAvg
          }
        })
        .catch(() => {})
        .finally(() => (eye.pending = false))
    }
    if (meter && eye.ready) {
      // reference drifts over ~40 s; the eye opens faster (darker scene) than it closes
      eye.slow += (eye.fast - eye.slow) * Math.min(1, dt / 40)
      const target = Math.exp(Math.max(-0.55, Math.min(0.5, (eye.slow - eye.fast) * 0.6)))
      const rate = target > postUniforms.adapt.value ? 1.4 : 3.5
      postUniforms.adapt.value += (target - postUniforms.adapt.value) * Math.min(1, dt * rate)
    } else postUniforms.adapt.value = 1
  }, 1)
  return null
}
