// Web Audio engine: synthesised engines (AudioWorklet), tyres, wind, road, impacts, UI.
import workletUrl from './engine-worklet.js?url'
import { game, type CarEntry } from '../game/game'
import { Surface } from '../physics/ground'
import { clamp } from '../physics/math'
import { useGameStore } from '../state/gameStore'
import { useSettings } from '../state/settings'
import { cameraPose } from './cameraPose'

interface EngineVoice {
  node: AudioWorkletNode
  out: GainNode
  panner: PannerNode | null
  filter: BiquadFilterNode
  car: string
}

function noiseBuffer(ctx: AudioContext, seconds = 2) {
  const b = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate)
  const d = b.getChannelData(0)
  let pink = 0
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1
    pink = 0.97 * pink + 0.03 * w
    d[i] = w * 0.5 + pink * 3
  }
  return b
}

class AudioEngine {
  ctx: AudioContext | null = null
  master!: GainNode
  engineBus!: GainNode
  fxBus!: GainNode
  uiBus!: GainNode
  ready = false
  private loading = false
  private player: EngineVoice | null = null
  private ai = new Map<string, EngineVoice>()
  private squeal!: { gain: GainNode; filter: BiquadFilterNode; osc: OscillatorNode; osc2: OscillatorNode }
  private wind!: { gain: GainNode; filter: BiquadFilterNode }
  private road!: { gain: GainNode; filter: BiquadFilterNode }
  private kerb!: { gain: GainNode; osc: OscillatorNode }
  private gravel!: { gain: GainNode }
  private gearWhine!: { gain: GainNode; osc: OscillatorNode }
  private noise!: AudioBuffer
  private lastGear = 1
  private lastSession = -1
  private eventCursor = 0

  /** Must be called from a user gesture. */
  async init() {
    if (this.ready || this.loading) return
    this.loading = true
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx
    await ctx.audioWorklet.addModule(workletUrl)
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 12
    comp.ratio.value = 4
    comp.attack.value = 0.004
    comp.release.value = 0.2
    this.master = ctx.createGain()
    this.master.connect(comp).connect(ctx.destination)
    this.engineBus = ctx.createGain()
    this.fxBus = ctx.createGain()
    this.uiBus = ctx.createGain()
    this.engineBus.connect(this.master)
    this.fxBus.connect(this.master)
    this.uiBus.connect(this.master)
    this.noise = noiseBuffer(ctx)

    const loopNoise = () => {
      const s = ctx.createBufferSource()
      s.buffer = this.noise
      s.loop = true
      s.start(0, Math.random() * 1.5)
      return s
    }
    // tyre squeal: two detuned oscillators + band-passed noise
    {
      const gain = ctx.createGain()
      gain.gain.value = 0
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = 900
      filter.Q.value = 7
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = 780
      const osc2 = ctx.createOscillator()
      osc2.type = 'sawtooth'
      osc2.frequency.value = 802
      const og = ctx.createGain()
      og.gain.value = 0.25
      osc.connect(og)
      osc2.connect(og)
      og.connect(filter)
      loopNoise().connect(filter)
      filter.connect(gain).connect(this.fxBus)
      osc.start()
      osc2.start()
      this.squeal = { gain, filter, osc, osc2 }
    }
    // wind
    {
      const gain = ctx.createGain()
      gain.gain.value = 0
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 400
      loopNoise().connect(filter).connect(gain).connect(this.fxBus)
      this.wind = { gain, filter }
    }
    // road roar
    {
      const gain = ctx.createGain()
      gain.gain.value = 0
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 160
      loopNoise().connect(filter).connect(gain).connect(this.fxBus)
      this.road = { gain, filter }
    }
    // kerb rumble
    {
      const gain = ctx.createGain()
      gain.gain.value = 0
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.value = 60
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 260
      osc.connect(lp).connect(gain).connect(this.fxBus)
      osc.start()
      this.kerb = { gain, osc }
    }
    // gravel / grass crunch
    {
      const gain = ctx.createGain()
      gain.gain.value = 0
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 1200
      loopNoise().connect(hp).connect(gain).connect(this.fxBus)
      this.gravel = { gain }
    }
    // straight-cut gearbox whine
    {
      const gain = ctx.createGain()
      gain.gain.value = 0
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.start()
      osc.connect(gain).connect(this.fxBus)
      this.gearWhine = { gain, osc }
    }
    this.ready = true
    this.loading = false
    this.applyVolumes()
    useSettings.subscribe(() => this.applyVolumes())
  }

  applyVolumes() {
    if (!this.ready) return
    const a = useSettings.getState().audio
    this.master.gain.value = a.master
    this.engineBus.gain.value = a.engine
    this.fxBus.gain.value = a.effects
    this.uiBus.gain.value = a.effects * 0.6
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume()
  }

  private makeVoice(c: CarEntry, spatial: boolean): EngineVoice {
    const ctx = this.ctx!
    const sp = c.sim.vehicle.spec
    const node = new AudioWorkletNode(ctx, 'engine-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { layout: sp.engine.layout, pipe: sp.engine.layout === 'V8-flat' ? 0.0034 : 0.0046, character: sp.engine.layout === 'V8-flat' ? 1.2 : 1.0 },
    })
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 12000
    const out = ctx.createGain()
    out.gain.value = 0
    node.connect(filter)
    let panner: PannerNode | null = null
    if (spatial) {
      panner = ctx.createPanner()
      panner.panningModel = 'HRTF'
      panner.distanceModel = 'inverse'
      panner.refDistance = 6
      panner.rolloffFactor = 1.3
      panner.maxDistance = 600
      filter.connect(panner).connect(out)
    } else filter.connect(out)
    out.connect(this.engineBus)
    return { node, out, panner, filter, car: c.id }
  }

  private disposeVoice(v: EngineVoice) {
    v.out.gain.setTargetAtTime(0, this.ctx!.currentTime, 0.05)
    setTimeout(() => {
      v.node.disconnect()
      v.out.disconnect()
      v.panner?.disconnect()
    }, 300)
  }

  update(dt: number, paused: boolean) {
    if (!this.ready || !this.ctx) return
    const ctx = this.ctx
    const t = ctx.currentTime
    if (this.lastSession !== game.version) {
      this.lastSession = game.version
      if (this.player) this.disposeVoice(this.player)
      this.player = null
      for (const v of this.ai.values()) this.disposeVoice(v)
      this.ai.clear()
    }
    const screen = useGameStore.getState().screen
    const quiet = paused || (game.mode === 'attract' && screen !== 'home' && screen !== 'title')
    const listener = ctx.listener
    const cp = cameraPose
    if (listener.positionX) {
      listener.positionX.setTargetAtTime(cp.pos.x, t, 0.02)
      listener.positionY.setTargetAtTime(cp.pos.y, t, 0.02)
      listener.positionZ.setTargetAtTime(cp.pos.z, t, 0.02)
      listener.forwardX.setTargetAtTime(cp.fwd.x, t, 0.02)
      listener.forwardY.setTargetAtTime(cp.fwd.y, t, 0.02)
      listener.forwardZ.setTargetAtTime(cp.fwd.z, t, 0.02)
      listener.upX.setTargetAtTime(cp.up.x, t, 0.02)
      listener.upY.setTargetAtTime(cp.up.y, t, 0.02)
      listener.upZ.setTargetAtTime(cp.up.z, t, 0.02)
    }

    // ---- player car (non-spatial, interior/exterior colouring by camera)
    const p = game.player
    if (p && !this.player) this.player = this.makeVoice(p, false)
    if (p && this.player) {
      const v = p.sim.vehicle
      const e = v.engine
      const cam = useGameStore.getState().camera
      const inside = cam === 'cockpit' || cam === 'hood' || cam === 'bumper'
      const nv = this.player.node.parameters
      nv.get('rpm')!.setTargetAtTime(v.rpm, t, 0.01)
      nv.get('load')!.setTargetAtTime(clamp(e.throttleEff * (0.55 + 0.45 * e.boost), 0, 1), t, 0.02)
      nv.get('boost')!.setTargetAtTime(e.boost, t, 0.05)
      nv.get('crackle')!.setTargetAtTime(e.backfire > 0.1 ? 1 : e.throttleEff < 0.05 && v.rpm > 4500 ? 0.35 : 0, t, 0.02)
      nv.get('gain')!.setTargetAtTime(0.55, t, 0.05)
      this.player.filter.frequency.setTargetAtTime(inside ? 2400 + v.rpm * 0.4 : 9000, t, 0.05)
      this.player.out.gain.setTargetAtTime(quiet ? 0 : inside ? 0.85 : 0.65, t, 0.08)

      // tyres
      let squeal = 0,
        slideV = 0,
        kerbAmt = 0,
        gravelAmt = 0
      for (const w of v.wheels) {
        if (!w.contact) continue
        const onTarmac = w.surface === Surface.Asphalt || w.surface === Surface.Runoff || w.surface === Surface.Pit || w.surface === Surface.Kerb
        if (onTarmac) {
          const s = clamp((w.tyre.combinedSlip - 0.82) * 1.6, 0, 1) * clamp(w.tyre.slideVel / 3, 0, 1)
          squeal = Math.max(squeal, s)
          slideV = Math.max(slideV, w.tyre.slideVel)
        }
        if (w.surface === Surface.Kerb) kerbAmt += 0.25
        if (w.surface === Surface.Gravel || w.surface === Surface.Grass) gravelAmt += 0.25
      }
      const speed = v.speed
      this.squeal.gain.gain.setTargetAtTime(quiet ? 0 : squeal * 0.22, t, 0.04)
      this.squeal.osc.frequency.setTargetAtTime(640 + slideV * 18, t, 0.05)
      this.squeal.osc2.frequency.setTargetAtTime(655 + slideV * 19.5, t, 0.05)
      this.squeal.filter.frequency.setTargetAtTime(700 + slideV * 30, t, 0.05)
      this.wind.gain.gain.setTargetAtTime(quiet ? 0 : clamp((speed / 85) ** 2, 0, 1) * (inside ? 0.12 : 0.3), t, 0.1)
      this.wind.filter.frequency.setTargetAtTime(300 + speed * 18, t, 0.1)
      this.road.gain.gain.setTargetAtTime(quiet ? 0 : clamp(speed / 60, 0, 1) * (inside ? 0.35 : 0.18), t, 0.1)
      this.kerb.gain.gain.setTargetAtTime(quiet ? 0 : kerbAmt * clamp(speed / 20, 0, 1) * 0.35, t, 0.02)
      this.kerb.osc.frequency.setTargetAtTime(clamp(speed / 0.84, 10, 400), t, 0.02)
      this.gravel.gain.gain.setTargetAtTime(quiet ? 0 : gravelAmt * clamp(speed / 15, 0, 1) * 0.3, t, 0.05)
      const shaftHz = ((v.wheels[2].omega + v.wheels[3].omega) / (4 * Math.PI)) * v.setup.finalDrive * 7
      this.gearWhine.osc.frequency.setTargetAtTime(clamp(Math.abs(shaftHz), 20, 6000), t, 0.03)
      this.gearWhine.gain.gain.setTargetAtTime(quiet || v.spec.bodyStyle === 'coupe' ? 0 : clamp(speed / 70, 0, 1) * 0.025 * (0.4 + e.throttleEff), t, 0.05)
      if (v.gear !== this.lastGear) {
        if (!quiet) this.shiftClunk(v.gear > this.lastGear)
        this.lastGear = v.gear
      }
    } else {
      this.squeal?.gain.gain.setTargetAtTime(0, t, 0.05)
      this.wind?.gain.gain.setTargetAtTime(0, t, 0.1)
      this.road?.gain.gain.setTargetAtTime(0, t, 0.1)
      this.kerb?.gain.gain.setTargetAtTime(0, t, 0.05)
      this.gravel?.gain.gain.setTargetAtTime(0, t, 0.05)
      this.gearWhine?.gain.gain.setTargetAtTime(0, t, 0.05)
    }

    // ---- other cars: nearest 5 get spatial voices
    const others = game.cars.filter((c) => c !== p)
    const ranked = others
      .map((c) => ({ c, d: Math.hypot(c.sim.vehicle.pos.x - cp.pos.x, c.sim.vehicle.pos.y - cp.pos.y, c.sim.vehicle.pos.z - cp.pos.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, game.mode === 'attract' ? 4 : 5)
    const keep = new Set(ranked.filter((r) => r.d < 450).map((r) => r.c.id))
    for (const [id, v] of this.ai) if (!keep.has(id)) {
      this.disposeVoice(v)
      this.ai.delete(id)
    }
    for (const r of ranked) {
      if (!keep.has(r.c.id)) continue
      let voice = this.ai.get(r.c.id)
      if (!voice) {
        voice = this.makeVoice(r.c, true)
        this.ai.set(r.c.id, voice)
      }
      const v = r.c.sim.vehicle
      // doppler: relative velocity along the line of sight
      const dx = v.pos.x - cp.pos.x,
        dy = v.pos.y - cp.pos.y,
        dz = v.pos.z - cp.pos.z
      const dist = Math.max(r.d, 0.1)
      const vr = ((v.vel.x - cp.vel.x) * dx + (v.vel.y - cp.vel.y) * dy + (v.vel.z - cp.vel.z) * dz) / dist
      const doppler = clamp(343 / (343 + vr), 0.6, 1.6)
      const prm = voice.node.parameters
      prm.get('rpm')!.setTargetAtTime(v.rpm * doppler, t, 0.03)
      prm.get('load')!.setTargetAtTime(v.engine.throttleEff, t, 0.05)
      prm.get('boost')!.setTargetAtTime(v.engine.boost, t, 0.1)
      prm.get('crackle')!.setTargetAtTime(v.engine.backfire > 0.1 ? 1 : 0, t, 0.05)
      prm.get('gain')!.setTargetAtTime(0.5, t, 0.1)
      if (voice.panner) {
        voice.panner.positionX.setTargetAtTime(v.pos.x, t, 0.02)
        voice.panner.positionY.setTargetAtTime(v.pos.y, t, 0.02)
        voice.panner.positionZ.setTargetAtTime(v.pos.z, t, 0.02)
      }
      voice.filter.frequency.setTargetAtTime(clamp(16000 - dist * 30, 1500, 16000), t, 0.1)
      voice.out.gain.setTargetAtTime(quiet && game.mode !== 'attract' ? 0 : game.mode === 'attract' ? 0.5 : 0.7, t, 0.1)
    }

    // ---- impacts
    const ev = game.world.events
    for (const e of ev) {
      if (e.kind === 'ground' && e.impulse < 800) continue
      const d = Math.hypot(e.x - cp.pos.x, e.y - cp.pos.y, e.z - cp.pos.z)
      this.impact(clamp(e.impulse / 6000, 0.05, 1) * clamp(30 / (d + 5), 0, 1))
    }
    void dt
  }

  impact(strength: number) {
    if (!this.ready || strength < 0.02) return
    const ctx = this.ctx!
    const s = ctx.createBufferSource()
    s.buffer = this.noise
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 400 + strength * 2500
    const g = ctx.createGain()
    const t = ctx.currentTime
    g.gain.setValueAtTime(strength * 1.4, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25 + strength * 0.4)
    s.connect(f).connect(g).connect(this.fxBus)
    s.start(t, Math.random())
    s.stop(t + 1)
  }

  shiftClunk(up: boolean) {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.setValueAtTime(up ? 95 : 70, t)
    o.frequency.exponentialRampToValueAtTime(40, t + 0.06)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.12, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 500
    o.connect(f).connect(g).connect(this.fxBus)
    o.start(t)
    o.stop(t + 0.1)
  }

  /** Short UI click/blip (GT-style menu feedback). */
  ui(kind: 'move' | 'select' | 'back' | 'start' = 'move') {
    if (!this.ready) return
    const ctx = this.ctx!
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    const base = kind === 'select' ? 1320 : kind === 'back' ? 660 : kind === 'start' ? 990 : 1760
    o.type = 'sine'
    o.frequency.setValueAtTime(base, t)
    if (kind === 'select' || kind === 'start') o.frequency.setValueAtTime(base * 1.5, t + 0.05)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(kind === 'move' ? 0.05 : 0.09, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'start' ? 0.35 : 0.12))
    o.connect(g).connect(this.uiBus)
    o.start(t)
    o.stop(t + 0.4)
  }

  /** countdown beeps */
  beep(high: boolean) {
    if (!this.ready) return
    const ctx = this.ctx!
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'square'
    o.frequency.value = high ? 1320 : 660
    g.gain.setValueAtTime(0.06, t)
    g.gain.setTargetAtTime(0.0001, t + (high ? 0.5 : 0.18), 0.05)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 3000
    o.connect(f).connect(g).connect(this.uiBus)
    o.start(t)
    o.stop(t + 1)
  }
}

export const audio = new AudioEngine()
