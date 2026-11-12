// Racecraft audit: a headless 12-car team race from a standing start. Prints car-to-car contacts
// (closing speed, nose-to-tail vs side, who hit whom), off-tracks, spins, stuck cars, overtakes
// (and how many were clean), side-by-side time, first-corner incidents, finishing spread and lap
// pace vs skill.   bun scripts/race-audit.ts [laps=4] [--slow-player] [--fast-last] [--quiet]
import { game } from '../src/game/game'
import { useTeamStore } from '../src/team/teamStore'
import { SEASON } from '../src/team/data'
import { startTeamRace } from '../src/team/session'

export interface AuditResult {
  contacts: number
  rearEnds: number
  sides: number
  maxClosing: number
  offs: number
  spins: number
  stuck: number
  overtakes: number
  cleanOvertakes: number
  sideBySide: number
  firstCorner: number
  spread: number
  laps: number
  cars: number
  /** scenario metrics */
  slowHitFromBehind: number
  slowMaxClosing: number
  fastGained: number
  fastContacts: number
}

export function raceAudit(laps = 4, opts: { slowPlayer?: boolean; fastLast?: boolean; quiet?: boolean; seed?: number } = {}): AuditResult {
  const seasonLaps = SEASON[0].laps
  SEASON[0].laps = laps
  useTeamStore.getState().newSeason()
  const tr = startTeamRace(opts.seed)
  SEASON[0].laps = seasonLaps
  const log = opts.quiet ? () => {} : console.log
  const cars = tr.cars
  const N = cars.length
  const track = game.track
  const L = track.length
  const name = (k: number) => cars[k].driver.code
  const grid = [...cars].sort((a, b) => a.gridPos - b.gridPos)
  // scenario (b): the fastest driver starts last
  let fast = -1
  if (opts.fastLast) {
    const last = grid[grid.length - 1]
    last.baseSkill = Math.max(...cars.map((c) => c.baseSkill)) + 0.006
    fast = cars.indexOf(last)
  }
  // scenario (a): a slower, slightly erratic car mid-pack standing in for a human player
  let slow = -1
  if (opts.slowPlayer) {
    const c = grid[Math.floor(N / 2)]
    slow = cars.indexOf(c)
    const ai = c.entry.ai!
    const rebuild = ai.rebuildProfile.bind(ai)
    const tmp = new Float32Array(track.n)
    const shift = Math.round(10 / (L / track.n))
    ai.rebuildProfile = () => {
      rebuild()
      tmp.set(ai.profile)
      // 3 % slower in the corners and on the straights, braking 10 m early
      for (let i = 0; i < track.n; i++) ai.profile[i] = Math.min(tmp[i], tmp[(i + shift) % track.n]) * 0.955
    }
    ai.rebuildProfile()
    const lineAt = ai.lineAt.bind(ai)
    ai.lineAt = (i: number) => lineAt(i) + 0.5 * Math.sin(game.raceTime * 1.3)
  }
  const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`
  const r: AuditResult = { contacts: 0, rearEnds: 0, sides: 0, maxClosing: 0, offs: 0, spins: 0, stuck: 0, overtakes: 0, cleanOvertakes: 0, sideBySide: 0, firstCorner: 0, spread: 0, laps, cars: N, slowHitFromBehind: 0, slowMaxClosing: 0, fastGained: 0, fastContacts: 0 }
  const lastContact = new Float64Array(N * N).fill(-1e9)
  const off = new Uint8Array(N),
    spun = new Uint8Array(N)
  const stuckT = new Float64Array(N)
  const spinAt = new Float64Array(N).fill(-1e9)
  const stuckFlag = new Uint8Array(N)
  const overtakes: { t: number; a: number; b: number }[] = []
  tr.on((e) => {
    if (e.kind === 'overtake') overtakes.push({ t: game.raceTime, a: cars.findIndex((c) => c.id === e.car), b: cars.findIndex((c) => c.id === e.other) })
  })
  const ids = cars.map((c) => c.id)
  const sim = game.cars.map((gc) => ids.indexOf(gc.id)) // game car index -> race car index
  let evSeen = 0
  const dt = 1 / 60
  const sdiff = (a: number, b: number) => {
    let d = a - b
    if (d > L / 2) d -= L
    if (d < -L / 2) d += L
    return d
  }
  while (!tr.complete && game.raceTime < laps * 140 + 120) {
    game.update(dt)
    if (!game.racing) {
      evSeen = game.world.events.length
      continue
    }
    const t = game.raceTime
    const lap1 = (k: number) => cars[k].entry.timing.lap <= 1 && cars[k].entry.timing.s < 1300
    // contacts: new car-car events -> the two cars nearest the contact point
    const ev = game.world.events
    if (ev.length < evSeen) evSeen = 0
    for (; evSeen < ev.length; evSeen++) {
      const e = ev[evSeen]
      if (e.kind !== 'car') continue
      let a = -1, b = -1, da = 1e9, db = 1e9
      for (let k = 0; k < N; k++) {
        const p = cars[k].entry.sim.vehicle.pos
        const d = Math.hypot(p.x - e.x, p.z - e.z)
        if (d < da) { b = a; db = da; a = k; da = d } else if (d < db) { b = k; db = d }
      }
      if (a < 0 || b < 0 || db > 6) continue
      if (t - lastContact[a * N + b] < 1.5) { lastContact[a * N + b] = lastContact[b * N + a] = t; continue }
      lastContact[a * N + b] = lastContact[b * N + a] = t
      const ea = cars[a].entry, eb = cars[b].entry
      const ds = sdiff(ea.timing.s, eb.timing.s)
      const dd = Math.abs(ea.sample.d - eb.sample.d)
      const [front, back] = ds > 0 ? [a, b] : [b, a]
      const closing = cars[back].entry.sim.vehicle.speed - cars[front].entry.sim.vehicle.speed
      const rear = dd < 1.3
      r.contacts++
      if (rear) r.rearEnds++
      else r.sides++
      if (rear) r.maxClosing = Math.max(r.maxClosing, closing)
      if (lap1(a) || lap1(b)) r.firstCorner++
      if (front === slow && rear) { r.slowHitFromBehind++; r.slowMaxClosing = Math.max(r.slowMaxClosing, closing) }
      if (a === fast || b === fast) r.fastContacts++
      log(`${fmt(t)}  contact ${rear ? 'nose-to-tail' : 'side'}  ${name(back)} -> ${name(front)}  closing ${(closing * 3.6).toFixed(0)} km/h  lat ${dd.toFixed(1)} m  s ${ea.timing.s.toFixed(0)}`)
    }
    for (let k = 0; k < N; k++) {
      const c = cars[k]
      // the pit road (and its merge, a few seconds after the stop) is not an off-track
      if (c.pit || c.retired || c.finished || game.raceTime - c.lastPitAt < 6) { stuckT[k] = 0; continue }
      const v = c.entry.sim.vehicle
      const i = track.idx(c.entry.timing.s)
      // past the kerb (the racing line runs over the flat kerbs)
      const dd = c.entry.sample.d
      const isOff = Math.abs(dd) > track.hw[i] + (dd > 0 ? track.L : track.R).kerb[i] + 0.4
      if (isOff && !off[k]) { r.offs++; if (lap1(k)) r.firstCorner++; log(`${fmt(t)}  off-track ${name(k)} s ${c.entry.timing.s.toFixed(0)} d ${c.entry.sample.d.toFixed(1)} v ${(v.speed * 3.6).toFixed(0)} since pit ${(t - c.lastPitAt).toFixed(1)}`) }
      off[k] = isOff ? 1 : 0
      const vf = v.vel.x * v.fwd.x + v.vel.z * v.fwd.z
      const vl = v.vel.x * v.left.x + v.vel.z * v.left.z
      const isSpin = v.speed > 5 && Math.abs(Math.atan2(vl, Math.abs(vf))) > (30 * Math.PI) / 180
      if (isSpin && !spun[k] && t - spinAt[k] > 8) {
        spinAt[k] = t
        r.spins++
        if (lap1(k)) r.firstCorner++; log(`${fmt(t)}  spin ${name(k)} s ${c.entry.timing.s.toFixed(0)} d ${c.entry.sample.d.toFixed(1)} v ${(v.speed * 3.6).toFixed(0)} since pit ${(t - c.lastPitAt).toFixed(1)}`) }
      spun[k] = isSpin ? 1 : 0
      stuckT[k] = v.speed < 2 ? stuckT[k] + dt : 0
      if (stuckT[k] > 3 && !stuckFlag[k]) { stuckFlag[k] = 1; r.stuck++; log(`${fmt(t)}  STUCK ${name(k)} s ${c.entry.timing.s.toFixed(0)}`) }
      for (let j = k + 1; j < N; j++) {
        const o = cars[j]
        if (o.pit || o.retired || o.finished) continue
        const ds = Math.abs(sdiff(c.entry.timing.s, o.entry.timing.s))
        const dd = Math.abs(c.entry.sample.d - o.entry.sample.d)
        if (ds < 4.5 && dd > 1.6 && dd < 4) r.sideBySide += dt
      }
    }
  }
  for (const o of overtakes) {
    r.overtakes++
    if (o.a >= 0 && o.b >= 0 && o.t - lastContact[o.a * N + o.b] > 4) r.cleanOvertakes++
  }
  const fin = cars.filter((c) => c.finished).map((c) => c.entry.timing.finishTime)
  r.spread = fin.length ? Math.max(...fin) - Math.min(...fin) : 0
  if (fast >= 0) r.fastGained = N - cars[fast].entry.timing.position
  if (!opts.quiet) {
    log('')
    for (const c of game.standings()) {
      const rc = tr.byId.get(c.id)!
      log(`P${String(c.timing.position).padStart(2)} ${rc.driver.code} grid ${String(rc.gridPos).padStart(2)}  skill ${rc.baseSkill.toFixed(3)}  best ${rc.best.toFixed(2)}  ${rc.retired ? 'DNF ' + rc.retired : c.timing.finished ? fmt(c.timing.finishTime) : 'running'}${cars.indexOf(rc) === slow ? '  [slow player]' : ''}${cars.indexOf(rc) === fast ? '  [fast, from last]' : ''}`)
    }
    const perLap = r.contacts / (N * laps)
    log(`\ncontacts ${r.contacts} (${perLap.toFixed(3)}/car/lap; nose-to-tail ${r.rearEnds}, side ${r.sides}; max rear closing ${(r.maxClosing * 3.6).toFixed(0)} km/h)  off-tracks ${r.offs}  spins ${r.spins}  stuck ${r.stuck}`)
    log(`overtakes ${r.overtakes} (clean ${r.cleanOvertakes})  side-by-side ${r.sideBySide.toFixed(1)} s  first-corner incidents ${r.firstCorner}  finishing spread ${r.spread.toFixed(1)} s`)
    if (slow >= 0) log(`slow player: hit from behind ${r.slowHitFromBehind}x, max closing ${(r.slowMaxClosing * 3.6).toFixed(0)} km/h`)
    if (fast >= 0) log(`fast from last: gained ${r.fastGained} places, ${r.fastContacts} contacts`)
  }
  return r
}

if (import.meta.main) {
  const a = process.argv.slice(2)
  const laps = +(a.find((x) => !x.startsWith('--')) ?? 4)
  const seeds = +(a.find((x) => x.startsWith('--seeds='))?.slice(8) ?? 1)
  const opts = { slowPlayer: a.includes('--slow-player'), fastLast: a.includes('--fast-last'), quiet: a.includes('--quiet') || seeds > 1 }
  const all: AuditResult[] = []
  for (let k = 0; k < seeds; k++) all.push(raceAudit(laps, { ...opts, seed: seeds > 1 ? 1000 + k : undefined }))
  if (seeds > 1) {
    const sum = (f: (r: AuditResult) => number) => all.reduce((x, r) => x + f(r), 0)
    const mx = (f: (r: AuditResult) => number) => Math.max(...all.map(f))
    console.log(`${seeds} races x ${laps} laps: contacts ${sum((r) => r.contacts)} (${(sum((r) => r.contacts) / sum((r) => r.cars * r.laps)).toFixed(3)}/car/lap; nose-to-tail ${sum((r) => r.rearEnds)}, side ${sum((r) => r.sides)}, max rear closing ${(mx((r) => r.maxClosing) * 3.6).toFixed(0)} km/h)  off-tracks ${sum((r) => r.offs)}  spins ${sum((r) => r.spins)}  stuck ${sum((r) => r.stuck)}`)
    console.log(`overtakes ${sum((r) => r.overtakes)} (clean ${sum((r) => r.cleanOvertakes)})  side-by-side ${sum((r) => r.sideBySide).toFixed(0)} s  first-corner incidents ${sum((r) => r.firstCorner)}`)
    if (opts.slowPlayer) console.log(`slow player hit from behind ${sum((r) => r.slowHitFromBehind)}x, max closing ${(mx((r) => r.slowMaxClosing) * 3.6).toFixed(0)} km/h`)
    if (opts.fastLast) console.log(`fast from last: gained ${all.map((r) => r.fastGained).join('/')} places, contacts ${all.map((r) => r.fastContacts).join('/')}`)
  }
}
