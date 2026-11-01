// AudioWorklet: physically-inspired combustion engine synthesiser.
//
// Each cylinder firing emits an exhaust pressure pulse. Pulses are routed into the exhaust bank
// they belong to; every bank is a waveguide (delay line with reflective, lossy termination) that
// produces the characteristic pipe resonances. Firing angles follow the real firing order, so a
// cross-plane V8 burbles (uneven per-bank intervals) while a flat-plane V8 screams. Intake roar,
// mechanical harmonics, overrun crackle and soft saturation complete the sound.

const LAYOUTS = {
  // crank angles (deg, 0..720) of each firing and the exhaust bank it belongs to
  'V8-cross': { angles: [0, 90, 180, 270, 360, 450, 540, 630], banks: [0, 1, 1, 0, 1, 0, 0, 1] },
  'V8-flat': { angles: [0, 90, 180, 270, 360, 450, 540, 630], banks: [0, 1, 0, 1, 0, 1, 0, 1] },
  I6: { angles: [0, 120, 240, 360, 480, 600], banks: [0, 0, 0, 1, 1, 1] },
  V10: { angles: [0, 72, 144, 216, 288, 360, 432, 504, 576, 648], banks: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1] },
  V12: { angles: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660], banks: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1] },
  F6: { angles: [0, 120, 240, 360, 480, 600], banks: [0, 1, 0, 1, 0, 1] },
}

class Waveguide {
  constructor(size) {
    this.buf = new Float32Array(size)
    this.idx = 0
    this.lp = 0
  }
  process(x, delay, feedback, damp) {
    const n = this.buf.length
    let d = Math.min(n - 2, Math.max(2, delay))
    const di = Math.floor(d)
    const f = d - di
    let r0 = this.idx - di
    if (r0 < 0) r0 += n
    let r1 = r0 - 1
    if (r1 < 0) r1 += n
    const y = this.buf[r0] * (1 - f) + this.buf[r1] * f
    // lossy reflection at the open end (inverting) with a lowpass
    this.lp += (y - this.lp) * damp
    this.buf[this.idx] = x - this.lp * feedback
    this.idx = (this.idx + 1) % n
    return y
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 900, minValue: 0, maxValue: 12000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'boost', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'crackle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0.5, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
    ]
  }

  constructor(options) {
    super()
    const o = options.processorOptions || {}
    const layout = LAYOUTS[o.layout] || LAYOUTS['V8-cross']
    this.angles = layout.angles
    this.banks = layout.banks
    this.cyl = this.angles.length
    this.phase = 0 // crank angle in degrees (0..720)
    this.rpm = 900
    this.load = 0
    this.boost = 0
    this.crackle = 0
    this.gainV = 0.5
    this.pulse = [0, 0]
    this.pulseShape = [0, 0]
    this.guides = [new Waveguide(4096), new Waveguide(4096)]
    // pipe lengths (seconds of round trip) differ slightly per bank for richness
    this.pipe = [o.pipe || 0.0042, (o.pipe || 0.0042) * 1.07]
    this.intakeLP = 0
    this.intakeBP = [0, 0]
    this.out1 = 0
    this.out2 = 0
    this.dc = 0
    this.dcIn = 0
    this.rand = 12345
    this.cyclePrev = 0
    this.cylAmp = new Float32Array(this.cyl).fill(1)
    this.character = o.character || 1
    this.popEnv = 0
    this.lastFired = -1
  }

  noise() {
    this.rand = (this.rand * 1103515245 + 12345) & 0x7fffffff
    return this.rand / 0x3fffffff - 1
  }

  process(_inputs, outputs, params) {
    const out = outputs[0]
    const L = out[0]
    const R = out[1] || out[0]
    const sr = sampleRate
    const tRpm = params.rpm[0],
      tLoad = params.load[0],
      tBoost = params.boost[0],
      tCrackle = params.crackle[0],
      tGain = params.gain[0]
    for (let i = 0; i < L.length; i++) {
      // parameter smoothing
      this.rpm += (tRpm - this.rpm) * 0.0012
      this.load += (tLoad - this.load) * 0.004
      this.boost += (tBoost - this.boost) * 0.002
      this.crackle += (tCrackle - this.crackle) * 0.01
      this.gainV += (tGain - this.gainV) * 0.002
      const rpm = Math.max(this.rpm, 300)
      // crank advance (deg per sample); 4-stroke cycle = 720 deg
      const dphi = (rpm / 60) * 360 / sr
      const prev = this.phase
      this.phase += dphi
      if (this.phase >= 720) {
        this.phase -= 720
        // per-cycle combustion variation
        for (let c = 0; c < this.cyl; c++) this.cylAmp[c] = 1 + this.noise() * (0.08 + (1 - this.load) * 0.12)
      }
      // firings crossed this sample (phase may have wrapped past 720)
      const wrapped = this.phase < prev
      for (let c = 0; c < this.cyl; c++) {
        const a = this.angles[c]
        const fired = wrapped ? a > prev || a <= this.phase : a > prev && a <= this.phase
        if (fired) this.pulse[this.banks[c]] += (0.25 + this.load * 0.95) * this.cylAmp[c]
      }
      // pulse shaping: fast attack, decay tied to engine speed (blowdown duration)
      const decay = Math.exp(-(260 + rpm * 0.12) / sr)
      let excit = 0
      const ex = [0, 0]
      for (let b = 0; b < 2; b++) {
        this.pulseShape[b] = this.pulseShape[b] * decay + this.pulse[b]
        this.pulse[b] = 0
        ex[b] = this.pulseShape[b] * (0.9 + this.noise() * 0.12)
        excit += ex[b]
      }
      // overrun crackle: random pops when lifting at high rpm
      if (this.crackle > 0.05 && this.noise() > 1 - 0.0016 * this.crackle) this.popEnv = 1.6 + this.noise() * 0.6
      this.popEnv *= 0.9985
      const pop = this.popEnv * this.noise() * 0.5 * this.crackle

      // exhaust waveguides
      let exh = 0
      for (let b = 0; b < 2; b++) {
        const delay = this.pipe[b] * sr
        exh += this.guides[b].process(ex[b] + pop * 0.5, delay, 0.72, 0.35)
      }
      // intake roar: band-passed noise modulated by firing
      const n = this.noise()
      const fc = 0.04 + rpm / 9000 * 0.14
      this.intakeBP[0] += fc * (n - this.intakeBP[0] - this.intakeBP[1] * 0.6)
      this.intakeBP[1] += fc * this.intakeBP[0]
      const intake = this.intakeBP[1] * (0.15 + this.load * 0.6) * (0.4 + excit * 0.6)
      // mechanical harmonics (crank & valvetrain)
      const crank = (this.phase / 360) * Math.PI * 2
      const mech = Math.sin(crank * 2) * 0.02 + Math.sin(crank * 4.5) * 0.012 * (rpm / 8000)
      // turbo whine
      const whine = this.boost > 0.02 ? Math.sin(this.out2) * this.boost * 0.05 : 0
      this.out2 += (2 * Math.PI * (2500 + this.boost * rpm * 0.9)) / sr
      if (this.out2 > 6.283) this.out2 -= 6.283

      let s = exh * 0.9 + excit * 0.25 + intake + mech + whine + pop * 0.6
      // DC blocker
      this.dc = s - this.dcIn + 0.995 * this.dc
      this.dcIn = s
      s = this.dc
      // soft saturation
      s = Math.tanh(s * 1.4 * this.character) * this.gainV
      // gentle low-pass for body
      this.out1 += (s - this.out1) * 0.55
      L[i] = this.out1
      R[i] = this.out1
    }
    return true
  }
}

registerProcessor('engine-processor', EngineProcessor)
