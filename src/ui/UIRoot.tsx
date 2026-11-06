import { useCallback, useEffect, useState } from 'react'
import { audio } from '../audio/audio'
import { game } from '../game/game'
import { exitReplay, quitToMenu, restartSession, startAttract, watchReplay } from '../game/session'
import { input } from '../input/input'
import { net, useNet } from '../net/client'
import { useGameStore } from '../state/gameStore'
import { useSettings } from '../state/settings'
import { switchToWebGL } from '../render/gpuHealth'
import { Btn, fmtTime } from './components'
import { HUD } from './hud/HUD'
import { cycleReplayCamera, ReplayOverlay } from './hud/Replay'
import { Telemetry } from './hud/Telemetry'
import { Garage } from './screens/Garage'
import { Home, Title } from './screens/Home'
import { Lobby } from './screens/Lobby'
import { RaceSetup } from './screens/RaceSetup'
import { Settings, SettingsPanel } from './screens/Settings'
import { Broadcast } from './team/Broadcast'
import { TeamHQ } from './team/TeamHQ'
import { TeamResults } from './team/TeamResults'

function Boot() {
  const ready = useGameStore((s) => s.sceneReady)
  const screen = useGameStore((s) => s.screen)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    if (ready && screen === 'boot') {
      const t = setTimeout(() => useGameStore.getState().setScreen('title'), 600)
      return () => clearTimeout(t)
    }
  }, [ready, screen])
  useEffect(() => {
    if (ready) {
      const t = setTimeout(() => setGone(true), 1400)
      return () => clearTimeout(t)
    }
  }, [ready])
  if (gone) return null
  return (
    <div className={'boot' + (ready ? ' hidden' : '')}>
      <div className="boot-inner">
        <div className="logo" style={{ fontSize: 64 }}>
          SPEED
        </div>
        <div className="logo-sub">BUILDING THE WORLD</div>
        <div className="boot-bar">
          <i />
        </div>
      </div>
    </div>
  )
}

/** Shown when the renderer reported a fatal GPU error, so a black screen always comes with a way out. */
function GpuNotice() {
  const err = useGameStore((s) => s.gpuError)
  const backend = useGameStore((s) => s.rendererInfo)
  const [hidden, setHidden] = useState(false)
  if (!err || hidden) return null
  return (
    <div className="gpu-notice panel" role="alert">
      <div>
        <b>Graphics error{backend ? ` (${backend})` : ''}</b>
        <span>{err}</span>
      </div>
      <div className="gpu-notice-actions">
        {backend !== 'WebGL2' && (
          <Btn primary onClick={() => switchToWebGL(err)}>
            Switch to WebGL2
          </Btn>
        )}
        <Btn ghost onClick={() => setHidden(true)}>
          Dismiss
        </Btn>
      </div>
    </div>
  )
}

function PauseMenu() {
  const g = useGameStore()
  const [settings, setSettings] = useState(false)
  if (settings)
    return (
      <div className="overlay">
        <SettingsPanel inGame onClose={() => setSettings(false)} />
      </div>
    )
  const online = g.sessionKind === 'online'
  if (game.mode === 'team')
    return (
      <div className="overlay">
        <div className="panel pause-menu">
          <h2>Paused</h2>
          <Btn primary onClick={() => g.set({ paused: false })}>
            Resume
          </Btn>
          <Btn
            onClick={() => {
              g.set({ paused: false })
              restartSession()
            }}
          >
            Restart race
          </Btn>
          <Btn onClick={() => setSettings(true)}>Settings</Btn>
          <Btn
            ghost
            sound="back"
            onClick={() => {
              g.set({ paused: false })
              startAttract()
              g.setScreen('teamHQ')
            }}
          >
            Retire to team HQ
          </Btn>
        </div>
      </div>
    )
  return (
    <div className="overlay">
      <div className="panel pause-menu">
        <h2>Paused</h2>
        <Btn primary onClick={() => g.set({ paused: false })}>
          Resume
        </Btn>
        {!online && (
          <Btn
            onClick={() => {
              g.set({ paused: false })
              restartSession()
            }}
          >
            Restart
          </Btn>
        )}
        <Btn
          onClick={() => {
            game.resetPlayerToTrack()
            g.set({ paused: false })
          }}
        >
          Reset car to track
        </Btn>
        {!online && (game.recorder?.replay.count ?? 0) > 30 && <Btn onClick={() => watchReplay('pause')}>Watch replay</Btn>}
        <Btn onClick={() => g.cycleCamera()}>Camera: {g.camera}</Btn>
        <Btn onClick={() => setSettings(true)}>Settings</Btn>
        <Btn ghost sound="back" onClick={quitToMenu}>
          {online ? 'Leave race' : 'Quit to menu'}
        </Btn>
      </div>
    </div>
  )
}

function Results() {
  const g = useGameStore()
  const netResults = useNet((s) => s.results)
  const online = g.sessionKind === 'online'
  const rows = online && netResults
    ? netResults.map((r, i) => ({ pos: i + 1, name: r.name, time: r.dnf ? 'DNF' : fmtTime(r.time), best: fmtTime(r.bestLap), me: r.id === useNet.getState().myId, color: game.cars.find((c) => c.id === r.id)?.color ?? '#e4002b' }))
    : game.standings().map((c) => ({ pos: c.timing.position, name: c.name, time: c.timing.finished ? fmtTime(c.timing.finishTime) : '+' + Math.max(0, game.totalLaps - c.timing.lap) + ' lap', best: fmtTime(c.timing.best), me: c.isPlayer, color: c.color }))
  const me = rows.find((r) => r.me)
  return (
    <div className="overlay">
      <div className="panel" style={{ width: 'min(680px, 94vw)' }}>
        <div className="panel-head">
          <h2>Results</h2>
          {me && <span className="caps">You finished P{me.pos}</span>}
        </div>
        <div className="panel-body">
          <table className="results-table">
            <thead>
              <tr>
                <th>Pos</th>
                <th>Driver</th>
                <th>Time</th>
                <th>Best lap</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.pos + r.name} className={r.me ? 'me' : ''}>
                  <td className="num">{r.pos}</td>
                  <td>
                    <span className="sw" style={{ display: 'inline-block', width: 4, height: 14, background: r.color, marginRight: 10, borderRadius: 2, verticalAlign: -2 }} />
                    {r.name}
                  </td>
                  <td className="num">{r.time}</td>
                  <td className="num">{r.best}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '0 24px 22px', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          {!online && (game.recorder?.replay.count ?? 0) > 30 && <Btn onClick={() => watchReplay('results')}>Watch replay</Btn>}
          {!online && <Btn onClick={restartSession}>Race again</Btn>}
          {online && (
            <Btn
              onClick={() => {
                startAttract()
                g.setScreen('lobby')
              }}
            >
              Back to lobby
            </Btn>
          )}
          <Btn primary onClick={quitToMenu}>
            Menu
          </Btn>
        </div>
      </div>
    </div>
  )
}

function Driving() {
  const paused = useGameStore((s) => s.paused)
  const replaying = useGameStore((s) => s.replaying)
  const [finished, setFinished] = useState(false)
  const netResults = useNet((s) => s.results)
  useEffect(() => {
    setFinished(false)
    return game.on((e) => {
      if (e.type === 'finish' && e.car === 'player') setTimeout(() => setFinished(true), 2500)
      if (e.type === 'session') setFinished(false)
    })
  }, [])
  const showResults = finished || (useGameStore.getState().sessionKind === 'online' && !!netResults)
  const onTeamComplete = useCallback(() => setFinished(true), [])
  if (replaying) return <ReplayOverlay />
  if (game.mode === 'team')
    return (
      <>
        <Broadcast onComplete={onTeamComplete} />
        {paused && !finished && <PauseMenu />}
        {finished && <TeamResults />}
      </>
    )
  return (
    <>
      <HUD />
      <Telemetry />
      {paused && !showResults && <PauseMenu />}
      {showResults && <Results />}
    </>
  )
}

export function UIRoot() {
  const screen = useGameStore((s) => s.screen)
  const room = useNet((s) => s.room)

  // global keys: pause / back / camera / reset
  useEffect(
    () =>
      input.on((a) => {
        const g = useGameStore.getState()
        if (g.replaying) {
          if (a === 'pause') exitReplay()
          if (a === 'camera') cycleReplayCamera()
          return
        }
        if (a === 'pause') {
          if (g.screen === 'driving') {
            g.set({ paused: !g.paused })
            audio.ui(g.paused ? 'back' : 'select')
          } else if (g.screen !== 'home' && g.screen !== 'title' && g.screen !== 'boot') {
            if (g.screen === 'garage' || g.screen === 'lobby' || g.screen === 'teamHQ') startAttract()
            g.setScreen('home')
            audio.ui('back')
          }
        }
        if (g.screen !== 'driving' || g.paused) return
        if (a === 'camera') g.cycleCamera()
        if (a === 'reset') game.resetPlayerToTrack()
        if (a === 'biasFwd' || a === 'biasRear') {
          const p = game.player
          if (p) {
            const v = p.sim.vehicle
            const bias = Math.min(0.75, Math.max(0.45, v.setup.brakeBias + (a === 'biasFwd' ? 0.005 : -0.005)))
            v.applySetup({ ...v.setup, brakeBias: bias })
            game.emit({ type: 'notice', text: `Brake balance ${(bias * 100).toFixed(1)}% F` })
          }
        }
        if (a === 'tcCycle') {
          const s = useSettings.getState()
          const tc = (s.assists.tc + 1) % 6
          s.setAssists({ tc })
          game.emit({ type: 'notice', text: tc === 0 ? 'Traction control off' : `Traction control ${tc}` })
        }
        if (a === 'racingLine') {
          const s = useSettings.getState()
          s.set({ racingLine: s.racingLine === 'off' ? 'braking' : s.racingLine === 'braking' ? 'full' : 'off' })
        }
      }),
    [],
  )

  // the replay flag follows the game (a new session ends a replay)
  useEffect(() => game.on((e) => e.type === 'replay' && useGameStore.getState().replaying !== e.on && useGameStore.getState().set({ replaying: e.on })), [])

  // online: the server's countdown starts the race for everybody in the room
  useEffect(() => {
    if (!room) return
    if (room.phase === 'countdown' && (game.mode !== 'online' || game.onlineStartAt !== room.startAt)) {
      const g = useGameStore.getState()
      g.set({ sessionHour: room.timeOfDay, sessionKind: 'online', paused: false })
      useNet.setState({ results: null })
      game.startOnline(room, net.myId, g.career.setups[g.career.carId])
      g.setScreen('driving')
    }
    // players leaving mid race
    if (game.mode === 'online') {
      for (const c of [...game.cars]) if (c.isRemote && !room.players.some((p) => p.id === c.id)) game.removeRemote(c.id)
    }
  }, [room])

  return (
    <div className="ui-root">
      {screen === 'title' && <Title />}
      {screen === 'home' && <Home />}
      {screen === 'garage' && <Garage />}
      {screen === 'raceSetup' && <RaceSetup />}
      {screen === 'settings' && <Settings />}
      {screen === 'lobby' && <Lobby />}
      {screen === 'driving' && <Driving />}
      {screen === 'teamHQ' && <TeamHQ />}
      <Boot />
      <GpuNotice />
    </div>
  )
}
