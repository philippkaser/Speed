// The signage atlas: every printed board, LED band and screen of the circuit painted once into one
// 2048 x 2048 canvas (16 slots of 1024 x 256), so all the signs are one material and one draw call.
// The sponsors are fictional.
import * as THREE from 'three/webgpu'
import { canvasTexture } from '../textures'
import type { Kit } from './kit'

export const SLOT = {
  speed: 0,
  helix: 1,
  vanta: 2,
  nordkap: 3,
  aurel: 4,
  voltara: 5,
  kairo: 6,
  stratos: 7,
  meridian: 8,
  orbit: 9,
  bridge: 10,
  brake: 11,
  chevron: 12,
  fascia: 13,
  led: 14,
  screen: 15,
} as const

/** sponsor slots, for boards that cycle through them */
export const SPONSORS = [SLOT.speed, SLOT.helix, SLOT.vanta, SLOT.nordkap, SLOT.aurel, SLOT.voltara, SLOT.kairo, SLOT.stratos, SLOT.meridian, SLOT.orbit]

const W = 2048,
  H = 2048,
  SW = 1024,
  SH = 256
const FONT = 'Inter, "Arial Black", Arial, sans-serif'

type Ctx = CanvasRenderingContext2D

function text(ctx: Ctx, s: string, x: number, y: number, size: number, color: string, opts: { weight?: number; italic?: boolean; align?: CanvasTextAlign; spacing?: number; maxW?: number; sy?: number } = {}) {
  ctx.save()
  ctx.fillStyle = color
  ctx.font = `${opts.italic ? 'italic ' : ''}${opts.weight ?? 900} ${size}px ${FONT}`
  ctx.textAlign = opts.align ?? 'center'
  ctx.textBaseline = 'middle'
  if (opts.spacing) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${opts.spacing}px`
  ctx.translate(x, y)
  if (opts.sy) ctx.scale(1, opts.sy)
  if (opts.maxW) {
    const w = ctx.measureText(s).width
    if (w > opts.maxW) ctx.scale(opts.maxW / w, 1)
  }
  ctx.fillText(s, 0, 0)
  ctx.restore()
}

function stripes(ctx: Ctx, x: number, y: number, w: number, h: number, colors: string[], slant = 40) {
  const n = colors.length
  const bw = w / n
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[i]
    ctx.beginPath()
    ctx.moveTo(x + i * bw + slant, y)
    ctx.lineTo(x + (i + 1) * bw + slant, y)
    ctx.lineTo(x + (i + 1) * bw, y + h)
    ctx.lineTo(x + i * bw, y + h)
    ctx.closePath()
    ctx.fill()
  }
}

/** a slight sheen and grime: printed vinyl outdoors */
function weather(ctx: Ctx) {
  const g = ctx.createLinearGradient(0, 0, 0, SH)
  g.addColorStop(0, 'rgba(255,255,255,0.06)')
  g.addColorStop(0.5, 'rgba(255,255,255,0)')
  g.addColorStop(1, 'rgba(0,0,0,0.12)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, SW, SH)
}

const painters: ((ctx: Ctx) => void)[] = []
painters[SLOT.speed] = (ctx) => {
  ctx.fillStyle = '#0b0d10'
  ctx.fillRect(0, 0, SW, SH)
  stripes(ctx, 700, 0, 260, SH, ['#c8102e', '#ffffff', '#c8102e'], 70)
  text(ctx, 'SPEED', 360, 120, 168, '#ffffff', { italic: true, maxW: 600 })
  text(ctx, 'WORLD GT SERIES', 360, 215, 34, '#9aa3ad', { weight: 700, spacing: 8 })
}
painters[SLOT.helix] = (ctx) => {
  ctx.fillStyle = '#f5b800'
  ctx.fillRect(0, 0, SW, SH)
  ctx.strokeStyle = '#111'
  ctx.lineWidth = 14
  for (const ph of [0, Math.PI]) {
    ctx.beginPath()
    for (let x = 0; x <= 150; x += 4) ctx.lineTo(60 + x, 128 + Math.sin(x / 24 + ph) * 60)
    ctx.stroke()
  }
  text(ctx, 'HELIX', 560, 112, 160, '#111111', { maxW: 640 })
  text(ctx, 'SYNTHETIC ENGINE OILS', 560, 210, 36, '#2a2200', { weight: 700, spacing: 6 })
}
painters[SLOT.vanta] = (ctx) => {
  const g = ctx.createLinearGradient(0, 0, SW, 0)
  g.addColorStop(0, '#a50d24')
  g.addColorStop(1, '#e0213c')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, SW, SH)
  stripes(ctx, 40, 0, 120, SH, ['#ffffff', '#a50d24'], 60)
  text(ctx, 'VANTA', 580, 118, 170, '#ffffff', { italic: true, maxW: 660 })
  text(ctx, 'PERFORMANCE PARTS', 580, 214, 34, '#ffd7dc', { weight: 700, spacing: 7 })
}
painters[SLOT.nordkap] = (ctx) => {
  ctx.fillStyle = '#0d47a1'
  ctx.fillRect(0, 0, SW, SH)
  // tyre tread mark
  ctx.fillStyle = '#ffffff'
  for (let i = 0; i < 6; i++) {
    ctx.beginPath()
    ctx.moveTo(50 + i * 30, 50)
    ctx.lineTo(70 + i * 30, 50)
    ctx.lineTo(50 + i * 30, 206)
    ctx.lineTo(30 + i * 30, 206)
    ctx.fill()
  }
  text(ctx, 'NORDKAP', 610, 112, 150, '#ffffff', { maxW: 680 })
  text(ctx, 'RACING TYRES', 610, 210, 36, '#bcd3ff', { weight: 700, spacing: 10 })
}
painters[SLOT.aurel] = (ctx) => {
  ctx.fillStyle = '#111111'
  ctx.fillRect(0, 0, SW, SH)
  ctx.strokeStyle = '#d4af37'
  ctx.lineWidth = 6
  ctx.strokeRect(24, 24, SW - 48, SH - 48)
  ctx.save()
  ctx.fillStyle = '#d4af37'
  ctx.font = `700 150px Georgia, "Times New Roman", serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('AUREL', 512, 112)
  ctx.font = `600 32px ${FONT}`
  ;(ctx as unknown as { letterSpacing: string }).letterSpacing = '14px'
  ctx.fillText('GRAND TOURING', 512, 200)
  ctx.restore()
}
painters[SLOT.voltara] = (ctx) => {
  ctx.fillStyle = '#f7f7f5'
  ctx.fillRect(0, 0, SW, SH)
  ctx.fillStyle = '#00897b'
  ctx.beginPath()
  ctx.moveTo(110, 30)
  ctx.lineTo(60, 140)
  ctx.lineTo(105, 140)
  ctx.lineTo(80, 226)
  ctx.lineTo(160, 104)
  ctx.lineTo(114, 104)
  ctx.lineTo(140, 30)
  ctx.fill()
  text(ctx, 'VOLTARA', 590, 112, 150, '#00897b', { italic: true, maxW: 680 })
  text(ctx, 'RENEWABLE ENERGY', 590, 210, 34, '#2d4d49', { weight: 700, spacing: 7 })
}
painters[SLOT.kairo] = (ctx) => {
  ctx.fillStyle = '#0f1c2e'
  ctx.fillRect(0, 0, SW, SH)
  ctx.strokeStyle = '#c9d1d9'
  ctx.lineWidth = 8
  ctx.beginPath()
  ctx.arc(128, 128, 86, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(128, 128)
  ctx.lineTo(128, 64)
  ctx.moveTo(128, 128)
  ctx.lineTo(176, 150)
  ctx.stroke()
  text(ctx, 'KAIRO', 600, 110, 150, '#e6ebf0', { weight: 300, spacing: 20, maxW: 640 })
  text(ctx, 'SWISS CHRONOGRAPHS', 600, 208, 32, '#8fa1b5', { weight: 600, spacing: 8 })
}
painters[SLOT.stratos] = (ctx) => {
  ctx.fillStyle = '#121212'
  ctx.fillRect(0, 0, SW, SH)
  ctx.fillStyle = '#ff6a00'
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(420, 0)
  ctx.lineTo(320, SH)
  ctx.lineTo(0, SH)
  ctx.fill()
  text(ctx, 'S', 170, 128, 210, '#121212', { italic: true })
  text(ctx, 'STRATOS', 680, 112, 140, '#ffffff', { italic: true, maxW: 600 })
  text(ctx, 'RACING FUELS', 680, 208, 36, '#ff9a4d', { weight: 700, spacing: 9 })
}
painters[SLOT.meridian] = (ctx) => {
  ctx.fillStyle = '#0e3b2e'
  ctx.fillRect(0, 0, SW, SH)
  ctx.fillStyle = '#4fd1a5'
  ctx.beginPath()
  ctx.arc(128, 128, 80, Math.PI, 0)
  ctx.fill()
  ctx.fillRect(48, 140, 160, 16)
  text(ctx, 'MERIDIAN', 610, 116, 140, '#ffffff', { weight: 800, maxW: 680 })
  text(ctx, 'PRIVATE BANK', 610, 210, 34, '#9fe3c9', { weight: 600, spacing: 10 })
}
painters[SLOT.orbit] = (ctx) => {
  const g = ctx.createLinearGradient(0, 0, SW, SH)
  g.addColorStop(0, '#3b0a6b')
  g.addColorStop(1, '#7b2ff7')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, SW, SH)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 10
  ctx.beginPath()
  ctx.ellipse(130, 128, 90, 40, -0.4, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(130, 128, 30, 0, Math.PI * 2)
  ctx.fill()
  text(ctx, 'orbit', 600, 112, 170, '#ffffff', { weight: 800, maxW: 640 })
  text(ctx, '5G MOBILE NETWORK', 600, 212, 32, '#dcc8ff', { weight: 600, spacing: 8 })
}
painters[SLOT.bridge] = (ctx) => {
  ctx.fillStyle = '#0a1a3a'
  ctx.fillRect(0, 0, SW, SH)
  stripes(ctx, -40, 0, 180, SH, ['#c8102e', '#ffffff', '#0d47a1'], 60)
  stripes(ctx, SW - 150, 0, 180, SH, ['#0d47a1', '#ffffff', '#c8102e'], 60)
  text(ctx, 'WORLD GT CHAMPIONSHIP', 512, 108, 84, '#ffffff', { italic: true, maxW: 700 })
  text(ctx, 'AUTODROMO VALLE ALTA', 512, 196, 38, '#9fb3d9', { weight: 700, spacing: 10, maxW: 680 })
}
painters[SLOT.brake] = (ctx) => {
  // three portrait boards 341 px wide: the board's aspect is 0.9 x 1.6 m, so the text is drawn
  // squashed to come out right
  ctx.fillStyle = '#f2f2ee'
  ctx.fillRect(0, 0, SW, SH)
  const labels = ['300', '200', '100']
  for (let k = 0; k < 3; k++) {
    const x0 = k * 341
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 16
    ctx.strokeRect(x0 + 12, 8, 317, 240)
    for (let b = 0; b <= k; b++) {
      ctx.fillStyle = '#111'
      ctx.fillRect(x0 + 50 + b * 36, 30, 22, 30)
    }
    text(ctx, labels[k], x0 + 170, 160, 150, '#111111', { sy: 0.62, maxW: 290 })
  }
}
painters[SLOT.chevron] = (ctx) => {
  ctx.fillStyle = '#c8102e'
  ctx.fillRect(0, 0, 512, SH)
  ctx.fillStyle = '#ffffff'
  for (let i = 0; i < 3; i++) {
    const x = 60 + i * 150
    ctx.beginPath()
    ctx.moveTo(x, 30)
    ctx.lineTo(x + 70, 30)
    ctx.lineTo(x + 150, 128)
    ctx.lineTo(x + 70, 226)
    ctx.lineTo(x, 226)
    ctx.lineTo(x + 80, 128)
    ctx.fill()
  }
  ctx.fillStyle = '#1e4fb3'
  ctx.fillRect(512, 0, 512, SH)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 10
  ctx.strokeRect(530, 18, 476, 220)
  text(ctx, 'PIT', 768, 132, 170, '#ffffff')
}
painters[SLOT.fascia] = (ctx) => {
  ctx.fillStyle = '#111316'
  ctx.fillRect(0, 0, SW, SH)
  ctx.fillStyle = '#c8102e'
  ctx.fillRect(0, 200, SW, 22)
  text(ctx, 'AUTODROMO VALLE ALTA', 512, 104, 96, '#ffffff', { weight: 800, maxW: 940, spacing: 4 })
}
painters[SLOT.led] = (ctx) => {
  ctx.fillStyle = '#05070a'
  ctx.fillRect(0, 0, SW, SH)
  text(ctx, 'SPEED', 250, 128, 150, '#ffffff', { italic: true })
  ctx.fillStyle = '#e8102e'
  ctx.fillRect(470, 60, 12, 136)
  text(ctx, 'WORLD GT', 740, 128, 120, '#ffcc00', { italic: true, maxW: 480 })
  // LED pixel grid
  ctx.fillStyle = 'rgba(0,0,0,0.35)'
  for (let y = 0; y < SH; y += 6) ctx.fillRect(0, y, SW, 2)
  for (let x = 0; x < SW; x += 6) ctx.fillRect(x, 0, 2, SH)
}
painters[SLOT.screen] = (ctx) => {
  // big screen: race broadcast graphics
  const g = ctx.createLinearGradient(0, 0, 0, SH)
  g.addColorStop(0, '#1a3a6a')
  g.addColorStop(1, '#0a1428')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, SW, SH)
  ctx.fillStyle = '#c8102e'
  ctx.fillRect(0, 0, 300, SH)
  text(ctx, 'LIVE', 150, 90, 90, '#ffffff', { italic: true })
  text(ctx, 'LAP 1/12', 150, 180, 44, '#ffffff', { weight: 700 })
  const names = ['1  VAN DER BERG', '2  MORETTI', '3  OKONKWO', '4  LINDQVIST']
  names.forEach((n, i) => {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.12)'
    ctx.fillRect(320, 12 + i * 60, 690, 54)
    text(ctx, n, 340, 40 + i * 60, 40, '#ffffff', { weight: 700, align: 'left' })
    text(ctx, ['+0.000', '+1.284', '+2.910', '+4.077'][i], 990, 40 + i * 60, 36, '#ffd24d', { weight: 600, align: 'right' })
  })
  ctx.fillStyle = 'rgba(0,0,0,0.3)'
  for (let y = 0; y < SH; y += 5) ctx.fillRect(0, y, SW, 1)
}

let atlas: THREE.Texture | null = null
/** The atlas texture (painted on first use). */
export function signAtlas() {
  if (atlas) return atlas
  atlas = canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#808080'
    ctx.fillRect(0, 0, W, H)
    for (let i = 0; i < 16; i++) {
      const x = (i % 2) * SW,
        y = Math.floor(i / 2) * SH
      ctx.save()
      ctx.translate(x, y)
      ctx.beginPath()
      ctx.rect(0, 0, SW, SH)
      ctx.clip()
      painters[i]?.(ctx)
      if (i !== SLOT.led && i !== SLOT.screen) weather(ctx)
      ctx.restore()
    }
  })
  atlas.anisotropy = 16
  return atlas
}

/**
 * Atlas uv rectangle [u0, v0, u1, v1] (v0 bottom) of a slot, or of a sub-rectangle of it given in
 * slot pixels (x0, x1 across 0..1024). Inset half a texel... a few texels against mip bleeding.
 */
export function slotUV(slot: number, x0 = 0, x1 = SW, inset = 3): [number, number, number, number] {
  const sx = (slot % 2) * SW,
    sy = Math.floor(slot / 2) * SH
  const u0 = (sx + x0 + inset) / W,
    u1 = (sx + x1 - inset) / W
  const vTop = 1 - (sy + inset) / H,
    vBot = 1 - (sy + SH - inset) / H
  return [u0, vBot, u1, vTop]
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _d = new THREE.Vector3()

/**
 * A sign face in a kit's local frame: centre, width along local x (or `axis`), height along y, facing
 * `normal` (+z by default). emission: LED panels.
 */
export function signQuad(
  kit: Kit,
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  uvr: [number, number, number, number],
  opts: { facing?: 1 | -1; emission?: number; gloss?: number; axis?: 'x' | 'z' } = {},
) {
  const f = opts.facing ?? 1
  const hw = w / 2,
    hh = h / 2
  if ((opts.axis ?? 'x') === 'x') {
    // facing +z: a (left, bottom) is at -x
    _a.set(cx - hw * f, cy - hh, cz)
    _b.set(cx + hw * f, cy - hh, cz)
    _c.set(cx + hw * f, cy + hh, cz)
    _d.set(cx - hw * f, cy + hh, cz)
  } else {
    // facing +x
    _a.set(cx, cy - hh, cz + hw * f)
    _b.set(cx, cy - hh, cz - hw * f)
    _c.set(cx, cy + hh, cz - hw * f)
    _d.set(cx, cy + hh, cz + hw * f)
  }
  kit.extra.aSign.cur[0] = opts.emission ?? 0
  kit.extra.aSign.cur[1] = opts.gloss ?? 0
  const [u0, v0, u1, v1] = uvr
  kit.quad(_a, _b, _c, _d, SIGN_SURF, [u0, v0, u1, v0, u1, v1, u0, v1])
}

const SIGN_SURF = { c: [1, 1, 1] as const, r: 0.5 }

/** A kit for signs (adds the aSign attribute). */
export function signKit(K: new () => Kit) {
  const k = new K()
  k.defineExtra('aSign', 2, [0, 0])
  return k
}
