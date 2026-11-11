// Texture LOD bias under temporal AA. TAA jitters every frame's samples over the pixel and averages
// them, so the converged image is a supersample: the mip a single sample would pick (one texel per
// pixel) is a level softer than that supersample needs. Every mip-mapped material texture sampled in
// a fragment shader takes a shared negative bias (log2(render scale) - 0.5, as FSR 2 / DLSS ask for;
// set per frame by PostFX, 0 without TAA). Applied once, to three's TextureNode, so every material
// helper gets it without being touched. Not applied to render targets, depth / shadow compares,
// cube / 3D textures, explicit level / gradient / bias reads or vertex-stage reads.
import * as THREE from 'three/webgpu'
import { uniform } from 'three/tsl'

type N = any

/** the shared bias (mip levels; negative = sharper) */
export const lodBias = uniform(0)

const MIP_FILTERS = new Set<number>([THREE.LinearMipmapLinearFilter, THREE.LinearMipmapNearestFilter, THREE.NearestMipmapLinearFilter, THREE.NearestMipmapNearestFilter])

function wantsBias(node: N, builder: N) {
  const t = node.value as N
  if (!t || !t.isTexture) return false
  if (builder.shaderStage !== 'fragment') return false
  if (node.biasNode || node.levelNode || node.gradNode || node.compareNode || node.gatherNode || node.depthNode) return false
  if (node.sampler === false) return false
  if (builder.context.getTextureLevel || builder.context.getTextureGradient) return false
  if (t.isRenderTargetTexture || t.isDepthTexture || t.isFramebufferTexture || t.isCubeTexture || t.isData3DTexture || t.isArrayTexture || t.isDataArrayTexture) return false
  if (!MIP_FILTERS.has(t.minFilter)) return false
  return t.generateMipmaps === true || (Array.isArray(t.mipmaps) && t.mipmaps.length > 1)
}

let installed = false
export function installLodBias() {
  if (installed) return
  installed = true
  const proto = (THREE as N).TextureNode.prototype
  const setup = proto.setup
  proto.setup = function (this: N, builder: N) {
    if (!wantsBias(this, builder)) return setup.call(this, builder)
    this.biasNode = lodBias
    try {
      return setup.call(this, builder)
    } finally {
      this.biasNode = null
    }
  }
}
