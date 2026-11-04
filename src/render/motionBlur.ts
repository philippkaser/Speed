// Per-object motion blur: a camera shutter, reconstructed in screen space.
//
// What a real camera records is the scene integrated over the time its shutter is open: every
// surface smears along the path it travels relative to the camera during that time, and what it
// uncovers shows through. The scene pass gives us one instant plus, per pixel, how the surface there
// moved (see motionHistory.ts). From that the blur is rebuilt in five passes:
//
//  0. Prepare (velocity resolution): each pixel's streak, resolved once. The motion over the last
//     frame is scaled by the shutter angle (360 degrees: the streak spans exactly the way to the next
//     frame), the camera rigs' deliberate shake is taken out (the camera's real path stays, so what it
//     follows or is mounted on stays sharp), spinning wheel parts move with their hub (their rotation
//     is reconstructed separately), and the result is clamped to the longest streak.
//  1. Tile max: the longest streak in every tile (tile edge = longest half streak), separable.
//  2. Neighbour max: the longest streak that can reach a tile from its 3x3 neighbourhood. A fast
//     object's blur then spills over the still pixels around it instead of stopping at its outline.
//  3. Gather, per output pixel (McGuire et al. 2012, with Guertin et al. 2014 and Jimenez 2014):
//     - still neighbourhoods exit at once;
//     - neighbourhoods moving as one (a panning helicopter shot, the road under a chase camera) are
//       box filtered along the pixel's own streak, densely (a tap every ~1.25 px, up to 64), so they
//       come out as the smooth streak of a real shutter, not as grain;
//     - everywhere else, taps along the dominant streak and the pixel's own are weighted by which
//       surface is in front and whose streak covers the pixel. A sharp car in front of a streaking
//       background never smears into it; the background behind its outline continues from the
//       mirrored tap. Box-shaped weights keep streak ends crisp, like a shutter;
//     - wheels follow their real screw motion: every tap rotates the pixel's view-space position
//       about the axle by its share of the angle swept during the exposure, adds the hub's motion and
//       projects back. Spokes blur into a disc, the tyre keeps its outline, calipers stay sharp
//       behind the rim, and seen from a fixed camera the contact patch stays still while the top of
//       the tyre streaks.
// Depth comes from the velocity target (the surface that owns the motion), so the world seen through
// glass blurs with the world, not with the glass.
import * as THREE from 'three/webgpu'
import * as tsl from 'three/tsl'
import { MAX_WHEEL_SLOTS, motionCamera, wheelUniforms as wheelArrays } from './motionHistory'

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

const wheelUniforms = wheelArrays as N

export const motionBlurUniforms = {
  /** exposure as a fraction of one frame (exposure time / frame time) */
  shutter: uniform(0.5),
  /** longest half streak as a fraction of the image height */
  maxRadius: uniform(0.08),
  /** 1: camera shake does not blur (see markCameraPath), 0: it does */
  ignoreShake: uniform(1),
  frame: uniform(0),
}

export interface MotionBlurOptions {
  /** most tap pairs where surfaces with different motion meet */
  pairs?: number
  /** most taps where everything moves as one */
  denseTaps?: number
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
  pairs: number
  denseTaps: number
  wheels: boolean
  private _prep = target('MotionBlur.prepare', THREE.NearestFilter)
  private _tileH = target('MotionBlur.tileH', THREE.NearestFilter)
  private _tile = target('MotionBlur.tile', THREE.NearestFilter)
  private _neighbor = target('MotionBlur.neighbor', THREE.NearestFilter)
  private _out = target('MotionBlur.output', THREE.LinearFilter)
  private _textureNode: N
  private _quad = new (THREE.QuadMesh as N)() as THREE.QuadMesh
  private _materials: THREE.NodeMaterial[] = []
  private _outSize = uniform(new THREE.Vector2(1, 1))
  private _velSize = uniform(new THREE.Vector2(1, 1))
  private _tiles = uniform(new THREE.Vector2(1, 1))
  private _tileSize = uniform(8)
  private _tileSizeInt = uniform(8, 'int')

  constructor(colorNode: N, velocityNode: N, opts: MotionBlurOptions = {}) {
    super('vec4')
    this.colorNode = colorNode
    this.velocityNode = velocityNode
    this.pairs = Math.max(4, Math.min(20, opts.pairs ?? 12))
    this.denseTaps = Math.max(8, Math.min(96, opts.denseTaps ?? 48))
    this.wheels = opts.wheels ?? true
    this._textureNode = passTexture(this as N, this._out.texture)
    this.updateBeforeType = THREE.NodeUpdateType.FRAME
  }

  getTextureNode() {
    return this._textureNode
  }

  /** Debug (?showvel): the streaks as the gather sees them, see motionDebugView(). */
  getStreakDebugNode(): N {
    return streakView(passTexture(this as N, this._prep.texture))
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
    // tile edge = the longest half streak, in velocity texels
    const radiusPx = motionBlurUniforms.maxRadius.value * H
    const T = Math.max(4, Math.ceil((radiusPx * vh) / H))
    const nx = Math.ceil(vw / T),
      ny = Math.ceil(vh / T)
    this._outSize.value.set(W, H)
    this._velSize.value.set(vw, vh)
    this._tiles.value.set(nx, ny)
    this._tileSize.value = T
    this._tileSizeInt.value = T
    this._prep.setSize(vw, vh)
    this._tileH.setSize(nx, vh)
    this._tile.setSize(nx, ny)
    this._neighbor.setSize(nx, ny)
    this._out.setSize(W, H)

    _state = THREE.RendererUtils.resetRendererState(renderer, _state)
    const [mP, mH, mV, mN, mG] = this._materials
    const pass = (rt: THREE.RenderTarget, m: THREE.NodeMaterial, name: string) => {
      this._quad.material = m
      this._quad.name = name
      renderer.setRenderTarget(rt)
      this._quad.render(renderer)
    }
    pass(this._prep, mP, 'Motion Blur [ Prepare ]')
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
    const C = motionCamera as N
    const color = this.colorNode
    const vel = this.velocityNode
    const outSize = this._outSize
    const velSize = this._velSize
    const tiles = this._tiles
    const T = this._tileSize
    const Ti = this._tileSizeInt
    const maxR = U.maxRadius.mul(outSize.y)
    const MAXS = MAX_WHEEL_SLOTS

    const project = (q: N) => {
      const iz = float(1).div(max(q.z.negate(), 1e-4))
      return vec2(C.projX.mul(q.x).mul(iz).mul(0.5).add(0.5), float(0.5).sub(C.projY.mul(q.y).mul(iz).mul(0.5)))
    }
    const viewPos = (p: N, z: N) => vec3(p.x.mul(2).sub(1).mul(z).div(C.projX), float(1).sub(p.y.mul(2)).mul(z).div(C.projY), z.negate())
    const distOf = (r: N) => float(1).div(max(r.w, 1e-5))
    /** per-frame NDC motion -> half streak in output pixels over the exposure (unclamped) */
    const toHalf = (ndc: N) => ndc.mul(vec2(0.5, -0.5)).mul(outSize).mul(U.shutter.mul(0.5))

    // ---- 0. prepare: (half streak px xy, wheel slot, inverse depth)
    const prepare = Fn(() => {
      const p = floor(uv().mul(velSize))
      const raw = vel.load(ivec2(p)).toVar()
      const slot = round(raw.z)
      // spinning wheel parts move with their hub; their rotation is rebuilt in the gather
      const ndc = select(slot.greaterThan(0.5), wheelUniforms.motion.element(int(clamp(slot, 0, MAXS))).xy, raw.xy).toVar()
      // take the camera's shake out of the motion: reproject with the shake-free camera instead
      const X = vec4(viewPos(p.add(0.5).div(velSize), distOf(raw)), 1)
      const cT = C.toPrevTrue.mul(X)
      const cB = C.toPrevBlur.mul(X)
      const ok = cT.w.greaterThan(1e-4).and(cB.w.greaterThan(1e-4))
      ndc.addAssign(select(ok, cT.xy.div(cT.w).sub(cB.xy.div(cB.w)).mul(U.ignoreShake), vec2(0)))
      const v = toHalf(ndc)
      return vec4(v.mul(min(float(1), maxR.div(max(length(v), 1e-4)))), raw.z, raw.w)
    })

    const prepTex = texture(this._prep.texture)
    const texel = (p: N) => ivec2(clamp(p.mul(velSize), vec2(0), velSize.sub(1)))
    const at = (p: N) => prepTex.load(texel(p))
    /** fraction of a pixel at distance d covered by a streak of half length len (box, 1 px edge) */
    const cover = (d: N, len: N) => clamp(len.sub(d).add(0.5), 0, 1)

    // ---- 1. tile max, horizontal: (tilesX x height); xy longest streak, z shortest, w longest
    const tileH = Fn(() => {
      const p = floor(uv().mul(vec2(tiles.x, velSize.y)))
      const x0 = int(p.x.mul(T))
      const y = int(p.y)
      const best = vec2(0).toVar()
      const bestLen = float(0).toVar()
      const minLen = float(1e6).toVar()
      Loop({ start: int(0), end: Ti, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        const v = prepTex.load(ivec2(min(x0.add(i), int(velSize.x).sub(1)), y)).xy
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

    // ---- 2. neighbour max: the longest streak that can reach this tile
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
          const s = tileTex.load(clamp(p.add(ivec2(dx, dy)), ivec2(0), maxT))
          minLen.assign(min(minLen, s.z))
          // a diagonal neighbour only reaches this tile if it streaks along the diagonal
          let reaches: N = s.w.greaterThan(bestLen)
          if (dx && dy) reaches = reaches.and(abs(dot(s.xy.div(max(s.w, 1e-4)), vec2(dx, dy).mul(Math.SQRT1_2))).greaterThan(0.6))
          If(reaches, () => {
            best.assign(s.xy)
            bestLen.assign(s.w)
          })
        }
      return vec4(best, minLen, bestLen)
    })

    // ---- 3. gather
    const nmTex = texture(this._neighbor.texture)
    const PAIRS = this.pairs
    const DENSE = this.denseTaps
    const WHEEL_TAPS = Math.max(12, Math.round(PAIRS * 2.5))
    const wheelsOn = this.wheels

    const gather = Fn(() => {
      const uvC = uv()
      const c0 = color.sample(uvC).toVar()
      const rC = at(uvC).toVar()
      const slotC = round(rC.z).toVar()
      const result = vec4(c0).toVar()
      // per pixel and per frame jitter (interleaved gradient noise)
      const seed = screenCoordinate.xy.add(U.frame.mul(5.588238))
      const noise = interleavedGradientNoise(seed).toVar()
      const noise2 = interleavedGradientNoise(seed.yx.add(vec2(37.1, 11.9))).toVar()
      const inv = vec2(1).div(outSize)

      const generalGather = () => {
        // dominant streak of the neighbourhood; the tile lookup is jittered so tile edges never show
        const tp = uvC.mul(velSize).div(T).add(vec2(noise, noise2).sub(0.5).mul(0.7))
        const nm = nmTex.load(ivec2(clamp(floor(tp), vec2(0), tiles.sub(1))))
        const vN = nm.xy.toVar()
        const lenN = nm.w.toVar()
        If(lenN.greaterThan(0.5), () => {
          const vC = vec2(rC.xy).toVar()
          const lenC = length(vC).toVar()
          If(nm.z.greaterThan(lenN.mul(0.7)), () => {
            // the neighbourhood moves as one: a dense box filter along the pixel's own streak
            const n = int(clamp(ceil(lenC.mul(2).div(1.25)), 4, DENSE)).toVar()
            const sum = vec4(0).toVar()
            Loop({ start: int(0), end: n, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
              const t = float(i).add(noise).div(float(n)).mul(2).sub(1)
              sum.addAssign(color.sample(uvC.add(vC.mul(t).mul(inv))))
            })
            result.assign(sum.div(float(n)))
          }).Else(() => {
            // edge pixels: the velocity target can be coarser than the image and the image is
            // antialiased, so a pixel on a moving object's outline can carry the object's colour with
            // the background's motion and would stay behind as a sharp contour. Take the motion of a
            // neighbouring texel that is nearer and faster (dilating moving objects, never sharp ones).
            const tc = texel(uvC)
            const maxTc = ivec2(velSize.sub(1))
            const own = vec4(rC).toVar()
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue
                const r = prepTex.load(clamp(tc.add(ivec2(dx, dy)), ivec2(0), maxTc))
                const l = length(r.xy)
                If(r.w.greaterThan(own.w.mul(1.03)).and(l.greaterThan(lenC.add(0.75))), () => {
                  own.assign(r)
                  lenC.assign(l)
                })
              }
            vC.assign(own.xy)
            const zC = distOf(own).toVar()
            const ext = zC.mul(0.02).add(0.04)
            const dirN = vN.div(lenN)
            // the pixel's own direction (aligned with the dominant one: blur is symmetric)
            const ownDir = select(lenC.greaterThan(0.5), vC.div(max(lenC, 1e-4)), dirN)
            const dirC = ownDir.mul(sign(dot(ownDir, dirN)).add(0.001).sign()).toVar()
            // the more the pixel itself dominates, the more both tap sets follow its own motion
            const k = smoothstep(0.3, 0.7, lenC.div(lenN))
            const dirA = normalize(mix(dirN, dirC, k).add(vec2(1e-5, 0))).toVar()
            const pairs = int(clamp(ceil(lenN.div(2.5)), 3, PAIRS)).toVar()
            const sum = vec4(0).toVar()
            const wsum = float(0).toVar()
            Loop({ start: int(0), end: pairs, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
              const odd = i.bitAnd(int(1)).equal(int(1))
              const t = float(i).add(noise).div(float(pairs))
              const d = t.mul(lenN)
              const off = select(odd, dirC, dirA).mul(d).mul(inv)
              const p1 = uvC.add(off),
                p2 = uvC.sub(off)
              const r1 = at(p1),
                r2 = at(p2)
              const c1 = color.sample(p1),
                c2 = color.sample(p2)
              const l1 = length(r1.xy),
                l2 = length(r2.xy)
              // in front of the centre (1) or behind it (0); equal depths share both roles
              const f1 = clamp(zC.sub(distOf(r1)).div(ext).add(0.5), 0, 1)
              const f2 = clamp(zC.sub(distOf(r2)).div(ext).add(0.5), 0, 1)
              const cC = cover(d, lenC)
              // a tap contributes if its own streak reaches the centre (in front), or if the centre's
              // streak reaches it (behind: the background revealed by a moving pixel)
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
          // the hub's streak (prepared: shake removed, clamped); the swept angle is scaled by the
          // same clamp so the contact patch stays put (rolling without slip) when the clamp bites
          const hubHalf = vec2(rC.xy).toVar()
          const hubRaw = length(toHalf(wheelUniforms.motion.element(s).xy))
          const phi = hubD.w.mul(min(float(1), maxR.div(max(hubRaw, 1e-4)))).toVar()
          const ctr = hubD.xyz.toVar()
          const zC = distOf(rC).toVar()
          const rel = viewPos(uvC, zC).sub(ctr).toVar()
          const rPx = length(uvC.sub(project(ctr)).mul(outSize))
          const arcPx = abs(phi).mul(rPx).add(length(hubHalf).mul(2)).toVar()
          If(arcPx.greaterThan(0.75), () => {
            const n = int(clamp(ceil(arcPx.div(1.5)), 4, WHEEL_TAPS)).toVar()
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
              const rT = at(pT)
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
    this._materials = [
      mk(prepare(), 'MotionBlur_prepare'),
      mk(tileH(), 'MotionBlur_tileMaxH'),
      mk(tileV(), 'MotionBlur_tileMaxV'),
      mk(neighbor(), 'MotionBlur_neighborMax'),
      mk(gather(), 'MotionBlur_gather'),
    ]

    const properties = builder.getNodeProperties(this)
    properties.colorNode = this.colorNode
    properties.velocityNode = this.velocityNode
    return this._textureNode
  }

  dispose() {
    for (const rt of [this._prep, this._tileH, this._tile, this._neighbor, this._out]) rt.dispose()
    for (const m of this._materials) m.dispose()
    this._materials = []
    super.dispose()
  }
}

/**
 * @param color    texture node of the image to blur (output resolution)
 * @param velocity texture node of the scene pass's velocity target (see motionHistory.ts)
 */
export function motionBlur(color: N, velocity: N, opts?: MotionBlurOptions) {
  return new MotionBlurNode(color, velocity, opts)
}

/**
 * The prepared streaks (half length, 4 levels per pixel: |x| red, |y| green), spinning wheel parts
 * in blue, steering-only wheel parts in magenta.
 */
function streakView(prep: N): N {
  return Fn(() => {
    const r = prep.sample(uv())
    const slot = round(r.z)
    const wheel = select(slot.greaterThan(0.5), vec3(0, 0, 0.8), select(slot.lessThan(-0.5), vec3(0.6, 0, 0.6), vec3(0)))
    return vec4(vec3(r.xy.abs().mul(4 / 255), 0).add(wheel), 1)
  })()
}
