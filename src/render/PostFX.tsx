// Post-processing pipeline (TSL / RenderPipeline):
//   scene pass with MRT (colour, normals, diffuse albedo, metal/rough, velocity)
//   -> SSGI (screen-space indirect diffuse + AO)  or  GTAO
//   -> SSR (screen-space reflections, incl. dielectrics like clear coat & asphalt sheen)
//   -> SMAA (or FXAA on low)  -> per-object motion blur  -> particles
//   -> the camera: exposure -> the lens (lens.ts: chromatic aberration, lens scatter, the sun's glare,
//      star and ghosts, vignetting) -> the sensor (sensor.ts: noise) -> the picture (sensor.ts: filmic
//      display rendering in an inset gamut) -> sRGB with dither
// No temporal AA: TAA reuses earlier frames, and in tracking shots (a car still on screen, the track
// sliding past) it smeared and ghosted the cars. Every frame here stands on its own.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js'
import { ssgi } from 'three/addons/tsl/display/SSGINode.js'
import { ssr } from 'three/addons/tsl/display/SSRNode.js'
import { smaa } from 'three/addons/tsl/display/SMAANode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
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
  uniform,
  unpackRGBToNormal,
  vec2,
  vec4,
  mix,
  convertToTexture,
} from 'three/tsl'
import { useSettings } from '../state/settings'
import { reportGpuError } from './gpuHealth'
import { debugFlag } from '../util/debug'
import { ae, exposureMeter, stepAutoExposure } from './autoExposure'
import { motionBlur, motionBlurUniforms } from './motionBlur'
import { beginMotionFrame, motionBlendMode, motionVelocityOutput } from './motionHistory'
import { particleScene, particleU, sceneDepth } from './particles'
import { lateralCA, lensScatter, naturalVignette, SCATTER, scatterUpsample, sunGlare, sunVisibility, updateLens } from './lens'
import { displayTransform, encodeDisplay, sensorNoise, sensorU } from './sensor'
import { sunState } from './Environment'

/** Set frames > 0 when the camera jumps (a cut): the frame it is set on is not motion blurred. */
export const cameraCut = { frames: 0 }
/** cameraCut.frames after the previous frame's countdown: a larger value means a new cut */
let lastCutFrames = 0

export const postUniforms = {
  motionBlur: uniform(0.6),
  /** share of the natural (cos^4) vignetting the lens leaves uncorrected */
  vignette: uniform(0.4),
  exposure: uniform(1),
  /** auto exposure x exposure compensation (a multiplier: 2^stops) */
  adapt: uniform(1),
  meterTap: uniform(0),
}

/**
 * Base exposure, calibrated like a camera's meter on a sunny track: sunlit asphalt lands at the tone
 * curve's anchor (sensor.ts: ~37% sRGB), grass and a grey card in full sun a little above, white paint
 * and sunlit cloud tops in the shoulder with their detail, the sky near the sun and the sun itself far
 * beyond white. postUniforms.exposure follows the sun's height (Environment.tsx); auto exposure
 * (autoExposure.ts) and the exposure compensation go on top.
 */
const EXPOSURE = 1.45

/**
 * How much screen-space AO / GI an object takes (0 for objects flagged `userData.noAO`: the cars, whose
 * clear coat would show the passes' noise over its reflections; their contact shading is the shadows').
 */
const aoWeight = uniform(1).onObjectUpdate(({ object }) => (object?.userData.noAO ? 0 : 1))

const _size = new THREE.Vector2()
/** one output pixel in uv */
const texelFull = uniform(new THREE.Vector2(1 / 1920, 1 / 1080))

const aeDebug = debugFlag('aedebug')

/**
 * Debug (window.__wantHdr = true): the exposed linear frame (half floats, base64) into window.__hdr;
 * window.__hdrSeq = n: the next n frames into window.__hdrs.
 */
function hdrDump(renderer: THREE.WebGPURenderer, tex: any) {
  const w = window as unknown as { __wantHdr?: boolean; __hdr?: object; __hdrSeq?: number; __hdrs?: (object | null)[] }
  const seq = (w.__hdrSeq ?? 0) > 0
  if ((!w.__wantHdr && !seq) || !tex?.renderTarget) return
  const slot = seq ? (w.__hdrs ??= []).push(null) - 1 : -1
  if (seq) w.__hdrSeq!--
  else w.__wantHdr = false
  const rt = tex.renderTarget as THREE.RenderTarget
  const meta = { w: rt.width, h: rt.height, exposure: postUniforms.exposure.value, adapt: postUniforms.adapt.value, base: EXPOSURE }
  renderer.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height).then((px) => {
    const b = new Uint8Array((px as Uint16Array).buffer)
    let s = ''
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
    const rec = { ...meta, data: btoa(s) }
    if (slot >= 0) w.__hdrs![slot] = rec
    else w.__hdr = rec
  })
}

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
    // alpha: the SSR's roughness, or (without SSR) the object's weight for screen-space AO / GI
    if (useSSGI || useSSR || useAO) outputs.normal = vec4(packNormalToRGB(normalView), useSSR ? roughness : aoWeight)
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
      // (cars excluded: the occlusion is noisy and would darken their mirror reflections)
      const w = useSSR ? float(1) : normalTex!.a
      composite = vec4(color.rgb.mul(mix(float(1), gi.getAONode(), w)).add(diffuse.rgb.mul(gi.getGINode().rgb).mul(w)), color.a)
    } else if (useAO && sceneNormal) {
      const a = gtao(depth, sceneNormal, camera)
      a.radius.value = 1.2
      a.resolutionScale = 0.5
      const w = useSSR ? float(1) : normalTex!.a
      composite = vec4(color.rgb.mul(mix(float(1), a.getTextureNode().r, w)), color.a)
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
    // ---- the camera: exposure, then the lens (lens.ts), the sensor and the picture (sensor.ts)
    const exposedTex = convertToTexture(vec4(out.rgb.mul(postUniforms.exposure).mul(postUniforms.adapt).mul(EXPOSURE), 1))
    // the camera's light meter (autoExposure.ts), read back asynchronously
    const meter = useAE ? exposureMeter(exposedTex, postUniforms.adapt) : null
    // the sharp image through the lens: lateral chromatic aberration towards the corners
    let img: any = lateralCA(exposedTex)
    if (useBloom) {
      // lens scatter: SCATTER.k of all light over the lens's long-tailed PSF (no threshold, energy
      // conserving: only what is far brighter than its surroundings shows a halo)
      const scatter = lensScatter(exposedTex)
      img = img.mul(1 - SCATTER.k).add(scatterUpsample(scatter.getTextureNode(), texelFull))
      // the sun: its scatter, the iris's diffraction star and (High, Ultra) the ghosts, from its light
      // and its measured visibility
      const vis = sunVisibility(scenePass.getTextureNode('depth'))
      img = img.add(sunGlare(vis, gfx.preset === 'high' || gfx.preset === 'ultra'))
    }
    // natural vignetting (cos^4 of the off-axis angle, partly corrected)
    img = img.mul(naturalVignette(postUniforms.vignette))
    // the sensor's noise, the picture, the display's encoding (with dither)
    let toned: any = encodeDisplay(displayTransform(sensorNoise(img)))
    // keep the meter in the graph (its contribution is scaled by a zero uniform)
    if (meter) toned = toned.add(meter.sample(vec2(0.5, 0.5)).r.mul(postUniforms.meterTap))
    rp.outputNode = vec4(toned, 1)
    // the output is already display encoded
    rp.outputColorTransform = false
    // debug views: ?showvel (the streaks the blur uses), ?showtiles (its neighbour-max tiles)
    if (blurDebug) {
      rp.outputNode = blurDebug
      rp.outputColorTransform = false
    }
    ;(rp as any).__meter = meter
    ;(rp as any).__exposed = exposedTex
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
    const size = renderer.getDrawingBufferSize(_size)
    texelFull.value.set(1 / Math.max(1, size.x), 1 / Math.max(1, size.y))
    sensorU.frame.value = (sensorU.frame.value + 1) % 65536
    // the lens sees the sun (its glare) at the camera's total exposure
    updateLens(camera, size.x, size.y, sunState, EXPOSURE * postUniforms.exposure.value * postUniforms.adapt.value, cut)
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
    hdrDump(renderer, (pipeline as any).__exposed)
    // auto exposure (stops from the base exposure) and the player's exposure compensation
    const ev = stepAutoExposure(renderer, (pipeline as any).__meter, dt, cut)
    postUniforms.adapt.value = Math.pow(2, ev + (gfx.exposureComp ?? 0))
    if (aeDebug) (window as unknown as { __ae?: object }).__ae = { ev, target: ae.target, measured: ae.measured }
  }, 1)
  return null
}
