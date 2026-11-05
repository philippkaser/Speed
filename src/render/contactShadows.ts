// Screen-space (contact) shadows of the sun: what the shadow maps are too coarse to resolve. Blades of
// grass on the ground, the base of a trunk, the lip of a kerb, a tyre on the road, panel gaps and
// small parts on the cars, at any distance (a shadow map's texel grows with distance; the screen's
// pixel is always a pixel).
//
// After the scene pass, a full-screen pass marches from every pixel towards the sun through the
// depth buffer (view space, a short ray that grows with distance, jittered per frame so the temporal
// AA turns the steps into a smooth result). Where the ray passes behind something within a plausible
// thickness, the pixel is in contact shadow. The result (sun visibility, and the pixel's distance)
// goes into a texture that the materials read in the next frame as part of the sun's shadow
// (sunShadow.ts): reprojected with the motion vectors, and only where the distance matches, so a
// surface never takes another one's shadow. It only ever dims the sun's direct light, never the sky's
// or the bounced light, as a real shadow does. The reflection probes' renders ignore it.
import * as THREE from 'three/webgpu'
import * as tsl from 'three/tsl'

type N = any

const { Fn, abs, clamp, context, float, getScreenPosition, getViewPosition, interleavedGradientNoise, max, mix, passTexture, positionView, screenCoordinate, screenUV, select, texture, uniform, uv, vec2, vec4, velocity } = tsl as N

let mainCamera: THREE.Camera | null = null

export const contactU = {
  /** direction to the sun in the main camera's view space */
  sunView: uniform(new THREE.Vector3(0, 1, 0)),
  proj: uniform(new THREE.Matrix4()),
  projInv: uniform(new THREE.Matrix4()),
  frame: uniform(0),
  /** 1 while the main camera renders (the probes' cameras see the mask of another view) */
  active: uniform(0).onRenderUpdate(({ camera }: { camera: THREE.Camera }) => (contactOn && camera === mainCamera ? 1 : 0)),
}
let contactOn = false

/** Last frame's mask: r = sun visibility, g = the pixel's distance (m). White until the first pass. */
const blank = new THREE.DataTexture(new Uint16Array([THREE.DataUtils.toHalfFloat(1), THREE.DataUtils.toHalfFloat(0), 0, THREE.DataUtils.toHalfFloat(1)]), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType)
blank.needsUpdate = true
const maskTexture: N = texture(blank)

/**
 * The contact shadow term for the sun, in a material: last frame's mask at this fragment's previous
 * screen position, where the surface there was this one (its distance matches); 1 elsewhere.
 */
export const contactShadowNode: N = Fn(() => {
  const prev = screenUV.sub(velocity.xy.mul(vec2(0.5, -0.5)))
  const s = maskTexture.sample(prev)
  const d = positionView.z.negate()
  const inside = prev.x.greaterThan(0).and(prev.x.lessThan(1)).and(prev.y.greaterThan(0)).and(prev.y.lessThan(1))
  const same = abs(s.g.sub(d)).lessThan(d.mul(0.04).add(0.08))
  const v = select(inside.and(same), s.r, float(1))
  return mix(float(1), v, contactU.active)
})()

let _state: any
const _m = new THREE.Matrix4()

class ContactShadowNode extends THREE.Node {
  depthNode: N
  camera: THREE.PerspectiveCamera
  steps: number
  scale: number
  private _rt = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
  private _quad = new (THREE.QuadMesh as N)() as THREE.QuadMesh
  private _material: THREE.NodeMaterial | null = null
  private _out: N

  constructor(depthNode: N, camera: THREE.PerspectiveCamera, steps: number, scale: number) {
    super('vec4')
    this.depthNode = depthNode
    this.camera = camera
    this.steps = steps
    this.scale = scale
    this._rt.texture.name = 'ContactShadows'
    this._out = passTexture(this as N, this._rt.texture)
    this.updateBeforeType = THREE.NodeUpdateType.FRAME
  }

  getTextureNode() {
    return this._out
  }

  updateBefore(frame: THREE.NodeFrame): boolean | undefined {
    const renderer = frame.renderer as THREE.WebGPURenderer
    // The mask has a fixed size, set once: it is sampled by uv, and the scene's materials hold it, so it
    // must never be resized under them (a resize destroys the texture they are bound to).
    if (this._rt.width === 1) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2())
      this._rt.setSize(Math.max(64, Math.round(size.x * this.scale)), Math.max(36, Math.round(size.y * this.scale)))
    }
    // the projection the depth buffer was drawn with (jittered by the TAA, which is still in effect)
    contactU.proj.value.copy(this.camera.projectionMatrix)
    contactU.projInv.value.copy(this.camera.projectionMatrixInverse)
    contactU.frame.value = (contactU.frame.value + 1) % 64
    _state = THREE.RendererUtils.resetRendererState(renderer, _state)
    this._quad.material = this._material!
    this._quad.name = 'Contact Shadows'
    renderer.setRenderTarget(this._rt)
    this._quad.render(renderer)
    THREE.RendererUtils.restoreRendererState(renderer, _state)
    // the materials read it from the next frame on
    maskTexture.value = this._rt.texture
    return undefined
  }

  setup(builder: N) {
    this.depthNode.build(builder)
    const depth = this.depthNode
    const steps = this.steps
    const node = Fn(() => {
      const p = uv()
      const d0 = depth.sample(p).r
      const out = vec4(1, 1e4, 0, 1).toVar()
      // sky: nothing to shadow
      tsl.If(d0.lessThan(0.9999995), () => {
        const P = getViewPosition(p, d0, contactU.projInv).toVar()
        const dist = P.z.negate()
        // the ray grows with distance (a pixel covers more ground further away), as does the
        // thickness that things in front of the ray are assumed to have
        const len = clamp(dist.mul(0.012), 0.1, 1.6)
        const thick = dist.mul(0.02).add(0.15)
        const bias = dist.mul(0.0015).add(0.01)
        const jitter = interleavedGradientNoise(screenCoordinate.xy.add(float(contactU.frame).mul(5.588238)))
        const occ = float(0).toVar()
        for (let i = 0; i < steps; i++) {
          const t = float(i).add(jitter).div(steps).mul(len)
          const Q = P.add(contactU.sunView.mul(t))
          const sp = getScreenPosition(Q, contactU.proj)
          const inside = sp.x.greaterThan(0).and(sp.x.lessThan(1)).and(sp.y.greaterThan(0)).and(sp.y.lessThan(1))
          const ds = depth.sample(sp).r
          const zs = getViewPosition(sp, ds, contactU.projInv).z
          // the depth buffer has something in front of the ray here, not too far in front
          const front = zs.sub(Q.z)
          const hit = inside.and(front.greaterThan(bias)).and(front.lessThan(thick)).and(ds.lessThan(0.9999995))
          // softer towards the end of the ray (penumbra)
          occ.assign(max(occ, select(hit, float(1).sub(t.div(len).mul(0.6)), float(0))))
        }
        out.assign(vec4(float(1).sub(occ), dist, 0, 1))
      })
      return out
    })()
    const m = new THREE.NodeMaterial()
    m.contextNode = context(builder.getSharedContext())
    m.fragmentNode = node
    m.name = 'ContactShadows'
    m.needsUpdate = true
    this._material?.dispose()
    this._material = m
    builder.getNodeProperties(this).depthNode = this.depthNode
    return this._out
  }

  dispose() {
    this._rt.dispose()
    this._material?.dispose()
    if (maskTexture.value === this._rt.texture) maskTexture.value = blank
    super.dispose()
  }
}

/**
 * @param depth  the scene pass's depth texture node
 * @param steps  ray steps per pixel
 * @param scale  resolution of the mask relative to the depth buffer
 */
export function contactShadows(depth: N, camera: THREE.PerspectiveCamera, steps = 16, scale = 0.5) {
  mainCamera = camera
  contactOn = true
  return new ContactShadowNode(depth, camera, steps, scale)
}

/** No contact shadows (the materials' term is 1). */
export function contactShadowsOff() {
  contactOn = false
  maskTexture.value = blank
}

const _v = new THREE.Vector3()
/** Keeps the sun's direction in the main camera's view space current (call once per frame). */
export function updateContactShadows(camera: THREE.Camera, sunDir: THREE.Vector3) {
  mainCamera = camera
  _m.copy(camera.matrixWorldInverse)
  contactU.sunView.value.copy(_v.copy(sunDir).transformDirection(_m))
}
