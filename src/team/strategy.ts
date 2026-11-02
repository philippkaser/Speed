// Race strategy: rules scaled to the race length, a lap-time model calibrated against the simulation
// (scripts/calibrate-race.ts), a whole-race estimator and an optimiser that the pit wall, the planner
// and the rival teams all use.
import { wearGrip } from '../physics/tyre'

export type Compound = 'RS' | 'RM' | 'RH'
export const RACE_COMPOUNDS: Compound[] = ['RS', 'RM', 'RH']

export const TYRES: Record<Compound, { name: string; short: string; color: string }> = {
  RS: { name: 'Soft', short: 'S', color: '#ff3b30' },
  RM: { name: 'Medium', short: 'M', color: '#ffd60a' },
  RH: { name: 'Hard', short: 'H', color: '#f2f2f2' },
}

export type DriveMode = 'push' | 'race' | 'save'
/**
 * Driver instructions: pace offset (on the AI's grip budget), fuel burn, tread wear and the risk of a
 * mistake. Pushing is faster but eats tyres and fuel; saving buys laps.
 */
export const MODES: Record<DriveMode, { label: string; skill: number; fuel: number; wear: number; risk: number; lapDelta: number }> = {
  push: { label: 'Push', skill: 0.012, fuel: 1.1, wear: 1.45, risk: 2.4, lapDelta: -0.55 },
  race: { label: 'Race', skill: 0, fuel: 1, wear: 1, risk: 1, lapDelta: 0 },
  save: { label: 'Save', skill: -0.022, fuel: 0.86, wear: 0.62, risk: 0.45, lapDelta: 1.0 },
}

export interface Stop {
  /** box at the end of this lap */
  lap: number
  compound: Compound
  /** kg added */
  fuel: number
}

export interface Strategy {
  startCompound: Compound
  startFuel: number
  stops: Stop[]
}

export interface RaceRules {
  laps: number
  /** kg */
  tank: number
  /** kg per lap at the "race" instruction */
  fuelPerLap: number
  /** tread used per lap (fraction) at the "race" instruction, per compound */
  treadPerLap: Record<Compound, number>
  /** multiplier on the physical abrasion rate so that the compounds last the laps above */
  wearScale: number
  /** refuelling rate, kg/s */
  refuelRate: number
  /** four tyres, s */
  tyreTime: number
  /** time lost driving through the pit lane compared with a racing lap (excluding the stop), s */
  laneLoss: number
  /** pit lane speed limit, m/s */
  pitSpeed: number
}

// --- calibration (Vanta R-GT3, AI at skill 0.97, empty tank; scripts/calibrate-race.ts)
/** lap time on new tyres, empty tank */
export const BASE_LAP: Record<Compound, number> = { RS: 92.45, RM: 93.5, RH: 95.25 }
/** physical tread loss per lap of the most worn tyre (fraction) */
const PHYS_TREAD_PER_LAP: Record<Compound, number> = { RS: 0.00296, RM: 0.00158, RH: 0.00089 }
/** engine work per lap, J */
export const ENGINE_WORK_PER_LAP = 8.15 * 3.6e6
/** lap time per kg carried, s (measured: +60 kg costs 0.6 s) */
export const FUEL_EFFECT = 0.0105
/** lap time per unit of grip lost, s */
const GRIP_EFFECT = 33
/** the standing start and the first lap's traffic, s */
const FIRST_LAP = 4.5
/** tread at which a set is considered finished */
export const TREAD_LIMIT = 0.12

export function raceRules(laps: number): RaceRules {
  const softLife = Math.max(3, laps * 0.3)
  const rs = (1 - 0.38) / softLife
  const treadPerLap: Record<Compound, number> = {
    RS: rs,
    RM: rs * (PHYS_TREAD_PER_LAP.RM / PHYS_TREAD_PER_LAP.RS),
    RH: rs * (PHYS_TREAD_PER_LAP.RH / PHYS_TREAD_PER_LAP.RS),
  }
  const fuelPerLap = 7
  return {
    laps,
    tank: Math.round(fuelPerLap * Math.max(4.5, laps * 0.6)),
    fuelPerLap,
    treadPerLap,
    wearScale: rs / PHYS_TREAD_PER_LAP.RS,
    refuelRate: 8,
    tyreTime: 3.4,
    laneLoss: 16,
    pitSpeed: 22.2,
  }
}

/** Lap time model: compound, tread left, fuel on board, driving instruction. */
export function lapTime(c: Compound, tread: number, fuel: number, mode: DriveMode = 'race') {
  return BASE_LAP[c] + fuel * FUEL_EFFECT + (1 - wearGrip(tread)) * GRIP_EFFECT + MODES[mode].lapDelta
}

export function stopTime(r: RaceRules, fuel: number) {
  return 0.6 + Math.max(r.tyreTime, fuel / r.refuelRate)
}

export interface Estimate {
  total: number
  valid: boolean
  /** lap the car runs dry or the tyres are finished, if any */
  problem: string
  laps: { time: number; compound: Compound; tread: number; fuel: number }[]
  stints: { compound: Compound; from: number; to: number }[]
}

/** Lap-by-lap estimate of a whole race. */
export function estimate(s: Strategy, r: RaceRules, mode: DriveMode = 'race'): Estimate {
  let fuel = s.startFuel
  let c = s.startCompound
  let tread = 1
  let total = 0
  let problem = ''
  const laps: Estimate['laps'] = []
  const stints: Estimate['stints'] = []
  let stintFrom = 1
  const stops = [...s.stops].sort((a, b) => a.lap - b.lap)
  const m = MODES[mode]
  for (let lap = 1; lap <= r.laps; lap++) {
    const burn = r.fuelPerLap * m.fuel
    let t = lapTime(c, tread, Math.max(0, fuel - burn / 2), mode)
    if (lap === 1) t += FIRST_LAP
    fuel -= burn
    tread -= r.treadPerLap[c] * m.wear
    // a quarter of a lap in reserve: real burn varies with traffic and the start
    if (!problem && fuel < r.fuelPerLap * m.fuel * 0.25) problem = fuel < 0 ? `Runs dry on lap ${lap}` : `Fuel critical on lap ${lap}`
    if (!problem && tread < TREAD_LIMIT) problem = `${TYRES[c].name}s finished on lap ${lap}`
    const stop = stops.find((x) => x.lap === lap)
    if (stop && lap < r.laps) {
      const add = Math.min(stop.fuel, r.tank - Math.max(fuel, 0))
      t += r.laneLoss + stopTime(r, add)
      fuel = Math.max(fuel, 0) + add
      stints.push({ compound: c, from: stintFrom, to: lap })
      stintFrom = lap + 1
      c = stop.compound
      tread = 1
    }
    laps.push({ time: t, compound: c, tread, fuel })
    total += t
  }
  stints.push({ compound: c, from: stintFrom, to: r.laps })
  return { total, valid: !problem, problem, laps, stints }
}

/** Fuel needed to cover `laps` laps at the given instruction, with a small margin. */
export function fuelFor(r: RaceRules, laps: number, mode: DriveMode = 'race') {
  return Math.min(r.tank, Math.ceil(r.fuelPerLap * MODES[mode].fuel * (laps + 0.6)))
}

/** Build a strategy from stint plan: compounds and the lap each stint ends on. */
export function planFrom(r: RaceRules, compounds: Compound[], ends: number[]): Strategy {
  const stops: Stop[] = []
  let prev = 0
  for (let i = 0; i < compounds.length - 1; i++) {
    const lapsNext = (i + 1 < ends.length ? ends[i + 1] : r.laps) - ends[i]
    stops.push({ lap: ends[i], compound: compounds[i + 1], fuel: fuelFor(r, lapsNext) })
    prev = ends[i]
  }
  void prev
  return { startCompound: compounds[0], startFuel: fuelFor(r, (ends[0] ?? r.laps) - 0), stops }
}

export interface Candidate {
  name: string
  strategy: Strategy
  est: Estimate
}

/** Search 0-3 stop strategies; returns the valid ones fastest first. */
export function optimise(r: RaceRules): Candidate[] {
  const out: Candidate[] = []
  const seqs = (n: number): Compound[][] => {
    if (n === 0) return [[]]
    const rest = seqs(n - 1)
    return RACE_COMPOUNDS.flatMap((c) => rest.map((x) => [c, ...x]))
  }
  for (let stops = 0; stops <= 3; stops++) {
    if (stops >= r.laps) break
    for (const comp of seqs(stops + 1)) {
      // stint lengths proportional to each compound's life, then a few shifted variants
      const life = comp.map((c) => 1 / r.treadPerLap[c])
      const sum = life.reduce((a, b) => a + b, 0)
      for (const shift of [0, -1, 1, -2, 2]) {
        const ends: number[] = []
        let acc = 0
        for (let i = 0; i < stops; i++) {
          acc += (life[i] / sum) * r.laps
          ends.push(Math.max(1, Math.min(r.laps - 1, Math.round(acc) + (i === 0 ? shift : 0))))
        }
        if (ends.some((e, i) => i > 0 && e <= ends[i - 1])) continue
        const strategy = planFrom(r, comp, ends)
        const est = estimate(strategy, r)
        if (!est.valid) continue
        const name = stops === 0 ? 'No stop' : `${stops}-stop`
        out.push({ name: `${name} · ${comp.map((c) => TYRES[c].short).join('-')}`, strategy, est })
      }
    }
  }
  out.sort((a, b) => a.est.total - b.est.total)
  // drop near-duplicates
  const seen = new Set<string>()
  return out.filter((c) => {
    const k = c.name + c.strategy.stops.map((s) => s.lap).join(',')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
