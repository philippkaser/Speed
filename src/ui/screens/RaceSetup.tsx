import { useMemo } from 'react'
import { game } from '../../game/game'
import { startDriving } from '../../game/session'
import { getCar } from '../../physics/spec'
import { useGameStore } from '../../state/gameStore'
import { useSettings } from '../../state/settings'
import { Btn, Segmented, Slider } from '../components'
import { BottomBar, TopBar } from './Home'

export function TrackMapSVG({ stroke = '#fff', width = 3, pad = 40 }: { stroke?: string; width?: number; pad?: number }) {
  const tr = game.track
  const d = useMemo(() => {
    let s = ''
    for (let i = 0; i < tr.n; i += 6) s += (i === 0 ? 'M' : 'L') + tr.px[i].toFixed(1) + ' ' + tr.pz[i].toFixed(1) + ' '
    return s + 'Z'
  }, [tr])
  const vb = `${tr.minX - pad} ${tr.minZ - pad} ${tr.maxX - tr.minX + pad * 2} ${tr.maxZ - tr.minZ + pad * 2}`
  return (
    <svg viewBox={vb} className="track-map" preserveAspectRatio="xMidYMid meet">
      <path d={d} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={width * 6} strokeLinejoin="round" />
      <path d={d} fill="none" stroke={stroke} strokeWidth={width * 2.2} strokeLinejoin="round" />
      <circle cx={tr.px[0]} cy={tr.pz[0]} r={width * 5} fill="#e4002b" />
    </svg>
  )
}

export function RaceSetup() {
  const g = useGameStore()
  const photoSky = useSettings((s) => (s.graphics.sky ?? 'photo') === 'photo')
  const race = g.sessionKind === 'race'
  const tr = game.track
  const spec = getCar(g.career.carId)
  const hourLabel = (h: number) => `${Math.floor(h).toString().padStart(2, '0')}:${Math.round((h % 1) * 60).toString().padStart(2, '0')}`
  return (
    <>
      <TopBar crumb={race ? 'Race' : 'Time Trial'} />
      <div className="screen" style={{ gap: 24 }}>
        <div className="panel" style={{ flex: 1.1, display: 'flex', flexDirection: 'column' }}>
          <div className="panel-head">
            <h2>{tr.def.name}</h2>
            <span className="caps">{tr.def.location}</span>
          </div>
          <div className="panel-body" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, minHeight: 200 }}>
              <TrackMapSVG />
            </div>
            <div className="stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <div className="stat">
                <span className="v num">{(tr.length / 1000).toFixed(2)}</span>
                <span className="u">km</span>
                <div className="l">Length</div>
              </div>
              <div className="stat">
                <span className="v num">{countCorners(tr)}</span>
                <div className="l">Corners</div>
              </div>
              <div className="stat">
                <span className="v num">{Math.round(Math.max(...tr.py) - Math.min(...tr.py))}</span>
                <span className="u">m</span>
                <div className="l">Elevation</div>
              </div>
              <div className="stat">
                <span className="v num">{Math.round(maxStraight(tr))}</span>
                <span className="u">m</span>
                <div className="l">Longest straight</div>
              </div>
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.5, marginTop: 14 }}>{tr.def.description}</div>
          </div>
        </div>
        <div className="panel" style={{ width: 'min(520px, 44vw)', display: 'flex', flexDirection: 'column' }}>
          <div className="panel-head">
            <h2>Session</h2>
          </div>
          <div className="panel-body" style={{ flex: 1 }}>
            <div className="field" style={{ gridTemplateColumns: '1fr auto' }}>
              <div className="lab">Mode</div>
              <Segmented
                options={[
                  { value: 'race', label: 'Race' },
                  { value: 'practice', label: 'Time Trial' },
                ]}
                value={g.sessionKind === 'online' ? 'race' : g.sessionKind}
                onChange={(v) => g.set({ sessionKind: v })}
              />
            </div>
            {race && (
              <>
                <Slider label="Laps" value={g.raceLaps} min={1} max={30} step={1} onChange={(v) => g.set({ raceLaps: v })} />
                <Slider label="Opponents" value={g.opponents} min={1} max={11} step={1} onChange={(v) => g.set({ opponents: v })} />
                <Slider label="AI strength" value={g.aiSkill} min={0.8} max={1.02} step={0.01} unit="%" format={(v) => Math.round(v * 100) + ''} onChange={(v) => g.set({ aiSkill: v })} />
              </>
            )}
            <Slider label="Time of day" sub={photoSky ? 'Used with the dynamic sky (Settings → Graphics → Sky); the photographic sky keeps its own afternoon sun' : 'Sun position, light colour and shadows'} value={g.timeOfDay} min={6.5} max={20.2} step={0.1} format={hourLabel} onChange={(v) => g.set({ timeOfDay: v })} />
            <div className="section-title" style={{ marginTop: 20 }}>
              Your car
            </div>
            <div className="field" style={{ gridTemplateColumns: '1fr auto' }}>
              <div>
                <div className="lab">{spec.name}</div>
                <div className="sub">{spec.category}</div>
              </div>
              <span className="swatch on" style={{ background: g.career.colors[spec.id], width: 26, height: 26, display: 'inline-block' }} />
            </div>
          </div>
          <div style={{ padding: '0 24px 22px', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Btn sound="back" onClick={() => g.setScreen('home')}>
              Back
            </Btn>
            <Btn primary sound="start" onClick={() => startDriving(race ? 'race' : 'practice')}>
              {race ? 'Start race' : 'Start session'}
            </Btn>
          </div>
        </div>
      </div>
      <BottomBar hints={[['Esc', 'Back']]} />
    </>
  )
}

function countCorners(tr: typeof game.track) {
  let n = 0
  let inCorner = false
  for (let i = 0; i < tr.n; i++) {
    const c = Math.abs(tr.racingCurv[i]) > 1 / 220
    if (c && !inCorner) n++
    inCorner = c
  }
  return n
}

function maxStraight(tr: typeof game.track) {
  let best = 0,
    run = 0
  for (let k = 0; k < tr.n * 2; k++) {
    const i = k % tr.n
    if (Math.abs(tr.curv[i]) < 1 / 900) run++
    else {
      best = Math.max(best, run)
      run = 0
    }
  }
  return Math.min(best, tr.n)
}
