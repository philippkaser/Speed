// Unified driver input: keyboard, gamepads (standard mapping) and steering wheels via the Gamepad API.
import { clamp } from '../physics/math'
import { type ControlSettings, useSettings } from '../state/settings'

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
  /** keyboard steering / pedal ramps (shared with the headless feel probe: scripts/feel-probe.ts) */
  readonly kb = new KeyboardFilter()
  readonly pad = new PadFilter()
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

  /**
   * Poll devices and produce filtered controls. speed in m/s for speed-sensitive steering; slip: the
   * car's body slip angle (rad, Vehicle.bodySlip) so that keyboard opposite lock is quick.
   */
  update(dt: number, speed: number, slip = 0) {
    const st = useSettings.getState().controls
    const c = this.controls
    const k = this.keys
    // ---- keyboard
    const left = k.has('KeyA') || k.has('ArrowLeft')
    const right = k.has('KeyD') || k.has('ArrowRight')
    const up = k.has('KeyW') || k.has('ArrowUp')
    const down = k.has('KeyS') || k.has('ArrowDown')
    const kb = this.kb.update(dt, speed, { left, right, up, down }, st, slip)
    let steer = kb.steer
    let throttle = kb.throttle
    let brake = kb.brake
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
        ps = this.pad.update(dt, speed, p.axes[0] ?? 0, st)
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

export interface KeyState {
  left: boolean
  right: boolean
  up: boolean
  down: boolean
}

type ShapingSettings = Pick<ControlSettings, 'steeringSensitivity' | 'steeringLinearity' | 'deadzone'>

/**
 * Keyboard steering and pedals: digital keys become ramps. Pure (no DOM), so the feel probe
 * (scripts/feel-probe.ts) drives exactly what a player gets.
 */
export class KeyboardFilter {
  steer = 0
  throttle = 0
  brake = 0
  /** the steering key held (+1 right, -1 left, 0 none) and for how long (s) */
  private key = 0
  private held = 0
  reset() {
    this.steer = this.throttle = this.brake = 0
    this.key = this.held = 0
  }
  /**
   * speed in m/s; slip: the car's body slip angle (rad, + = it moves to the left of where it points),
   * so that opposite lock comes and goes as fast as a slide needs.
   */
  update(dt: number, speed: number, keys: KeyState, st: ShapingSettings, slip = 0) {
    const target = (keys.right ? 1 : 0) - (keys.left ? 1 : 0)
    if (target !== this.key) {
      this.key = target
      this.held = 0
    } else this.held += dt
    const sens = st.steeringSensitivity
    const kmh = speed * 3.6
    // the counter-steer direction while the car slides (input sign, + = right)
    const counter = Math.abs(slip) > KB.counterSlip ? -Math.sign(slip) : 0
    let rate: number
    if (target === 0) {
      // let go: back to the centre, at once while the car slides (out of opposite lock, or out of
      // lock that a slide the other way has turned into too much)
      rate = counter !== 0 ? KB.fast : 1 / (KB.returnBase + KB.returnPerKmh * kmh)
    } else if (this.steer !== 0 && Math.sign(target) !== Math.sign(this.steer)) {
      // through the centre the other way
      rate = KB.fast
    } else if (target === counter && Math.abs(this.steer) < clamp(Math.abs(slip) / KB.counterFull, 0.25, 1)) {
      // opposite lock: at once, as much as the slide asks for (a held key adds more at the usual rate)
      rate = KB.fast
    } else {
      // turning in: the time to full lock grows with speed, and a press starts gently so that a tap
      // is a small correction and a held key still finds the limit
      const ease = KB.ease0 + (1 - KB.ease0) * smooth01((this.held - KB.easeFrom) / (KB.easeTo - KB.easeFrom))
      rate = ease / (KB.fullBase + KB.fullPerKmh * kmh)
    }
    this.steer = moveTo(this.steer, target, rate * sens * dt)
    this.throttle = moveTo(this.throttle, keys.up ? 1 : 0, (keys.up ? 5 : 9) * dt)
    this.brake = moveTo(this.brake, keys.down ? 1 : 0, (keys.down ? 4.5 : 9) * dt)
    return this
  }
}

/** Keyboard steering ramps (measured with scripts/feel-probe.ts). */
export const KB = {
  /** time (s) to full lock from the centre holding a key: base + per km/h (0.3 s standing, 0.84 s at 120, 1.2 s at 200) */
  fullBase: 0.3,
  fullPerKmh: 0.0045,
  /** a fresh press steers at this share of the rate, rising to the full rate between easeFrom and easeTo (s held) */
  ease0: 0.35,
  easeFrom: 0.03,
  easeTo: 0.2,
  /** time (s) back to the centre from full lock with no key: base + per km/h */
  returnBase: 0.2,
  returnPerKmh: 0.0015,
  /** reversing through the centre, opposite lock and letting go of it (per second) */
  fast: 6,
  /** body slip (rad) beyond which a press against the slide counts as opposite lock */
  counterSlip: 0.04,
  /** body slip (rad) that gets full opposite lock at once (smaller slides get a share of it) */
  counterFull: 0.3,
}

function smooth01(x: number) {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/** Gamepad stick -> steering (pure, shared with the feel probe). */
export class PadFilter {
  steer = 0
  reset() {
    this.steer = 0
  }
  update(_dt: number, _speed: number, raw: number, st: ShapingSettings) {
    this.steer = shapePadSteer(raw, st)
    return this.steer
  }
}

/** Gamepad stick -> steering: deadzone, then the response curve. */
export function shapePadSteer(raw: number, st: ShapingSettings) {
  let x = raw
  const dz = st.deadzone
  x = Math.abs(x) < dz ? 0 : (Math.sign(x) * (Math.abs(x) - dz)) / (1 - dz)
  return Math.sign(x) * Math.pow(Math.abs(x), st.steeringLinearity)
}

function moveTo(v: number, t: number, d: number) {
  if (v < t) return Math.min(t, v + d)
  if (v > t) return Math.max(t, v - d)
  return v
}

export const input = new InputManager()
