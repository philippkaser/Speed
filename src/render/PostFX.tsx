// Post-processing pipeline (TSL / RenderPipeline):
//   scene pass with MRT (colour, normals, diffuse albedo, metal/rough, velocity)
//   -> SSGI (screen-space indirect diffuse + AO)  or  GTAO
//   -> SSR (screen-space reflections, incl. dielectrics like clear coat & asphalt sheen)
//   -> TRAA (temporal reprojection AA)  -> motion blur  -> bloom -> lens effects -> tone mapping
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js'
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js'
import { ssgi } from 'three/addons/tsl/display/SSGINode.js'
import { ssr } from 'three/addons/tsl/display/SSRNode.js'
import { traa } from 'three/addons/tsl/display/TRAANode.js'
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
  velocity,
  mix,
  smoothstep,
  length,
  hash,
  time,
  int,
  convertToTexture,
} from 'three/tsl'
import { useSettings } from '../state/settings'

export const postUniforms = {
  motionBlur: uniform(0.6),
  vignette: uniform(0.32),
  exposure: uniform(1),
  grain: uniform(0.025),
  saturation: uniform(1.06),
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
  const useTAA = gfx.taa
  const useMB = gfx.motionBlur > 0
  const useBloom = gfx.bloom

  const pipeline = useMemo(() => {
    const rp = new THREE.RenderPipeline(renderer)
    const scenePass = pass(scene, camera)
    const outputs: Record<string, any> = { output }
    if (useTAA || useMB) outputs.velocity = velocity
    if (useSSGI || useSSR || useAO) outputs.normal = packNormalToRGB(normalView)
    if (useSSGI) outputs.diffuseColor = diffuseColor
    if (useSSR) outputs.metalrough = vec2(metalness, roughness)
    scenePass.setMRT(mrt(outputs))
    const color = scenePass.getTextureNode('output')
    const depth = scenePass.getTextureNode('depth')
    if (outputs.normal) scenePass.getTexture('normal').type = THREE.UnsignedByteType
    if (outputs.diffuseColor) scenePass.getTexture('diffuseColor').type = THREE.UnsignedByteType
    if (outputs.metalrough) scenePass.getTexture('metalrough').type = THREE.UnsignedByteType
    const normalTex = outputs.normal ? scenePass.getTextureNode('normal') : null
    const sceneNormal = normalTex ? sample((uv) => unpackRGBToNormal(normalTex.sample(uv))) : null
    const vel = outputs.velocity ? scenePass.getTextureNode('velocity') : null

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
      const diffuse = scenePass.getTextureNode('diffuseColor')
      composite = vec4(color.rgb.mul(gi.getAONode()).add(diffuse.rgb.mul(gi.getGINode().rgb)), color.a)
    } else if (useAO && sceneNormal) {
      const a = gtao(depth, sceneNormal, camera)
      a.radius.value = 1.2
      a.resolutionScale = 0.5
      composite = vec4(color.rgb.mul(a.getTextureNode().r), color.a)
    }
    if (useSSR && sceneNormal) {
      const mr = scenePass.getTextureNode('metalrough')
      const r = ssr(convertToTexture(composite), depth, sceneNormal, { metalnessNode: mr.r, roughnessNode: mr.g, camera, reflectNonMetals: true })
      r.maxDistance.value = 60
      r.thickness.value = 0.35
      r.quality.value = gfx.preset === 'ultra' ? 0.6 : 0.4
      r.resolutionScale = gfx.preset === 'ultra' ? 1 : 0.5
      composite = vec4(composite.rgb.add(r.rgb), color.a)
    }
    let out: any = composite
    if (useTAA && vel) out = traa(out, depth, vel, camera)
    else out = fxaa(out)
    if (useMB && vel) out = motionBlur(convertToTexture(out), vel.mul(postUniforms.motionBlur), int(12))
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
    rp.outputNode = vec4(graded.mul(postUniforms.exposure), 1)
    return rp
  }, [renderer, scene, camera, useSSGI, useSSR, useAO, useTAA, useMB, useBloom, gfx.preset])

  useEffect(() => () => pipeline.dispose(), [pipeline])

  useFrame((_, dt) => {
    // constant shutter: blur length corresponds to 1/60 s regardless of frame rate
    postUniforms.motionBlur.value = gfx.motionBlur * Math.min(1, 1 / 60 / Math.max(dt, 1e-3))
    pipeline.render()
  }, 1)
  return null
}
