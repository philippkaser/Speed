// Unified driver input: keyboard, gamepads (standard mapping) and steering wheels via the Gamepad API.
import { clamp } from '../physics/math'
import { useSettings } from '../state/settings'

export interface DriverControls {
  steer: number
  throttle: number
  brake: number
  handbrake: number
  clutch: number
  shiftUp: boolean
  shiftDown: boolean
  device: 'keyboard' | 'gamepad' | 'wheel'
}

export type ActionName = 'camera' | 'lookBack' | 'reset' | 'pause' | 'hud' | 'racingLine' | 'shiftUp' | 'shiftDown' | 'lookLeft' | 'lookRight' | 'biasFwd' | 'biasRear' | 'tcCycle' | 'telemetry'

const KEYMAP: Record<string, ActionName> = {
  KeyC: 'camera',
  KeyB: 'lookBack',
  KeyR: 'reset',
  Escape: 'pause',
  KeyP: 'pause',
  KeyH: 'hud',
  KeyL: 'racingLine',
  KeyE: 'shiftUp',
  ShiftLeft: 'shiftUp',
  ShiftRight: 'shiftUp',
  KeyQ: 'shiftDown',
  ControlLeft: 'shiftDown',
  ControlRight: 'shiftDown',
  KeyZ: 'lookLeft',
  KeyX: 'lookRight',
  BracketRight: 'biasFwd',
  BracketLeft: 'biasRear',
  KeyT: 'tcCycle',
  KeyI: 'telemetry',
}

const WHEEL_IDS = /wheel|g2[79]|g9[23]|g920|g923|t300|t150|t248|tmx|fanatec|csl|podium|simucube|moza|046d-c2|044f-b6|0eb7/i

type Listener = (a: ActionName) => void

export class InputManager {
  private keys = new Set<string>()
  private listeners = new Set<Listener>()
  private prevButtons: boolean[][] = []
  controls: DriverControls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0, shiftUp: false, shiftDown: false, device: 'keyboard' }
  private kbSteer = 0
  private kbThrottle = 0
  private kbBrake = 0
  lastDevice: DriverControls['device'] = 'keyboard'
  enabled = true
  private attached = false
  held: Record<string, boolean> = {}

  attach() {
    if (this.attached || typeof window === 'undefined') return
    this.attached = true
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', () => this.keys.clear())
  }

  detach() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.attached = false
  }

  on(fn: Listener) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(a: ActionName) {
    if (a === 'shiftUp') this.controls.shiftUp = true
    if (a === 'shiftDown') this.controls.shiftDown = true
    for (const l of this.listeners) l(a)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault()
    if (!e.repeat) {
      const a = KEYMAP[e.code]
      if (a) this.emit(a)
    }
    this.keys.add(e.code)
    this.lastDevice = 'keyboard'
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }

  isDown(code: string) {
    return this.keys.has(code)
  }

  /** Poll devices and produce filtered controls. speed in m/s for speed-sensitive keyboard steering. */
  update(dt: number, speed: number) {
    const st = useSettings.getState().controls
    const c = this.controls
    const k = this.keys
    // ---- keyboard
    const left = k.has('KeyA') || k.has('ArrowLeft')
    const right = k.has('KeyD') || k.has('ArrowRight')
    const up = k.has('KeyW') || k.has('ArrowUp')
    const down = k.has('KeyS') || k.has('ArrowDown')
    const target = (right ? 1 : 0) - (left ? 1 : 0)
    const speedFactor = 1 / (1 + speed / 38)
    const sens = st.steeringSensitivity
    const rateIn = 2.6 * sens * (0.45 + 0.55 * speedFactor)
    const rateOut = 4.2 * sens
    if (target !== 0) {
      const rate = Math.sign(target) !== Math.sign(this.kbSteer) && this.kbSteer !== 0 ? rateOut : rateIn
      this.kbSteer = moveTo(this.kbSteer, target, rate * dt)
    } else this.kbSteer = moveTo(this.kbSteer, 0, rateOut * dt)
    this.kbThrottle = moveTo(this.kbThrottle, up ? 1 : 0, (up ? 5 : 9) * dt)
    this.kbBrake = moveTo(this.kbBrake, down ? 1 : 0, (down ? 4.5 : 9) * dt)
    let steer = this.kbSteer
    let throttle = this.kbThrottle
    let brake = this.kbBrake
    let handbrake = k.has('Space') ? 1 : 0
    let clutch = 0
    let device: DriverControls['device'] = 'keyboard'
    const usingKeys = left || right || up || down || handbrake > 0

    // ---- gamepads / wheels
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []
    for (let pi = 0; pi < pads.length; pi++) {
      const p = pads[pi]
      if (!p || !p.connected) continue
      const isWheel = WHEEL_IDS.test(p.id)
      const prev = this.prevButtons[pi] ?? []
      const pressed = p.buttons.map((b) => b.pressed || b.value > 0.5)
      const edge = (i: number) => pressed[i] && !prev[i]
      this.prevButtons[pi] = pressed

      let ps = 0,
        pt = 0,
        pb = 0,
        pc = 0
      if (isWheel) {
        const ax = (i: number) => (i >= 0 && i < p.axes.length ? p.axes[i] : 0)
        ps = clamp(ax(st.steerAxis), -1, 1)
        const pedal = (i: number) => {
          if (i < 0 || i >= p.axes.length) return 0
          const raw = p.axes[i]
          const v = st.invertPedals ? (raw + 1) / 2 : (1 - raw) / 2
          return clamp(v, 0, 1)
        }
        pt = st.throttleAxis >= 0 ? pedal(st.throttleAxis) : (p.buttons[7]?.value ?? 0)
        pb = st.brakeAxis >= 0 ? pedal(st.brakeAxis) : (p.buttons[6]?.value ?? 0)
        pc = st.clutchAxis >= 0 ? pedal(st.clutchAxis) : 0
        // paddles
        if (edge(4)) this.emit('shiftDown')
        if (edge(5)) this.emit('shiftUp')
        if (edge(9)) this.emit('pause')
        if (edge(3)) this.emit('camera')
      } else {
        let x = p.axes[0] ?? 0
        const dz = st.deadzone
        x = Math.abs(x) < dz ? 0 : (Math.sign(x) * (Math.abs(x) - dz)) / (1 - dz)
        ps = Math.sign(x) * Math.pow(Math.abs(x), st.steeringLinearity)
        pt = p.buttons[7]?.value ?? 0
        pb = p.buttons[6]?.value ?? 0
        if (pressed[1]) handbrake = 1
        if (edge(0) || edge(5)) this.emit('shiftUp')
        if (edge(2) || edge(4)) this.emit('shiftDown')
        if (edge(3)) this.emit('camera')
        if (edge(9)) this.emit('pause')
        if (edge(8)) this.emit('lookBack')
        if (edge(12)) this.emit('hud')
        if (edge(13)) this.emit('reset')
      }
      const active = Math.abs(ps) > 0.02 || pt > 0.02 || pb > 0.02
      if (active || (!usingKeys && this.lastDevice !== 'keyboard')) {
        if (active) this.lastDevice = isWheel ? 'wheel' : 'gamepad'
        if (!usingKeys) {
          steer = ps
          throttle = pt
          brake = pb
          clutch = pc
          device = isWheel ? 'wheel' : 'gamepad'
        }
      }
      this.held['lookBackPad'] = !isWheel && pressed[8]
      this.rumbleTarget = p
    }
    c.steer = this.enabled ? steer : 0
    c.throttle = this.enabled ? throttle : 0
    c.brake = this.enabled ? brake : 0
    c.handbrake = this.enabled ? handbrake : 0
    c.clutch = clutch
    c.device = device
    return c
  }

  /** Consume edge-triggered shift requests */
  consumeShifts() {
    const up = this.controls.shiftUp,
      down = this.controls.shiftDown
    this.controls.shiftUp = false
    this.controls.shiftDown = false
    return { up, down }
  }

  private rumbleTarget: Gamepad | null = null
  private lastRumble = 0
  rumble(strong: number, weak: number) {
    if (!useSettings.getState().controls.vibration) return
    const p = this.rumbleTarget as (Gamepad & { vibrationActuator?: { playEffect: (t: string, o: object) => Promise<unknown> } }) | null
    const now = performance.now()
    if (!p?.vibrationActuator || now - this.lastRumble < 60) return
    this.lastRumble = now
    if (strong < 0.02 && weak < 0.02) return
    p.vibrationActuator.playEffect('dual-rumble', { duration: 80, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }).catch(() => {})
  }

  lookBack() {
    return this.keys.has('KeyB') || !!this.held['lookBackPad']
  }
  lookSide() {
    return (this.keys.has('KeyX') ? 1 : 0) - (this.keys.has('KeyZ') ? 1 : 0)
  }
}

function moveTo(v: number, t: number, d: number) {
  if (v < t) return Math.min(t, v + d)
  if (v > t) return Math.max(t, v - d)
  return v
}

export const input = new InputManager()
