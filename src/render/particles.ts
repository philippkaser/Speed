// Particle rendering: tyre smoke, dust and sparks.
//
// Particles live in their own scene, rendered in a separate pass after the main G-buffer pass and
// composited over the lit image (see PostFX). Inside the main pass, camera-facing quads overwrote the
// normal, albedo and motion-vector targets over their whole rectangle (MRT targets other than colour
// do not blend), which printed the quads into SSGI/SSR/AO and the motion blur; and quads crossing the
// road were cut along hard straight lines.
//
// Smoke is shaded as a scattering medium rather than as textured cards:
//  - each puff is a soft density blob (Gaussian core eroded by animated fBm noise, unique per
//    particle), opacity = 1 - exp(-optical depth); optical depth falls as the puff expands (mass is
//    conserved, column density ~ 1/r^2), so plumes thin out as they grow, as real smoke does;
//  - lighting from the sun (with the scene's light colour and intensity) on a puff-shaped normal,
//    image-based ambient from the sky, plus single scattering with a Henyey-Greenstein phase function
//    (g = 0.6), which makes thin smoke glow when you look towards the sun;
//  - soft particles: opacity fades where the puff meets scene geometry, using the main pass depth.
import * as THREE from 'three/webgpu'
import {
  attribute,
  cameraPosition,
  cameraViewMatrix,
  color,
  cos,
  exp,
  float,
  Fn,
  length,
  mix,
  mx_fractal_noise_float,
  perspectiveDepthToViewZ,
  positionView,
  positionWorld,
  pow,
  screenUV,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'

type N = any

/** Scene holding the particle systems (rendered by PostFX into its own pass). */
export const particleScene = new THREE.Scene()
particleScene.matrixWorldAutoUpdate = true


export const particleU = {
  sunDir: uniform(new THREE.Vector3(0, 1, 0)),
  sunColor: uniform(new THREE.Color(1, 1, 1)),
  /** 1 when the main pass depth is bound (soft particles), 0 otherwise */
  soft: uniform(0),
  near: uniform(0.1),
  far: uniform(1000),
}

/** Main pass depth; PostFX swaps in the real depth texture before the first particle render. */
export const sceneDepth = texture(new THREE.DepthTexture(1, 1))

/** Premultiplied "over": colour = src + dst*(1-a); alpha tracks transmittance, T = T*(1-a). */
function overBlending(m: THREE.Material) {
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.AddEquation
  m.blendSrc = THREE.OneFactor
  m.blendDst = THREE.OneMinusSrcAlphaFactor
  m.blendEquationAlpha = THREE.AddEquation
  m.blendSrcAlpha = THREE.ZeroFactor
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor
}

/** Opacity factor that fades a particle out where it touches or passes behind scene geometry. */
const softFade = Fn(([range]: [N]) => {
  const sceneZ = perspectiveDepthToViewZ(sceneDepth.sample(screenUV).r, particleU.near, particleU.far)
  const gap = positionView.z.sub(sceneZ) // > 0: particle in front of the surface
  const soft = smoothstep(0, 1, gap.div(range)).clamp(0, 1)
  // and when the camera is inside the puff
  const nearCam = smoothstep(0.4, 2.2, positionView.z.negate())
  return mix(float(1), soft, particleU.soft).mul(nearCam)
})

export function smokeMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false })
  overBlending(m)
  m.premultipliedAlpha = true
  // per puff: x = optical depth at the centre, y = noise seed, z = rotation, w = radius (m)
  // (packed: WebGPU allows 8 vertex buffers and the instance matrix takes one)
  const puff = attribute('aPuff', 'vec4')
  const density = puff.x
  const seed = puff.y
  const rot = puff.z
  const radius = puff.w
  const tint = attribute('aTint', 'vec3')

  // rotated, centred sprite coordinates in [-1, 1]
  const c = uv().sub(0.5).mul(2)
  const cs = cos(rot),
    sn = sin(rot)
  const rotate = (q: N) => vec2(q.x.mul(cs).sub(q.y.mul(sn)), q.x.mul(sn).add(q.y.mul(cs)))
  const cr = rotate(c)
  const r2 = c.dot(c)
  // density: Gaussian core eroded by billowy fBm, unique per puff and slowly churning
  const densityAt = (q: N, octaves: number) => {
    const p = vec3(q.mul(1.8).add(seed.mul(37.1)), seed.mul(11.3).add(time.mul(0.22)))
    const n = mx_fractal_noise_float(p, octaves, 2.05, 0.6).mul(0.5).add(0.5)
    const core = exp(q.dot(q).mul(-2.2))
    // cauliflower edges: the noise erodes the blob where its density is low
    return core.mul(n.mul(1.7).add(0.02)).sub(float(1).sub(core).mul(0.14)).sub(0.03).max(0)
  }
  const shape = densityAt(cr, 4)
  const tau = density.mul(shape).mul(2.2)
  const alpha = float(1).sub(exp(tau.negate())).mul(smoothstep(1.0, 0.82, length(c)))
  m.opacityNode = alpha.mul(softFade(radius.mul(0.7)))

  // sun in view space; the sprite's x/y axes are the camera's right/up
  const sunV = cameraViewMatrix.mul(vec4(particleU.sunDir, 0)).xyz
  // self-shadowing: optical depth between this point and the sun, from a second density sample taken
  // towards the sun in the sprite plane (the light path through the puff)
  const towardSun = rotate(sunV.xy).mul(0.42)
  const tauSun = density.mul(densityAt(cr.add(towardSun), 3)).mul(2.2).mul(sunV.xy.length().mul(0.7).add(0.3))
  const sunVis = exp(tauSun.mul(-0.9))

  // puff-shaped normal (view space): a hemisphere bulging towards the camera
  const bulge = float(1).sub(r2.min(1)).max(0).sqrt()
  const nV = vec3(c.x, c.y, bulge.mul(0.9).add(0.25)).normalize()
  // sky and ground light come from the environment through the standard lighting model
  m.normalNode = nV
  m.colorNode = tint
  m.roughnessNode = float(1)
  m.metalnessNode = float(0)

  // direct sun, computed here so the self-shadowing applies to it alone:
  //  diffuse multiple scattering (wrapped Lambert) + single scattering towards the eye with a
  //  Henyey-Greenstein phase function (g = 0.6), which makes thin smoke glow against the sun
  const wrap = nV.dot(sunV).add(0.45).div(1.45).clamp(0, 1)
  const V = cameraPosition.sub(positionWorld).normalize()
  const cosT = particleU.sunDir.negate().dot(V)
  const g = 0.6
  const hg = float((1 - g * g) / (4 * Math.PI)).div(pow(float(1 + g * g).sub(cosT.mul(2 * g)), 1.5))
  m.emissiveNode = (particleU.sunColor as N).mul(tint).mul(sunVis).mul(wrap.mul(1 / Math.PI).add(hg.mul(1.2)))
  return m
}

export function sparkMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
  // additive in colour, leaves transmittance untouched
  m.blending = THREE.CustomBlending
  m.blendSrc = THREE.OneFactor
  m.blendDst = THREE.OneFactor
  m.blendSrcAlpha = THREE.ZeroFactor
  m.blendDstAlpha = THREE.OneFactor
  const a = attribute('aAlpha', 'float')
  const d = length(uv().sub(0.5).mul(vec2(2, 2)))
  const hot = mix(color(8, 2.4, 0.4), color(14, 10, 5), a)
  m.colorNode = hot.mul(smoothstep(1, 0.15, d)).mul(a).mul(softFade(float(0.05)))
  m.opacityNode = float(0)
  return m
}
