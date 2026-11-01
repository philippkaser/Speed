import { useState } from 'react'
import { startAttract } from '../../game/session'
import { net, useNet } from '../../net/client'
import { getCar } from '../../physics/spec'
import { useGameStore } from '../../state/gameStore'
import { useSettings } from '../../state/settings'
import { Btn, FieldRow, Slider } from '../components'
import { BottomBar, TopBar } from './Home'

export function Lobby() {
  const g = useGameStore()
  const n = useNet()
  const name = useSettings((s) => s.playerName)
  const setName = useSettings((s) => s.set)
  const [code, setCode] = useState('')
  const [chat, setChat] = useState('')
  const carId = g.career.carId
  const color = g.career.colors[carId]
  const room = n.room
  const me = room?.players.find((p) => p.id === n.myId)
  const isHost = room?.hostId === n.myId

  const connect = async () => {
    try {
      await net.connect({ name, carId, color })
    } catch {
      /* status shown */
    }
  }

  return (
    <>
      <TopBar crumb="Online" />
      <div className="screen" style={{ justifyContent: 'center', gap: 24 }}>
        {!room ? (
          <div className="panel" style={{ width: 'min(560px, 92vw)', alignSelf: 'center' }}>
            <div className="panel-head">
              <h2>Online racing</h2>
              <span className="caps">{n.status === 'online' ? `connected · ${n.ping} ms` : n.status}</span>
            </div>
            <div className="panel-body">
              <FieldRow label="Driver name">
                <input className="text-input" value={name} maxLength={20} onChange={(e) => setName({ playerName: e.target.value || 'Driver' })} />
              </FieldRow>
              <FieldRow label="Car" sub={getCar(carId).category}>
                <span style={{ fontWeight: 600 }}>{getCar(carId).name}</span>
              </FieldRow>
              {n.status !== 'online' ? (
                <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
                  {n.error && <span className="error" style={{ marginRight: 'auto' }}>{n.error}</span>}
                  <Btn primary onClick={connect} disabled={n.status === 'connecting'}>
                    {n.status === 'connecting' ? 'Connecting…' : 'Connect'}
                  </Btn>
                </div>
              ) : (
                <>
                  <div className="section-title" style={{ marginTop: 18 }}>
                    Play
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
                    <Btn primary onClick={() => net.quick()}>
                      Quick match
                    </Btn>
                    <Btn onClick={() => net.createRoom(g.raceLaps, g.timeOfDay)}>Create lobby</Btn>
                  </div>
                  <div className="section-title" style={{ marginTop: 22 }}>
                    Join with code
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <input className="text-input" style={{ fontFamily: 'var(--mono)', letterSpacing: '0.2em', width: 180, textTransform: 'uppercase' }} placeholder="CODE" maxLength={5} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && net.join(code)} />
                    <Btn onClick={() => net.join(code)} disabled={code.length < 5}>
                      Join
                    </Btn>
                  </div>
                  {n.error && (
                    <div className="error" style={{ marginTop: 12 }}>
                      {n.error}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="panel" style={{ flex: 1, maxWidth: 820, display: 'flex', flexDirection: 'column' }}>
              <div className="panel-head">
                <h2>Lobby</h2>
                <span className="code num">{room.code}</span>
                <span className="spacer" />
                <span className="caps">
                  {room.players.length} / 12 · {room.laps} laps · {n.ping} ms
                </span>
              </div>
              <div className="panel-body" style={{ flex: 1 }}>
                {room.players.map((p, i) => (
                  <div className="player-row" key={p.id}>
                    <span className="num" style={{ color: 'var(--dim)' }}>
                      {i + 1}
                    </span>
                    <span style={{ fontWeight: p.id === n.myId ? 700 : 500 }}>
                      <span className="swatch" style={{ width: 12, height: 12, display: 'inline-block', marginRight: 10, background: p.color, verticalAlign: -1 }} />
                      {p.name}
                      {p.id === room.hostId && (
                        <span className="chip host" style={{ marginLeft: 10 }}>
                          host
                        </span>
                      )}
                    </span>
                    <span style={{ color: 'var(--muted)', fontSize: 13 }}>{getCar(p.carId).name}</span>
                    <span className={'chip' + (p.ready ? ' ok' : '')}>{p.ready ? 'ready' : 'waiting'}</span>
                    <span className="num" style={{ color: 'var(--dim)', fontSize: 12, textAlign: 'right' }}>
                      {p.ping} ms
                    </span>
                  </div>
                ))}
                {n.chat.length > 0 && (
                  <div style={{ marginTop: 16, fontSize: 13, color: 'var(--muted)', maxHeight: 140, overflow: 'auto' }}>
                    {n.chat.map((c, i) => (
                      <div key={i}>
                        <b style={{ color: 'var(--text)' }}>{c.name}</b> {c.text}
                      </div>
                    ))}
                  </div>
                )}
                <div className="row" style={{ marginTop: 12 }}>
                  <input
                    className="text-input"
                    style={{ flex: 1 }}
                    placeholder="Message"
                    value={chat}
                    onChange={(e) => setChat(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && chat.trim()) {
                        net.chat(chat.trim())
                        setChat('')
                      }
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="panel" style={{ width: 340, alignSelf: 'flex-start' }}>
              <div className="panel-head">
                <h2>Race</h2>
              </div>
              <div className="panel-body">
                {isHost ? (
                  <>
                    <Slider label="Laps" value={room.laps} min={1} max={20} step={1} onChange={(v) => net.configure(v, room.timeOfDay)} />
                    <Slider
                      label="Time of day"
                      value={room.timeOfDay}
                      min={6.5}
                      max={20.2}
                      step={0.1}
                      format={(h) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`}
                      onChange={(v) => net.configure(room.laps, v)}
                    />
                  </>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6 }}>Waiting for the host to start the race. Share the code {room.code} with friends.</div>
                )}
                <div className="row" style={{ marginTop: 18, flexWrap: 'wrap' }}>
                  <Btn
                    onClick={() => {
                      net.updateCar(carId, color, name)
                      net.setReady(!me?.ready)
                    }}
                  >
                    {me?.ready ? 'Not ready' : 'Ready'}
                  </Btn>
                  {isHost && (
                    <Btn primary sound="start" onClick={() => net.start()} disabled={room.players.some((p) => !p.ready && p.id !== n.myId)}>
                      Start race
                    </Btn>
                  )}
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <Btn ghost sound="back" onClick={() => net.leave()}>
                    Leave lobby
                  </Btn>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      <BottomBar hints={[['Esc', 'Back']]} />
      {!room && (
        <div style={{ position: 'absolute', right: 36, bottom: 70 }}>
          <Btn
            sound="back"
            onClick={() => {
              startAttract()
              g.setScreen('home')
            }}
          >
            Back
          </Btn>
        </div>
      )}
    </>
  )
}
