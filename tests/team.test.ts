import { expect, test } from 'bun:test'
import { game } from '../src/game/game'
import { getCar } from '../src/physics/spec'
import { defaultPlayerTeam, RIVAL_TEAMS, SEASON } from '../src/team/data'
import { estimate, fuelFor, optimise, raceRules } from '../src/team/strategy'
import { driverSkill, TeamRace } from '../src/team/teamRace'
import { pitLane, PitPath } from '../src/track/pitlane'

test('every season round has valid, varied strategies that need a stop', () => {
  for (const round of SEASON) {
    const r = raceRules(round.laps)
    const c = optimise(r)
    expect(c.length).toBeGreaterThan(3)
    for (const x of c.slice(0, 5)) {
      expect(x.est.valid).toBe(true)
      expect(x.strategy.startFuel).toBeLessThanOrEqual(r.tank)
      expect(x.strategy.stops.length).toBeGreaterThan(0)
    }
    // the top strategies are close: the choice matters but is not obvious
    expect(c[Math.min(3, c.length - 1)].est.total - c[0].est.total).toBeLessThan(20)
    // a no-stop run is impossible on fuel
    const noStop = estimate({ startCompound: 'RH', startFuel: r.tank, stops: [] }, r)
    expect(noStop.valid).toBe(false)
    expect(fuelFor(r, round.laps)).toBe(r.tank)
  }
})

test('the pit path runs from the entry through the box to the exit', () => {
  const tr = game.getTrack('valle-alta')
  const lane = pitLane(tr)
  for (const boxS of lane.boxS) {
    const p = new PitPath(tr, lane, boxS, -5)
    expect(p.length).toBeGreaterThan(lane.sExit - lane.sEntry - 5)
    expect(p.length).toBeLessThan(lane.sExit - lane.sEntry + 80)
    expect(p.boxU).toBeGreaterThan(p.laneStartU)
    expect(p.boxU).toBeLessThan(p.laneEndU)
    for (let i = 1; i < p.u.length; i++) expect(p.u[i]).toBeGreaterThan(p.u[i - 1])
  }
})

test('a pit stop: box call, pit lane, service, new tyres and fuel, rejoin', () => {
  const player = defaultPlayerTeam()
  const rival = RIVAL_TEAMS[0]
  const spec = getCar('vanta-gt3')
  const mk = (team: typeof player, i: 0 | 1) => {
    const d = team.drivers[i]
    return { id: `${team.id}-${d.id}`, name: d.last, code: d.code, teamId: team.id, color: team.color, accent: team.accent, number: d.number, carId: spec.id, setup: { ...spec.defaultSetup }, skill: driverSkill(d) }
  }
  game.startTeam('valle-alta', 4, [mk(player, 0), mk(rival, 0)])
  const tr = new TeamRace(game, 4)
  game.teamRace = tr
  const r = tr.rules
  const strat = { startCompound: 'RS' as const, startFuel: 30, stops: [] }
  tr.add(game.cars[0], player, player.drivers[0], true, 0, strat, 'race')
  tr.add(game.cars[1], rival, rival.drivers[0], false, 0, { ...strat, stops: [] }, 'race')
  const me = tr.cars[0]
  const events: string[] = []
  tr.on((e) => events.push(e.kind + ('phase' in e ? ':' + e.phase : '')))
  // run to the start, call the car in, then until it is back on track
  let t = 0
  while (!tr.started && t < 20) {
    game.update(1 / 60)
    t += 1 / 60
  }
  tr.box(me.id, 'RM', 20)
  const fuelBefore = () => me.fuel
  let sawService = false,
    fuelAtEntry = 0
  while (t < 260) {
    game.update(1 / 60)
    t += 1 / 60
    if (me.pit?.phase === 'in' && !fuelAtEntry) fuelAtEntry = fuelBefore()
    if (me.pit?.phase === 'service') sawService = true
    if (sawService && !me.pit) break
  }
  console.log(`pit stop test: events ${events.filter((e) => e.startsWith('pit')).join(' ')}; fuel ${fuelAtEntry.toFixed(1)} -> ${me.fuel.toFixed(1)} kg; compound ${me.compound}; tread ${(me.tread * 100).toFixed(0)}%`)
  expect(sawService).toBe(true)
  expect(events).toContain('pit:in')
  expect(events).toContain('pit:stop')
  expect(events).toContain('pit:out')
  expect(me.stops).toBe(1)
  expect(me.compound).toBe('RM')
  expect(me.tread).toBeGreaterThan(0.97)
  // the requested 20 kg, up to a full tank (minus what the out-lap has burnt since)
  const expected = Math.min(r.tank, fuelAtEntry + 20)
  expect(me.fuel).toBeGreaterThan(expected - r.fuelPerLap * 0.3)
  expect(me.fuel).toBeLessThanOrEqual(r.tank + 0.01)
  expect(me.entry.sim.scripted).toBe(false)
  // back on the circuit, inside the track
  expect(Math.abs(me.entry.sample.d)).toBeLessThan(tr.game.track.hw[tr.game.track.idx(me.entry.timing.s)] + 1)
  tr.dispose()
  game.endTeamRace()
}, 120000)
