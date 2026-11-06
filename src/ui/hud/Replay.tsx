// Replay viewer: a broadcast-style overlay (timing tower, lower third of the car on camera, the
// shot) and the transport (play / pause, 0.25x - 4x, scrub, jump, camera, car to follow).
// The replay itself is src/game/replay.ts; its cameras are in CameraRig / broadcastCam.
import { useEffect, useRef, useState } from 'react'
import { game } from '../../game/game'
import { exitReplay } from '../../game/session'
import type { ReplayCamMode } from '../../game/replay'
import { director, SHOT_LABEL } from '../../render/broadcastCam'
import { useSettings } from '../../state/settings'
import { fmtTime } from '../components'

const SPEEDS = [0.25, 0.5, 1, 2, 4]
const CAMS: { id: ReplayCamMode; label: string }[] = [
  { id: 'tv', label: 'TV' },
  { id: 'chase', label: 'Chase' },
  { id: 'onboard', label: 'Onboard' },
]

function clock(t: number) {
  const s = Math.max(0, t)
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}

export function ReplayOverlay() {
  const [, force] = useState(0)
  const scrub = useRef<HTMLInputElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  const dragging = useRef(false)
  const units = useSettings((s) => s.units)

  // graphics at 10 Hz, the scrubber and clock every frame
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 100)
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const rp = game.replay
      if (!rp) return
      if (scrub.current && !dragging.current) scrub.current.value = String(rp.t - rp.start)
      if (time.current) time.current.textContent = `${clock(rp.t - rp.start)} / ${clock(rp.end - rp.start)}`
    }
    raf = requestAnimationFrame(loop)
    return () => {
      clearInterval(id)
      cancelAnimationFrame(raf)
    }
  }, [])

  // keys: space / K play-pause, arrows seek and speed, C camera, [ ] car, Home restart (Esc: UIRoot)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const rp = game.replay
      if (!rp) return
      const k = e.code
      if (k === 'Space' || k === 'KeyK') {
        // at the end, play starts over
        if (rp.t >= rp.end) {
          rp.seek(rp.start)
          rp.playing = true
        } else rp.playing = !rp.playing
      } else if (k === 'ArrowLeft') rp.seek(rp.t - 5)
      else if (k === 'ArrowRight') rp.seek(rp.t + 5)
      else if (k === 'ArrowUp') rp.speed = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(rp.speed) + 1)] ?? 1
      else if (k === 'ArrowDown') rp.speed = SPEEDS[Math.max(0, SPEEDS.indexOf(rp.speed) - 1)] ?? 1
      else if (k === 'BracketRight' || k === 'BracketLeft') step(k === 'BracketRight' ? 1 : -1)
      else if (k === 'Home') rp.seek(rp.start)
      else return
      e.preventDefault()
      force((x) => x + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const rp = game.replay
  if (!rp) return null
  const standings = rp.standings()
  const race = rp.replay.header.mode !== 'practice'
  const laps = rp.replay.header.laps
  const lead = standings[0]
  const onAirId = rp.cam === 'tv' ? director.target : rp.focus
  const onAir = rp.views.find((v) => v.id === onAirId) ?? lead
  const kmh = (v: number) => Math.round(units === 'metric' ? v * 3.6 : v * 2.23694)
  const follow = (id: string) => {
    if (rp.cam === 'tv') rp.tvFocus = rp.tvFocus === id ? '' : id
    else rp.focus = id
    force((x) => x + 1)
  }

  return (
    <div className="replay">
      <div className="rp-top">
        <span className="rp-tag">REPLAY</span>
        {race && lead && (
          <span className="rp-lap num">
            LAP {Math.min(lead.lap + 1, laps)}/{laps}
          </span>
        )}
        <span className="rp-clock num">{race && rp.replay.goAt >= 0 ? (rp.raceTime < 0 ? 'GRID' : clock(rp.raceTime)) : fmtTime(onAir?.lapTime ?? 0)}</span>
      </div>

      {standings.length > 1 && (
        <div className="rp-tower">
          {standings.map((v) => {
            const gap = v === lead ? (race ? 'Leader' : '') : '+' + (Math.max(0, lead.distance - v.distance) / Math.max(v.speed, 15)).toFixed(1)
            const c = game.cars.find((e) => e.id === v.id)
            return (
              <div key={v.id} className={'rp-row' + (v.id === onAirId ? ' on' : '') + (v.isPlayer ? ' me' : '') + ((rp.cam === 'tv' ? rp.tvFocus : rp.focus) === v.id ? ' follow' : '')} onClick={() => follow(v.id)} title="Follow this car">
                <b className="num">{v.position}</b>
                <i style={{ background: c?.color ?? '#fff' }} />
                <span>{v.name}</span>
                <em className="num">{v.finished ? 'FIN' : gap}</em>
              </div>
            )
          })}
        </div>
      )}

      {onAir && (
        <div className="rp-third">
          {race && <b className="num">P{onAir.position}</b>}
          <i style={{ background: game.cars.find((e) => e.id === onAir.id)?.color ?? '#fff' }} />
          <span className="rp-name">{onAir.name}</span>
          <span className="rp-tele num">
            {kmh(onAir.speed)} <small>{units === 'metric' ? 'km/h' : 'mph'}</small> · {onAir.gear === 0 ? 'N' : onAir.gear < 0 ? 'R' : onAir.gear}
          </span>
          {rp.cam === 'tv' && <span className="rp-shot caps">{SHOT_LABEL[director.shot]}</span>}
        </div>
      )}

      <div className="rp-bar">
        <button className="rp-btn" onClick={() => (rp.seek(rp.t - 5), force((x) => x + 1))} title="Back 5 s (←)">
          −5s
        </button>
        <button
          className="rp-btn play"
          onClick={() => {
            if (rp.t >= rp.end) {
              rp.seek(rp.start)
              rp.playing = true
            } else rp.playing = !rp.playing
            force((x) => x + 1)
          }}
          title="Play / pause (Space)"
        >
          {rp.playing ? '❚❚' : '▶'}
        </button>
        <button className="rp-btn" onClick={() => (rp.seek(rp.t + 5), force((x) => x + 1))} title="Forward 5 s (→)">
          +5s
        </button>
        <input
          ref={scrub}
          className="rp-scrub"
          type="range"
          min={0}
          max={Math.max(0.1, rp.end - rp.start)}
          step={0.01}
          defaultValue={rp.t - rp.start}
          onPointerDown={() => (dragging.current = true)}
          onPointerUp={() => (dragging.current = false)}
          onChange={(e) => rp.seek(rp.start + Number(e.target.value))}
          aria-label="Replay position"
        />
        <span className="rp-time num" ref={time} />
        <div className="rp-seg">
          {SPEEDS.map((s) => (
            <button key={s} className={rp.speed === s ? 'on' : ''} onClick={() => ((rp.speed = s), force((x) => x + 1))}>
              {s}×
            </button>
          ))}
        </div>
        <div className="rp-seg">
          {CAMS.map((c) => (
            <button key={c.id} className={rp.cam === c.id ? 'on' : ''} onClick={() => ((rp.cam = c.id), force((x) => x + 1))} title="Camera (C)">
              {c.label}
            </button>
          ))}
        </div>
        <button className="rp-btn exit" onClick={exitReplay} title="Exit replay (Esc)">
          Exit
        </button>
      </div>
    </div>
  )

  function step(dir: number) {
    const r = game.replay
    if (!r) return
    const list = r.standings()
    const cur = r.cam === 'tv' ? r.tvFocus || director.target : r.focus
    const i = Math.max(0, list.findIndex((v) => v.id === cur))
    const next = list[(i + dir + list.length) % list.length]
    if (!next) return
    if (r.cam === 'tv') r.tvFocus = next.id
    else r.focus = next.id
  }
}

/** Cycle the replay camera (the game's camera key). */
export function cycleReplayCamera() {
  const rp = game.replay
  if (!rp) return
  rp.cam = CAMS[(CAMS.findIndex((c) => c.id === rp.cam) + 1) % CAMS.length].id
}
