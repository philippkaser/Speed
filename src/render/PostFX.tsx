// Post-processing pipeline (TSL / RenderPipeline):
//   scene pass with MRT (colour, normals, diffuse albedo, metal/rough, velocity)
//   -> SSGI (screen-space indirect diffuse + AO)  or  GTAO
//   -> SSR (screen-space reflections, incl. dielectrics like clear coat & asphalt sheen)
//   -> per-object motion blur -> temporal AA (taa.ts)   (without TAA: SMAA, FXAA on low, then the blur)
//   -> particles
//   -> the camera: exposure -> the lens (lens.ts: chromatic aberration, lens scatter, the sun's glare,
//      star and ghosts, vignetting) -> the sensor (sensor.ts: noise) -> the picture (sensor.ts: filmic
//      display rendering in an inset gamut) -> sRGB with dither
// The temporal AA rejects history by motion, not by depth, so in tracking shots (a car still on
// screen, the track sliding past) the road never takes the car's history (see taa.ts).
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three/webgpu'
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js'
import { ssgi } from 'three/addons/tsl/display/SSGINode.js'
import { ssr } from 'three/addons/tsl/display/SSRNode.js'
import { smaa } from 'three/addons/tsl/display/SMAANode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { bokehDof, dofU } from './dof'
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
import { renderScale, temporalAA } from './taa'
import { stepDynamicRes } from './dynamicRes'
import { rcas, sharpenU } from './sharpen'
import { contactShadows, contactShadowsOff, updateContactShadows } from './contactShadows'
import { beginMotionFrame, motionBlendMode, motionVelocityOutput } from './motionHistory'
import { particleScene, particleU, sceneDepth } from './particles'
import { lateralCA, lensScatter, naturalVignette, SCATTER, scatterUpsample, sunGlare, sunVisibility, updateLens } from './lens'
import { displayTransform, displayTransformHDR, encodeDisplay, encodeDisplayHDR, hdrState, sensorNoise, sensorU } from './sensor'
import { sunState } from './Environment'
import { game } from '../game/game'
import { cameraFocus } from './CameraRig'

/**
 * Depth of field of the cinematic cameras (the menu's attract shots, the showroom, the TV broadcast,
 * replays): a physical lens. The circle of confusion of a point at distance z with the lens focused at
 * zf is c = f^2 / (N (zf - f)) * |z - zf| / z on the sensor; f follows from the camera's field of view
 * and the sensor's height, N is the f-number. The driving cameras never get it (GT7 doesn't either):
 * the road ahead must stay sharp. Other code (a replay director) may set `lensDof.force`.
 */
export const lensDof = {
  /** sensor height (m): full frame for the showroom, Super 35 for the TV cameras */
  sensorH: 0.024,
  fStop: 2.8,
  /** focus distance (m), < 0: auto-focus on the car in focus (CameraRig.cameraFocus) */
  focus: -1,
  /** largest blur radius (output pixels at 1080p) */
  maxRadius: 14,
  /** turn the depth of field on outside the cinematic modes (e.g. replays) */
  force: false,
}
const CINEMATIC_MODES = new Set(['attract', 'showroom', 'team'])
const _toFocus = new THREE.Vector3()
const _camDir = new THREE.Vector3()

/** Set frames > 0 when the camera jumps (a cut): the frame it is set on is not motion blurred. */
export const cameraCut = { frames: 0 }
/** cameraCut.frames after the previous frame's countdown: a larger value means a new cut */
let lastCutFrames = 0

export const postUniforms = {
  motionBlur: uniform(0.6),
  /** share of the natural (cos^4) vignetting the lens leaves uncorrected */
  vignette: uniform(0.22),
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
 * How much screen-space AO / GI an object takes. Objects flagged `userData.noAO` (the cars) take none
 * without TAA: the passes' noise would sit on their clear coat as grain. With TAA the noise converges
 * in the history, and the cars get their contact shading (wheel arches, under the wing, the diffuser,
 * panel gaps), the reflections in those cavities occluded too, as they really are.
 */
const aoForAll = { on: false }
const aoWeight = uniform(1).onObjectUpdate(({ object }) => (object?.userData.noAO && !aoForAll.on ? 0 : 1))

const _size = new THREE.Vector2()
/** one output pixel in uv */
const texelFull = uniform(new THREE.Vector2(1 / 1920, 1 / 1080))

const aeDebug = debugFlag('aedebug')
const OFFSCREEN = typeof location !== 'undefined' && new URLSearchParams(location.search).has('offscreen')

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
  // temporal AA (taa.ts) where the preset allows it; SMAA / FXAA otherwise
  const useTAA = (gfx.taa ?? gfx.preset !== 'low') && !debugFlag('notaa')
  const useAE = gfx.autoExposure ?? false
  // screen-space contact shadows of the sun (contactShadows.ts), Medium and up, with shadows on
  const useContact = (gfx.contactShadows ?? gfx.preset !== 'low') && gfx.shadows > 0 && !debugFlag('nocontact')
  // RCAS after the tone curve (sharpen.ts); film grain (the sensor's noise) only when asked for
  const useSharpen = (gfx.sharpness ?? 0.5) > 0 && !debugFlag('nosharpen')
  const useGrain = !!gfx.filmGrain
  // depth of field in the cinematic modes only (rebuilt when the game changes mode)
  const [mode, setMode] = useState(game.mode)
  useEffect(() => game.on((e) => e.type === 'session' && setMode(game.mode)), [])
  const useDof = (CINEMATIC_MODES.has(mode) || lensDof.force) && gfx.preset !== 'low' && !debugFlag('nodof')

  const pipeline = useMemo(() => {
    aoForAll.on = useTAA
    const rp = new THREE.RenderPipeline(renderer)
    const scenePass = pass(scene, camera)
    // the scene renders at the internal resolution (dynamicRes.ts); the TAA upscales to the output
    scenePass.setResolutionScale(renderScale.value)
    // G-buffer layout. WebGPU's default limit is 32 bytes of colour attachments per sample and every
    // RGBA8 / RGBA16F target counts as 8, so at most four targets: roughness rides in the normal
    // target's alpha and metalness in the albedo target's alpha (or a target of its own without SSGI).
    const outputs: Record<string, any> = { output }
    // velocity: NDC motion per frame, wheel slot, inverse depth of the surface that owns the motion
    if (useMB || useTAA) outputs.velocity = motionVelocityOutput
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
      // three's presets: with TAA the noise is varied every frame and converges in the history, so
      // fewer samples give a cleaner result; without it, more samples and the noise stays
      gi.sliceCount.value = useTAA ? (gfx.preset === 'ultra' ? 3 : 2) : gfx.preset === 'ultra' ? 4 : 3
      gi.stepCount.value = useTAA ? (gfx.preset === 'ultra' ? 16 : 10) : gfx.preset === 'ultra' ? 12 : 8
      gi.radius.value = 6
      gi.giIntensity.value = 6
      gi.aoIntensity.value = 1.15
      gi.thickness.value = 0.8
      gi.useTemporalFiltering = useTAA
      // half of the internal resolution below Ultra (sized from the output each frame, see useFrame)
      gi.resolutionScale = renderScale.value * (gfx.preset === 'ultra' ? 1 : 0.5)
      ;(rp as any).__gi = gi
      const diffuse = scenePass.getTextureNode('diffuseColor')
      // (cars excluded without TAA, see aoWeight)
      const w = useSSR ? float(1) : normalTex!.a
      composite = vec4(color.rgb.mul(mix(float(1), gi.getAONode(), w)).add(diffuse.rgb.mul(gi.getGINode().rgb).mul(w)), color.a)
    } else if (useAO && sceneNormal) {
      const a = gtao(depth, sceneNormal, camera)
      a.radius.value = 1.2
      a.resolutionScale = 0.5 * renderScale.value
      ;(rp as any).__gtao = a
      a.useTemporalFiltering = useTAA
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
    let taaNode: any = null
    const blur = (src: any) => {
      const q = gfx.preset === 'ultra' ? { pairs: 16, denseTaps: 64 } : gfx.preset === 'high' ? { pairs: 12, denseTaps: 48 } : { pairs: 8, denseTaps: 32 }
      const node = motionBlur(typeof src.getTextureNode === 'function' ? src.getTextureNode() : convertToTexture(src), vel, { ...q, wheels: true })
      if (debugFlag('showtiles')) blurDebug = node.getTileDebugNode()
      else if (debugFlag('showvel')) blurDebug = node.getStreakDebugNode()
      return node.getTextureNode()
    }
    if (useTAA && vel) {
      // With TAA, the motion blur comes first: the velocity target is drawn with TAA's sub-pixel
      // jitter, so where a car meets the road the blur's boundary moves by up to half a pixel every
      // frame (and the blur's sampling noise changes every frame); TAA averages both away. (After TAA,
      // nothing smoothed them: the bottoms of the cars shimmered.)
      if (useMB) out = blur(composite)
      out = taaNode = temporalAA(convertToTexture(out), depth, vel, camera)
    } else {
      // without it: spatial AA on the sharp image, then the blur
      out = useSMAA ? smaa(composite) : fxaa(composite)
      if (useMB && vel) out = blur(out)
    }
    // particles (smoke, dust, sparks): own pass, soft against the scene depth, composited over the
    // lit image (premultiplied colour, transmittance in alpha). After anti-aliasing and motion blur, so they
    // neither ghost nor pick up the scene's motion vectors.
    sceneDepth.value = scenePass.getTexture('depth')
    particleU.soft.value = 1
    const particlePass = pass(particleScene, camera)
    particlePass.setResolutionScale(gfx.preset === 'high' || gfx.preset === 'ultra' ? 0.75 : 0.5)
    ;(rp as any).__particles = particlePass
    const parts = particlePass.getTextureNode('output')
    out = vec4(out.rgb.mul(parts.a).add(parts.rgb), 1)
    // the lens's depth of field (dof.ts): a physical circle of confusion, one gather pass
    if (useDof) out = bokehDof(convertToTexture(out), depth)
    // the sun's contact shadows, from this frame's depth, for the materials of the next
    const contact = useContact ? contactShadows(depth, vel, camera, gfx.preset === 'ultra' ? 20 : gfx.preset === 'high' ? 16 : 12, gfx.preset === 'ultra' ? 1 : 0.5) : (contactShadowsOff(), null)
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
    // the picture, sharpened (RCAS on the display-referred image, sharpen.ts), the display's encoding
    // (with dither). The sensor's noise only as optional film grain: it costs clarity
    const hdr = hdrState.active
    const graded = useGrain ? sensorNoise(img) : img
    let disp: any = hdr ? displayTransformHDR(graded) : displayTransform(graded)
    // RCAS works on [0, 1]: the HDR picture is normalised to its peak around it
    if (useSharpen) disp = hdr ? rcas(convertToTexture(disp.div(sensorU.hdrPeak))).mul(sensorU.hdrPeak) : rcas(convertToTexture(disp))
    let toned: any = hdr ? encodeDisplayHDR(disp) : encodeDisplay(disp)
    // keep the meter and the contact shadows in the graph (their contribution is scaled by a zero
    // uniform): they render every frame, but nothing in this image reads them
    if (meter) toned = toned.add(meter.sample(vec2(0.5, 0.5)).r.mul(postUniforms.meterTap))
    if (contact) toned = toned.add(contact.getTextureNode().sample(vec2(0.5, 0.5)).r.mul(postUniforms.meterTap))
    rp.outputNode = vec4(toned, 1)
    // the output is already display encoded
    rp.outputColorTransform = false
    // debug views: ?showvel (the streaks the blur uses), ?showtiles (its neighbour-max tiles)
    if (blurDebug) {
      rp.outputNode = blurDebug
      rp.outputColorTransform = false
    }
    ;(rp as any).__meter = meter
    ;(rp as any).__taa = taaNode
    ;(rp as any).__exposed = exposedTex
    ;(rp as any).__scene = scenePass
    return rp
  }, [renderer, scene, camera, useSSGI, useSSR, useAO, useSMAA, useTAA, useMB, useBloom, gfx.preset, useAE, useContact, useSharpen, useGrain, useDof])

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
    // the internal resolution for this frame (dynamic resolution, within the preset's pixel budget)
    const rs = stepDynamicRes(renderer, frameDt, size.x, size.y, {
      preset: gfx.preset,
      maxScale: gfx.resolutionScale ?? 1,
      dynamic: (gfx.dynamicRes ?? true) && !OFFSCREEN,
      targetFps: gfx.targetFps ?? 60,
      temporal: useTAA,
    })
    const pl = pipeline as any
    if (pl.__scene && pl.__scene.getResolutionScale() !== rs) pl.__scene.setResolutionScale(rs)
    if (pl.__gi) pl.__gi.resolutionScale = rs * (gfx.preset === 'ultra' ? 1 : 0.5)
    if (pl.__gtao) pl.__gtao.resolutionScale = 0.5 * rs
    if (pl.__particles) pl.__particles.setResolutionScale(Math.min(gfx.preset === 'high' || gfx.preset === 'ultra' ? 0.75 : 0.5, rs))
    sharpenU.amount.value = Math.max(0, Math.min(1, gfx.sharpness ?? 0.5))
    if (useDof) {
      // the lens: focal length from the field of view on the sensor, focused on the car in focus
      const fovRad = (camera.fov * Math.PI) / 180 / Math.max(camera.zoom, 1e-3)
      const f = lensDof.sensorH / 2 / Math.tan(fovRad / 2)
      camera.getWorldDirection(_camDir)
      const auto = _toFocus.copy(cameraFocus).sub(camera.position).dot(_camDir)
      const zf = Math.max(f * 4, lensDof.focus > 0 ? lensDof.focus : auto > 0.5 ? auto : 10)
      // a TV camera's long lens stops down: a wide shot keeps its depth, a telephoto isolates the car
      const N = mode === 'team' ? Math.max(lensDof.fStop, 4) : lensDof.fStop
      const cocSensor = (f * f) / (N * Math.max(zf - f, 1e-3))
      dofU.focus.value = zf
      dofU.k.value = ((cocSensor / lensDof.sensorH) * size.y) / 2
      dofU.maxPx.value = (lensDof.maxRadius * size.y) / 1080
      dofU.near.value = camera.near
      dofU.far.value = camera.far
      dofU.texel.value.set(1 / Math.max(1, size.x), 1 / Math.max(1, size.y))
    }
    sensorU.noise.value = gfx.filmGrain ? 0.02 : 0
    sensorU.hdrPeak.value = hdrState.active ? Math.max(1, (gfx.hdrPeakNits ?? hdrState.peakNits) / Math.max(80, gfx.hdrPaperWhite ?? hdrState.paperWhiteNits)) : 1
    sensorU.frame.value = (sensorU.frame.value + 1) % 65536
    updateContactShadows(camera, sunState.dir)
    // the lens sees the sun (its glare) at the camera's total exposure
    updateLens(camera, size.x, size.y, sunState, EXPOSURE * postUniforms.exposure.value * postUniforms.adapt.value, cut)
    // a cut drops the camera's motion for that frame; objects keep theirs, and nothing of the previous
    // shot may linger in the temporal AA's history
    beginMotionFrame(scene, camera, { cut, exposure: shutter * frameDt, dt: frameDt })
    if (cut) (pipeline as any).__taa?.restart()
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
