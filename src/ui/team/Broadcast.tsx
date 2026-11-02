// TV broadcast graphics for team races, plus the pit wall the player runs the team from.
import { useEffect, useRef, useState } from 'react'
import { game } from '../../game/game'
import { director, SHOT_LABEL, type ShotKind } from '../../render/broadcastCam'
import { commentaryFor, speak } from '../../team/commentary'
import { SEASON } from '../../team/data'
import { lastGrid, teamRace } from '../../team/session'
import { type Compound, type DriveMode, MODES, RACE_COMPOUNDS, TYRES } from '../../team/strategy'
import type { RaceCar, Stamped, TeamRace } from '../../team/teamRace'
import { useTeamStore } from '../../team/teamStore'
import { fmtTime } from '../components'
import './team.css'

function useTick(hz: number) {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((t) => t + 1), 1000 / hz)
    return () => clearInterval(id)
  }, [hz])
}

export function TyreDot({ c, size = 18 }: { c: Compound; size?: number }) {
  const t = TYRES[c]
  return (
    <span className="tyre-dot" style={{ width: size, height: size, borderColor: t.color, color: t.color, fontSize: size * 0.55 }}>
      {t.short}
    </span>
  )
}

const fmtGap = (x: number) => (x < 60 ? '+' + x.toFixed(1) : '+' + fmtTime(x))

// ------------------------------------------------------------------------------------- timing tower

function Tower({ tr }: { tr: TeamRace }) {
  const [mode, setMode] = useState<'int' | 'gap'>('int')
  const [moves, setMoves] = useState<Record<string, { dir: number; at: number }>>({})
  useEffect(
    () =>
      tr.on((e) => {
        if (e.kind === 'overtake') setMoves((m) => ({ ...m, [e.car]: { dir: 1, at: performance.now() }, [e.other]: { dir: -1, at: performance.now() } }))
      }),
    [tr],
  )
  const st = game.standings()
  const lap = Math.min(tr.rules.laps, (st[0]?.timing.lap ?? 0) + 1)
  const ROW = 27
  const now = performance.now()
  return (
    <div className="bc-tower">
      <div className="bc-tower-head" onClick={() => setMode(mode === 'int' ? 'gap' : 'int')} title="Interval / gap to leader">
        <span className="bc-lap">
          LAP <b>{tr.chequered ? tr.rules.laps : lap}</b>/{tr.rules.laps}
        </span>
        <span className="bc-flag" data-f={tr.chequered ? 'cheq' : game.phase === 'racing' ? 'green' : 'grid'} />
      </div>
      <div className="bc-rows" style={{ height: st.length * ROW }}>
        {st.map((e, i) => {
          const c = tr.byId.get(e.id)
          if (!c) return null
          const mv = moves[e.id]
          const moved = mv && now - mv.at < 3500 ? mv.dir : 0
          let gap: string
          if (c.retired) gap = 'OUT'
          else if (c.inPit()) gap = c.pit!.phase === 'service' ? 'STOP' : 'PIT'
          else if (i === 0) gap = c.finished ? 'WINNER' : mode === 'int' ? 'Interval' : 'Leader'
          else if (c.lapsDown > 0) gap = `+${c.lapsDown} LAP`
          else if (!tr.started) gap = '—'
          else gap = fmtGap(mode === 'int' ? c.interval : c.gap)
          const focus = director.focus === c.id
          const onAir = director.target === c.id || director.second === c.id
          return (
            <div
              key={e.id}
              className={'bc-row' + (c.mine ? ' mine' : '') + (focus ? ' focus' : '') + (c.retired ? ' out' : '') + (onAir ? ' air' : '')}
              style={{ transform: `translateY(${i * ROW}px)`, ['--team' as string]: c.team.color, ['--acc' as string]: c.team.accent }}
              onClick={() => (director.focus = director.focus === c.id ? '' : c.id)}
              title={`${c.driver.first} ${c.driver.last} · ${c.team.name}`}
            >
              <span className="p">{i + 1}</span>
              <span className="bar" />
              <span className="cd">{c.driver.code}</span>
              <span className={'mv' + (moved > 0 ? ' up' : moved < 0 ? ' down' : '')}>{moved > 0 ? '▲' : moved < 0 ? '▼' : ''}</span>
              <span className={'gap' + (gap === 'PIT' || gap === 'STOP' ? ' pit' : '')}>{gap}</span>
              <span className="ty">
                <TyreDot c={c.compound} size={15} />
                <i>{c.tyreLaps}</i>
              </span>
              <span className="stops">{c.stops > 0 ? c.stops : ''}</span>
            </div>
          )
        })}
      </div>
      {tr.fastest && (
        <div className="bc-fastest">
          <span>FASTEST LAP</span>
          <b>{tr.byId.get(tr.fastest.car)?.driver.code}</b>
          <i>{fmtTime(tr.fastest.time)}</i>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------- lower third

function LowerThird({ tr }: { tr: TeamRace }) {
  const [shown, setShown] = useState({ cut: -1, at: 0 })
  useEffect(() => {
    if (director.cut !== shown.cut) setShown({ cut: director.cut, at: performance.now() })
  })
  const age = performance.now() - shown.at
  const c = tr.byId.get(director.target)
  if (!c || game.phase === 'grid' || game.phase === 'countdown') return null
  const pit = c.pit && c.pit.phase === 'service' ? c.pit : null
  const visible = pit || age < 5200
  if (!visible) return null
  const other = director.second ? tr.byId.get(director.second) : null
  const pos = c.entry.timing.position
  if (pit) {
    return (
      <div className="bc-l3 pitstop" style={{ ['--team' as string]: c.team.color }}>
        <div className="l3-tag">PIT STOP</div>
        <div className="l3-main">
          <span className="num">{c.driver.number}</span>
          <span className="nm">{c.driver.last.toUpperCase()}</span>
          <span className="tm">{c.team.name}</span>
        </div>
        <div className="l3-clock">
          <b>{pit.stationary.toFixed(1)}</b>
          <span>s</span>
        </div>
        <div className="l3-sub">
          <TyreDot c={pit.compound} size={16} /> {TYRES[pit.compound].name}s{pit.fuel > 0 ? ` · +${pit.fuel.toFixed(0)} kg fuel` : ''}
        </div>
      </div>
    )
  }
  if (other && Math.abs(other.entry.timing.position - pos) === 1) {
    const [a, b] = other.entry.timing.position < pos ? [other, c] : [c, other]
    return (
      <div className="bc-l3 battle">
        <div className="l3-tag">BATTLE FOR P{a.entry.timing.position}</div>
        {[a, b].map((x) => (
          <div className="l3-row" key={x.id} style={{ ['--team' as string]: x.team.color }}>
            <span className="p">{x.entry.timing.position}</span>
            <span className="bar" />
            <span className="nm">{x.driver.last.toUpperCase()}</span>
            <TyreDot c={x.compound} size={15} />
            <span className="age">{x.tyreLaps} L</span>
          </div>
        ))}
        <div className="l3-gap">GAP {b.interval > 0 ? b.interval.toFixed(2) : '—'} s</div>
      </div>
    )
  }
  return (
    <div className="bc-l3" style={{ ['--team' as string]: c.team.color }}>
      <div className="l3-tag">
        P{pos} <span>{SHOT_LABEL[director.shot]}</span>
      </div>
      <div className="l3-main">
        <span className="num">{c.driver.number}</span>
        <span className="nm">
          {c.driver.first} <b>{c.driver.last.toUpperCase()}</b>
        </span>
        <span className="tm">{c.team.name}</span>
      </div>
      <div className="l3-sub">
        <TyreDot c={c.compound} size={16} /> {c.tyreLaps} laps · {pos > 1 ? `${fmtGap(c.interval)} to P${pos - 1}` : 'Race leader'} · {c.stops} stop{c.stops === 1 ? '' : 's'}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------------------- banners, radio, commentary

interface Banner {
  id: number
  kind: string
  title: string
  sub: string
  color?: string
}

function Feed({ tr }: { tr: TeamRace }) {
  const [banners, setBanners] = useState<Banner[]>([])
  const [radio, setRadio] = useState<{ e: Extract<Stamped, { kind: 'radio' }>; at: number } | null>(null)
  const [line, setLine] = useState<{ text: string; at: number } | null>(null)
  const voice = useTeamStore((s) => s.prefs.voice)
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  useEffect(
    () =>
      tr.on((e) => {
        const name = (id: string) => tr.byId.get(id)?.driver.last.toUpperCase() ?? id
        const push = (b: Omit<Banner, 'id'>) => setBanners((list) => [...list.slice(-2), { ...b, id: e.id }])
        if (e.kind === 'radio') setRadio({ e, at: performance.now() })
        else if (e.kind === 'overtake' && (e.pos <= 5 || tr.byId.get(e.car)?.mine || tr.byId.get(e.other)?.mine)) push({ kind: 'move', title: `${name(e.car)} ▲ P${e.pos}`, sub: `passes ${name(e.other)}`, color: tr.byId.get(e.car)?.team.color })
        else if (e.kind === 'undercut' && (e.pos <= 8 || tr.byId.get(e.car)?.mine || tr.byId.get(e.other)?.mine)) push({ kind: 'move', title: `${name(e.car)} JUMPS ${name(e.other)}`, sub: `strategy gains P${e.pos}`, color: tr.byId.get(e.car)?.team.color })
        else if (e.kind === 'fastest') push({ kind: 'fastest', title: 'FASTEST LAP', sub: `${name(e.car)} · ${fmtTime(e.time)}` })
        else if (e.kind === 'lead') push({ kind: 'lead', title: 'NEW LEADER', sub: name(e.car), color: tr.byId.get(e.car)?.team.color })
        else if (e.kind === 'lastLap') push({ kind: 'last', title: 'FINAL LAP', sub: '' })
        else if (e.kind === 'chequered') push({ kind: 'cheq', title: 'CHEQUERED FLAG', sub: `${name(e.car)} WINS` })
        else if (e.kind === 'retire') push({ kind: 'retire', title: 'RETIRED', sub: `${name(e.car)} · ${e.reason}` })
        else if (e.kind === 'pit' && e.phase === 'out' && e.slow) push({ kind: 'slow', title: 'SLOW STOP', sub: `${name(e.car)} · ${e.time!.toFixed(1)} s` })
        const l = commentaryFor(e, tr)
        if (l) {
          setLine({ text: l.text, at: performance.now() })
          if (voiceRef.current && l.big) speak(l.text)
        }
      }),
    [tr],
  )
  useEffect(() => {
    if (!banners.length) return
    const t = setTimeout(() => setBanners((b) => b.slice(1)), 3400)
    return () => clearTimeout(t)
  }, [banners])
  const now = performance.now()
  const rc = radio ? tr.byId.get(radio.e.car) : null
  return (
    <>
      <div className="bc-banners">
        {banners.slice(-1).map((b) => (
          <div key={b.id} className={'bc-banner ' + b.kind} style={{ ['--team' as string]: b.color ?? '#e4002b' }}>
            <b>{b.title}</b>
            {b.sub && <span>{b.sub}</span>}
          </div>
        ))}
      </div>
      {line && now - line.at < 7000 && (
        <div className="bc-comm" key={line.at}>
          <span className="mic" />
          {line.text}
        </div>
      )}
      {radio && rc && now - radio.at < 6500 && (
        <div className="bc-radio" key={radio.e.id} style={{ ['--team' as string]: rc.team.accent }}>
          <div className="rh">
            <span className="wave">
              <i />
              <i />
              <i />
              <i />
            </span>
            TEAM RADIO · {radio.e.from === 'driver' ? rc.driver.last.toUpperCase() : `ENGINEER → ${rc.driver.code}`}
          </div>
          <div className="rt">“{radio.e.text}”</div>
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------------------------------- start

function StartSequence({ tr }: { tr: TeamRace }) {
  const [goAt, setGoAt] = useState(0)
  useEffect(() => tr.on((e) => e.kind === 'start' && setGoAt(performance.now())), [tr])
  const phase = game.phase
  const t = game.countdownTotal - game.countdown
  const round = SEASON[Math.min(useTeamStore.getState().round, SEASON.length - 1)]
  if (phase === 'grid' || phase === 'countdown') {
    const lights = Math.max(0, Math.min(5, Math.floor(t - 2.8)))
    return (
      <>
        {t < 3.4 && (
          <div className="bc-grid">
            <div className="gh">
              STARTING GRID <span>{round.name}</span>
            </div>
            <div className="gl">
              {lastGrid.slots.map((s, i) => {
                const d = s.team.drivers[s.driverIndex]
                return (
                  <div key={s.id} className={'gs' + (s.team.id === 'player' ? ' mine' : '')} style={{ ['--team' as string]: s.team.color, gridColumn: (i % 2) + 1 }}>
                    <span className="p">{i + 1}</span>
                    <span className="bar" />
                    <span className="nm">{d.last.toUpperCase()}</span>
                    <span className="tm">{s.team.short}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {t >= 2.8 && (
          <div className="bc-lights">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className={i < lights ? 'on' : ''}>
                <i />
                <i />
              </span>
            ))}
          </div>
        )}
      </>
    )
  }
  if (goAt && performance.now() - goAt < 1600) return <div className="bc-go">LIGHTS OUT</div>
  return null
}

// ------------------------------------------------------------------------------------- pit wall

function CarCard({ tr, c }: { tr: TeamRace; c: RaceCar }) {
  const [plan, setPlan] = useState<{ compound: Compound; fuel: number } | null>(null)
  const t = c.entry.timing
  const pos = t.position
  const st = game.standings()
  const ahead = st[pos - 2] ? tr.byId.get(st[pos - 2].id) : null
  const behind = st[pos] ? tr.byId.get(st[pos].id) : null
  const tread = c.tread
  const temp = c.vehicle.wheels.reduce((a, w) => a + w.tyre.surfTemp, 0) / 4
  const fuelLap = tr.rules.fuelPerLap * MODES[c.mode].fuel
  const lapsFuel = c.fuel / fuelLap
  const next = c.nextStop()
  const lapsLeft = tr.rules.laps - t.lap - t.s / game.track.length
  const needTo = next && next.lap > t.lap ? next.lap - t.lap - t.s / game.track.length : lapsLeft
  const fuelOk = lapsFuel >= needTo - 0.05
  const called = c.pit?.phase === 'called'
  const inPit = c.inPit()
  const windowOpen = tr.callWindowOpen(c)
  const maxFuel = Math.max(0, tr.rules.tank - c.fuel)
  const suggest = () => {
    const e = tr.emergencyCall(c, Math.max(1, Math.round(lapsLeft)))
    setPlan({ compound: e.compound, fuel: Math.round(e.fuel) })
  }
  const treadCls = tread > 0.5 ? 'ok' : tread > 0.3 ? 'warn' : 'bad'
  return (
    <div className={'pw-card' + (director.focus === c.id ? ' focus' : '')} style={{ ['--team' as string]: c.team.color, ['--acc' as string]: c.team.accent }}>
      <div className="pw-head" onClick={() => (director.focus = director.focus === c.id ? '' : c.id)} title="Follow this car on the broadcast">
        <span className="pos">P{pos}</span>
        <span className="num">#{c.driver.number}</span>
        <span className="nm">{c.driver.last.toUpperCase()}</span>
        <span className="cam">{director.focus === c.id ? '● LIVE' : 'WATCH'}</span>
      </div>
      {c.retired ? (
        <div className="pw-out">Retired · {c.retired}</div>
      ) : (
        <>
          <div className="pw-gaps">
            <span>{ahead ? `▲ ${ahead.driver.code} ${c.interval > 0 ? c.interval.toFixed(1) : '—'}` : 'Leading'}</span>
            <span>{behind && !behind.retired ? `▼ ${behind.driver.code} ${behind.interval > 0 ? behind.interval.toFixed(1) : '—'}` : ''}</span>
          </div>
          <div className="pw-grid">
            <div className="pw-tyre">
              <TyreDot c={c.compound} size={26} />
              <div>
                <div className={'pw-bar ' + treadCls}>
                  <i style={{ width: `${Math.max(0, tread) * 100}%` }} />
                </div>
                <div className="pw-sub">
                  {Math.round(tread * 100)}% · {c.tyreLaps} laps · <span style={{ color: temp < 70 ? '#6cb8ff' : temp > 112 ? '#ff6b6b' : '#9be58f' }}>{temp.toFixed(0)}°</span>
                </div>
              </div>
            </div>
            <div className="pw-fuel">
              <div className="pw-k">FUEL</div>
              <div className={'pw-v' + (fuelOk ? '' : ' bad')}>{c.fuel.toFixed(1)} kg</div>
              <div className="pw-sub">
                {lapsFuel.toFixed(1)} laps · need {Math.max(0, needTo).toFixed(1)}
              </div>
            </div>
          </div>
          <div className="pw-modes">
            {(['push', 'race', 'save'] as DriveMode[]).map((m) => (
              <button key={m} className={c.mode === m ? 'on ' + m : m} onClick={() => tr.setMode(c.id, m)} disabled={c.finished}>
                {MODES[m].label}
              </button>
            ))}
          </div>
          {inPit ? (
            <div className="pw-pit live">
              <b>{c.pit!.phase === 'service' ? `IN THE BOX · ${c.pit!.stationary.toFixed(1)} s` : c.pit!.phase === 'in' ? 'PIT LANE · ENTERING' : 'PIT LANE · LEAVING'}</b>
              <span>
                <TyreDot c={c.pit!.compound} size={14} /> +{c.pit!.fuel.toFixed(0)} kg
              </span>
            </div>
          ) : called ? (
            <div className="pw-pit called">
              <b>BOX THIS LAP</b>
              <span>
                <TyreDot c={c.pit!.compound} size={14} /> +{c.pit!.fuel.toFixed(0)} kg
              </span>
              <button onClick={() => tr.cancelBox(c.id)}>Stay out</button>
            </div>
          ) : plan ? (
            <div className="pw-plan">
              <div className="pw-compounds">
                {RACE_COMPOUNDS.map((k) => (
                  <button key={k} className={plan.compound === k ? 'on' : ''} onClick={() => setPlan({ ...plan, compound: k })} style={{ ['--tc' as string]: TYRES[k].color }}>
                    {TYRES[k].name}
                  </button>
                ))}
              </div>
              <label className="pw-fuelset">
                <span>Fuel +{plan.fuel} kg</span>
                <input type="range" min={0} max={Math.round(maxFuel)} step={1} value={Math.min(plan.fuel, Math.round(maxFuel))} onChange={(e) => setPlan({ ...plan, fuel: +e.target.value })} />
                <i>{((c.fuel + plan.fuel) / fuelLap).toFixed(1)} laps</i>
              </label>
              <div className="pw-actions">
                <button className="go" onClick={() => (tr.box(c.id, plan.compound, Math.min(plan.fuel, maxFuel)), setPlan(null))}>
                  Confirm · box {windowOpen ? 'this lap' : 'next lap'}
                </button>
                <button onClick={() => setPlan(null)}>Back</button>
              </div>
            </div>
          ) : (
            <div className="pw-pit">
              <span className="pw-next">
                {c.request ? (
                  <>
                    Box called <TyreDot c={c.request.compound} size={13} /> +{c.request.fuel} kg
                  </>
                ) : next ? (
                  <>
                    Plan: lap {next.lap} <TyreDot c={next.compound} size={13} /> +{next.fuel} kg
                  </>
                ) : (
                  'No stop planned'
                )}
                {tr.started && !c.finished && <i className="pw-rejoin">· pit now ≈ P{tr.rejoinEstimate(c, next?.fuel ?? 0)}</i>}
              </span>
              {!c.finished && (
                <button className="box" onClick={suggest}>
                  BOX
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function PitWall({ tr }: { tr: TeamRace }) {
  const mine = tr.cars.filter((c) => c.mine).sort((a, b) => a.slot - b.slot)
  const [open, setOpen] = useState(true)
  return (
    <div className={'pw' + (open ? '' : ' closed')}>
      <div className="pw-title" onClick={() => setOpen(!open)}>
        <span>PIT WALL</span>
        <span className="team" style={{ color: mine[0]?.team.accent }}>
          {mine[0]?.team.name}
        </span>
        <span className="tog">{open ? '▾' : '▴'}</span>
      </div>
      {open && (
        <div className="pw-cards">
          {mine.map((c) => (
            <CarCard key={c.id} tr={tr} c={c} />
          ))}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------- controls

const SHOTS: (ShotKind | null)[] = [null, 'trackside', 'heli', 'onboard', 'chase']

function Controls({ tr }: { tr: TeamRace }) {
  const prefs = useTeamStore((s) => s.prefs)
  const setPrefs = useTeamStore((s) => s.setPrefs)
  const mine = tr.cars.filter((c) => c.mine).sort((a, b) => a.slot - b.slot)
  useEffect(() => {
    game.timeScale = prefs.timeScale
  }, [prefs.timeScale])
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === '1' || e.key === '2') {
        const c = mine[+e.key - 1]
        if (c) director.focus = director.focus === c.id ? '' : c.id
      }
      if (e.key === '0') director.focus = ''
      if (e.key === 'v') {
        const i = SHOTS.indexOf(director.lockShot)
        director.lockShot = SHOTS[(i + 1) % SHOTS.length]
      }
      if (e.key === 'f') setPrefs({ timeScale: prefs.timeScale >= 4 ? 1 : prefs.timeScale * 2 })
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })
  return (
    <div className="bc-ctrl">
      <div className="bc-bug">
        <span className="live">LIVE</span>
        <b>SPEED</b> GT SERIES
      </div>
      <div className="bc-ctrl-row" title="Simulation speed (F)">
        {[1, 2, 4].map((x) => (
          <button key={x} className={prefs.timeScale === x ? 'on' : ''} onClick={() => setPrefs({ timeScale: x })}>
            {x}×
          </button>
        ))}
      </div>
      <div className="bc-ctrl-row" title="Camera (0 / 1 / 2)">
        <button className={!director.focus ? 'on' : ''} onClick={() => (director.focus = '')}>
          Director
        </button>
        {mine.map((c) => (
          <button key={c.id} className={director.focus === c.id ? 'on' : ''} onClick={() => (director.focus = c.id)}>
            {c.driver.code}
          </button>
        ))}
      </div>
      <div className="bc-ctrl-row" title="Shot type (V)">
        {SHOTS.map((k) => (
          <button key={k ?? 'auto'} className={director.lockShot === k ? 'on' : ''} onClick={() => (director.lockShot = k)}>
            {k ? SHOT_LABEL[k] : 'Auto'}
          </button>
        ))}
      </div>
      <div className="bc-ctrl-row">
        <button className={prefs.voice ? 'on' : ''} onClick={() => setPrefs({ voice: !prefs.voice })} title="Spoken commentary">
          Commentary voice {prefs.voice ? 'on' : 'off'}
        </button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------------------- root

export function Broadcast({ onComplete }: { onComplete: () => void }) {
  useTick(8)
  const tr = teamRace()
  useEffect(() => {
    if (!tr) return
    director.focus = ''
    director.lockShot = null
    director.finishShown = false
    return tr.on((e) => {
      if (e.kind === 'complete') setTimeout(onComplete, 2500)
    })
  }, [tr, onComplete])
  if (!tr) return null
  return (
    <div className="bc">
      <Tower tr={tr} />
      <Controls tr={tr} />
      <StartSequence tr={tr} />
      <LowerThird tr={tr} />
      <Feed tr={tr} />
      <PitWall tr={tr} />
      <div className="bc-shot">{SHOT_LABEL[director.shot]}</div>
    </div>
  )
}
