// The crowd: every spectator is one camera-facing card (instanced, one draw call for all the stands)
// drawn from a procedurally painted atlas of 96 different people, painted as people look in a
// photograph rather than as figures: real proportions and skin tones, clothes mostly in neutrals,
// volumes lit from above, folds, the lap in the shadow of the row in front, grain over all of it; caps
// and sun hats, sunglasses, arms down, waving or cheering, flags and phones held up.
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
  ROWS = 6,
  CW = 96,
  CH = 192

// Real colours, not display colours: skin as photographed in daylight, clothes mostly neutrals (a crowd
// reads as navy, black, grey, denim, khaki and white), team colours at the strength of dyed fabric
const SKIN = ['#e3bea2', '#d6a688', '#c48f6c', '#a9765a', '#8a5a40', '#6a4330', '#4e2f22']
const HAIR = ['#1a1410', '#2b1f17', '#3f2c1f', '#5c4230', '#80633f', '#a88c62', '#7d7975', '#4a4744', '#b9b4ab']
const NEUTRAL = ['#2a3346', '#1f2024', '#3b3e44', '#5b5e63', '#8a8c8f', '#b5b3ac', '#c9c8c2', '#d9d6cc', '#e4e3de', '#e8e7e2', '#4a5d78', '#6f84a3', '#9aa3ad', '#8a7d5c', '#c2b49a', '#575c3f', '#6b4a3a']
const TEAM = ['#a8232b', '#c9a227', '#c8571e', '#2c56a0', '#2f6a3e', '#8b1f2a', '#d8d6d0', '#1b2a4a']
const PANTS = ['#2b3346', '#1d1e21', '#4f5d74', '#6b6250', '#3c3f44', '#5a5040', '#7c7666']
const FLAGS = [
  ['#b31b2c', '#e8e6e0', '#b31b2c'],
  ['#1f7a45', '#e8e6e0', '#b8323a'],
  ['#151515', '#c0262b', '#e0b525'],
  ['#2a4f9a', '#e8e6e0', '#c8363f'],
  ['#e0b525', '#151515', '#e0b525'],
  ['#1d3f8a', '#e8e6e0', '#1d3f8a'],
]

/** a colour at k times its brightness, with alpha */
function tone(hex: string, k: number, a = 1) {
  const c = new THREE.Color(hex)
  return `rgba(${Math.round(Math.min(255, c.r * 255 * k))},${Math.round(Math.min(255, c.g * 255 * k))},${Math.round(Math.min(255, c.b * 255 * k))},${a})`
}

/**
 * One seated spectator in a 96 x 192 px cell (0.62 x 1.24 m: 155 px a metre). Proportions of a real
 * person (shoulders ~0.44 m, head ~0.16 x 0.22 m), painted as volumes: light from above, the torso
 * rounding away at its sides, folds in the cloth, the lap half hidden behind the seat row in front.
 */
function paintPerson(ctx: CanvasRenderingContext2D, ox: number, oy: number, r: () => number) {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
  const skin = pick(SKIN),
    hair = pick(HAIR),
    pants = pick(PANTS)
  const shirt = r() < 0.68 ? pick(NEUTRAL) : pick(TEAM)
  const jacket = r() < 0.22 ? pick(NEUTRAL) : null
  const pose = r() // < 0.66 arms down, < 0.8 one arm up, < 0.88 both up, < 0.94 flag, else phone
  const hat = r() // < 0.2 cap, < 0.3 sun hat
  const female = r() < 0.4
  const wide = (female ? 0.86 : 0.97) + r() * 0.14
  const cx = ox + 48 + (r() - 0.5) * 6
  const sh = oy + 98 + (r() - 0.5) * 8 // shoulder line
  const sw = 68 * wide // shoulder width
  const ww = sw * 0.86 // waist
  const hipY = oy + 168
  ctx.save()
  // lap: thighs coming towards the viewer, foreshortened
  const lg = ctx.createLinearGradient(0, hipY - 8, 0, oy + 190)
  lg.addColorStop(0, tone(pants, 1.05))
  lg.addColorStop(1, tone(pants, 0.7))
  ctx.fillStyle = lg
  ctx.beginPath()
  ctx.ellipse(cx - sw * 0.2, hipY + 10, sw * 0.26, 14, 0.1, 0, Math.PI * 2)
  ctx.ellipse(cx + sw * 0.2, hipY + 10, sw * 0.26, 14, -0.1, 0, Math.PI * 2)
  ctx.fill()
  // torso: rounded shoulders, narrowing to the waist
  const torsoCol = jacket ?? shirt
  const tg = ctx.createLinearGradient(cx - sw / 2, 0, cx + sw / 2, 0)
  tg.addColorStop(0, tone(torsoCol, 0.74))
  tg.addColorStop(0.3, tone(torsoCol, 0.98))
  tg.addColorStop(0.55, tone(torsoCol, 1.04))
  tg.addColorStop(1, tone(torsoCol, 0.78))
  ctx.fillStyle = tg
  ctx.beginPath()
  ctx.moveTo(cx - sw / 2 + 8, sh)
  ctx.quadraticCurveTo(cx - sw / 2, sh + 2, cx - sw / 2, sh + 16)
  ctx.lineTo(cx - ww / 2, hipY + 4)
  ctx.lineTo(cx + ww / 2, hipY + 4)
  ctx.lineTo(cx + sw / 2, sh + 16)
  ctx.quadraticCurveTo(cx + sw / 2, sh + 2, cx + sw / 2 - 8, sh)
  ctx.closePath()
  ctx.fill()
  // light from above on the shoulders, shade towards the waist
  const vg = ctx.createLinearGradient(0, sh, 0, hipY)
  vg.addColorStop(0, 'rgba(255,255,255,0.12)')
  vg.addColorStop(0.5, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(0,0,0,0.18)')
  ctx.fillStyle = vg
  ctx.fill()
  // folds in the cloth: a few soft darker strokes
  ctx.strokeStyle = tone(torsoCol, 0.6, 0.35)
  ctx.lineWidth = 2.2
  ctx.lineCap = 'round'
  for (let k = 0; k < 3; k++) {
    const fx = cx + (r() - 0.5) * ww * 0.8,
      fy = sh + 30 + r() * 30
    ctx.beginPath()
    ctx.moveTo(fx, fy)
    ctx.quadraticCurveTo(fx + (r() - 0.5) * 10, fy + 12, fx + (r() - 0.5) * 14, fy + 24)
    ctx.stroke()
  }
  // an open jacket shows the shirt; or a print on the shirt
  if (jacket) {
    ctx.fillStyle = tone(shirt, 0.92)
    ctx.beginPath()
    ctx.moveTo(cx - 9, sh + 2)
    ctx.lineTo(cx + 9, sh + 2)
    ctx.lineTo(cx + 6, hipY)
    ctx.lineTo(cx - 6, hipY)
    ctx.closePath()
    ctx.fill()
  } else if (r() < 0.3) {
    ctx.fillStyle = tone(pick(TEAM), 0.9, 0.85)
    ctx.fillRect(cx - 10 + (r() - 0.5) * 8, sh + 22, 18, 12)
  }
  // neck, in the head's shadow
  ctx.fillStyle = tone(skin, 0.8)
  ctx.fillRect(cx - 6, sh - 14, 12, 16)
  // head: ~0.16 x 0.22 m
  const hy = sh - 30
  const hw = 12.5 * (female ? 0.94 : 1),
    hh = 17
  const hg = ctx.createRadialGradient(cx - 3, hy - 5, 2, cx, hy, 20)
  hg.addColorStop(0, tone(skin, 1.08))
  hg.addColorStop(0.7, tone(skin, 1.0))
  hg.addColorStop(1, tone(skin, 0.84))
  ctx.fillStyle = hg
  ctx.beginPath()
  ctx.ellipse(cx, hy, hw, hh, 0, 0, Math.PI * 2)
  ctx.fill()
  // the face's shading: brow and eye sockets, under the nose and the chin
  ctx.fillStyle = tone(skin, 0.7, 0.25)
  ctx.fillRect(cx - 8, hy - 3, 16, 4)
  ctx.fillRect(cx - 3, hy + 6, 6, 2)
  ctx.fillStyle = tone(skin, 0.65, 0.2)
  ctx.beginPath()
  ctx.ellipse(cx, hy + 15, 8, 3, 0, 0, Math.PI)
  ctx.fill()
  if (r() < 0.32) {
    // sunglasses
    ctx.fillStyle = 'rgba(12,12,14,0.85)'
    ctx.beginPath()
    ctx.ellipse(cx - 5, hy - 1, 4.5, 3, 0, 0, Math.PI * 2)
    ctx.ellipse(cx + 5, hy - 1, 4.5, 3, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  // hair (an uneven outline) or a hat
  const hairShape = (long: boolean) => {
    ctx.fillStyle = tone(hair, 1)
    ctx.beginPath()
    const n = 14
    for (let k = 0; k <= n; k++) {
      const t = Math.PI * (1.02 + (0.96 * k) / n)
      const rr = 1 + (r() - 0.5) * 0.12
      const x = cx + Math.cos(t) * (hw + 2) * rr,
        y = hy - 3 + Math.sin(t) * (hh + 1) * rr
      if (k === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()
    if (long) {
      ctx.fillRect(cx - hw - 2, hy - 4, 5, hh + 16)
      ctx.fillRect(cx + hw - 3, hy - 4, 5, hh + 16)
    }
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.ellipse(cx - 3, hy - hh + 2, hw * 0.6, 3, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  if (hat < 0.2) {
    const capCol = r() < 0.5 ? pick(TEAM) : pick(NEUTRAL)
    ctx.fillStyle = tone(capCol, 0.95)
    ctx.beginPath()
    ctx.ellipse(cx, hy - 9, hw + 1.5, 9, 0, Math.PI, 0)
    ctx.fill()
    ctx.fillStyle = tone(capCol, 0.7)
    ctx.fillRect(cx - hw - 2, hy - 10, (hw + 2) * 2, 4)
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(cx - hw, hy - 6, hw * 2, 4)
  } else if (hat < 0.3) {
    ctx.fillStyle = r() < 0.5 ? '#d9cca6' : '#e6e3da'
    ctx.beginPath()
    ctx.ellipse(cx, hy - 9, hw + 10, 5, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(cx, hy - 12, hw + 1, 8, 0, Math.PI, 0)
    ctx.fill()
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    ctx.fillRect(cx - hw, hy - 5, hw * 2, 5)
  } else if (r() < 0.94) hairShape(female && r() < 0.7)
  // arms: tapered, sleeves or skin, a hand at the end
  const sleeve = jacket ?? shirt
  const longSleeve = !!jacket || r() < 0.3
  const limb = (x0: number, y0: number, x1: number, y1: number, w0: number, w1: number, col: string) => {
    const dx = x1 - x0,
      dy = y1 - y0
    const l = Math.hypot(dx, dy) || 1
    const nx = -dy / l,
      ny = dx / l
    ctx.fillStyle = col
    ctx.beginPath()
    ctx.moveTo(x0 + nx * w0, y0 + ny * w0)
    ctx.lineTo(x1 + nx * w1, y1 + ny * w1)
    ctx.lineTo(x1 - nx * w1, y1 - ny * w1)
    ctx.lineTo(x0 - nx * w0, y0 - ny * w0)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x1, y1, w1, 0, Math.PI * 2)
    ctx.fill()
  }
  const arm = (side: number, up: boolean, ang = 0) => {
    const x0 = cx + side * (sw / 2 - 6),
      y0 = sh + 10
    if (up) {
      const ex = x0 + side * (10 + ang * 8),
        ey = sh - 30 - ang * 8
      const hx = x0 + side * (6 + ang * 16),
        hy2 = oy + 30 + ang * 10
      limb(x0, y0, ex, ey, 7, 6, tone(sleeve, 0.85))
      limb(ex, ey, hx, hy2, 6, 5, longSleeve ? tone(sleeve, 0.9) : tone(skin, 0.92))
      ctx.fillStyle = tone(skin, 0.95)
      ctx.beginPath()
      ctx.ellipse(hx, hy2 - 3, 5, 6, 0, 0, Math.PI * 2)
      ctx.fill()
    } else {
      const ex = x0 + side * 3,
        ey = sh + 46
      const hx = cx + side * (sw * 0.24),
        hy2 = hipY + 2
      limb(x0, y0, ex, ey, 7.5, 6.5, tone(sleeve, 0.8))
      limb(ex, ey, hx, hy2, 6.5, 5.5, longSleeve ? tone(sleeve, 0.78) : tone(skin, 0.84))
      ctx.fillStyle = tone(skin, 0.8)
      ctx.beginPath()
      ctx.ellipse(hx, hy2, 5.5, 4.5, 0, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  if (pose < 0.66) {
    arm(-1, false)
    arm(1, false)
  } else if (pose < 0.8) {
    arm(-1, false)
    arm(1, true, r())
  } else if (pose < 0.88) {
    arm(-1, true, r() * 0.5)
    arm(1, true, r() * 0.5)
  } else if (pose < 0.94) {
    arm(-1, false)
    arm(1, true, 0.6)
    const fx = cx + sw / 2 + 12
    ctx.strokeStyle = '#4a4a4a'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(fx - 4, oy + 46)
    ctx.lineTo(fx - 4, oy + 4)
    ctx.stroke()
    const fl = pick(FLAGS)
    // a cloth flag, sagging and creased
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = tone(fl[k], 0.9)
      ctx.beginPath()
      ctx.moveTo(fx - 44 + k * 13, oy + 5 + k * 1.5)
      ctx.lineTo(fx - 31 + k * 13, oy + 5 + (k + 1) * 1.5)
      ctx.lineTo(fx - 31 + k * 13, oy + 28 + (k + 1) * 1.2)
      ctx.lineTo(fx - 44 + k * 13, oy + 28 + k * 1.2)
      ctx.closePath()
      ctx.fill()
    }
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.fillRect(fx - 44, oy + 18, 40, 3)
  } else {
    arm(-1, true, 0.9)
    arm(1, true, 0.9)
    ctx.fillStyle = '#141416'
    ctx.fillRect(cx - 8, oy + 38, 16, 22)
    ctx.fillStyle = 'rgba(120,140,170,0.35)'
    ctx.fillRect(cx - 6, oy + 40, 12, 17)
  }
  // the seat row in front hides and shadows the lap
  const og = ctx.createLinearGradient(0, hipY - 30, 0, oy + CH)
  og.addColorStop(0, 'rgba(0,0,0,0)')
  og.addColorStop(1, 'rgba(0,0,0,0.4)')
  ctx.globalCompositeOperation = 'source-atop'
  ctx.fillStyle = og
  ctx.fillRect(ox, hipY - 30, CW, oy + CH - (hipY - 30))
  ctx.restore()
}

/** Film grain and a slight softening over the painted cells: no clean vector edges. */
function weatherAtlas(ctx: CanvasRenderingContext2D, w: number, h: number, r: () => number) {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue
    const n = (r() - 0.5) * 18
    d[i] = Math.max(0, Math.min(255, d[i] + n))
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n))
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n))
  }
  ctx.putImageData(img, 0, 0)
  const soft = document.createElement('canvas')
  soft.width = w
  soft.height = h
  const sc = soft.getContext('2d')!
  sc.filter = 'blur(0.6px)'
  sc.drawImage(ctx.canvas, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(soft, 0, 0)
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

let atlas: THREE.Texture | null = null
export function crowdAtlas() {
  if (atlas) return atlas
  const r = mulberry(4242)
  atlas = canvasTexture(COLS * CW, ROWS * CH, (ctx) => {
    ctx.clearRect(0, 0, COLS * CW, ROWS * CH)
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) paintPerson(ctx, i * CW, j * CH, r)
    weatherAtlas(ctx, COLS * CW, ROWS * CH, r)
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
