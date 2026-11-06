import { useEffect, useMemo, useRef, useState } from 'react'
import { audio } from '../../audio/audio'
import { game } from '../../game/game'
import { input } from '../../input/input'
import { clamp } from '../../physics/math'
import { useGameStore } from '../../state/gameStore'
import { useSettings } from '../../state/settings'
import { fmtDelta, fmtTime } from '../components'
import { dynRes } from '../../render/dynamicRes'

const TACH_W = 470,
  TACH_CX = 235,
  TACH_CY = 160,
  TACH_R = 140
const A0 = Math.PI * 0.94,
  A1 = Math.PI * 0.06

function arcPoint(t: number, r = TACH_R) {
  const a = A0 + (A1 - A0) * t
  return [TACH_CX + r * Math.cos(a), TACH_CY - r * Math.sin(a)]
}
function arcPath(t0: number, t1: number, r = TACH_R) {
  const [x0, y0] = arcPoint(t0, r)
  const [x1, y1] = arcPoint(t1, r)
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`
}

function tempColor(t: number, opt: number, win: number) {
  const x = (t - opt) / win
  if (x < -0.6) return 'rgba(64,140,255,0.55)'
  if (x < -0.25) return 'rgba(64,200,220,0.5)'
  if (x < 0.4) return 'rgba(52,210,123,0.55)'
  if (x < 0.9) return 'rgba(255,190,40,0.6)'
  return 'rgba(255,70,70,0.65)'
}

type Toast = { id: number; text: string; kind: 'best' | 'warn' | 'info' }

export function HUD() {
  const visible = useSettings((s) => s.hudVisible)
  const units = useSettings((s) => s.units)
  const showFps = useSettings((s) => s.graphics.showFps)
  const r = useRef<Record<string, HTMLElement | SVGElement | null>>({})
  const ref = (k: string) => (el: HTMLElement | SVGElement | null) => {
    r.current[k] = el
  }
  const [toasts, setToasts] = useState<Toast[]>([])
  const [center, setCenter] = useState<{ big: string; sm?: string; lights?: number } | null>(null)
  const [, force] = useState(0)

  const spec = game.player?.sim.vehicle.spec
  const maxRpm = spec ? Math.ceil(spec.engine.maxRpm / 1000) * 1000 : 9000
  const limiter = spec?.engine.limiterRpm ?? 8000
  const arcLen = useMemo(() => TACH_R * Math.abs(A1 - A0), [])

  // event toasts
  useEffect(() => {
    let id = 0
    const push = (text: string, kind: Toast['kind'], ms = 2600) => {
      const t = { id: ++id, text, kind }
      setToasts((x) => [...x.slice(-2), t])
      setTimeout(() => setToasts((x) => x.filter((y) => y.id !== t.id)), ms)
    }
    return game.on((e) => {
      if (e.type === 'lap' && e.car === 'player') {
        if (e.best) push(`Best lap  ${fmtTime(e.time)}`, 'best')
        else push(`Lap  ${fmtTime(e.time)}${e.valid ? '' : '  · invalid'}`, e.valid ? 'info' : 'warn')
      } else if (e.type === 'trackLimits') push('Track limits — lap invalidated', 'warn')
      else if (e.type === 'countdown') {
        audio.beep(false)
      } else if (e.type === 'go') {
        audio.beep(true)
        setCenter({ big: 'GO', lights: -1 })
        setTimeout(() => setCenter(null), 1300)
      } else if (e.type === 'finish' && e.car === 'player') {
        push(`Finished P${e.position}`, 'best', 4000)
      } else if (e.type === 'notice') push(e.text, 'info', 1600)
      else if (e.type === 'session') force((v) => v + 1)
    })
  }, [])

  // per-frame DOM updates (throttled to ~30 Hz)
  useEffect(() => {
    let raf = 0
    let last = 0
    let fpsAcc = 0,
      fpsN = 0,
      fpsLast = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      fpsN++
      if (now - fpsLast > 500) {
        fpsAcc = (fpsN * 1000) / (now - fpsLast)
        fpsN = 0
        fpsLast = now
        const f = r.current.fps
        if (f) {
          const gpu = dynRes.timestamps && dynRes.gpuMs > 0 ? ` · GPU ${dynRes.gpuMs.toFixed(1)} ms` : ''
          const res = dynRes.outW ? ` · ${dynRes.inW}×${dynRes.inH} → ${dynRes.outW}×${dynRes.outH}` : ''
          f.textContent = `${fpsAcc.toFixed(0)} fps · ${useGameStore.getState().rendererInfo}${gpu}${res}`
        }
      }
      if (now - last < 33) return
      last = now
      const p = game.player
      if (!p) return
      const v = p.sim.vehicle
      const t = p.timing
      const el = r.current
      const set = (k: string, s: string) => {
        const e = el[k]
        if (e && e.textContent !== s) e.textContent = s
      }
      // tach
      const rpm = v.rpm
      const frac = clamp(rpm / maxRpm, 0, 1)
      const fill = el.tachFill as SVGPathElement | null
      if (fill) {
        fill.setAttribute('stroke-dasharray', `${(frac * arcLen).toFixed(1)} ${arcLen.toFixed(1)}`)
        const shift = rpm > limiter - 650
        const flash = rpm > limiter - 150 && Math.floor(now / 70) % 2 === 0
        fill.setAttribute('stroke', flash ? '#4da3ff' : shift ? '#ff3b4a' : rpm > limiter - 1400 ? '#ffcc33' : '#ffffff')
      }
      set('gear', v.gear === 0 ? 'N' : v.gear < 0 ? 'R' : String(v.gear))
      const spd = units === 'metric' ? v.speed * 3.6 : v.speed * 2.23694
      set('speed', Math.round(spd).toString())
      const thr = el.thr as HTMLElement | null
      if (thr) thr.style.height = `${Math.round(v.throttle * 100)}%`
      const brk = el.brk as HTMLElement | null
      if (brk) brk.style.height = `${Math.round(v.brake * 100)}%`
      const tc = el.tc as HTMLElement | null
      if (tc) tc.className = v.tcActive ? 'on' : ''
      const abs = el.abs as HTMLElement | null
      if (abs) abs.className = v.absActive ? 'on' : ''
      // timing
      const racing = game.phase === 'racing' || game.mode === 'practice'
      set('lap', String(Math.min(t.lap + 1, Math.max(game.totalLaps, 1))))
      set('time', t.started && racing ? fmtTime(t.current) : '0:00.000')
      const timeEl = el.time as HTMLElement | null
      if (timeEl) timeEl.className = 'hud-time num' + (t.valid ? '' : ' invalid')
      set('last', fmtTime(t.last))
      set('best', fmtTime(t.best))
      const d = el.delta as HTMLElement | null
      if (d) {
        if (t.best > 0 && t.started) {
          d.style.display = ''
          d.textContent = fmtDelta(t.deltaToBest)
          d.className = 'delta num ' + (t.deltaToBest > 0 ? 'pos' : 'neg')
        } else d.style.display = 'none'
      }
      for (let k = 0; k < 3; k++) {
        const s = el['sec' + k] as HTMLElement | null
        if (!s) continue
        let col = 'rgba(255,255,255,0.15)'
        if (k < t.sector && t.started) {
          const time = t.sectorTimes[k]
          const best = t.bestSectors[k]
          col = best === 0 || time <= best ? '#b48cff' : time - best < 0.25 ? '#34d27b' : '#ffcc33'
        } else if (k === t.sector && t.started) col = 'rgba(255,255,255,0.55)'
        s.style.background = col
      }
      // position & standings
      set('pos', String(t.position))
      set('posOf', '/' + game.cars.length)
      const st = el.standings as HTMLElement | null
      if (st && game.cars.length > 1) {
        const list = game.standings()
        const myIdx = list.indexOf(p)
        const from = clamp(myIdx - 2, 0, Math.max(0, list.length - 5))
        let html = ''
        for (let i = from; i < Math.min(list.length, from + 5); i++) {
          const c = list[i]
          const gap = c === p ? '' : (() => {
            const dd = c.timing.distance - p.timing.distance
            const tgap = dd / Math.max(p.sim.vehicle.speed, 20)
            return (tgap > 0 ? '−' : '+') + Math.abs(tgap).toFixed(1)
          })()
          html += `<div class="r${c === p ? ' me' : ''}"><span>${i + 1}</span><span><i class="sw" style="background:${c.color}"></i>${escapeHtml(c.name)}</span><span class="num">${gap}</span></div>`
        }
        if (st.innerHTML !== html) st.innerHTML = html
      }
      // tyres: three tread zones (display left->right = car left->right), hot pressure, wear
      for (let i = 0; i < 4; i++) {
        const w = v.wheels[i]
        const e = el['ty' + i] as HTMLElement | null
        if (!e) continue
        const cp = w.model.compound
        const t = w.tyre
        const bars = e.children
        for (let k = 0; k < 3; k++) {
          const rib = 2 - k
          const temp = t.ribSurf[rib] * 0.6 + t.ribBulk[rib] * 0.4
          const b = bars[k] as HTMLElement
          b.style.background = tempColor(temp, cp.optTemp, cp.tempWindow)
          b.title = Math.round(temp) + '°C'
        }
        const avg = (t.ribSurf[0] + t.ribSurf[1] + t.ribSurf[2]) / 3
        const lab = el['tyl' + i]
        if (lab) lab.textContent = `${Math.round(avg)}° ${t.pressure.toFixed(2)}`
        const wr = el['tyw' + i] as HTMLElement | null
        if (wr) wr.style.height = `${Math.round(t.wear * 100)}%`
      }
      // g meter
      const gd = el.gdot as SVGCircleElement | null
      if (gd) {
        gd.setAttribute('cx', (46 - clamp(v.accelLat, -2.5, 2.5) * 16).toFixed(1))
        gd.setAttribute('cy', (46 - clamp(v.accelLong, -2.5, 2.5) * 16).toFixed(1))
      }
      // minimap dots
      const mm = el.mapDots as SVGGElement | null
      if (mm) {
        const dots = mm.children
        game.cars.forEach((c, i) => {
          const dot = dots[i] as SVGCircleElement | undefined
          if (!dot) return
          dot.setAttribute('cx', c.sim.vehicle.pos.x.toFixed(1))
          dot.setAttribute('cy', c.sim.vehicle.pos.z.toFixed(1))
        })
      }
      // countdown
      if (game.phase === 'grid' || game.phase === 'countdown') {
        const c = game.countdown
        const lit = c > 3.5 ? 0 : Math.min(5, Math.floor((3.5 - c) / 0.6) + 1)
        const L = el.lights as HTMLElement | null
        if (L) {
          L.style.display = 'flex'
          Array.from(L.children).forEach((ch, i) => ((ch as HTMLElement).className = i < lit ? 'red' : ''))
        }
      } else {
        const L = el.lights as HTMLElement | null
        if (L) L.style.display = 'none'
      }
      // wrong way
      const ww = el.wrong as HTMLElement | null
      if (ww) ww.style.display = t.wrongWay > 1.5 ? '' : 'none'
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [units, maxRpm, limiter, arcLen])

  // HUD toggle via keyboard
  useEffect(
    () =>
      input.on((a) => {
        if (a === 'hud') useSettings.getState().set({ hudVisible: !useSettings.getState().hudVisible })
      }),
    [],
  )

  const tr = game.track
  const mapPath = useMemo(() => {
    let s = ''
    for (let i = 0; i < tr.n; i += 8) s += (i === 0 ? 'M' : 'L') + tr.px[i].toFixed(0) + ' ' + tr.pz[i].toFixed(0)
    return s + 'Z'
  }, [tr])
  const pad = 60
  const vb = `${tr.minX - pad} ${tr.minZ - pad} ${tr.maxX - tr.minX + 2 * pad} ${tr.maxZ - tr.minZ + 2 * pad}`
  const mapScale = Math.max(tr.maxX - tr.minX, tr.maxZ - tr.minZ) / 230

  const ticks = []
  for (let k = 0; k <= maxRpm; k += 500) {
    const major = k % 1000 === 0
    const [x0, y0] = arcPoint(k / maxRpm, TACH_R - (major ? 14 : 8))
    const [x1, y1] = arcPoint(k / maxRpm, TACH_R - 2)
    ticks.push(<line key={'t' + k} x1={x0} y1={y0} x2={x1} y2={y1} stroke={k >= limiter ? '#ff3b4a' : 'rgba(255,255,255,0.75)'} strokeWidth={major ? 2.4 : 1.2} />)
    if (major) {
      const [lx, ly] = arcPoint(k / maxRpm, TACH_R - 30)
      ticks.push(
        <text key={'l' + k} x={lx} y={ly + 4} textAnchor="middle" fontSize="13" fontWeight="600" fill={k >= limiter ? '#ff3b4a' : 'rgba(255,255,255,0.8)'}>
          {k / 1000}
        </text>,
      )
    }
  }
  const race = game.mode === 'race' || game.mode === 'online'

  return (
    <div className="hud" style={{ display: visible ? '' : 'none' }}>
      <div className="hud-box hud-tl">
        <div className="hud-lap">
          <span className="caps">Lap</span>
          <span className="big num" ref={ref('lap')}>
            1
          </span>
          {race && <span className="of num">/{game.totalLaps}</span>}
        </div>
        <div className="hud-time num" ref={ref('time')}>
          0:00.000
        </div>
        <span className="delta num" ref={ref('delta')} style={{ display: 'none' }} />
        <div className="sectors">
          <i ref={ref('sec0')} />
          <i ref={ref('sec1')} />
          <i ref={ref('sec2')} />
        </div>
        <div className="hud-sub">
          <span>Last</span>
          <b className="num" ref={ref('last')}>
            -:--.---
          </b>
          <span>Best</span>
          <b className="num" ref={ref('best')}>
            -:--.---
          </b>
        </div>
      </div>

      {game.cars.length > 1 && (
        <div className="hud-box hud-tr">
          <div className="hud-pos">
            <span className="caps" style={{ marginRight: 6 }}>
              Pos
            </span>
            <span className="p num" ref={ref('pos')}>
              1
            </span>
            <span className="of num" ref={ref('posOf')}>
              /1
            </span>
          </div>
          <div className="standings" ref={ref('standings')} />
        </div>
      )}

      <div className="hud-bottom">
        <svg className="tach" viewBox={`0 0 ${TACH_W} 168`}>
          <path d={arcPath(0, 1)} stroke="rgba(255,255,255,0.1)" strokeWidth="16" fill="none" strokeLinecap="butt" />
          <path d={arcPath(limiter / maxRpm, 1)} stroke="rgba(255,59,74,0.45)" strokeWidth="16" fill="none" />
          <path ref={ref('tachFill')} d={arcPath(0, 1)} stroke="#fff" strokeWidth="16" fill="none" strokeDasharray={`0 ${arcLen}`} style={{ filter: 'drop-shadow(0 0 6px rgba(255,255,255,0.35))' }} />
          {ticks}
        </svg>
        <div className="tach-readout">
          <div className="gear num" ref={ref('gear')}>
            N
          </div>
          <div className="speed num">
            <span ref={ref('speed')}>0</span>
            <small>{units === 'metric' ? 'KM/H' : 'MPH'}</small>
          </div>
        </div>
        <div className="pedals l">
          <div className="pedal">
            <i ref={ref('brk')} style={{ background: '#ff3b4a' }} />
          </div>
        </div>
        <div className="pedals r">
          <div className="pedal">
            <i ref={ref('thr')} style={{ background: '#34d27b' }} />
          </div>
        </div>
        <div className="aids">
          <span ref={ref('tc')}>TC</span>
          <span ref={ref('abs')}>ABS</span>
        </div>
      </div>

      <div className="hud-box hud-bl">
        <svg viewBox={vb} className="track-map" preserveAspectRatio="xMidYMid meet">
          <path d={mapPath} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={mapScale * 9} strokeLinejoin="round" />
          <path d={mapPath} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth={mapScale * 3} strokeLinejoin="round" />
          <rect x={tr.px[0] - mapScale * 2} y={tr.pz[0] - mapScale * 7} width={mapScale * 4} height={mapScale * 14} fill="#e4002b" />
          <g ref={ref('mapDots')}>
            {game.cars.map((c) => (
              <circle key={c.id} r={mapScale * (c.isPlayer ? 7 : 5)} fill={c.isPlayer ? '#e4002b' : c.color} stroke={c.isPlayer ? '#fff' : 'rgba(0,0,0,0.6)'} strokeWidth={mapScale * 1.6} />
            ))}
          </g>
        </svg>
      </div>

      <div className="hud-box hud-br">
        <div className="tyres">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="tyre-cell">
              <div className="tyre-wrap">
                <div className="tyre" ref={ref('ty' + i)}>
                  <i />
                  <i />
                  <i />
                </div>
                <div className="tyre-wear">
                  <i ref={ref('tyw' + i)} />
                </div>
              </div>
              <div className="tyre-label num" ref={ref('tyl' + i)}>
                --
              </div>
            </div>
          ))}
        </div>
        <svg className="gmeter" viewBox="0 0 92 92">
          <circle cx="46" cy="46" r="40" fill="none" stroke="rgba(255,255,255,0.15)" />
          <circle cx="46" cy="46" r="24" fill="none" stroke="rgba(255,255,255,0.1)" />
          <line x1="6" y1="46" x2="86" y2="46" stroke="rgba(255,255,255,0.1)" />
          <line x1="46" y1="6" x2="46" y2="86" stroke="rgba(255,255,255,0.1)" />
          <circle ref={ref('gdot')} cx="46" cy="46" r="5" fill="#ffcc33" />
        </svg>
      </div>

      <div className="center-msg">
        <div className="lights" ref={ref('lights')} style={{ display: 'none' }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} />
          ))}
        </div>
        {center && (
          <>
            {center.lights === -1 && (
              <div className="lights">
                {[0, 1, 2, 3, 4].map((i) => (
                  <i key={i} className="green" />
                ))}
              </div>
            )}
            <div className="big">{center.big}</div>
            {center.sm && <div className="sm">{center.sm}</div>}
          </>
        )}
        <div ref={ref('wrong')} style={{ display: 'none' }}>
          <div className="big" style={{ color: 'var(--bad)', fontSize: 48 }}>
            WRONG WAY
          </div>
        </div>
      </div>
      {toasts.map((t, i) => (
        <div key={t.id} className={'toast ' + t.kind} style={{ top: `calc(17% + ${i * 48}px)` }}>
          {t.text}
        </div>
      ))}
      {showFps && <div className="fps" ref={ref('fps')} />}
    </div>
  )
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
