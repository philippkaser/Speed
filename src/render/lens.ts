// The camera's lens: what a real lens adds between the scene and the sensor.
//
//  - Lens scatter (bloom): every lens spreads a share of all the light it passes over a wide,
//    long-tailed point-spread function (scattering in the glass and its coatings, reflections inside
//    the barrel, a little diffusion). There is no threshold: a sunlit kerb gets the same share as the
//    sun, energy is conserved (the scattered share is taken from the image), and only what is far
//    brighter than its surroundings shows a halo. The bright sky glows over the horizon, the car's
//    roof line and the A-pillars; looking into the sun veils the whole frame.
//
//    The PSF is a power law (energy density ~ r^-SLOPE) plus a "glow" bump at medium radii, built as
//    a weighted sum of the levels of a mip chain (Jimenez, "Next Generation Post Processing in Call of
//    Duty: Advanced Warfare", 2014): a 13-tap downsample from half resolution down to a few pixels,
//    then a 3 x 3 tent upsample that adds each level in with its weight. Each level doubles the PSF's
//    width, so the weights shape the PSF at every radius, and they are set in image heights: the lens
//    looks the same at every resolution.
//
//    Temporal stability: the first downsample takes a partial Karis average (each 2 x 2 group of
//    taps weighted by 1 / (1 + luma / KARIS)) and clamps each tap at CLAMP. A glint one pixel wide
//    (the sun in the clear coat, a wheel nut, the edge of a windscreen), which appears and disappears
//    from frame to frame as it slides between pixels, can then add no more to the halo than an
//    ordinary bright pixel; large bright areas (the sky, clouds, white walls) average as before.
//    That is what removes the one-frame fireflies: the old bloom resampled the full-resolution image
//    with single bilinear taps, so every such glint popped a halo in and out.
//
//  - The sun's glare is computed analytically from the sun's light, so it is exactly stable however the
//    sun's few pixels alias, and it continues when the sun is just outside the frame:
//      - its share of the lens scatter, with the same PSF (the scatter's input is clamped, so the
//        sun's own pixels leave it out);
//      - the diffraction star of the iris (aperture.ts: FFT of a 7-bladed iris, spectral), its spikes
//        widened by the size of the sun's disc on screen (a mip level of the star texture);
//      - ghosts: reflections between the lens elements, images of the iris strung along the line from
//        the sun through the centre of the frame, each a heptagon with the coating's tint and a little
//        dispersion at its rim, its energy spread over its area (big ghosts are faint).
//    How much of the sun is visible is measured on the GPU: 32 depth samples across the sun's disc
//    (sky = nothing in front of it), smoothed over two frames, read by the glare in the same frame.
//
//  - Lateral chromatic aberration: the lens focuses red slightly further out than blue, growing with
//    the square of the distance from the centre.
//  - Natural vignetting: the cos^4 law of the off-axis angle (taken from the lens's real field of
//    view, so a TV camera's long lens barely darkens its corners and a wide chase camera does),
//    partly corrected as real lenses are.
import * as THREE from 'three/webgpu'
import * as tsl from 'three/tsl'
import { IRIS, STAR_EXTENT, STAR_SIZE, starTexture } from './aperture'

type N = any

const { Fn, If, atan, clamp, context, cos, exp, float, length, max, min, mix, mod, passTexture, select, smoothstep, texture, uniform, uniformArray, uv, vec2, vec3, vec4 } = tsl as N

/** Most mip levels of the scatter chain (half resolution down to 2 px at 4K). */
export const MAX_LEVELS = 10

/** The lens's point-spread function. */
export const SCATTER = {
  /** share of all light the lens scatters (taken from the image, spread over the PSF). A modern
   *  multi-coated broadcast or cinema lens: enough for the sky to glow over a roof line, not the milky
   *  veil over the whole frame that 12% gave */
  k: 0.05,
  /** power-law slope of the PSF's energy density (r^-slope): smaller = a longer veil */
  slope: 2.45,
  /** share of the scattered light in a glow at medium radii (diffusion), and its radius in image heights */
  glow: 0.45,
  glowSigma: 0.015,
  /** finest PSF component, in image heights */
  minSigma: 0.0025,
}

/** Karis average strength (luma at which a group's weight halves) and the per-tap clamp of the scatter's input. */
const KARIS = 4
const CLAMP = 64

/** The sun's diffraction star: share of the sun's light in the spikes. */
const STAR_GAIN = 0.012

/** Ghosts: position on the axis sun -> centre (1 = the sun, 0 = centre), radius (image heights), share of the sun's light, coating tint, dispersion. */
const GHOSTS: [number, number, number, [number, number, number], number][] = [
  [-0.15, 0.008, 0.7e-4, [1.0, 0.6, 0.85], 0.06],
  [-0.3, 0.018, 1.8e-4, [0.55, 1.0, 0.65], 0.06],
  [-0.55, 0.04, 2.8e-4, [1.0, 0.72, 0.42], 0.05],
  [-0.85, 0.075, 4.2e-4, [0.75, 0.55, 1.0], 0.04],
  [-1.25, 0.14, 6.3e-4, [0.55, 0.85, 1.0], 0.03],
  [-1.75, 0.3, 9.0e-4, [0.8, 0.9, 1.0], 0.02],
  [0.4, 0.011, 0.8e-4, [1.0, 0.85, 0.55], 0.06],
  [0.7, 0.028, 1.4e-4, [0.6, 1.0, 0.8], 0.05],
]

/** Angular radius of the sun (radians). */
const SUN_RADIUS = 0.00465

export const lensU = {
  /** tan of half the vertical field of view */
  tanHalfFov: uniform(Math.tan((58 * Math.PI) / 360)),
  aspect: uniform(16 / 9),
  /** the sun: screen position (uv, y down), its light at the sensor (exposed units x image heights^2, rgb), radius on screen */
  sunUv: uniform(new THREE.Vector2(0.5, 0.5)),
  sunLight: uniform(new THREE.Vector3(0, 0, 0)),
  /** radius of the sun's disc in uv (x, y) */
  sunRadiusUv: uniform(new THREE.Vector2(0.004, 0.004)),
  /** mip level of the star texture that matches the sun's disc */
  starLod: uniform(2),
  /** weight of this frame's visibility reading (1 after a cut) */
  visBlend: uniform(0.5),
  /** per scatter level: energy (k included) and 1 / (2 sigma^2) in image heights, for the sun's halo */
  haloA: uniformArray(new Array(MAX_LEVELS).fill(0), 'float'),
  haloB: uniformArray(new Array(MAX_LEVELS).fill(1), 'float'),
}

/** Standard deviation of scatter level i's PSF in output pixels (measured on a model of the chain). */
const levelSigmaPx = (i: number) => (i === 0 ? 1.73 : 2.36 * 2 ** i)

/** Number of scatter levels for an output height: down to 2-3 pixels. */
export const scatterLevels = (height: number) => Math.max(3, Math.min(MAX_LEVELS, Math.ceil(Math.log2(Math.max(8, height))) - 2))

/** Energy per scatter level (summing to SCATTER.k) and each level's sigma in image heights. */
export function scatterWeights(height: number) {
  const L = scatterLevels(height)
  const s: number[] = [],
    p: number[] = [],
    g: number[] = []
  for (let i = 0; i < L; i++) {
    // the coarsest levels are bounded by the size of the image
    const si = Math.min(levelSigmaPx(i), 0.45 * height) / height
    s.push(si)
    const t = Math.min(1, Math.max(0, (si - SCATTER.minSigma * 0.5) / (SCATTER.minSigma * 0.5)))
    p.push(si ** (2 - SCATTER.slope) * t * t * (3 - 2 * t))
    g.push(Math.exp(-0.5 * (Math.log(si / SCATTER.glowSigma) / 0.7) ** 2))
  }
  const ps = p.reduce((a, b) => a + b, 0) || 1,
    gs = g.reduce((a, b) => a + b, 0) || 1
  const a = p.map((v, i) => SCATTER.k * ((1 - SCATTER.glow) * (v / ps) + SCATTER.glow * (g[i] / gs)))
  return { a, s, levels: L }
}

// ------------------------------------------------------------------------------------------ scatter

let _state: any

function rt(name: string) {
  const r = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
  r.texture.name = name
  r.texture.generateMipmaps = false
  return r
}

const LUMA = [0.2126, 0.7152, 0.0722]

/** The 13 taps of the downsample, in source texels, as five overlapping 2 x 2 groups with their weights. */
const GROUPS: [number, [number, number][]][] = [
  [0.5, [[-1, -1], [1, -1], [-1, 1], [1, 1]]],
  [0.125, [[-2, -2], [0, -2], [-2, 0], [0, 0]]],
  [0.125, [[0, -2], [2, -2], [0, 0], [2, 0]]],
  [0.125, [[-2, 0], [0, 0], [-2, 2], [0, 2]]],
  [0.125, [[0, 0], [2, 0], [0, 2], [2, 2]]],
]

class LensScatterNode extends THREE.Node {
  inputNode: N
  private _down = Array.from({ length: MAX_LEVELS }, (_, i) => rt('LensScatter.down' + i))
  private _up = Array.from({ length: MAX_LEVELS }, (_, i) => rt('LensScatter.up' + i))
  private _texel = Array.from({ length: MAX_LEVELS }, () => uniform(new THREE.Vector2(1, 1)))
  private _weight = Array.from({ length: MAX_LEVELS }, () => uniform(0))
  private _hasCoarser = Array.from({ length: MAX_LEVELS }, () => uniform(0))
  private _prefilter: THREE.NodeMaterial | null = null
  private _downM: THREE.NodeMaterial[] = []
  private _upM: THREE.NodeMaterial[] = []
  private _quad = new (THREE.QuadMesh as N)() as THREE.QuadMesh
  private _textureNode: N
  private _height = 0
  levels = 0

  constructor(inputNode: N) {
    super('vec4')
    this.inputNode = inputNode
    this._textureNode = passTexture(this as N, this._up[0].texture)
    this.updateBeforeType = THREE.NodeUpdateType.FRAME
  }

  getTextureNode() {
    return this._textureNode
  }

  updateBefore(frame: THREE.NodeFrame): boolean | undefined {
    const renderer = frame.renderer as THREE.WebGPURenderer
    const src = this.inputNode.value as THREE.Texture
    const W = Math.max(1, (src.image as { width: number }).width)
    const H = Math.max(1, (src.image as { height: number }).height)
    if (H !== this._height) {
      this._height = H
      const { a, s, levels } = scatterWeights(H)
      this.levels = levels
      for (let i = 0; i < MAX_LEVELS; i++) {
        this._weight[i].value = a[i] ?? 0
        this._hasCoarser[i].value = i < levels - 1 ? 1 : 0
        lensU.haloA.array[i] = a[i] ?? 0
        lensU.haloB.array[i] = 1 / (2 * (s[i] ?? 1) ** 2)
      }
    }
    const L = this.levels
    let w = W,
      h = H
    for (let i = 0; i < L; i++) {
      // each level samples the one above it: its texel size is the source's
      this._texel[i].value.set(1 / w, 1 / h)
      w = Math.max(1, Math.ceil(w / 2))
      h = Math.max(1, Math.ceil(h / 2))
      this._down[i].setSize(w, h)
      this._up[i].setSize(w, h)
    }
    _state = THREE.RendererUtils.resetRendererState(renderer, _state)
    const pass = (target: THREE.RenderTarget, m: THREE.NodeMaterial, name: string) => {
      this._quad.material = m
      this._quad.name = name
      renderer.setRenderTarget(target)
      this._quad.render(renderer)
    }
    pass(this._down[0], this._prefilter!, 'Lens Scatter [ Prefilter ]')
    for (let i = 1; i < L; i++) pass(this._down[i], this._downM[i], `Lens Scatter [ Down ${i} ]`)
    for (let i = L - 1; i >= 0; i--) pass(this._up[i], this._upM[i], `Lens Scatter [ Up ${i} ]`)
    THREE.RendererUtils.restoreRendererState(renderer, _state)
    return undefined
  }

  setup(builder: N) {
    this.inputNode.build(builder)
    const luma = (c: N) => c.dot(vec3(...LUMA))
    /** 13-tap downsample around this texel; karis: partial Karis average and per-tap clamp */
    const down13 = (tex: N, texel: N, karis: boolean) =>
      Fn(() => {
        const p = uv()
        const acc = vec3(0).toVar()
        const wsum = float(0).toVar()
        for (const [gw, taps] of GROUPS) {
          let g: N = vec3(0)
          for (const [dx, dy] of taps) {
            const c = tex.sample(p.add(texel.mul(vec2(dx, dy)))).rgb
            g = g.add(karis ? min(max(c, vec3(0)), vec3(CLAMP)) : c)
          }
          g = g.mul(0.25)
          const wk = karis ? float(gw).div(luma(g).div(KARIS).add(1)) : float(gw)
          acc.addAssign(g.mul(wk))
          wsum.addAssign(wk)
        }
        return vec4(acc.div(wsum), 1)
      })()
    /** 3 x 3 tent upsample of the coarser level, plus this level's own share */
    const up = (i: number) =>
      Fn(() => {
        const p = uv()
        const own = texture(this._down[i].texture).sample(p).rgb.mul(this._weight[i])
        // (the coarsest possible level has nothing below it: bind any other target, never its own)
        const coarse = texture((i + 1 < MAX_LEVELS ? this._up[i + 1] : this._down[i]).texture)
        // the coarser level's texel is twice this level's; this level's texel = its source's x 2
        const t = this._texel[i].mul(4)
        let acc: N = vec3(0)
        for (const [dx, dy, wt] of [
          [-1, -1, 1],
          [0, -1, 2],
          [1, -1, 1],
          [-1, 0, 2],
          [0, 0, 4],
          [1, 0, 2],
          [-1, 1, 1],
          [0, 1, 2],
          [1, 1, 1],
        ])
          acc = acc.add(coarse.sample(p.add(t.mul(vec2(dx, dy)))).rgb.mul(wt / 16))
        return vec4(own.add(select(this._hasCoarser[i].greaterThan(0.5), acc, vec3(0))), 1)
      })()

    const mk = (node: N, name: string) => {
      const m = new THREE.NodeMaterial()
      m.contextNode = context(builder.getSharedContext())
      m.fragmentNode = node
      m.name = name
      m.needsUpdate = true
      return m
    }
    this._prefilter?.dispose()
    for (const m of [...this._downM, ...this._upM]) m?.dispose()
    this._prefilter = mk(down13(this.inputNode, this._texel[0], true), 'LensScatter_prefilter')
    this._downM = [this._prefilter]
    for (let i = 1; i < MAX_LEVELS; i++) this._downM.push(mk(down13(texture(this._down[i - 1].texture), this._texel[i], false), 'LensScatter_down' + i))
    this._upM = []
    for (let i = 0; i < MAX_LEVELS; i++) this._upM.push(mk(up(i), 'LensScatter_up' + i))
    builder.getNodeProperties(this).inputNode = this.inputNode
    return this._textureNode
  }

  dispose() {
    for (const r of [...this._down, ...this._up]) r.dispose()
    for (const m of new Set([...this._downM, ...this._upM])) m.dispose()
    this._downM = []
    this._upM = []
    super.dispose()
  }
}

/** The lens scatter of an exposed HDR image (texture node): half resolution, energy SCATTER.k. */
export function lensScatter(exposed: N) {
  return new LensScatterNode(exposed)
}

/**
 * Full-resolution read of the scatter (half resolution): four bilinear taps half a texel apart, a
 * small tent that hides the half-resolution grid.
 */
export function scatterUpsample(scatter: N, texelFull: N): N {
  const p = uv()
  let acc: N = vec3(0)
  for (const [dx, dy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ])
    acc = acc.add(scatter.sample(p.add(texelFull.mul(vec2(dx, dy)))).rgb)
  return acc.mul(0.25)
}

// ------------------------------------------------------------------------------------------ sun

const VIS_TAPS = 32

/** How much of the sun's disc is unoccluded, measured from the depth buffer and smoothed over frames. */
class SunVisibilityNode extends THREE.Node {
  depthNode: N
  private _rts = [0, 1].map((i) => {
    const r = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
    r.texture.name = 'SunVisibility' + i
    return r
  })
  private _prevTex = texture(this._rts[1].texture)
  private _materials: THREE.NodeMaterial[] = []
  private _quad = new (THREE.QuadMesh as N)() as THREE.QuadMesh
  private _flip = 0
  private _out: N

  constructor(depthNode: N) {
    super('float')
    this.depthNode = depthNode
    this._out = texture(this._rts[0].texture)
    this.updateBeforeType = THREE.NodeUpdateType.FRAME
  }

  /** this frame's visibility (0..1) */
  getVisibility(): N {
    return this._out.sample(vec2(0.5)).r
  }

  updateBefore(frame: THREE.NodeFrame): boolean | undefined {
    const renderer = frame.renderer as THREE.WebGPURenderer
    const cur = this._flip,
      prev = 1 - cur
    this._flip = prev
    this._prevTex.value = this._rts[prev].texture
    this._out.value = this._rts[cur].texture
    _state = THREE.RendererUtils.resetRendererState(renderer, _state)
    this._quad.material = this._materials[0]
    this._quad.name = 'Sun Visibility'
    renderer.setRenderTarget(this._rts[cur])
    this._quad.render(renderer)
    THREE.RendererUtils.restoreRendererState(renderer, _state)
    return undefined
  }

  setup(builder: N) {
    this.depthNode.build(builder)
    const node = Fn(() => {
      const acc = float(0).toVar()
      // Vogel spiral across the disc (at least ~1.5 px wide, so it never hangs on one pixel)
      for (let i = 0; i < VIS_TAPS; i++) {
        const r = Math.sqrt((i + 0.5) / VIS_TAPS)
        const a = i * 2.39996323
        const p = lensU.sunUv.add(lensU.sunRadiusUv.mul(vec2(Math.cos(a) * r, Math.sin(a) * r)))
        const inside = p.x.greaterThan(0).and(p.x.lessThan(1)).and(p.y.greaterThan(0)).and(p.y.lessThan(1))
        const d = this.depthNode.sample(clamp(p, vec2(0), vec2(1))).r
        // nothing drawn in front of the sky; off screen the sun counts as visible (its glare fades with distance)
        acc.addAssign(select(inside, select(d.greaterThanEqual(0.9999995), float(1), float(0)), float(1)))
      }
      const v = acc.div(VIS_TAPS)
      return vec4(mix(this._prevTex.sample(vec2(0.5)).r, v, lensU.visBlend), 0, 0, 1)
    })()
    const m = new THREE.NodeMaterial()
    m.contextNode = context(builder.getSharedContext())
    m.fragmentNode = node
    m.name = 'SunVisibility'
    m.needsUpdate = true
    for (const o of this._materials) o.dispose()
    this._materials = [m]
    builder.getNodeProperties(this).depthNode = this.depthNode
    return this.getVisibility()
  }

  dispose() {
    for (const r of this._rts) r.dispose()
    for (const m of this._materials) m.dispose()
    super.dispose()
  }
}

export function sunVisibility(depthNode: N) {
  return new SunVisibilityNode(depthNode)
}

/** Polygonal iris metric: 1 on the edge of a regular IRIS.blades-gon of circumradius 1, 0 at the centre. */
const irisMetric = (q: N) => {
  const seg = (2 * Math.PI) / IRIS.blades
  const a = mod(atan(q.y, q.x).sub(IRIS.rotation).add(Math.PI * 8), seg).sub(seg / 2)
  return length(q).mul(cos(a)).div(Math.cos(Math.PI / IRIS.blades) * (1 - IRIS.roundness) + IRIS.roundness)
}

/**
 * The sun's glare at this pixel (exposed units): its share of the lens scatter, the diffraction star
 * and, with `ghosts`, the lens's ghosts. `visible` is the sun's measured visibility (0..1).
 */
export function sunGlare(visible: N, ghosts: boolean): N {
  const star = texture(starTexture())
  return Fn(() => {
    const out = vec3(0).toVar()
    const light = lensU.sunLight.mul(visible)
    If(light.dot(vec3(1)).greaterThan(1e-7), () => {
      const p = uv()
      const asp = vec2(lensU.aspect, 1)
      // offset from the sun, in image heights (y down)
      const d = p.sub(lensU.sunUv).mul(asp)
      const r2 = d.dot(d)
      // 1. the sun's share of the lens scatter: the scatter's own PSF, as a sum of Gaussians
      const halo = float(0).toVar()
      for (let i = 0; i < MAX_LEVELS; i++) halo.addAssign(lensU.haloA.element(i).mul(lensU.haloB.element(i)).mul(1 / Math.PI).mul(exp(r2.mul(lensU.haloB.element(i)).negate())))
      out.addAssign(light.mul(halo))
      // 2. the diffraction star (energy per texel, mean 1, over STAR_EXTENT^2 image heights^2)
      const st = d.div(STAR_EXTENT).add(0.5)
      const edge = max(st.x.sub(0.5).abs(), st.y.sub(0.5).abs())
      const s = star.sample(st).level(lensU.starLod).rgb.mul(smoothstep(0.5, 0.44, edge))
      out.addAssign(light.mul(s).mul(STAR_GAIN / (STAR_EXTENT * STAR_EXTENT)))
      // 3. ghosts along the axis from the sun through the centre
      if (ghosts) {
        const c = p.sub(0.5).mul(asp)
        const sc = lensU.sunUv.sub(0.5).mul(asp)
        for (const [t, rad, e, tint, disp] of GHOSTS) {
          const q = c.sub(sc.mul(t)).div(rad)
          const m = irisMetric(q)
          // the edge is soft (the ghost is out of focus); red reaches further out than blue
          const soft = 0.2 + Math.min(0.15, rad)
          const col = vec3(
            clamp(float(1 + disp).sub(m).div(soft).add(0.5), 0, 1),
            clamp(float(1).sub(m).div(soft).add(0.5), 0, 1),
            clamp(float(1 - disp).sub(m).div(soft).add(0.5), 0, 1),
          )
          const area = Math.PI * rad * rad * 0.94
          out.addAssign(light.mul(col).mul(vec3(...tint)).mul(e / area))
        }
      }
    })
    return out
  })()
}

// ------------------------------------------------------------------------------------------ optics

/** Lateral chromatic aberration: red and blue sampled at slightly different radii. */
export function lateralCA(exposed: N, strength = 0.0009): N {
  const p = uv()
  const d = p.sub(0.5)
  const r2 = d.mul(vec2(lensU.aspect, 1)).dot(d.mul(vec2(lensU.aspect, 1))).div(lensU.aspect.mul(lensU.aspect).add(1).mul(0.25))
  const k = r2.mul(strength)
  const r = exposed.sample(d.mul(float(1).add(k)).add(0.5)).r
  const g = exposed.sample(p).g
  const b = exposed.sample(d.mul(float(1).sub(k)).add(0.5)).b
  return vec3(r, g, b)
}

/** Natural vignetting: cos^4 of the off-axis angle, `amount` of it (real lenses correct the rest). */
export function naturalVignette(amount: N = 0.4): N {
  const d = uv().sub(0.5).mul(2)
  const tanTheta = length(d.mul(vec2(lensU.aspect, 1)).mul(lensU.tanHalfFov))
  const c2 = float(1).div(tanTheta.mul(tanTheta).add(1))
  return mix(float(1), c2.mul(c2), amount)
}

const _v = new THREE.Vector3()

/**
 * Keeps the lens uniforms in step with the camera, the drawing buffer and the sun. `sun` is the sun's
 * direction, colour and strength (the directional light), `exposure` the camera's total exposure.
 */
export function updateLens(camera: THREE.Camera, width: number, height: number, sun?: { dir: THREE.Vector3; color: THREE.Color; intensity: number }, exposure = 1, cut = false) {
  const pc = camera as THREE.PerspectiveCamera
  const t = pc.isPerspectiveCamera ? Math.tan((pc.fov * Math.PI) / 360) / pc.zoom : lensU.tanHalfFov.value
  lensU.tanHalfFov.value = t
  const aspect = width / Math.max(1, height)
  lensU.aspect.value = aspect
  lensU.visBlend.value = cut ? 1 : 0.5
  lensU.sunLight.value.set(0, 0, 0)
  if (!sun || sun.intensity <= 0 || !pc.isPerspectiveCamera) return
  // the sun in view space: behind the camera it has no glare
  pc.updateMatrixWorld()
  _v.copy(sun.dir).transformDirection(pc.matrixWorldInverse)
  if (_v.z > -1e-3) return
  const x = -_v.x / _v.z / (t * aspect),
    y = -_v.y / _v.z / t
  const u = x * 0.5 + 0.5,
    v = 0.5 - y * 0.5
  lensU.sunUv.value.set(u, v)
  // the sun's light at the sensor: radiance x disc area on screen = intensity x exposure / (4 tan^2)
  const phi = (sun.intensity * exposure) / (4 * t * t)
  // fades out as the sun leaves the frame (its glare still reaches in a little way)
  const out = Math.max(0, Math.abs(u - 0.5) - 0.5) * aspect + Math.max(0, Math.abs(v - 0.5) - 0.5)
  const fade = Math.max(0, 1 - out / 0.25) ** 2
  lensU.sunLight.value.set(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(phi * fade)
  const rH = SUN_RADIUS / (2 * t)
  // sample across at least ~1.5 px so the measurement never hangs on a single pixel
  const rV = Math.max(rH, 1.5 / Math.max(1, height))
  lensU.sunRadiusUv.value.set(rV / aspect, rV)
  // the star's spikes widened by the sun's disc: the mip level whose texel matches its diameter
  const texels = ((2 * rH) / STAR_EXTENT) * STAR_SIZE
  lensU.starLod.value = Math.max(0, Math.log2(Math.max(1, texels)))
}
