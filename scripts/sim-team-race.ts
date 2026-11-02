// Headless team race: the full field, real physics, pit stops through the pit lane. Prints the
// race events and the classification.  bun scripts/sim-team-race.ts [laps]
import { game } from '../src/game/game'
import { useTeamStore } from '../src/team/teamStore'
import { SEASON } from '../src/team/data'
import { startTeamRace } from '../src/team/session'
import { TYRES } from '../src/team/strategy'

const laps = +(process.argv[2] ?? 0)
if (laps) SEASON[0].laps = laps
useTeamStore.getState().newSeason()
const tr = startTeamRace()
const name = (id: string) => tr.byId.get(id)?.driver.code ?? id
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`
tr.on((e) => {
  const t = fmt(e.t)
  switch (e.kind) {
    case 'overtake':
      console.log(`${t}  ${name(e.car)} passes ${name(e.other)} for P${e.pos}`)
      break
    case 'pit':
      if (e.phase === 'out') console.log(`${t}  ${name(e.car)} pit stop ${e.time!.toFixed(1)} s -> ${TYRES[e.compound!].name} +${e.fuel!.toFixed(0)} kg${e.slow ? ' (slow!)' : ''}`)
      break
    case 'mistake':
      console.log(`${t}  ${name(e.car)} mistake`)
      break
    case 'retire':
      console.log(`${t}  ${name(e.car)} RETIRES: ${e.reason}`)
      break
    case 'fastest':
      console.log(`${t}  fastest lap ${name(e.car)} ${e.time.toFixed(3)}`)
      break
    case 'radio':
      console.log(`${t}  [radio ${name(e.car)}] ${e.text}`)
      break
    case 'undercut':
      console.log(`${t}  STRATEGY: ${name(e.car)} jumps ${name(e.other)} (P${e.pos})`)
      break
    case 'lead':
    case 'lastLap':
    case 'chequered':
    case 'complete':
    case 'start':
      console.log(`${t}  ${e.kind}${'car' in e ? ' ' + name(e.car) : ''}`)
      break
  }
})
const t0 = performance.now()
const dt = 1 / 60
let frames = 0
while (!tr.complete && game.raceTime < 60 * 60) {
  game.update(dt)
  frames++
}
console.log(`\nsimulated ${fmt(game.raceTime)} in ${((performance.now() - t0) / 1000).toFixed(1)} s (${frames} frames)\n`)
for (const c of game.standings()) {
  const rc = tr.byId.get(c.id)!
  const lt = rc.lapTimes.slice(1)
  console.log(
    `P${String(c.timing.position).padStart(2)} ${rc.driver.code} ${rc.team.short}  ${rc.retired ? 'DNF ' + rc.retired : c.timing.finished ? fmt(c.timing.finishTime) : 'running'}  laps ${c.timing.lap}  stops ${rc.stops}  best ${rc.best.toFixed(2)}  laps ${lt.map((x) => x.toFixed(1)).join(' ')}  fuel ${rc.fuel.toFixed(1)} tread ${(rc.tread * 100).toFixed(0)}%  grid ${rc.gridPos}`,
  )
}
