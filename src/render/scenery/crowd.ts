// The crowd: every spectator is one camera-facing card (instanced, one draw call for all the stands)
// drawn from a procedurally painted atlas of 64 different people: skin, hair, shirts in team colours,
// caps and sun hats, sunglasses, arms down, waving or cheering, flags and phones held up.
//
// Idle motion in the vertex shader (sway, and the excited ones bouncing); the previous position is
// moved with last frame's clock (motionTime), so the motion blur sees exactly that motion.
import * as THREE from 'three/webgpu'
import { attribute, cameraPosition, cameraViewMatrix, float, Fn, fwidth, log2, max, normalize, positionPrevious, sin, texture, vec2, vec3, vec4 } from 'three/tsl'
import { motionTime } from '../motionHistory'
import { canvasTexture } from '../textures'
import { mulberry } from './noise'

type N = any

const COLS = 16,
  ROWS = 4,
  CW = 64,
  CH = 128

const SKIN = ['#f3cdb0', '#e8b896', '#d9a27a', '#c08560', '#9c6844', '#7a4c2e', '#5b3620']
const HAIR = ['#16110d', '#2e2118', '#4f3524', '#7a5434', '#b89159', '#d8c08a', '#8e8a86', '#3a3a3a']
const SHIRT = ['#c8102e', '#e8e8e8', '#1b1b1d', '#0d47a1', '#f5b800', '#ff6a00', '#1e7a3c', '#7d7f84', '#1d2b4f', '#e03c8a', '#00897b', '#f2f2f2', '#8b0f1f', '#3d6fd1', '#ffd400', '#2b2b2b']
const PANTS = ['#2b3a55', '#1c1c1e', '#6b5a43', '#3e4247', '#28324a', '#7a6a52']
const FLAGS = [
  ['#c8102e', '#ffffff', '#c8102e'],
  ['#009246', '#ffffff', '#ce2b37'],
  ['#000000', '#dd0000', '#ffce00'],
  ['#0055a4', '#ffffff', '#ef4135'],
  ['#ffcc00', '#111111', '#ffcc00'],
  ['#0d47a1', '#ffffff', '#0d47a1'],
]

function paintPerson(ctx: CanvasRenderingContext2D, ox: number, oy: number, r: () => number) {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
  const skin = pick(SKIN),
    shirt = pick(SHIRT),
    hair = pick(HAIR),
    pants = pick(PANTS)
  const pose = r() // < 0.62 arms down, < 0.78 waving, < 0.88 cheering, < 0.95 flag, else phone
  const hat = r() // < 0.18 cap, < 0.28 sun hat
  const wide = 0.9 + r() * 0.25
  const cx = ox + 32 + (r() - 0.5) * 4
  const sh = oy + 70 + (r() - 0.5) * 6 // shoulder line
  const tw = 40 * wide
  ctx.save()
  // lap / knees (seen between the rows)
  ctx.fillStyle = pants
  ctx.beginPath()
  ctx.ellipse(cx, oy + 121, tw * 0.6, 9, 0, 0, Math.PI * 2)
  ctx.fill()
  // torso
  const g = ctx.createLinearGradient(cx - tw / 2, 0, cx + tw / 2, 0)
  g.addColorStop(0, shade(shirt, 0.7))
  g.addColorStop(0.45, shirt)
  g.addColorStop(1, shade(shirt, 0.78))
  ctx.fillStyle = g
  roundRect(ctx, cx - tw / 2, sh, tw, oy + 118 - sh, 10)
  ctx.fill()
  // shirt detail: a stripe or a logo patch for some
  if (r() < 0.35) {
    ctx.fillStyle = shade(pick(SHIRT), 1)
    ctx.fillRect(cx - tw / 2, sh + 14, tw, 6)
  } else if (r() < 0.3) {
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.fillRect(cx + 4, sh + 10, 8, 6)
  }
  // neck and head
  ctx.fillStyle = shade(skin, 0.85)
  ctx.fillRect(cx - 4, sh - 10, 8, 12)
  const hy = sh - 20
  const hg = ctx.createRadialGradient(cx - 3, hy - 3, 2, cx, hy, 13)
  hg.addColorStop(0, skin)
  hg.addColorStop(1, shade(skin, 0.72))
  ctx.fillStyle = hg
  ctx.beginPath()
  ctx.ellipse(cx, hy, 9.5, 11.5, 0, 0, Math.PI * 2)
  ctx.fill()
  // hair / hats
  if (hat < 0.18) {
    ctx.fillStyle = pick(SHIRT)
    ctx.beginPath()
    ctx.ellipse(cx, hy - 6, 10.5, 7, 0, Math.PI, 0)
    ctx.fill()
    ctx.fillRect(cx - 11, hy - 7, 22, 4)
    ctx.fillRect(cx - 6, hy - 4, 16, 3)
  } else if (hat < 0.28) {
    ctx.fillStyle = r() < 0.5 ? '#e9dcb8' : '#f4f4f0'
    ctx.beginPath()
    ctx.ellipse(cx, hy - 6, 18, 4.5, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(cx, hy - 9, 9.5, 6, 0, Math.PI, 0)
    ctx.fill()
  } else if (r() < 0.93) {
    ctx.fillStyle = hair
    ctx.beginPath()
    ctx.ellipse(cx, hy - 4, 10, 8.5, 0, Math.PI * 1.05, Math.PI * 1.95)
    ctx.fill()
    if (r() < 0.3) ctx.fillRect(cx - 10, hy - 6, 3, 14) // long hair
  }
  if (r() < 0.3) {
    ctx.fillStyle = '#0c0c0e'
    ctx.fillRect(cx - 8, hy - 2, 16, 4)
  }
  // arms
  const sleeve = shade(shirt, 0.82)
  const arm = (side: number, up: boolean, ang = 0) => {
    const x0 = cx + side * (tw / 2 - 3),
      y0 = sh + 6
    ctx.strokeStyle = up ? skin : sleeve
    ctx.lineWidth = 7
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    if (up) ctx.lineTo(x0 + side * (6 + ang * 10), oy + 18 + ang * 8)
    else ctx.lineTo(x0 + side * 2, oy + 112)
    ctx.stroke()
    if (up) {
      ctx.fillStyle = skin
      ctx.beginPath()
      ctx.arc(x0 + side * (6 + ang * 10), oy + 16 + ang * 8, 4.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  if (pose < 0.62) {
    arm(-1, false)
    arm(1, false)
  } else if (pose < 0.78) {
    arm(-1, false)
    arm(1, true, r())
  } else if (pose < 0.88) {
    arm(-1, true, r() * 0.5)
    arm(1, true, r() * 0.5)
  } else if (pose < 0.95) {
    arm(-1, false)
    arm(1, true, 0.6)
    const fx = cx + tw / 2 + 10
    ctx.strokeStyle = '#444'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(fx - 4, oy + 28)
    ctx.lineTo(fx - 4, oy + 2)
    ctx.stroke()
    const fl = pick(FLAGS)
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = fl[k]
      ctx.fillRect(fx - 30 + k * 9, oy + 2, 9, 16)
    }
  } else {
    arm(-1, true, 0.9)
    arm(1, true, 0.9)
    ctx.fillStyle = '#101012'
    ctx.fillRect(cx - 6, oy + 26, 12, 16)
  }
  ctx.restore()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h)
  ctx.lineTo(x, y + h)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function shade(hex: string, k: number) {
  const c = new THREE.Color(hex)
  return `rgb(${Math.round(Math.min(255, c.r * 255 * k))},${Math.round(Math.min(255, c.g * 255 * k))},${Math.round(Math.min(255, c.b * 255 * k))})`
}

let atlas: THREE.Texture | null = null
export function crowdAtlas() {
  if (atlas) return atlas
  const r = mulberry(4242)
  atlas = canvasTexture(COLS * CW, ROWS * CH, (ctx) => {
    ctx.clearRect(0, 0, COLS * CW, ROWS * CH)
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) paintPerson(ctx, i * CW, j * CH, r)
  })
  atlas.anisotropy = 4
  return atlas
}

/** One spectator: base of the card (world), atlas cell, size, how excited they are. */
export interface Spectator {
  x: number
  y: number
  z: number
}

/** Card size at scale 1 (m): a seated person's upper body and lap. */
const CARD_W = 0.62,
  CARD_H = 1.24

/** All the spectators of the circuit in one instanced draw. */
export function crowdMesh(spots: Spectator[], seed = 77) {
  const r = mulberry(seed)
  const n = spots.length
  const g = new THREE.InstancedBufferGeometry()
  const quad = new THREE.PlaneGeometry(1, 1)
  quad.translate(0, 0.5, 0)
  g.index = quad.index
  g.setAttribute('position', quad.getAttribute('position'))
  g.setAttribute('uv', quad.getAttribute('uv'))
  const A = new Float32Array(Math.max(1, n) * 4),
    B = new Float32Array(Math.max(1, n) * 4)
  const box = new THREE.Box3()
  spots.forEach((p, i) => {
    A.set([p.x, p.y, p.z, Math.floor(r() * COLS * ROWS)], i * 4)
    const excited = r() < 0.12 ? 0.6 + r() * 0.4 : r() * 0.25
    B.set([r() * 6.283, excited, 0.92 + r() * 0.16, r()], i * 4)
    box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z))
  })
  g.setAttribute('iA', new THREE.InstancedBufferAttribute(A, 4))
  g.setAttribute('iB', new THREE.InstancedBufferAttribute(B, 4))
  g.instanceCount = n
  g.boundingSphere = box.getBoundingSphere(new THREE.Sphere())
  g.boundingSphere.radius += 2
  const mesh = new THREE.Mesh(g, crowdMaterial(crowdAtlas()))
  mesh.name = 'crowd'
  mesh.castShadow = false
  mesh.receiveShadow = true
  // small: not in the cars' reflection probes
  mesh.userData.noProbe = true
  mesh.matrixAutoUpdate = false
  return mesh
}

function crowdMaterial(tex: THREE.Texture) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 })
  const iA: N = attribute('iA', 'vec4'),
    iB: N = attribute('iB', 'vec4')
  const corner: N = attribute('position', 'vec3')
  const cuv: N = attribute('uv', 'vec2')
  const toCam: N = cameraPosition.sub(iA.xyz)
  const flat = vec2(toCam.x, toCam.z)
  const fn = flat.div(max(flat.length(), 1e-3))
  const right = vec3(fn.y, 0, fn.x.negate())
  const sc = iB.z
  const phase = iB.x,
    excite = iB.y
  const base = iA.xyz.add(right.mul(corner.x.mul(CARD_W).mul(sc))).add(vec3(0, corner.y.mul(CARD_H).mul(sc), 0))
  // idle: a slow sway for everyone, the excited ones bouncing (the top of the card more than the lap)
  const idle = (t: N): N => {
    const sway = sin(t.mul(1.1).add(phase)).mul(0.018).mul(corner.y)
    const bounce: N = max(sin(t.mul(float(3.2).add(excite.mul(2))).add(phase.mul(1.7))), 0).mul(excite).mul(0.07).mul(corner.y.mul(0.7).add(0.3))
    return right.mul(sway).add(vec3(0, bounce, 0))
  }
  m.positionNode = Fn(() => {
    positionPrevious.assign(base.add(idle(motionTime.prev)))
    return base.add(idle(motionTime.now))
  })()
  const cell = iA.w
  const cx = cell.mod(COLS),
    cy = cell.div(COLS).floor()
  const auv = vec2(cx.add(cuv.x).div(COLS), float(1).sub(cy.add(float(1).sub(cuv.y)).div(ROWS)))
  const t = texture(tex, auv)
  // keep the silhouettes' coverage in the smaller mips (alpha tested cards thin out otherwise)
  const lod = log2(max(max(fwidth(auv.x).mul(COLS * CW), fwidth(auv.y).mul(ROWS * CH)), 1))
  const alpha = t.a.mul(lod.mul(0.3).add(1))
  // a little variety in the light the clothes reflect
  const tint = iB.w.mul(0.2).add(0.9)
  m.colorNode = vec4(t.rgb.mul(tint), alpha)
  // rounded: facing the camera, leaning up, turning away at the card's sides
  const nW = normalize(vec3(fn.x, 0, fn.y).add(vec3(0, 0.45, 0)).add(right.mul(cuv.x.sub(0.5).mul(1.1))))
  m.normalNode = cameraViewMatrix.mul(vec4(nW, 0)).xyz.normalize()
  m.roughnessNode = float(0.8)
  m.metalnessNode = float(0)
  return m
}
