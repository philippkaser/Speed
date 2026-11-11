// Temporal anti-aliasing: each frame is rendered with a different sub-pixel offset of the projection
// (a Halton sequence), and the result is accumulated with the reprojected history of earlier frames.
// Edges, the catch fence's wires, grass blades, leaves and specular glints, all smaller than a pixel,
// are resolved over several frames instead of crawling and sparkling as single samples do; the noise
// of the screen-space GI converges the same way.
//
// The resolve (per pixel):
//  - Motion: the velocity target's per-frame motion of the closest surface in the 3 x 3 neighbourhood
//    (so an edge takes the motion of the object in front, not of what is behind it).
//  - History: last frame's result at the reprojected position, read with a 5-tap Catmull-Rom filter
//    (bilinear history reads blur the image a little more every frame).
//  - Rejection by motion, not by depth: the history is only trusted where the surface there last
//    frame moved like the surface here now. Last frame's velocity target is kept and compared at the
//    reprojected position. In a tracking shot the road just uncovered behind a car moves fast while
//    the car that covered it last frame did not, so the road takes none of the car's history, at any
//    distance. (three's TAA told surfaces apart by depth with fixed thresholds, which at 100 m cannot
//    separate a car from the road behind it: the road kept the car's history and the cars smeared.)
//  - Clipping: the history is clipped towards the current 3 x 3 neighbourhood's colour box (YCoCg,
//    variance clipping, Salvi 2016), which removes what the motion test cannot see (changes of light,
//    reflections, transparent surfaces).
//  - Blend in a tonemapped space (Karis 2014): a bright glint cannot dominate its neighbours' history
//    and flicker. The current frame weighs 7% (with the tight
//    reconstruction kernel, 10% let the jitter through as shimmer on asphalt and edges) (more when the history is uncertain or the pixel moves
//    fast, so fast motion stays sharp), 100% after a camera cut or where the history is rejected.
import * as THREE from 'three/webgpu'
import * as tsl from 'three/tsl'
import { velocity } from 'three/tsl'

type N = any

const { Fn, If, abs, clamp, context, float, floor, int, ivec2, length, max, min, mix, passTexture, select, smoothstep, sqrt, texture, uniform, uv, vec2, vec3, vec4, OnAfterRenderPipeline, OnBeforeRenderPipeline } = tsl as N

export const taaU = {
  /** 1 on the frame of a camera cut: the history is dropped */
  reset: uniform(0),
  /** weight of the current frame where the history is trusted and still (at native resolution) */
  alpha: uniform(0.07),
  /** variance clipping width (standard deviations) */
  gamma: uniform(1.0),
  /** sharpness of the current frame's reconstruction kernel exp(-k d^2) (d in input pixels) at native
   *  resolution. Converged over the jitter sequence, the result is the pixel's box supersample
   *  convolved with this kernel: UE4's 2.29 (sigma 0.47 px) leaves a visibly soft image; 5 (sigma
   *  0.32 px) is close to the box alone. When upscaling it widens towards 2.29 (fewer samples per
   *  output pixel). */
  kernel: uniform(5.0),
}

/**
 * Internal render scale (per axis) of the scene and everything drawn from the G-buffer; the TAA
 * reconstructs the output resolution from it (temporal upscaling). Owned by the dynamic resolution
 * controller (dynamicRes.ts) and the scene pass in PostFX.
 */
export const renderScale = { value: 1 }

/** Halton (2, 3) sub-pixel offsets in [-0.5, 0.5] px. */
function halton(i: number, b: number) {
  let f = 1,
    r = 0
  while (i > 0) {
    f /= b
    r += f * (i % b)
    i = Math.floor(i / b)
  }
  return r
}
const JITTER = Array.from({ length: 64 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5])
/**
 * Phases of the jitter sequence: 8 per output pixel's share of an input pixel (as FSR 2 and UE's
 * TSR do), so at any upscale ratio every output pixel sees a sample close to its centre within the
 * sequence.
 */
const jitterPhases = (scale: number) => Math.max(8, Math.min(64, Math.ceil(8 / (scale * scale))))

let _state: any
const _size = new THREE.Vector2()

function target(name: string, filter: THREE.MagnificationTextureFilter) {
  const rt = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType, minFilter: filter, magFilter: filter })
  rt.texture.name = name
  rt.texture.generateMipmaps = false
  return rt
}

/** RGB <-> YCoCg (the clipping box is tighter around real colour distributions in YCoCg). */
const toYCoCg = (c: N) => vec3(c.dot(vec3(0.25, 0.5, 0.25)), c.dot(vec3(0.5, 0, -0.5)), c.dot(vec3(-0.25, 0.5, -0.25)))
const fromYCoCg = (c: N) => vec3(c.x.add(c.y).sub(c.z), c.x.add(c.z), c.x.sub(c.y).sub(c.z))
/**
 * Finite, non-negative colour: NaN and infinities become 0 (a comparison with NaN is false). One bad
 * pixel in the history would otherwise stay there for good and spread through the history filter.
 */
const finite = (c: N) => {
  const ch = (x: N) => select(x.lessThan(65000), max(x, 0), float(0))
  return vec3(ch(c.x), ch(c.y), ch(c.z))
}
/** Reversible tonemap for blending HDR (Karis): x / (1 + max) and back. */
const compress = (c: N) => c.div(max(max(c.r, c.g), c.b).add(1))
const expand = (c: N) => c.div(max(float(1).sub(max(max(c.r, c.g), c.b)), 1e-4))

class TemporalAANode extends THREE.Node {
  colorNode: N
  depthNode: N
  velocityNode: N
  camera: THREE.PerspectiveCamera
  private _history = [target('TAA.historyA', THREE.LinearFilter), target('TAA.historyB', THREE.LinearFilter)]
  private _prevVel = target('TAA.previousVelocity', THREE.NearestFilter)
  private _read = texture(this._history[1].texture)
  private _out: N
  private _flip = 0
  private _materials: THREE.NodeMaterial[] = []
  private _quad = new (THREE.QuadMesh as N)() as THREE.QuadMesh
  /** output (history) size, input (scene) size, this frame's jitter in input pixels */
  private _outSize = uniform(new THREE.Vector2(1, 1))
  private _inSize = uniform(new THREE.Vector2(1, 1))
  private _jitterPx = uniform(new THREE.Vector2(0, 0))
  /** output pixels per input pixel (>= 1 when upscaling) */
  private _ratio = uniform(1)
  private _jitter = 0
  private _phases = 8
  private _unjittered = new THREE.Matrix4()
  /** frames since the history (re)started: the first frame has nothing to blend with */
  private _frames = 0

  constructor(colorNode: N, depthNode: N, velocityNode: N, camera: THREE.PerspectiveCamera) {
    super('vec4')
    this.colorNode = colorNode
    this.depthNode = depthNode
    this.velocityNode = velocityNode
    this.camera = camera
    this._out = passTexture(this as N, this._history[0].texture)
    this.updateBeforeType = THREE.NodeUpdateType.FRAME
  }

  getTextureNode() {
    return this._out
  }

  /** Drops the history (a camera cut). */
  restart() {
    this._frames = 0
  }

  /**
   * Jitters the projection by a sub-pixel offset of the INPUT grid (the scene renders at the internal
   * resolution): the sample of input pixel i lies at i + 0.5 + jitter (y down, as uv).
   */
  private jitter(outW: number, outH: number) {
    const c = this.camera
    c.updateProjectionMatrix()
    this._unjittered.copy(c.projectionMatrix)
    // the motion vectors are drawn with the unjittered projection
    ;(velocity as N).setProjectionMatrix(this._unjittered)
    const s = renderScale.value
    const inW = Math.max(1, Math.floor(outW * s)),
      inH = Math.max(1, Math.floor(outH * s))
    this._phases = jitterPhases(s)
    const [jx, jy] = JITTER[this._jitter % this._phases]
    this._jitterPx.value.set(jx, jy)
    c.setViewOffset(inW, inH, jx, jy, inW, inH)
  }

  private unjitter() {
    this.camera.clearViewOffset()
    ;(velocity as N).setProjectionMatrix(null)
    this._jitter = (this._jitter + 1) % this._phases
  }

  updateBefore(frame: THREE.NodeFrame): boolean | undefined {
    const renderer = frame.renderer as THREE.WebGPURenderer
    const color = this.colorNode.value as THREE.Texture
    const inW = Math.max(1, (color.image as { width: number }).width)
    const inH = Math.max(1, (color.image as { height: number }).height)
    const out = renderer.getDrawingBufferSize(_size)
    const W = Math.max(1, out.x),
      H = Math.max(1, out.y)
    const cur = this._flip,
      prev = 1 - cur
    this._flip = prev
    if (this._history[cur].width !== W || this._history[cur].height !== H) {
      for (const rt of this._history) rt.setSize(W, H)
      this._frames = 0
    }
    if (this._prevVel.width !== inW || this._prevVel.height !== inH) {
      this._prevVel.setSize(inW, inH)
      this._frames = 0
    }
    this._outSize.value.set(W, H)
    this._inSize.value.set(inW, inH)
    this._ratio.value = Math.max(1, W / inW)
    taaU.reset.value = this._frames === 0 ? 1 : 0
    this._read.value = this._history[prev].texture
    this._out.value = this._history[cur].texture
    _state = THREE.RendererUtils.resetRendererState(renderer, _state)
    this._quad.material = this._materials[0]
    this._quad.name = 'TAA [ Resolve ]'
    renderer.setRenderTarget(this._history[cur])
    this._quad.render(renderer)
    THREE.RendererUtils.restoreRendererState(renderer, _state)
    // keep this frame's motion for next frame's rejection test
    const vel = this.velocityNode.value as THREE.Texture
    if ((vel.image as { width: number }).width === inW && (vel.image as { height: number }).height === inH) renderer.copyTextureToTexture(vel, this._prevVel.texture)
    this._frames++
    return undefined
  }

  setup(builder: N) {
    this.colorNode.build(builder)
    this.depthNode.build(builder)
    this.velocityNode.build(builder)
    if (builder.renderPipeline && !builder.context.renderPipelineState.viewOffsetOwner) {
      builder.context.renderPipelineState.viewOffsetOwner = this
      OnBeforeRenderPipeline(() => {
        const s = builder.renderer.getDrawingBufferSize(_size)
        this.jitter(s.width, s.height)
      })
      OnAfterRenderPipeline(() => this.unjitter())
    }

    const color = this.colorNode
    const depth = this.depthNode
    const vel = this.velocityNode
    const prevVel = texture(this._prevVel.texture)
    const hist = this._read
    const outSize = this._outSize
    const inSize = this._inSize
    const jitterPx = this._jitterPx
    const ratio = this._ratio

    /** 5-tap Catmull-Rom (bilinear taps at the 1D filters' merged centres; corners dropped). */
    const catmullRom = (p: N) => {
      const size = outSize
      const sp = p.mul(size)
      const t1 = floor(sp.sub(0.5)).add(0.5)
      const f = sp.sub(t1)
      const w0 = f.mul(f.mul(float(1).sub(f.mul(0.5))).sub(0.5))
      const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1)
      const w2 = f.mul(f.mul(f.mul(-1.5).add(2)).add(0.5))
      const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5))
      const w12 = w1.add(w2)
      const t12 = t1.add(w2.div(w12)).div(size)
      const t0 = t1.sub(1).div(size)
      const t3 = t1.add(2).div(size)
      const s = (x: N, y: N) => hist.sample(vec2(x, y)).rgb
      const a = s(t12.x, t0.y).mul(w12.x.mul(w0.y))
      const b = s(t0.x, t12.y).mul(w0.x.mul(w12.y))
      const c = s(t12.x, t12.y).mul(w12.x.mul(w12.y))
      const d = s(t3.x, t12.y).mul(w3.x.mul(w12.y))
      const e = s(t12.x, t3.y).mul(w12.x.mul(w3.y))
      const wsum = w12.x.mul(w0.y).add(w0.x.mul(w12.y)).add(w12.x.mul(w12.y)).add(w3.x.mul(w12.y)).add(w12.x.mul(w3.y))
      return finite(a.add(b).add(c).add(d).add(e).div(wsum))
    }

    const resolve = Fn(() => {
      const p = uv()
      // this output pixel's centre on the input grid, and the input pixel whose (jittered) sample is
      // nearest to it: input pixel i is sampled at i + 0.5 + jitter
      const inPos = p.mul(inSize)
      const ip = ivec2(floor(inPos.sub(jitterPx)))
      const maxI = ivec2(int(inSize.x).sub(1), int(inSize.y).sub(1))
      const at = (dx: number, dy: number) => clamp(ip.add(ivec2(dx, dy)), ivec2(0), maxI)
      // neighbourhood statistics (tonemapped YCoCg) and the closest surface
      const m1 = vec3(0).toVar(),
        m2 = vec3(0).toVar()
      const lo = vec3(1e9).toVar(),
        hi = vec3(-1e9).toVar()
      const closest = float(2).toVar()
      const closestAt = ivec2(ip).toVar()
      // the current frame reconstructed at this output pixel: the 3 x 3 input samples weighted by a
      // Blackman-Harris-like kernel of their real (jittered) distance from the pixel centre, in input
      // pixels (Karis 2014, UE4 TAAU). `nearW` is the weight of the nearest sample in OUTPUT pixels:
      // how much this frame tells us about this output pixel (all of it at native resolution, little
      // when the nearest sample is half an input pixel away at a high upscale ratio)
      const recon = vec3(0).toVar()
      const reconW = float(0).toVar()
      const nearW = float(0).toVar()
      // tent-filtered neighbourhood (tonemapped YCoCg): stands in for the reconstruction where there is
      // no usable history, so disoccluded edges are smoothed instead of showing one jittered sample.
      // Only neighbours that move like this pixel count: never road into a car's outline, or car into road
      const tent = vec3(0).toVar()
      const tentW = float(0).toVar()
      const vOwn = vel.load(ip).xy
      const pxs = inSize.mul(0.5)
      const kk = max(taaU.kernel.div(ratio.mul(ratio)), 2.29).negate()
      for (const [dx, dy] of [
        [0, 0],
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1],
      ]) {
        const q = at(dx, dy)
        const c = finite(color.load(q).rgb)
        const y = toYCoCg(compress(c))
        // the sample's offset from this output pixel's centre (input pixels)
        const off = vec2(ip.add(ivec2(dx, dy))).add(0.5).add(jitterPx).sub(inPos)
        const d2 = off.dot(off)
        const w = tsl.exp(d2.mul(kk))
        recon.addAssign(y.mul(w))
        reconW.addAssign(w)
        nearW.assign(max(nearW, tsl.exp(max(d2.mul(ratio).mul(ratio).sub(0.25), 0).mul(-2.29))))
        m1.addAssign(y)
        m2.addAssign(y.mul(y))
        const same = float(1).sub(smoothstep(1, 3, length(vel.load(q).xy.sub(vOwn).mul(pxs))))
        const tw = same.mul(tsl.exp(d2.mul(-2.29)))
        tent.addAssign(y.mul(tw))
        tentW.addAssign(tw)
        lo.assign(min(lo, y))
        hi.assign(max(hi, y))
        const d = depth.load(q).r
        If(d.lessThan(closest), () => {
          closest.assign(d)
          closestAt.assign(q)
        })
      }
      const v = vel.load(closestAt).xy
      const histUV = p.sub(v.mul(vec2(0.5, -0.5)))
      // motion of whatever was at the history position last frame vs the motion here now (input pixels)
      const vPrev = prevVel.load(clamp(ivec2(floor(histUV.mul(inSize))), ivec2(0), maxI)).xy
      const px = inSize.mul(0.5)
      const speed = length(v.mul(px))
      const dv = length(v.sub(vPrev).mul(px))
      const reject = smoothstep(1, 3, dv.div(speed.mul(0.08).add(1)))
      const offscreen = select(histUV.x.lessThan(0).or(histUV.x.greaterThan(1)).or(histUV.y.lessThan(0)).or(histUV.y.greaterThan(1)), float(1), float(0))
      // history, clipped towards the neighbourhood's colour distribution
      const mean = m1.div(9)
      const sigma = sqrt(max(m2.div(9).sub(mean.mul(mean)), vec3(0)))
      const boxLo = max(lo, mean.sub(sigma.mul(taaU.gamma)))
      const boxHi = min(hi, mean.add(sigma.mul(taaU.gamma)))
      const h = toYCoCg(compress(catmullRom(histUV)))
      const centre = boxLo.add(boxHi).mul(0.5)
      const ext = boxHi.sub(boxLo).mul(0.5).add(1e-5)
      const off = h.sub(centre)
      const k = max(max(abs(off.x).div(ext.x), abs(off.y).div(ext.y)), abs(off.z).div(ext.z))
      const hc = select(k.greaterThan(1), centre.add(off.div(k)), h)
      // weight of this frame: more where the history is doubtful, or the pixel moves fast; scaled by
      // how close this frame's nearest sample is (upscaling: the history carries the detail between
      // the samples). Where the motion test fails, a quarter of the (clipped) history stays and the
      // current frame is tent-filtered: the pixel is anti-aliased spatially instead of crawling with
      // the jitter, and no more than a trace of another surface's history can survive
      const bad = max(reject, offscreen)
      const base = mix(taaU.alpha, float(0.3), smoothstep(8, 40, speed)).mul(mix(float(0.25), float(1), nearW))
      const a = max(max(base, bad.mul(0.75)), taaU.reset)
      const reconY = recon.div(max(reconW, 1e-5))
      const cur = mix(reconY, tent.div(max(tentW, 1e-5)), max(bad, taaU.reset).mul(0.6))
      const outY = mix(hc, cur, a)
      return vec4(finite(expand(max(fromYCoCg(outY), vec3(0)))), 1)
    })()

    const m = new THREE.NodeMaterial()
    m.contextNode = context(builder.getSharedContext())
    m.fragmentNode = resolve
    m.name = 'TAA_resolve'
    m.needsUpdate = true
    for (const o of this._materials) o.dispose()
    this._materials = [m]
    const props = builder.getNodeProperties(this)
    props.colorNode = this.colorNode
    props.depthNode = this.depthNode
    props.velocityNode = this.velocityNode
    return this._out
  }

  dispose() {
    for (const rt of [...this._history, this._prevVel]) rt.dispose()
    for (const m of this._materials) m.dispose()
    super.dispose()
  }
}

/**
 * Temporal anti-aliasing and upscaling: the scene renders at renderScale of the output resolution
 * with a sub-pixel jitter of the input grid; the resolve reconstructs every output pixel from the
 * nearby jittered samples and the reprojected, clipped history at the output resolution.
 *
 * @param color    texture node of the HDR image (internal resolution)
 * @param depth    the scene pass's depth texture node
 * @param velocity the scene pass's velocity texture node (motionHistory.ts)
 */
export function temporalAA(color: N, depth: N, velocity: N, camera: THREE.PerspectiveCamera) {
  return new TemporalAANode(color, depth, velocity, camera)
}
