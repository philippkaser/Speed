import { useEffect } from 'react'
import { audio } from '../../audio/audio'
import { startShowroom } from '../../game/session'
import { getCar, type CarSpec } from '../../physics/spec'
import { useGameStore } from '../../state/gameStore'
import { useSettings } from '../../state/settings'
import { Key } from '../components'

export function carStats(spec: CarSpec) {
  let peak = 0,
    peakRpm = 0,
    maxT = 0
  for (const [rpm, t] of spec.engine.torque) {
    const p = (t * rpm * Math.PI) / 30
    if (p > peak) {
      peak = p
      peakRpm = rpm
    }
    maxT = Math.max(maxT, t)
  }
  const ps = peak / 735.5
  return { ps: Math.round(ps), kw: Math.round(peak / 1000), peakRpm, torque: Math.round(maxT), kg: spec.mass, pw: (spec.mass / ps).toFixed(2), drive: spec.drivetrain }
}

export function TopBar({ crumb }: { crumb?: string }) {
  const name = useSettings((s) => s.playerName)
  const renderer = useGameStore((s) => s.rendererInfo)
  return (
    <div className="topbar">
      <div className="brand">SPEED</div>
      {crumb && (
        <div className="crumbs">
          / <b>{crumb}</b>
        </div>
      )}
      <div className="spacer" />
      <div className="caps" title="Active graphics backend">
        {renderer}
      </div>
      <div className="profile">
        <div className="avatar">{name.slice(0, 1).toUpperCase()}</div>
        <span>{name}</span>
      </div>
    </div>
  )
}

export function BottomBar({ hints }: { hints: [string, string][] }) {
  return (
    <div className="bottombar">
      {hints.map(([k, l]) => (
        <span key={k + l}>
          <Key k={k} />
          {l}
        </span>
      ))}
    </div>
  )
}

export function Title() {
  const setScreen = useGameStore((s) => s.setScreen)
  useEffect(() => {
    const go = () => {
      audio.init().then(() => audio.ui('start'))
      setScreen('home')
    }
    const key = (e: KeyboardEvent) => {
      if (e.repeat) return
      go()
    }
    window.addEventListener('keydown', key, { once: true })
    return () => window.removeEventListener('keydown', key)
  }, [setScreen])
  return (
    <div
      className="title-screen"
      onClick={() => {
        audio.init().then(() => audio.ui('start'))
        setScreen('home')
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div className="logo">SPEED</div>
        <div className="logo-sub">REAL DRIVING · REAL PHYSICS</div>
        <div className="logo-mark" />
      </div>
      <div className="title-press">PRESS ANY KEY</div>
    </div>
  )
}

const MENU: { id: 'team' | 'race' | 'trial' | 'online' | 'garage' | 'settings'; t: string; d: string }[] = [
  { id: 'team', t: 'Team Principal', d: 'Run a two-car team from the pit wall: setups, tyres, fuel and pit calls, live on TV.' },
  { id: 'race', t: 'Race', d: 'Grid start against AI drivers on the Autodromo Valle Alta.' },
  { id: 'trial', t: 'Time Trial', d: 'Hot laps, ghost delta and sector times. Find the limit.' },
  { id: 'online', t: 'Online', d: 'Race friends in real time. Create or join a lobby.' },
  { id: 'garage', t: 'Garage', d: 'Choose your car, paint and fine-tune the setup.' },
  { id: 'settings', t: 'Settings', d: 'Graphics, controls, assists and audio.' },
]

export function Home() {
  const g = useGameStore()
  const spec = getCar(g.career.carId)
  const st = carStats(spec)
  const pick = (id: (typeof MENU)[number]['id']) => {
    audio.init()
    if (id === 'team') {
      g.set({ sessionKind: 'team' })
      g.setScreen('teamHQ')
    } else if (id === 'race') {
      g.set({ sessionKind: 'race' })
      g.setScreen('raceSetup')
    } else if (id === 'trial') {
      g.set({ sessionKind: 'practice' })
      g.setScreen('raceSetup')
    } else if (id === 'online') g.setScreen('lobby')
    else if (id === 'garage') {
      startShowroom()
      g.setScreen('garage')
    } else g.setScreen('settings')
  }
  return (
    <>
      <TopBar crumb="Home" />
      <div className="screen">
        <div className="menu-col">
          {MENU.map((m, i) => (
            <button key={m.id} className="menu-tile" style={{ animationDelay: `${i * 60}ms` }} onClick={() => pick(m.id)} onMouseEnter={() => audio.ui('move')}>
              <span className="idx num">0{i + 1}</span>
              <span>
                <div className="t">{m.t}</div>
                <div className="d">{m.d}</div>
              </span>
              <span className="arrow">→</span>
            </button>
          ))}
        </div>
        <div className="car-card">
          <div className="maker">{spec.manufacturer}</div>
          <div className="name">{spec.name}</div>
          <div className="cat">{spec.category}</div>
          <div className="stats">
            <div className="stat">
              <span className="v num">{st.ps}</span>
              <span className="u">PS</span>
              <div className="l">Power</div>
            </div>
            <div className="stat">
              <span className="v num">{st.kg}</span>
              <span className="u">kg</span>
              <div className="l">Weight</div>
            </div>
            <div className="stat">
              <span className="v num">{st.drive}</span>
              <div className="l">Drive</div>
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
