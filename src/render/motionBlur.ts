// Per-object motion blur: a tile-based reconstruction filter with analytic wheel rotation.
//
// After McGuire et al. 2012 ("A reconstruction filter for plausible motion blur"), with the
// refinements of Guertin et al. 2014 (sampling along the pixel's own motion as well as the dominant
// one) and Jimenez 2014 (mirrored background reconstruction, jittered tile lookup, fast paths).
//
//  1. Tile max: the longest motion in every tile (tile edge = the longest streak), in two separable
//     passes over the velocity target.
//  2. Neighbour max: the longest motion that can reach a tile from its 3x3 neighbourhood. A fast
//     object's blur then spills over the static pixels around it, instead of stopping at its own
//     silhouette and dissolving inwards.
//  3. Gather, per pixel at output resolution:
//     - wheels follow their real screw motion: every tap rotates the pixel's view-space position
//       about the axle by its share of the angle swept during the exposure, adds the hub's motion
//       and projects back. Spokes blur into a disc along their arcs, the tyre keeps its outline,
//       calipers stay sharp behind the spinning rim, and seen from the side the contact patch stays
//       still while the top of the tyre streaks (a cycloid).
//     - everything else: taps along the dominant motion and along the pixel's own, weighted by
//       which surface is in front and whose motion covers the pixel. A sharp car in front of a
//       streaking background never smears into it; the background behind the car's edge is
//       continued from the mirrored tap, so the streaks run right up to a crisp outline (the look of
//       a panning shot). The weights are box-shaped, so a constant motion gives the uniform streak
//       of a real shutter, not a soft smudge.
//     - tiles with uniform motion take a cheap path without depth tests; tiles without motion exit
//       immediately.
// Motion depth comes from the velocity target's w (the surface that owns the motion), so the world
// seen through glass blurs with the world, not with the glass.
import * as THREE from 'three/webgpu'
import * as tsl from 'three/tsl'
import { MAX_WHEEL_SLOTS, motionCamera, wheelUniforms as wheelArrays } from './motionHistory'

const wheelUniforms = wheelArrays as N

type N = any

// TSL builds shader graphs from loosely typed nodes; its typings fight every swizzle
const {
  Fn,
  If,
  Loop,
  abs,
  ceil,
  clamp,
  context,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  int,
  interleavedGradientNoise,
  ivec2,
  length,
  max,
  min,
  mix,
  normalize,
  passTexture,
  round,
  screenCoordinate,
  screenSize,
  select,
  sign,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} = tsl as N

export const motionBlurUniforms = {
  /** exposure as a fraction of one frame's motion */
  shutter: uniform(0.5),
  /** longest half-streak as a fraction of the image height */
  maxRadius: uniform(0.055),
  frame: uniform(0),
}

export interface MotionBlurOptions {
  /** most taps per pixel for the general gather (scaled down with the length of the motion) */
  taps?: number
  /** reconstruct wheel rotation */
  wheels?: boolean
}

let _state: any

function target(name: string, filter: THREE.MagnificationTextureFilter) {
  const rt = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType, minFilter: filter, magFilter: filter })
  rt.texture.name = name
  return rt
}

class MotionBlurNode extends THREE.Node {
  colorNode: N
  velocityNode: N
  taps: number
  wheels: boolean
  private _tileH = target('MotionBlur.tileH', THREE.NearestFilter)
  private _tile = target('MotionBlur.tile', THREE.NearestFilter)
  private _neighbor = target('MotionBlur.neighbor', THREE.NearestFilter)
  private _out = target('MotionBlur.output', THREE.LinearFilter)
  private _textureNode: N
  private _quad = new (THREE.QuadMesh as N)() as THREE.QuadMesh
  private _materials: THREE.NodeMaterial[] = []
  // sizes
  private _outSize = uniform(new THREE.Vector2(1, 1))
  private _velSize = uniform(new THREE.Vector2(1, 1))
  private _tiles = uniform(new THREE.Vector2(1, 1))
  private _tileSize = uniform(8)
  private _tileSizeInt = uniform(8, 'int')

  constructor(colorNode: N, velocityNode: N, opts: MotionBlurOptions = {}) {
    super('vec4')
    this.colorNode = colorNode
    this.velocityNode = velocityNode
    this.taps = Math.max(8, Math.min(32, opts.taps ?? 20))
    this.wheels = opts.wheels ?? true
    this._textureNode = passTexture(this as N, this._out.texture)
    this.updateBeforeType = THREE.NodeUpdateType.FRAME
  }

  getTextureNode() {
    return this._textureNode
  }

  /** Debug (?showtiles): the neighbour max, 4 levels per pixel of half streak (x red, y green). */
  getTileDebugNode(): N {
    const t = passTexture(this as N, this._neighbor.texture)
    return vec4(t.xy.abs().mul(4 / 255), t.z.mul(4 / 255), 1)
  }

  updateBefore(frame: THREE.NodeFrame): boolean | undefined {
    const renderer = frame.renderer as THREE.WebGPURenderer
    const color = this.colorNode.value as THREE.Texture
    const vel = this.velocityNode.value as THREE.Texture
    const W = Math.max(1, (color.image as { width: number }).width)
    const H = Math.max(1, (color.image as { height: number }).height)
    const vw = Math.max(1, (vel.image as { width: number }).width)
    const vh = Math.max(1, (vel.image as { height: number }).height)
    // tile edge = the longest streak, in velocity texels
    const radiusPx = motionBlurUniforms.maxRadius.value * H
    const T = Math.max(4, Math.ceil((radiusPx * vh) / H))
    const nx = Math.ceil(vw / T),
      ny = Math.ceil(vh / T)
    this._outSize.value.set(W, H)
    this._velSize.value.set(vw, vh)
    this._tiles.value.set(nx, ny)
    this._tileSize.value = T
    this._tileSizeInt.value = T
    this._tileH.setSize(nx, vh)
    this._tile.setSize(nx, ny)
    this._neighbor.setSize(nx, ny)
    this._out.setSize(W, H)

    _state = THREE.RendererUtils.resetRendererState(renderer, _state)
    const [mH, mV, mN, mG] = this._materials
    const pass = (rt: THREE.RenderTarget, m: THREE.NodeMaterial, name: string) => {
      this._quad.material = m
      this._quad.name = name
      renderer.setRenderTarget(rt)
      this._quad.render(renderer)
    }
    pass(this._tileH, mH, 'Motion Blur [ Tile Max H ]')
    pass(this._tile, mV, 'Motion Blur [ Tile Max V ]')
    pass(this._neighbor, mN, 'Motion Blur [ Neighbour Max ]')
    pass(this._out, mG, 'Motion Blur [ Gather ]')
    THREE.RendererUtils.restoreRendererState(renderer, _state)
    return undefined
  }

  setup(builder: N) {
    this.colorNode.build(builder)
    this.velocityNode.build(builder)

    const U = motionBlurUniforms
    const C = motionCamera
    const color = this.colorNode
    const vel = this.velocityNode
    const outSize = this._outSize
    const velSize = this._velSize
    const tiles = this._tiles
    const T = this._tileSize
    const Ti = this._tileSizeInt
    const maxR = U.maxRadius.mul(outSize.y)
    const MAXS = MAX_WHEEL_SLOTS

    // ---- helpers
    const texel = (p: N) => ivec2(clamp(p.mul(velSize), vec2(0), velSize.sub(1)))
    const velAt = (p: N) => vel.load(texel(p))
    /** per-frame NDC motion -> half streak in output pixels (shutter scaled, clamped) */
    const halfVec = (ndc: N) => {
      const v = ndc.mul(vec2(0.5, -0.5)).mul(outSize).mul(U.shutter.mul(0.5))
      return v.mul(min(float(1), maxR.div(max(length(v), 1e-4))))
    }
    /** motion of a velocity texel: a spinning wheel part moves with its hub */
    const motionOf = (raw: N) => {
      const slot = round(raw.z)
      const hub = wheelUniforms.motion.element(int(clamp(slot, 0, MAXS))).xy
      return select(slot.greaterThan(0.5), hub, raw.xy)
    }
    const distOf = (raw: N) => float(1).div(max(raw.w, 1e-5))
    /** fraction of a pixel at distance d covered by a streak of half length len (box, 1 px edge) */
    const cover = (d: N, len: N) => clamp(len.sub(d).add(0.5), 0, 1)

    const project = (q: N) => {
      const iz = float(1).div(max(q.z.negate(), 1e-4))
      return vec2(C.projX.mul(q.x).mul(iz).mul(0.5).add(0.5), float(0.5).sub(C.projY.mul(q.y).mul(iz).mul(0.5)))
    }
    const viewPos = (p: N, z: N) => vec3(p.x.mul(2).sub(1).mul(z).div(C.projX), float(1).sub(p.y.mul(2)).mul(z).div(C.projY), z.negate())

    // ---- 1. tile max, horizontal: (tilesX x height)
    const tileH = Fn(() => {
      const p = floor(uv().mul(vec2(tiles.x, velSize.y)))
      const x0 = int(p.x.mul(T))
      const y = int(p.y)
      const best = vec2(0).toVar()
      const bestLen = float(0).toVar()
      const minLen = float(1e6).toVar()
      Loop({ start: int(0), end: Ti, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        const x = min(x0.add(i), int(velSize.x).sub(1))
        const v = halfVec(motionOf(vel.load(ivec2(x, y))))
        const l = length(v)
        If(l.greaterThan(bestLen), () => {
          best.assign(v)
          bestLen.assign(l)
        })
        minLen.assign(min(minLen, l))
      })
      return vec4(best, minLen, bestLen)
    })

    // ---- 1b. tile max, vertical: (tilesX x tilesY)
    const tileHTex = texture(this._tileH.texture)
    const tileV = Fn(() => {
      const p = floor(uv().mul(tiles))
      const x = int(p.x)
      const y0 = int(p.y.mul(T))
      const best = vec2(0).toVar()
      const bestLen = float(0).toVar()
      const minLen = float(1e6).toVar()
      Loop({ start: int(0), end: Ti, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        const s = tileHTex.load(ivec2(x, min(y0.add(i), int(velSize.y).sub(1))))
        If(s.w.greaterThan(bestLen), () => {
          best.assign(s.xy)
          bestLen.assign(s.w)
        })
        minLen.assign(min(minLen, s.z))
      })
      return vec4(best, minLen, bestLen)
    })

    // ---- 2. neighbour max: the longest motion that can reach this tile
    const tileTex = texture(this._tile.texture)
    const neighbor = Fn(() => {
      const p = ivec2(floor(uv().mul(tiles)))
      const maxT = ivec2(int(tiles.x).sub(1), int(tiles.y).sub(1))
      const centre = tileTex.load(p)
      const best = vec2(centre.xy).toVar()
      const bestLen = float(centre.w).toVar()
      const minLen = float(centre.z).toVar()
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const q = clamp(p.add(ivec2(dx, dy)), ivec2(0), maxT)
          const s = tileTex.load(q)
          minLen.assign(min(minLen, s.z))
          // a diagonal neighbour only reaches this tile if it streaks along the diagonal
          let reaches: N = s.w.greaterThan(bestLen)
          if (dx && dy) {
            const along = abs(dot(s.xy.div(max(s.w, 1e-4)), vec2(dx, dy).mul(Math.SQRT1_2)))
            reaches = reaches.and(along.greaterThan(0.6))
          }
          If(reaches, () => {
            best.assign(s.xy)
            bestLen.assign(s.w)
          })
        }
      return vec4(best, minLen, bestLen)
    })

    // ---- 3. gather
    const nmTex = texture(this._neighbor.texture)
    const TAPS = this.taps
    const PAIRS = Math.ceil(TAPS / 2)
    const WHEEL_TAPS = Math.max(8, Math.round(TAPS * 1.25))
    const wheelsOn = this.wheels

    const gather = Fn(() => {
      const uvC = uv()
      const c0 = color.sample(uvC).toVar()
      const rawC = velAt(uvC).toVar()
      const slotC = round(rawC.z).toVar()
      const result = vec4(c0).toVar()
      // per pixel and per frame jitter (interleaved gradient noise)
      const seed = screenCoordinate.xy.add(U.frame.mul(5.588238))
      const noise = interleavedGradientNoise(seed).toVar()
      const noise2 = interleavedGradientNoise(seed.yx.add(vec2(37.1, 11.9))).toVar()
      const inv = vec2(1).div(outSize)

      const generalGather = () => {
        // dominant motion of the neighbourhood; the tile lookup is jittered so tile edges never show
        const tp = uvC.mul(velSize).div(T).add(vec2(noise, noise2).sub(0.5).mul(0.7))
        const nm = nmTex.load(ivec2(clamp(floor(tp), vec2(0), tiles.sub(1))))
        const vN = nm.xy.toVar()
        const lenN = nm.w.toVar()
        If(lenN.greaterThan(0.5), () => {
          const vC = halfVec(motionOf(rawC)).toVar()
          const lenC = length(vC).toVar()
          If(nm.z.greaterThan(lenN.mul(0.7)), () => {
            // uniform motion in the neighbourhood: a plain box filter along the pixel's own motion
            const n = int(clamp(ceil(lenC.div(2.5)), 4, TAPS)).toVar()
            const sum = vec4(0).toVar()
            Loop({ start: int(0), end: n, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
              const t = float(i).add(noise).div(float(n)).mul(2).sub(1)
              sum.addAssign(color.sample(uvC.add(vC.mul(t).mul(inv))))
            })
            result.assign(sum.div(float(n)))
          }).Else(() => {
            // edge pixels: the velocity target can be coarser than the image (TAAU) and the image is
            // antialiased, so a pixel on a moving object's outline can carry the object's colour with
            // the background's motion and would stay behind as a sharp contour. Take the motion of a
            // neighbouring texel that is nearer and faster (dilating moving objects, never sharp ones).
            const tc = texel(uvC)
            const maxTc = ivec2(velSize.sub(1))
            const own = vec4(rawC).toVar()
            const ownLen = length(vC).toVar()
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue
                const r = vel.load(clamp(tc.add(ivec2(dx, dy)), ivec2(0), maxTc))
                const l = length(halfVec(motionOf(r)))
                If(r.w.greaterThan(own.w.mul(1.03)).and(l.greaterThan(ownLen.add(0.75))), () => {
                  own.assign(r)
                  ownLen.assign(l)
                })
              }
            vC.assign(halfVec(motionOf(own)))
            lenC.assign(length(vC))
            const zC = distOf(own).toVar()
            const ext = zC.mul(0.02).add(0.04)
            const dirN = vN.div(lenN)
            // the pixel's own direction (aligned with the dominant one: blur is symmetric)
            const ownDir = select(lenC.greaterThan(0.5), vC.div(max(lenC, 1e-4)), dirN)
            const dirC = ownDir.mul(sign(dot(ownDir, dirN)).add(0.001).sign()).toVar()
            // the more the pixel itself dominates, the more both tap sets follow its own motion
            const k = smoothstep(0.3, 0.7, lenC.div(lenN))
            const dirA = normalize(mix(dirN, dirC, k).add(vec2(1e-5, 0))).toVar()
            const pairs = int(clamp(ceil(lenN.div(3)), 3, PAIRS)).toVar()
            const sum = vec4(0).toVar()
            const wsum = float(0).toVar()
            Loop({ start: int(0), end: pairs, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
              const odd = i.bitAnd(int(1)).equal(int(1))
              const t = float(i).add(noise).div(float(pairs))
              const d = t.mul(lenN)
              const off = select(odd, dirC, dirA).mul(d).mul(inv)
              const p1 = uvC.add(off),
                p2 = uvC.sub(off)
              const r1 = velAt(p1),
                r2 = velAt(p2)
              const c1 = color.sample(p1),
                c2 = color.sample(p2)
              const l1 = length(halfVec(motionOf(r1))),
                l2 = length(halfVec(motionOf(r2)))
              // in front of the centre (1) or behind it (0); equal depths share both roles
              const f1 = clamp(zC.sub(distOf(r1)).div(ext).add(0.5), 0, 1)
              const f2 = clamp(zC.sub(distOf(r2)).div(ext).add(0.5), 0, 1)
              const cC = cover(d, lenC)
              // a tap contributes if its own streak reaches the centre (in front), or if the
              // centre's streak reaches it (behind: the background revealed by a moving pixel)
              const w1 = f1.mul(cover(d, l1)).add(f1.oneMinus().mul(cC))
              const w2 = f2.mul(cover(d, l2)).add(f2.oneMinus().mul(cC))
              // mirror: a sharp foreground tap hides background that continues on the other side
              const o1 = f1.mul(cover(d, l1).oneMinus())
              const o2 = f2.mul(cover(d, l2).oneMinus())
              const m1 = o1.greaterThan(0.5).and(o2.lessThan(0.5))
              const m2 = o2.greaterThan(0.5).and(o1.lessThan(0.5))
              const ww1 = select(m1, w2, w1),
                ww2 = select(m2, w1, w2)
              sum.addAssign(select(m1, c2, c1).mul(ww1))
              sum.addAssign(select(m2, c1, c2).mul(ww2))
              wsum.addAssign(ww1.add(ww2))
            })
            // whatever no tap claimed is the centre itself
            const total = float(pairs).mul(2)
            result.assign(sum.add(c0.mul(total.sub(wsum).max(0))).div(total))
          })
        })
      }

      if (wheelsOn) {
        If(abs(slotC).greaterThan(0.5), () => {
          // ---------------------------------------------------------------- wheels: screw motion
          const s = int(clamp(abs(slotC), 0, MAXS))
          const spinning = slotC.greaterThan(0)
          const hubD = wheelUniforms.hub.element(s).toVar()
          const axis = wheelUniforms.axle.element(s).xyz.toVar()
          // hub motion, clamped like every other streak; the swept angle is scaled by the same
          // factor so the contact patch stays put (rolling without slip) when the clamp bites
          const hubRaw = wheelUniforms.motion.element(s).xy.mul(vec2(0.5, -0.5)).mul(outSize).mul(U.shutter.mul(0.5))
          const hubClamp = min(float(1), maxR.div(max(length(hubRaw), 1e-4)))
          const hubHalf = hubRaw.mul(hubClamp).toVar()
          const phi = hubD.w.mul(hubClamp).toVar()
          const ctr = hubD.xyz.toVar()
          const zC = distOf(rawC).toVar()
          const rel = viewPos(uvC, zC).sub(ctr).toVar()
          const rPx = length(uvC.sub(project(ctr)).mul(outSize))
          const arcPx = abs(phi).mul(rPx).add(length(hubHalf).mul(2)).toVar()
          If(arcPx.greaterThan(0.75), () => {
            const n = int(clamp(ceil(arcPx.div(2.5)), 4, WHEEL_TAPS)).toVar()
            const tol = zC.mul(0.003).add(0.015)
            const accA = vec4(0).toVar()
            const accB = vec4(0).toVar()
            const wB = float(0).toVar()
            const nB = float(0).toVar()
            // Rodrigues: rel rotated about the axle by a = rel cos + (k x rel) sin + k (k.rel)(1 - cos)
            const kxr = cross(axis, rel).toVar()
            const kdr = axis.mul(dot(axis, rel)).toVar()
            Loop({ start: int(0), end: n, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
              const t = float(i).add(noise).div(float(n)).sub(0.5)
              const a = phi.mul(t)
              const ca = cos(a)
              const q = ctr.add(rel.mul(ca)).add(kxr.mul(sin(a))).add(kdr.mul(ca.oneMinus()))
              const lin = hubHalf.mul(t.mul(2)).mul(inv)
              const pT = project(q).add(lin)
              const cT = color.sample(pT)
              const cL = color.sample(uvC.add(lin))
              const rT = velAt(pT)
              const slotT = round(rT.z)
              const dz = distOf(rT).sub(q.z.negate())
              If(spinning, () => {
                // the same spinning layer (or one passing in front of it) seen at another angle
                const sameLayer = abs(slotT.sub(slotC)).lessThan(0.5).and(dz.lessThan(tol))
                // hidden behind something that does not spin: assume the layer continues there
                const hidden = sameLayer.not().and(dz.lessThan(tol.negate()))
                const gap = sameLayer.not().and(hidden.not())
                accA.addAssign(select(sameLayer, cT, select(hidden, cL, vec4(0))))
                // through a gap: what lies behind, weighted towards nearby angles
                const wg = select(gap, exp(a.div(0.35).pow(2).negate()).add(0.03), float(0))
                accB.addAssign(cT.mul(wg))
                wB.addAssign(wg)
                nB.addAssign(select(gap, float(1), float(0)))
              }).Else(() => {
                // a part that does not spin (caliper): spinning parts pass in front of it
                const passing = abs(slotT.add(slotC)).lessThan(0.5).and(dz.lessThan(tol.negate()))
                accA.addAssign(select(passing, cT, cL))
              })
            })
            const behind = select(wB.greaterThan(0), accB.div(max(wB, 1e-5)), c0)
            result.assign(accA.add(behind.mul(nB)).div(float(n)))
          })
        }).Else(generalGather)
      } else generalGather()
      return result
    })

    const mk = (node: N, name: string) => {
      const m = new THREE.NodeMaterial()
      m.contextNode = context(builder.getSharedContext())
      m.fragmentNode = node
      m.name = name
      m.needsUpdate = true
      return m
    }
    for (const m of this._materials) m.dispose()
    this._materials = [mk(tileH(), 'MotionBlur_tileMaxH'), mk(tileV(), 'MotionBlur_tileMaxV'), mk(neighbor(), 'MotionBlur_neighborMax'), mk(gather(), 'MotionBlur_gather')]

    const properties = builder.getNodeProperties(this)
    properties.colorNode = this.colorNode
    properties.velocityNode = this.velocityNode
    return this._textureNode
  }

  dispose() {
    this._tileH.dispose()
    this._tile.dispose()
    this._neighbor.dispose()
    this._out.dispose()
    for (const m of this._materials) m.dispose()
    this._materials = []
    super.dispose()
  }
}

/**
 * @param color    texture node of the image to blur (output resolution)
 * @param velocity texture node of the scene pass's velocity target (see motionHistory.ts)
 */
export function motionBlur(color: N, velocity: N, opts?: MotionBlurOptions): N {
  return new MotionBlurNode(color, velocity, opts)
}

/**
 * Debug view (?showvel): the blur half-vectors as the filter sees them (8 levels per pixel, |x| in
 * red, |y| in green), spinning wheel parts in blue, steering-only wheel parts in magenta.
 */
export function motionDebugView(velocity: N): N {
  return Fn(() => {
    const raw = velocity.sample(uv())
    const slot = round(raw.z)
    const hub = wheelUniforms.motion.element(int(clamp(slot, 0, MAX_WHEEL_SLOTS))).xy
    const ndc = select(slot.greaterThan(0.5), hub, raw.xy)
    const v = ndc.mul(vec2(0.5, -0.5)).mul(screenSize).mul(motionBlurUniforms.shutter.mul(0.5)).abs().mul(8 / 255)
    const wheel = select(slot.greaterThan(0.5), vec3(0, 0, 0.8), select(slot.lessThan(-0.5), vec3(0.6, 0, 0.6), vec3(0)))
    return vec4(vec3(v, 0).add(wheel), 1)
  })()
}
