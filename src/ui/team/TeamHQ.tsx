// Team principal headquarters: team identity, drivers, championship, car setups and race strategy.
import { useEffect, useMemo, useState } from 'react'
import { audio } from '../../audio/audio'
import { game } from '../../game/game'
import { getCar } from '../../physics/spec'
import { type Driver, driverName, SEASON, TEAM_PAINTS } from '../../team/data'
import { estimateLap } from '../../team/engineering'
import { startTeamRace } from '../../team/session'
import { type Compound, type DriveMode, estimate, MODES, optimise, RACE_COMPOUNDS, raceRules, type Strategy, TYRES } from '../../team/strategy'
import { driverSkill } from '../../team/teamRace'
import { allTeams, standings, TEAM_CAR, useTeamStore } from '../../team/teamStore'
import { Btn, fmtTime } from '../components'
import { BottomBar, TopBar } from '../screens/Home'
import { SetupSheet } from '../screens/Garage'
import { TyreDot } from './Broadcast'
import { GLTF_CARS } from '../../car/gltfCars'
import './team.css'

type Tab = 'overview' | 'setup' | 'strategy'

function Stat({ k, v }: { k: string; v: number }) {
  return (
    <div className="hq-stat">
      <span>{k}</span>
      <i>
        <b style={{ width: `${Math.round(v * 100)}%` }} />
      </i>
    </div>
  )
}

function DriverCard({ d }: { d: Driver }) {
  return (
    <div className="hq-driver">
      <div className="n">{d.number}</div>
      <div>
        <div className="nm">
          {d.first} {d.last}
        </div>
        <div className="nat">
          {d.code} · {d.nat}
        </div>
        <Stat k="Pace" v={d.pace} />
        <Stat k="Consistency" v={d.consistency} />
        <Stat k="Tyre care" v={d.tyreCare} />
        <Stat k="Racecraft" v={d.racecraft} />
      </div>
    </div>
  )
}

function TeamSide() {
  const ts = useTeamStore()
  const t = ts.team
  return (
    <div className="panel hq-side" style={{ ['--acc' as string]: t.accent }}>
      <div className="panel-body">
        <div className="caps">Your team</div>
        <input className="hq-team-name" value={t.name} maxLength={28} onChange={(e) => ts.setTeam({ name: e.target.value, short: e.target.value.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'YOU' })} />
        <div className="hq-colors" style={{ marginTop: 12 }}>
          <span>Livery</span>
          <div className="swatches">
            {TEAM_PAINTS.map((p) => (
              <button key={p} className={'swatch' + (p === t.color ? ' on' : '')} style={{ background: p }} onClick={() => ts.setTeam({ color: p })} aria-label={'livery ' + p} />
            ))}
          </div>
          <span>Accent</span>
          <div className="swatches">
            {TEAM_PAINTS.map((p) => (
              <button key={p} className={'swatch' + (p === t.accent ? ' on' : '')} style={{ background: p }} onClick={() => ts.setTeam({ accent: p })} aria-label={'accent ' + p} />
            ))}
          </div>
        </div>
        <div className="section-title" style={{ marginTop: 18 }}>
          Car
        </div>
        <div className="seg-mini" style={{ flexWrap: 'wrap' }}>
          {GLTF_CARS.map((m) => (
            <button key={m.id} className={(t.model ?? 'ferrari-296-gt3') === m.id ? 'on' : ''} onClick={() => ts.setTeam({ model: m.id })}>
              {m.name}
            </button>
          ))}
        </div>
        <div className="section-title" style={{ marginTop: 18 }}>
          Drivers
        </div>
        {t.drivers.map((d) => (
          <DriverCard key={d.id} d={d} />
        ))}
      </div>
    </div>
  )
}

function Overview() {
  const ts = useTeamStore()
  const teams = allTeams(ts.team)
  const st = standings(ts.results, teams)
  const teamOf = (id: string) => teams.find((t) => t.id === id)!
  const driverOf = (id: string) => teams.flatMap((t) => t.drivers).find((d) => d.id === id)!
  const last = ts.results[ts.results.length - 1]
  return (
    <div className="hq-cols">
      <div>
        <div className="section-title">Drivers' championship</div>
        <table className="hq-table">
          <tbody>
            {st.drivers.map((d, i) => {
              const team = teamOf(d.teamId)
              return (
                <tr key={d.id} className={team.id === ts.team.id ? 'mine' : ''} style={{ ['--acc' as string]: ts.team.accent }}>
                  <td className="num" style={{ width: 24 }}>
                    {i + 1}
                  </td>
                  <td>
                    <span className="sw" style={{ background: team.color }} />
                    {driverName(driverOf(d.id))}
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: 11 }}>{team.short}</td>
                  <td className="num">{d.points}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div>
        <div className="section-title">Teams' championship</div>
        <table className="hq-table">
          <tbody>
            {st.teams.map((t, i) => {
              const team = teamOf(t.id)
              return (
                <tr key={t.id} className={team.id === ts.team.id ? 'mine' : ''} style={{ ['--acc' as string]: ts.team.accent }}>
                  <td className="num" style={{ width: 24 }}>
                    {i + 1}
                  </td>
                  <td>
                    <span className="sw" style={{ background: team.color }} />
                    {team.name}
                  </td>
                  <td className="num">{t.points}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {last && (
          <>
            <div className="section-title" style={{ marginTop: 18 }}>
              Last race · {SEASON[last.round].name}
            </div>
            <table className="hq-table">
              <tbody>
                {last.rows.slice(0, 5).map((r) => (
                  <tr key={r.driverId} className={r.teamId === ts.team.id ? 'mine' : ''} style={{ ['--acc' as string]: ts.team.accent }}>
                    <td className="num" style={{ width: 24 }}>
                      {r.pos}
                    </td>
                    <td>
                      <span className="sw" style={{ background: teamOf(r.teamId).color }} />
                      {driverName(driverOf(r.driverId))}
                    </td>
                    <td className="num">{r.points ? `+${r.points}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}

function SetupTab() {
  const ts = useTeamStore()
  const [i, setI] = useState<0 | 1>(0)
  const track = game.getTrack('valle-alta')
  const d = ts.team.drivers[i]
  const setup = ts.setups[i]
  const skill = driverSkill(d)
  const est = estimateLap(track, TEAM_CAR, { ...setup, compound: 'RM' }, skill)
  const base = estimateLap(track, TEAM_CAR, { ...getCar(TEAM_CAR).defaultSetup, compound: 'RM' }, skill)
  const delta = est - base
  return (
    <div>
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        {ts.team.drivers.map((dr, k) => (
          <Btn key={dr.id} primary={k === i} onClick={() => setI(k as 0 | 1)}>
            #{dr.number} {dr.last}
          </Btn>
        ))}
        <Btn ghost onClick={() => ts.setSetup(i === 0 ? 1 : 0, { ...setup })}>
          Copy to other car
        </Btn>
      </div>
      <div className="est-lap">
        <span className="caps">Engineer's estimate</span>
        <b>{fmtTime(est)}</b>
        <span className="d" style={{ color: delta < -0.01 ? '#2ee59d' : delta > 0.01 ? '#ff5c6c' : 'var(--muted)' }}>
          {delta >= 0 ? '+' : ''}
          {delta.toFixed(2)} s vs baseline
        </span>
        <span className="caps" style={{ marginLeft: 'auto' }}>
          mediums, {d.last}
        </span>
      </div>
      <SetupSheet carId={TEAM_CAR} setup={setup} hideCompound onChange={(s) => ts.setSetup(i, s)} />
    </div>
  )
}

function StintBar({ s, laps }: { s: Strategy; laps: number }) {
  const r = raceRules(laps)
  const est = estimate(s, r)
  return (
    <>
      <div className="strat-bar">
        {est.stints.map((st, k) => (
          <span key={k} style={{ flex: st.to - st.from + 1, background: TYRES[st.compound].color }}>
            {TYRES[st.compound].short} {st.to - st.from + 1}
          </span>
        ))}
      </div>
      <div className="strat-laps">
        <span>Lap 1</span>
        {s.stops.map((x, k) => (
          <span key={k}>box L{x.lap}</span>
        ))}
        <span>Lap {laps}</span>
      </div>
    </>
  )
}

function StrategyCar({ i }: { i: 0 | 1 }) {
  const ts = useTeamStore()
  const round = SEASON[Math.min(ts.round, SEASON.length - 1)]
  const r = useMemo(() => raceRules(round.laps), [round.laps])
  const s = ts.strategies[i]
  const d = ts.team.drivers[i]
  const mode = ts.modes[i]
  const est = estimate(s, r, mode)
  const cands = useMemo(() => optimise(r).slice(0, 5), [r])
  const set = (patch: Partial<Strategy>) => ts.setStrategy(i, { ...s, ...patch })
  const setStop = (k: number, patch: Partial<Strategy['stops'][number]>) => set({ stops: s.stops.map((x, j) => (j === k ? { ...x, ...patch } : x)).sort((a, b) => a.lap - b.lap) })
  const best = cands[0]?.est.total ?? est.total
  const seg = (v: Compound, on: (c: Compound) => void) => (
    <span className="seg-mini">
      {RACE_COMPOUNDS.map((c) => (
        <button key={c} className={v === c ? 'on' : ''} style={{ ['--tc' as string]: TYRES[c].color }} onClick={() => on(c)}>
          {TYRES[c].name}
        </button>
      ))}
    </span>
  )
  return (
    <div className="strat-car" style={{ ['--acc' as string]: ts.team.accent }}>
      <div className="strat-head">
        <b>
          #{d.number} {d.last}
        </b>
        <span className="caps">{s.stops.length}-stop</span>
        <span className="strat-time" style={{ color: est.valid ? 'var(--text)' : '#ff5c6c' }}>
          {fmtTime(est.total)}
          <span style={{ color: 'var(--muted)', fontWeight: 500, marginLeft: 6, fontSize: 12 }}>{est.total - best > 0.05 ? `+${(est.total - best).toFixed(1)}` : 'best'}</span>
        </span>
      </div>
      <StintBar s={s} laps={round.laps} />
      <div className="strat-row">
        <span>Start</span>
        {seg(s.startCompound, (c) => set({ startCompound: c }))}
      </div>
      <div className="strat-row">
        <span>Fuel</span>
        <label className="pw-fuelset" style={{ color: 'var(--muted)' }}>
          <span>{s.startFuel} kg</span>
          <input type="range" min={10} max={r.tank} step={1} value={s.startFuel} onChange={(e) => set({ startFuel: +e.target.value })} />
          <i>{(s.startFuel / r.fuelPerLap).toFixed(1)} laps</i>
        </label>
      </div>
      {s.stops.map((x, k) => (
        <div className="strat-stop" key={k}>
          <b>Stop {k + 1}</b>
          <div style={{ display: 'grid', gap: 6 }}>
            <label className="pw-fuelset" style={{ color: 'var(--muted)' }}>
              <span>Lap {x.lap}</span>
              <input type="range" min={1} max={round.laps - 1} step={1} value={x.lap} onChange={(e) => setStop(k, { lap: +e.target.value })} />
              <i />
            </label>
            {seg(x.compound, (c) => setStop(k, { compound: c }))}
            <label className="pw-fuelset" style={{ color: 'var(--muted)' }}>
              <span>+{x.fuel} kg</span>
              <input type="range" min={0} max={r.tank} step={1} value={x.fuel} onChange={(e) => setStop(k, { fuel: +e.target.value })} />
              <i>{(x.fuel / r.fuelPerLap).toFixed(1)} laps</i>
            </label>
          </div>
          <button className="pw-actions" style={{ background: 'none', border: 0, color: 'var(--muted)', cursor: 'pointer' }} onClick={() => set({ stops: s.stops.filter((_, j) => j !== k) })} aria-label="remove stop">
            ✕
          </button>
        </div>
      ))}
      {s.stops.length < 3 && (
        <div style={{ marginTop: 8 }}>
          <Btn ghost onClick={() => set({ stops: [...s.stops, { lap: Math.min(round.laps - 1, (s.stops[s.stops.length - 1]?.lap ?? 0) + Math.ceil(round.laps / 3)), compound: 'RM', fuel: Math.round(r.fuelPerLap * 4) }] })}>
            + Add stop
          </Btn>
        </div>
      )}
      <div className="strat-row">
        <span>Instruction</span>
        <span className="seg-mini">
          {(['push', 'race', 'save'] as DriveMode[]).map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => ts.setMode(i, m)}>
              {MODES[m].label}
            </button>
          ))}
        </span>
      </div>
      {!est.valid && <div className="strat-warn">⚠ {est.problem}</div>}
      <div className="strat-presets">
        {cands.map((c) => (
          <button key={c.name + c.strategy.stops.map((x) => x.lap).join()} onClick={() => ts.setStrategy(i, structuredClone(c.strategy))} title={`${fmtTime(c.est.total)}`}>
            {c.name} · {c.strategy.stops.map((x) => 'L' + x.lap).join(' ')} {c.est.total - best > 0.05 ? `+${(c.est.total - best).toFixed(1)}` : ''}
          </button>
        ))}
      </div>
    </div>
  )
}

function StrategyTab() {
  const ts = useTeamStore()
  const round = SEASON[Math.min(ts.round, SEASON.length - 1)]
  const r = raceRules(round.laps)
  const life = (c: Compound) => Math.round(((1 - 0.38) / r.treadPerLap[c]) * 10) / 10
  return (
    <div>
      <div className="est-lap" style={{ flexWrap: 'wrap' }}>
        <span className="caps">Tyre life</span>
        {RACE_COMPOUNDS.map((c) => (
          <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <TyreDot c={c} size={18} /> ~{life(c)} laps
          </span>
        ))}
        <span className="caps" style={{ marginLeft: 'auto' }}>
          Tank {r.tank} kg · {r.fuelPerLap} kg/lap · pit loss ≈ {Math.round(r.laneLoss + 4)} s
        </span>
      </div>
      <div className="hq-cols">
        <StrategyCar i={0} />
        <StrategyCar i={1} />
      </div>
    </div>
  )
}

export function TeamHQ() {
  const ts = useTeamStore()
  const [tab, setTab] = useState<Tab>('overview')
  const seasonOver = ts.round >= SEASON.length
  const ri = Math.min(ts.round, SEASON.length - 1)
  const round = SEASON[ri]
  const r = raceRules(round.laps)
  useEffect(() => {
    if (ts.strategyRound !== ts.round && !seasonOver) ts.planRound()
  }, [ts.strategyRound, ts.round, seasonOver, ts])
  const go = () => {
    audio.init()
    audio.resume()
    startTeamRace()
  }
  const teams = allTeams(ts.team)
  const champ = seasonOver ? standings(ts.results, teams).drivers[0] : null
  const champName = champ ? driverName(teams.flatMap((t) => t.drivers).find((d) => d.id === champ.id)!) : ''
  const hh = Math.floor(round.hour),
    mm = Math.round((round.hour - hh) * 60)
  return (
    <>
      <TopBar crumb="Team Principal" />
      <div className="screen" style={{ display: 'block' }}>
        <div className="hq">
          <TeamSide />
          <div className="panel hq-main">
            <div className="tabs">
              {(
                [
                  ['overview', 'Championship'],
                  ['setup', 'Car setup'],
                  ['strategy', 'Race strategy'],
                ] as [Tab, string][]
              ).map(([k, l]) => (
                <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="panel-body" style={{ flex: 1, overflow: 'auto' }}>
              <div className="hq-round">
                {seasonOver ? (
                  <div>
                    <div className="caps">Season complete</div>
                    <div className="big">Champion: {champName}</div>
                  </div>
                ) : (
                  <>
                    <div>
                      <div className="caps">
                        Round {ri + 1} of {SEASON.length}
                      </div>
                      <div className="big">{round.name}</div>
                    </div>
                    <div className="kv">
                      Laps<b>{round.laps}</b>
                    </div>
                    <div className="kv">
                      Start<b>{`${hh}:${String(mm).padStart(2, '0')}`}</b>
                    </div>
                    <div className="kv">
                      Fuel tank<b>{r.tank} kg</b>
                    </div>
                    <div className="kv">
                      Pit stops<b>at least 1</b>
                    </div>
                  </>
                )}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  {seasonOver ? (
                    <Btn primary onClick={() => ts.newSeason()}>
                      New season
                    </Btn>
                  ) : (
                    <Btn primary sound="start" onClick={go}>
                      Go racing →
                    </Btn>
                  )}
                </div>
              </div>
              {tab === 'overview' && <Overview />}
              {tab === 'setup' && <SetupTab />}
              {tab === 'strategy' && <StrategyTab />}
            </div>
          </div>
        </div>
      </div>
      <BottomBar
        hints={[
          ['Click', 'Select'],
          ['Esc', 'Back'],
        ]}
      />
    </>
  )
}
