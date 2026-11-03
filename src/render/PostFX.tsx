// Post-processing pipeline (TSL / RenderPipeline):
//   scene pass with MRT (colour, normals, diffuse albedo, metal/rough, velocity)
//   -> SSGI (screen-space indirect diffuse + AO)  or  GTAO
//   -> SSR (screen-space reflections, incl. dielectrics like clear coat & asphalt sheen)
//   -> TRAA (temporal reprojection AA)  -> per-object motion blur  -> bloom -> lens effects -> tone mapping
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js'
import { ssgi } from 'three/addons/tsl/display/SSGINode.js'
import { ssr } from 'three/addons/tsl/display/SSRNode.js'
import { traa } from 'three/addons/tsl/display/TRAANode.js'
import { taau } from 'three/addons/tsl/display/TAAUNode.js'
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
} from 'three/tsl'
import { useSettings } from '../state/settings'
import { reportGpuError } from './gpuHealth'
import { debugFlag } from '../util/debug'
import { motionBlur, motionBlurUniforms, motionDebugView } from './motionBlur'
import { beginMotionFrame, motionBlendMode, motionVelocityOutput } from './motionHistory'
import { particleScene, particleU, sceneDepth } from './particles'

/** Set frames > 0 when the camera jumps: no camera motion (blur, TAA reprojection) across the cut. */
export const cameraCut = { frames: 0 }

export const postUniforms = {
  motionBlur: uniform(0.6),
  vignette: uniform(0.32),
  exposure: uniform(1),
  grain: uniform(0.012),
  saturation: uniform(1.06),
  /** eye adaptation multiplier (auto exposure) */
  adapt: uniform(1),
  meterTap: uniform(0),
}

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
  const useTAA = gfx.taa
  const useMB = gfx.motionBlur > 0
  const useBloom = gfx.bloom
  // temporal upscaling: render the scene (and SSGI/SSR) at a reduced internal resolution and let
  // TAAU reconstruct the output resolution from jittered history (like DLSS/FSR2)
  const upscale = useTAA ? Math.min(1, Math.max(0.5, gfx.upscale ?? 1)) : 1
  const useAE = gfx.autoExposure ?? false

  const pipeline = useMemo(() => {
    const rp = new THREE.RenderPipeline(renderer)
    const scenePass = pass(scene, camera)
    if (upscale < 0.999) scenePass.setResolutionScale(upscale)
    // G-buffer layout. WebGPU's default limit is 32 bytes of colour attachments per sample and every
    // RGBA8 / RGBA16F target counts as 8, so at most four targets: roughness rides in the normal
    // target's alpha and metalness in the albedo target's alpha (or a target of its own without SSGI).
    const outputs: Record<string, any> = { output }
    // velocity: NDC motion per frame, wheel slot, inverse depth of the surface that owns the motion
    if (useTAA || useMB) outputs.velocity = motionVelocityOutput
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
      gi.sliceCount.value = gfx.preset === 'ultra' ? 3 : 2
      gi.stepCount.value = gfx.preset === 'ultra' ? 12 : 8
      gi.radius.value = 6
      gi.giIntensity.value = 6
      gi.aoIntensity.value = 1.15
      gi.thickness.value = 0.8
      gi.useTemporalFiltering = useTAA
      gi.resolutionScale = upscale
      const diffuse = scenePass.getTextureNode('diffuseColor')
      composite = vec4(color.rgb.mul(gi.getAONode()).add(diffuse.rgb.mul(gi.getGINode().rgb)), color.a)
    } else if (useAO && sceneNormal) {
      const a = gtao(depth, sceneNormal, camera)
      a.radius.value = 1.2
      a.resolutionScale = 0.5 * upscale
      composite = vec4(color.rgb.mul(a.getTextureNode().r), color.a)
    }
    if (useSSR && sceneNormal) {
      const metalNode = useSSGI ? scenePass.getTextureNode('diffuseColor').a : scenePass.getTextureNode('metal').r
      const r = ssr(convertToTexture(composite), depth, sceneNormal, { metalnessNode: metalNode, roughnessNode: normalTex!.a, camera, reflectNonMetals: true })
      r.maxDistance.value = 60
      r.thickness.value = 0.35
      r.quality.value = gfx.preset === 'ultra' ? 0.6 : 0.4
      r.resolutionScale = (gfx.preset === 'ultra' ? 1 : 0.5) * upscale
      composite = vec4(composite.rgb.add(r.rgb), color.a)
    }
    let out: any = composite
    let tileDebug: any = null
    // luminance meter for auto exposure: tiny render target, read back asynchronously on the CPU
    let meter: any = null
    if (useAE) {
      meter = rtt(vec4(luminance(composite.rgb).max(1e-4).log(), 0, 0, 1), 48, 27, { type: THREE.FloatType })
      // keep the meter in the graph (its contribution is scaled by a zero uniform)
      composite = vec4(composite.rgb.add(meter.sample(vec2(0.5, 0.5)).r.mul(postUniforms.meterTap)), composite.a)
    }
    if (useTAA && vel) out = upscale < 0.999 ? taau(composite, depth, vel, camera) : traa(composite, depth, vel, camera)
    else out = fxaa(composite)
    if (useMB && vel) {
      const taps = gfx.preset === 'ultra' ? 24 : gfx.preset === 'high' ? 20 : 14
      const src = typeof out.getTextureNode === 'function' ? out.getTextureNode() : convertToTexture(out)
      const node = motionBlur(src, vel, { taps, wheels: true })
      out = node.getTextureNode()
      if (debugFlag('showtiles')) tileDebug = node.getTileDebugNode()
    }
    // particles (smoke, dust, sparks): own pass, soft against the scene depth, composited over the
    // lit image (premultiplied colour, transmittance in alpha). After TAA and motion blur, so they
    // neither ghost nor pick up the scene's motion vectors.
    sceneDepth.value = scenePass.getTexture('depth')
    particleU.soft.value = 1
    const particlePass = pass(particleScene, camera)
    particlePass.setResolutionScale(gfx.preset === 'high' || gfx.preset === 'ultra' ? 0.75 : 0.5)
    const parts = particlePass.getTextureNode('output')
    out = vec4(out.rgb.mul(parts.a).add(parts.rgb), 1)
    if (useBloom) {
      const b = bloom(out, 0.14, 0.4, 1.15)
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
    rp.outputNode = vec4(graded.mul(postUniforms.exposure).mul(postUniforms.adapt), 1)
    // debug view (?showvel): raw motion vectors, 8 levels per pixel of motion per frame,
    // |x| in red, |y| in green, signs in blue
    if (debugFlag('showvel') && vel) {
      rp.outputNode = motionDebugView(vel)
      rp.outputColorTransform = false
    }
    if (tileDebug) {
      rp.outputNode = tileDebug
      rp.outputColorTransform = false
    }
    ;(rp as any).__meter = meter
    return rp
  }, [renderer, scene, camera, useSSGI, useSSR, useAO, useTAA, useMB, useBloom, gfx.preset, upscale, useAE])

  useEffect(() => () => pipeline.dispose(), [pipeline])

  useFrame((_, dt) => {
    const cut = cameraCut.frames > 0
    if (cut) cameraCut.frames--
    // constant exposure: the setting is the shutter time as a fraction of 1/60 s, whatever the frame
    // rate (motion vectors span one frame, so they are scaled by exposure / frame time)
    const frameDt = Math.max(dt, 1e-3)
    const shutter = gfx.motionBlur * Math.min(3, 1 / 60 / frameDt)
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
