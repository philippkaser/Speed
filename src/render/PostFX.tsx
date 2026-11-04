// Post-processing pipeline (TSL / RenderPipeline):
//   scene pass with MRT (colour, normals, diffuse albedo, metal/rough, velocity)
//   -> SSGI (screen-space indirect diffuse + AO)  or  GTAO
//   -> SSR (screen-space reflections, incl. dielectrics like clear coat & asphalt sheen)
//   -> SMAA (or FXAA on low)  -> per-object motion blur  -> the camera: exposure -> the lens (lens.ts:
//   chromatic aberration, scatter/bloom, aperture starburst, flare ghosts, vignetting) -> grading
//   -> filmic tone mapping (Gran Turismo curve, see gtToneMap)
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
  max,
  min,
  screenSize,
  Fn,
  exp,
  pow,
  step,
} from 'three/tsl'
import { useSettings } from '../state/settings'
import { reportGpuError } from './gpuHealth'
import { debugFlag } from '../util/debug'
import { ae, exposureMeter, stepAutoExposure } from './autoExposure'
import { motionBlur, motionBlurUniforms } from './motionBlur'
import { beginMotionFrame, motionBlendMode, motionVelocityOutput } from './motionHistory'
import { particleScene, particleU, sceneDepth } from './particles'
import { brightPass, lateralCA, naturalVignette, SCATTER, starburst, updateLens } from './lens'

/** Set frames > 0 when the camera jumps (a cut): the frame it is set on is not motion blurred. */
export const cameraCut = { frames: 0 }
/** cameraCut.frames after the previous frame's countdown: a larger value means a new cut */
let lastCutFrames = 0

export const postUniforms = {
  motionBlur: uniform(0.6),
  /** share of the natural (cos^4) vignetting the lens leaves uncorrected */
  vignette: uniform(0.4),
  exposure: uniform(1),
  grain: uniform(0.012),
  saturation: uniform(1.06),
  /** auto exposure x exposure compensation (a multiplier: 2^stops) */
  adapt: uniform(1),
  meterTap: uniform(0),
}

/**
 * Base exposure, calibrated like a camera's meter on a sunny track: the asphalt and grass (albedo
 * ~0.1) land near middle grey, an 18% grey card in full sun in the lower linear section (~0.4), sunlit
 * cloud tops in the shoulder and the sun far beyond white. postUniforms.exposure follows the sun's
 * height (Environment.tsx); auto exposure (autoExposure.ts) and the exposure compensation go on top.
 */
const EXPOSURE = 1.45

/**
 * The sensor's white: the exposed signal (before the curve) at which it saturates. A real sensor has a
 * finite dynamic range: past its full well every channel clips, and a camera exposed for the track
 * blows out what is much brighter. At 1.5 that is ~2 stops over an 18% grey card in full sun: white
 * paint, kerbs and clouds in the sun, the sky through the windscreen and the sun burn out to pure
 * white. (The original curve only approaches white and kept faint detail ~1.5 stops further up.)
 */
const SENSOR_WHITE = 1.5

/**
 * Filmic tone curve of Gran Turismo Sport (H. Uchimura, "HDR theory and practice", 2017), per channel:
 * a toe that keeps the shadows' contrast, an exactly linear mid section (colours and greys as lit) and
 * a shoulder that runs into pure white, here reaching it at the sensor's white (SENSOR_WHITE) instead
 * of only approaching it. Per channel, bright colours lose their saturation on the way up as a sensor
 * clips one channel after the other: the sun, its glints in the paint and sunlit cloud edges blind to
 * white.
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
  // shoulder: exponential from the linear section (same slope) into exactly P at the sensor's white
  const D = SENSOR_WHITE - S0
  const f = (k: number) => (P - S1) * k - a * (1 - Math.exp(-k * D))
  let lo = 1e-3,
    hi = 50
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) < 0) lo = mid
    else hi = mid
  }
  const k = lo,
    norm = 1 - Math.exp(-k * D)
  const x = max(c, vec3(0))
  const w0 = float(1).sub(smoothstep(0, m, x))
  const w2 = step(S0, x)
  const w1 = float(1).sub(w0).sub(w2)
  const T = pow(x.div(m), vec3(cc)).mul(m).add(b)
  const S = min(float(S1).add(float(1).sub(exp(x.sub(S0).mul(-k))).mul((P - S1) / norm)), P)
  const L = x.sub(m).mul(a).add(m)
  return T.mul(w0).add(L.mul(w1)).add(S.mul(w2))
})

/**
 * How much screen-space AO / GI an object takes (0 for objects flagged `userData.noAO`: the cars, whose
 * clear coat would show the passes' noise over its reflections; their contact shading is the shadows').
 */
const aoWeight = uniform(1).onObjectUpdate(({ object }) => (object?.userData.noAO ? 0 : 1))

const _size = new THREE.Vector2()

const aeDebug = debugFlag('aedebug')

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
    // ---- the camera: exposure, then the lens (lens.ts), then the sensor's tone curve
    const exposedTex = convertToTexture(vec4(out.rgb.mul(postUniforms.exposure).mul(postUniforms.adapt).mul(EXPOSURE), 1))
    // the camera's light meter (autoExposure.ts), read back asynchronously
    const meter = useAE ? exposureMeter(exposedTex, postUniforms.adapt) : null
    // lateral chromatic aberration towards the corners
    let img: any = lateralCA(exposedTex)
    if (useBloom) {
      // lens scatter: a few percent of all light into a wide, long-tailed halo (no threshold, energy
      // conserving: the sun and its glints bloom into white, a sunlit wall barely changes)
      const scatter = bloom(exposedTex, 1, 0.85, 0)
      img = img.mul(1 - SCATTER).add(scatter.rgb.mul(SCATTER / 3))
      // aperture glare: a six-pointed star around everything far beyond white
      const bright = brightPass(exposedTex)
      img = img.add(starburst(bright).rgb)
      // ghosts between the lens elements, from the same bright pass (light sources only)
      if (gfx.preset === 'high' || gfx.preset === 'ultra') {
        const flare = lensflare(bright, { ghostTint: vec3(1.0, 0.93, 0.82), threshold: float(0), ghostSamples: float(4), ghostSpacing: float(0.28), ghostAttenuationFactor: float(22) })
        img = img.add((flare as any).rgb.mul(0.12))
      }
    }
    // natural vignetting (cos^4 of the off-axis angle, partly corrected)
    img = img.mul(naturalVignette(postUniforms.vignette))
    // grading: saturation and fine sensor grain, then the tone curve
    const lum = img.dot(vec3(0.2126, 0.7152, 0.0722))
    let graded = mix(vec3(lum), img, postUniforms.saturation)
    const n = hash(screenUV.mul(vec2(1931.3, 2711.7)).add(time.mul(37.1)).x.add(screenUV.y.mul(911.1)))
    graded = graded.mul(float(1).add(n.sub(0.5).mul(postUniforms.grain)))
    let toned: any = gtToneMap(graded)
    // keep the meter in the graph (its contribution is scaled by a zero uniform)
    if (meter) toned = toned.add(meter.sample(vec2(0.5, 0.5)).r.mul(postUniforms.meterTap))
    rp.outputNode = vec4(toned, 1)
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
    const size = renderer.getDrawingBufferSize(_size)
    updateLens(camera, size.x, size.y)
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
    // auto exposure (stops from the base exposure) and the player's exposure compensation
    const ev = stepAutoExposure(renderer, (pipeline as any).__meter, dt, cut)
    postUniforms.adapt.value = Math.pow(2, ev + (gfx.exposureComp ?? 0))
    if (aeDebug) (window as unknown as { __ae?: object }).__ae = { ev, target: ae.target, measured: ae.measured }
  }, 1)
  return null
}
