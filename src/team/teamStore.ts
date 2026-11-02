// Persistent state of the player's team: identity, car setups, race strategy, season standings.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getCar, type CarSetup } from '../physics/spec'
import { defaultPlayerTeam, POINTS, RIVAL_TEAMS, SEASON, type Team } from './data'
import { type DriveMode, optimise, raceRules, type Strategy } from './strategy'

export const TEAM_CAR = 'vanta-gt3'

export interface Classified {
  driverId: string
  teamId: string
  pos: number
  time: number
  bestLap: number
  laps: number
  dnf: string
  points: number
  stops: number
}

export interface RoundResult {
  round: number
  rows: Classified[]
  fastest: string
}

export interface TeamPrefs {
  /** spoken commentary (Web Speech) */
  voice: boolean
  /** broadcast camera: 'auto' director or follow one of our cars */
  follow: 'auto' | 0 | 1
  timeScale: number
}

interface TeamState {
  team: Team
  setups: [CarSetup, CarSetup]
  strategies: [Strategy, Strategy]
  modes: [DriveMode, DriveMode]
  /** strategies were planned for this round */
  strategyRound: number
  round: number
  results: RoundResult[]
  prefs: TeamPrefs
  setTeam: (patch: Partial<Team>) => void
  setSetup: (i: 0 | 1, s: CarSetup) => void
  setStrategy: (i: 0 | 1, s: Strategy) => void
  setMode: (i: 0 | 1, m: DriveMode) => void
  setPrefs: (p: Partial<TeamPrefs>) => void
  /** recommended strategies for the current round (also used on first entry and after each round) */
  planRound: () => void
  recordResult: (r: RoundResult) => void
  newSeason: () => void
}

export function allTeams(player: Team): Team[] {
  return [...RIVAL_TEAMS.slice(0, 2), player, ...RIVAL_TEAMS.slice(2)]
}

function recommended(round: number): [Strategy, Strategy] {
  const r = raceRules(SEASON[round].laps)
  const c = optimise(r)
  // the two cars split strategies so the team covers both options
  const a = c[0]?.strategy
  const b = (c.find((x) => x.name !== c[0].name) ?? c[1] ?? c[0])?.strategy
  return [structuredClone(a), structuredClone(b)]
}

export const useTeamStore = create<TeamState>()(
  persist(
    (set, get) => ({
      team: defaultPlayerTeam(),
      setups: [{ ...getCar(TEAM_CAR).defaultSetup }, { ...getCar(TEAM_CAR).defaultSetup }],
      strategies: recommended(0),
      modes: ['race', 'race'],
      strategyRound: 0,
      round: 0,
      results: [],
      prefs: { voice: false, follow: 'auto', timeScale: 1 },
      setTeam: (patch) => set({ team: { ...get().team, ...patch } }),
      setSetup: (i, s) => {
        const setups = [...get().setups] as [CarSetup, CarSetup]
        setups[i] = s
        set({ setups })
      },
      setStrategy: (i, s) => {
        const strategies = [...get().strategies] as [Strategy, Strategy]
        strategies[i] = s
        set({ strategies })
      },
      setMode: (i, m) => {
        const modes = [...get().modes] as [DriveMode, DriveMode]
        modes[i] = m
        set({ modes })
      },
      setPrefs: (p) => set({ prefs: { ...get().prefs, ...p } }),
      planRound: () => set({ strategies: recommended(get().round), strategyRound: get().round, modes: ['race', 'race'] }),
      recordResult: (r) => {
        const results = [...get().results.filter((x) => x.round !== r.round), r]
        const next = Math.min(SEASON.length, r.round + 1)
        set({ results, round: next })
        if (next < SEASON.length) get().planRound()
      },
      newSeason: () => {
        set({ results: [], round: 0 })
        get().planRound()
      },
    }),
    { name: 'speed-team-v1', version: 1 },
  ),
)

/** Championship standings from the recorded rounds. */
export function standings(results: RoundResult[], teams: Team[]) {
  const drivers = new Map<string, { points: number; wins: number; teamId: string }>()
  const teamPts = new Map<string, number>()
  for (const t of teams) {
    teamPts.set(t.id, 0)
    for (const d of t.drivers) drivers.set(d.id, { points: 0, wins: 0, teamId: t.id })
  }
  for (const r of results)
    for (const row of r.rows) {
      const d = drivers.get(row.driverId)
      if (d) {
        d.points += row.points
        if (row.pos === 1 && !row.dnf) d.wins++
      }
      teamPts.set(row.teamId, (teamPts.get(row.teamId) ?? 0) + row.points)
    }
  const ds = [...drivers.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.points - a.points || b.wins - a.wins)
  const ts = [...teamPts.entries()].map(([id, points]) => ({ id, points })).sort((a, b) => b.points - a.points)
  return { drivers: ds, teams: ts }
}

export function pointsFor(pos: number) {
  return POINTS[pos - 1] ?? 0
}
