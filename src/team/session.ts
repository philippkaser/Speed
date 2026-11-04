// Builds a team race: qualifying order, rival strategies, the grid, the race engine.
import { game, type TeamEntryConfig } from '../game/game'
import { getCar } from '../physics/spec'
import { useGameStore } from '../state/gameStore'
import { SEASON, type Team } from './data'
import { estimateLap } from './engineering'
import { type DriveMode, optimise, raceRules, type Strategy } from './strategy'
import { driverSkill, TeamRace } from './teamRace'
import { allTeams, TEAM_CAR, useTeamStore } from './teamStore'

export interface GridSlot {
  id: string
  team: Team
  driverIndex: 0 | 1
  qualy: number
}

/** The running team race, if any. */
export function teamRace(): TeamRace | null {
  return (game.teamRace as TeamRace | null) ?? null
}

export const lastGrid: { slots: GridSlot[] } = { slots: [] }

export function startTeamRace() {
  const ts = useTeamStore.getState()
  const round = SEASON[Math.min(ts.round, SEASON.length - 1)]
  const laps = round.laps
  const rules = raceRules(laps)
  const teams = allTeams(ts.team)
  const track = game.getTrack('valle-alta')
  const spec = getCar(TEAM_CAR)

  // rivals: a spread of the good strategies, so the race plays out differently for each team
  const cands = optimise(rules)
  const rivalStrategy = (k: number): Strategy => {
    const top = cands.slice(0, Math.min(6, cands.length))
    const c = top[(k * 3 + Math.floor(Math.random() * 3)) % top.length]
    return structuredClone(c.strategy)
  }

  // qualifying: engineer's lap estimate for setup and driver, plus the lap's luck
  const slots: (GridSlot & { cfg: TeamEntryConfig; strategy: Strategy; mode: DriveMode; mine: boolean })[] = []
  let k = 0
  for (const team of teams) {
    const mine = team.id === ts.team.id
    team.drivers.forEach((dr, di) => {
      const idx = di as 0 | 1
      const setup = { ...(mine ? ts.setups[idx] : spec.defaultSetup) }
      const skill = driverSkill(dr)
      const strategy = mine ? structuredClone(ts.strategies[idx]) : rivalStrategy(k++)
      setup.compound = strategy.startCompound
      const qualy = estimateLap(track, TEAM_CAR, { ...setup, compound: 'RS' }, skill + 0.004) + (Math.random() - 0.5) * 0.45 - dr.consistency * 0.1
      slots.push({
        id: `${team.id}-${dr.id}`,
        team,
        driverIndex: idx,
        qualy,
        strategy,
        mode: mine ? ts.modes[idx] : 'race',
        mine,
        cfg: { model: team.model ?? (['ferrari-296-gt3', 'amg-gt3', 'mustang-gt3'] as const)[k % 3], id: `${team.id}-${dr.id}`, name: `${dr.first[0]}. ${dr.last}`, code: dr.code, teamId: team.id, color: team.color, accent: team.accent, number: dr.number, carId: TEAM_CAR, setup, skill },
      })
    })
  }
  slots.sort((a, b) => a.qualy - b.qualy)
  lastGrid.slots = slots.map(({ id, team, driverIndex, qualy }) => ({ id, team, driverIndex, qualy }))

  useGameStore.getState().set({ sessionHour: round.hour, sessionKind: 'team', paused: false })
  game.startTeam('valle-alta', laps, slots.map((s) => s.cfg))
  const tr = new TeamRace(game, laps)
  game.teamRace = tr
  for (const s of slots) {
    const entry = game.cars.find((c) => c.id === s.id)!
    tr.add(entry, s.team, s.team.drivers[s.driverIndex], s.mine, s.driverIndex, s.strategy, s.mode)
  }
  game.timeScale = ts.prefs.timeScale
  // the scene (team boards, pit crews) is rebuilt once the race engine is attached
  game.version++
  game.emit({ type: 'session' })
  useGameStore.getState().setScreen('driving')
  return tr
}
