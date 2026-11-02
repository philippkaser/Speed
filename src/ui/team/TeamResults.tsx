// Race classification for team races: points, stops, fastest lap, championship update.
import { useMemo } from 'react'
import { game } from '../../game/game'
import { startAttract } from '../../game/session'
import { useGameStore } from '../../state/gameStore'
import { FASTEST_LAP_POINT, SEASON } from '../../team/data'
import { teamRace } from '../../team/session'
import { type Classified, pointsFor, useTeamStore } from '../../team/teamStore'
import { Btn, fmtTime } from '../components'
import { TyreDot } from './Broadcast'
import './team.css'

export function classify(): { rows: Classified[]; fastest: string } {
  const tr = teamRace()
  if (!tr) return { rows: [], fastest: '' }
  const st = game.standings()
  const fastest = tr.fastest?.car ?? ''
  const winner = st[0]
  const rows = st.map((e, i) => {
    const c = tr.byId.get(e.id)!
    const pos = i + 1
    const dnf = c.retired
    let points = dnf ? 0 : pointsFor(pos)
    if (!dnf && e.id === fastest && pos <= 10) points += FASTEST_LAP_POINT
    return {
      driverId: c.driver.id,
      teamId: c.team.id,
      pos,
      time: e.timing.finished ? e.timing.finishTime - (i === 0 ? 0 : winner.timing.finishTime) : -1,
      bestLap: c.best,
      laps: e.timing.lap,
      dnf,
      points,
      stops: c.stops,
    }
  })
  // retirements are classified last
  rows.sort((a, b) => (a.dnf ? 1 : 0) - (b.dnf ? 1 : 0) || a.pos - b.pos)
  rows.forEach((r, i) => (r.pos = i + 1))
  return { rows, fastest }
}

export function TeamResults() {
  const ts = useTeamStore()
  const tr = teamRace()
  const { rows, fastest } = useMemo(classify, [])
  const roundIdx = Math.min(ts.round, SEASON.length - 1)
  const teamPts = rows.filter((r) => r.teamId === ts.team.id).reduce((a, r) => a + r.points, 0)
  const lead = tr?.cars.find((c) => c.id === game.standings()[0]?.id)
  const done = () => {
    ts.recordResult({ round: roundIdx, rows, fastest: fastest ? tr!.byId.get(fastest)!.driver.id : '' })
    startAttract()
    useGameStore.getState().set({ sessionKind: 'team', paused: false })
    useGameStore.getState().setScreen('teamHQ')
  }
  const name = (driverId: string) => tr?.cars.find((c) => c.driver.id === driverId)
  return (
    <div className="overlay">
      <div className="panel" style={{ width: 'min(820px, 94vw)', maxHeight: '92%', display: 'flex', flexDirection: 'column' }}>
        <div className="panel-head">
          <h2>{SEASON[roundIdx].name} · Classification</h2>
          <span className="caps" style={{ color: ts.team.accent }}>
            {ts.team.name} +{teamPts} pts
          </span>
        </div>
        <div className="panel-body" style={{ overflow: 'auto' }}>
          {lead && (
            <div className="est-lap" style={{ ['--acc' as string]: lead.team.accent }}>
              <span className="caps">Winner</span>
              <b>
                {lead.driver.first} {lead.driver.last}
              </b>
              <span style={{ color: 'var(--muted)' }}>{lead.team.name}</span>
              {tr?.fastest && (
                <span style={{ marginLeft: 'auto', color: '#c9a7ff' }}>
                  Fastest lap {tr.byId.get(tr.fastest.car)?.driver.code} {fmtTime(tr.fastest.time)}
                </span>
              )}
            </div>
          )}
          <table className="results-table">
            <thead>
              <tr>
                <th>Pos</th>
                <th>Driver</th>
                <th>Team</th>
                <th>Time</th>
                <th>Stops</th>
                <th>Tyres</th>
                <th>Best lap</th>
                <th>Pts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = name(r.driverId)
                if (!c) return null
                return (
                  <tr key={r.driverId} className={r.teamId === ts.team.id ? 'me' : ''}>
                    <td className="num">{r.pos}</td>
                    <td>
                      <span className="sw" style={{ display: 'inline-block', width: 4, height: 14, background: c.team.color, marginRight: 10, borderRadius: 2, verticalAlign: -2 }} />
                      {c.driver.first} {c.driver.last}
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{c.team.short}</td>
                    <td className="num">{r.dnf ? `DNF · ${r.dnf}` : r.pos === 1 ? fmtTime(c.entry.timing.finishTime) : r.time >= 0 ? `+${r.time.toFixed(1)}` : `+${Math.max(1, (game.standings()[0]?.timing.lap ?? 0) - r.laps)} lap`}</td>
                    <td className="num">{r.stops}</td>
                    <td>
                      <TyreDot c={c.compound} size={15} />
                    </td>
                    <td className="num" style={{ color: r.driverId === (fastest ? tr?.byId.get(fastest)?.driver.id : '') ? '#c9a7ff' : undefined }}>
                      {r.bestLap ? fmtTime(r.bestLap) : '—'}
                    </td>
                    <td className="num">{r.points || ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '0 24px 22px', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Btn primary sound="start" onClick={done}>
            Continue to team HQ
          </Btn>
        </div>
      </div>
    </div>
  )
}
