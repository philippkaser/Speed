import { useEffect, useRef, useState } from 'react'
import { ffb } from '../../input/ffb'
import { useGameStore } from '../../state/gameStore'
import { type QualityPreset, useSettings } from '../../state/settings'
import { Btn, FieldRow, Segmented, Slider, Toggle } from '../components'
import { BottomBar, TopBar } from './Home'
import { gltfCarCredits } from '../../car/gltfCars'
import { worldCredits } from '../../render/worldAssets'

type Tab = 'graphics' | 'controls' | 'assists' | 'audio' | 'game'

export function SettingsPanel({ onClose, inGame = false }: { onClose: () => void; inGame?: boolean }) {
  const s = useSettings()
  const [tab, setTab] = useState<Tab>(inGame ? 'assists' : 'graphics')
  const gfx = s.graphics
  return (
    <div className="panel" style={{ width: 'min(760px, 92vw)', maxHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="tabs">
        {(
          [
            ['graphics', 'Graphics'],
            ['assists', 'Assists'],
            ['controls', 'Controls'],
            ['audio', 'Audio'],
            ['game', 'Gameplay'],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="panel-body" style={{ flex: 1 }}>
        {tab === 'graphics' && (
          <>
            <FieldRow label="Quality preset" sub="Ultra enables everything at full resolution">
              <Segmented<QualityPreset>
                options={[
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
                  { value: 'ultra', label: 'Ultra' },
                ]}
                value={gfx.preset}
                onChange={(v) => s.applyPreset(v)}
              />
            </FieldRow>
            <RendererRow />
            <Slider label="Resolution scale" value={gfx.resolutionScale} min={0.5} max={1} step={0.05} unit="%" format={(v) => Math.round(v * 100) + ''} onChange={(v) => s.setGraphics({ resolutionScale: v })} />
            <div className="section-title">Lighting</div>
            <FieldRow label="Sky" sub="Photographic: a real sky (HDRI) with its own sun, mid-afternoon. Dynamic: procedural sky that follows the time of day">
              <Segmented
                options={[
                  { value: 'photo', label: 'Photographic' },
                  { value: 'dynamic', label: 'Dynamic' },
                ]}
                value={gfx.sky ?? 'photo'}
                onChange={(v) => s.setGraphics({ sky: v as 'photo' | 'dynamic' })}
              />
            </FieldRow>
            <Toggle label="Global illumination (SSGI)" sub="Screen-space indirect light bounce and occlusion · WebGPU" value={gfx.ssgi} onChange={(v) => s.setGraphics({ ssgi: v })} />
            <Toggle label="Ambient occlusion" sub="Used when SSGI is off" value={gfx.ao} onChange={(v) => s.setGraphics({ ao: v })} />
            <FieldRow label="Car reflections" sub="Cubemaps rendered around the cars: the car in focus sharpest, the next most visible ones their own, the rest share. Medium 256 px · High 512 px · Ultra 1024 px">
              <Segmented
                options={[
                  { value: 0, label: 'Sky only' },
                  { value: 1, label: 'Medium' },
                  { value: 2, label: 'High' },
                  { value: 3, label: 'Ultra' },
                ]}
                value={gfx.reflections ?? 2}
                onChange={(v) => s.setGraphics({ reflections: v as 0 | 1 | 2 | 3 })}
              />
            </FieldRow>
            <Toggle label="Screen-space reflections" sub="Extra on-screen detail on top of the cubemaps (costly, can flicker at the screen edges)" value={gfx.ssr} onChange={(v) => s.setGraphics({ ssr: v })} />
            <FieldRow label="Shadows">
              <Segmented
                options={[
                  { value: 0, label: 'Off' },
                  { value: 1, label: 'Low' },
                  { value: 2, label: 'High' },
                  { value: 3, label: 'Ultra' },
                ]}
                value={gfx.shadows}
                onChange={(v) => s.setGraphics({ shadows: v as 0 | 1 | 2 | 3 })}
              />
            </FieldRow>
            <div className="section-title">Image</div>
            <Toggle label="Auto exposure" sub="The camera meters the scene: opens up in the cockpit, shade and pit garage, stops down into the sun" value={gfx.autoExposure ?? false} onChange={(v) => s.setGraphics({ autoExposure: v })} />
            <Slider label="Exposure compensation" sub="Brighter or darker than the camera's metering, in stops" value={gfx.exposureComp ?? 0} min={-1.5} max={1.5} step={0.1} unit=" EV" format={(v) => (v > 0.04 ? '+' : '') + v.toFixed(1)} onChange={(v) => s.setGraphics({ exposureComp: v })} />
            <Toggle label="Bloom" value={gfx.bloom} onChange={(v) => s.setGraphics({ bloom: v })} />
            <Slider label="Motion blur (shutter)" sub="How much of each frame the shutter is open. 360° = motion is continuous from frame to frame (smooth pans, no double images); 180° = the film look. 0 = off" value={gfx.motionBlur} min={0} max={1} step={1 / 24} unit="°" format={(v) => Math.round(v * 360) + ''} onChange={(v) => s.setGraphics({ motionBlur: v })} />
            <Slider label="Vegetation density" sub="Trees and the 3D grass on the verges (grass from 0.5)" value={gfx.trees} min={0.2} max={1.6} step={0.1} format={(v) => v.toFixed(1)} unit="×" onChange={(v) => s.setGraphics({ trees: v })} />
            <div className="section-title">Camera</div>
            <Slider label="Field of view" value={gfx.fov} min={45} max={80} step={1} unit="°" onChange={(v) => s.setGraphics({ fov: v })} />
            <Slider label="Camera shake" value={gfx.cameraShake} min={0} max={1} step={0.05} unit="%" format={(v) => Math.round(v * 100) + ''} onChange={(v) => s.setGraphics({ cameraShake: v })} />
            <Toggle label="Show frame rate" value={gfx.showFps} onChange={(v) => s.setGraphics({ showFps: v })} />
          </>
        )}
        {tab === 'assists' && (
          <>
            <Toggle label="ABS" sub="Anti-lock braking (per-wheel slip control)" value={s.assists.abs} onChange={(v) => s.setAssists({ abs: v })} />
            <Slider label="Traction control" sub="0 = off · 5 = maximum intervention" value={s.assists.tc} min={0} max={5} step={1} onChange={(v) => s.setAssists({ tc: v })} />
            <Slider label="Steering assist" sub="Countersteer & slip-angle guidance for pads/keyboard. 0 for wheels." value={s.assists.steering} min={0} max={1} step={0.05} unit="%" format={(v) => Math.round(v * 100) + ''} onChange={(v) => s.setAssists({ steering: v })} />
            <Toggle label="Automatic gearbox" value={s.assists.autoGear} onChange={(v) => s.setAssists({ autoGear: v })} />
            <FieldRow label="Driving line">
              <Segmented
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'braking', label: 'Braking zones' },
                  { value: 'full', label: 'Full' },
                ]}
                value={s.racingLine}
                onChange={(v) => s.set({ racingLine: v })}
              />
            </FieldRow>
          </>
        )}
        {tab === 'controls' && <Controls />}
        {tab === 'audio' && (
          <>
            <Slider label="Master" value={s.audio.master} min={0} max={1} step={0.05} format={(v) => Math.round(v * 100) + ''} unit="%" onChange={(v) => s.setAudio({ master: v })} />
            <Slider label="Engine" value={s.audio.engine} min={0} max={1.5} step={0.05} format={(v) => Math.round(v * 100) + ''} unit="%" onChange={(v) => s.setAudio({ engine: v })} />
            <Slider label="Effects" value={s.audio.effects} min={0} max={1.5} step={0.05} format={(v) => Math.round(v * 100) + ''} unit="%" onChange={(v) => s.setAudio({ effects: v })} />
          </>
        )}
        {tab === 'game' && (
          <>
            <FieldRow label="Driver name">
              <input className="text-input" value={s.playerName} maxLength={20} onChange={(e) => s.set({ playerName: e.target.value || 'Driver' })} />
            </FieldRow>
            <FieldRow label="Units">
              <Segmented
                options={[
                  { value: 'metric', label: 'km/h' },
                  { value: 'imperial', label: 'mph' },
                ]}
                value={s.units}
                onChange={(v) => s.set({ units: v })}
              />
            </FieldRow>
            <Toggle label="Show HUD" value={s.hudVisible} onChange={(v) => s.set({ hudVisible: v })} />
            <Credits />
          </>
        )}
      </div>
      <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end' }}>
        <Btn sound="back" onClick={onClose}>
          Done
        </Btn>
      </div>
    </div>
  )
}

function Controls() {
  const s = useSettings()
  const c = s.controls
  const [binding, setBinding] = useState<null | 'steerAxis' | 'throttleAxis' | 'brakeAxis' | 'clutchAxis'>(null)
  const [pads, setPads] = useState<string[]>([])
  const base = useRef<number[] | null>(null)
  useEffect(() => {
    const id = setInterval(() => {
      const list = (navigator.getGamepads?.() ?? []).filter(Boolean) as Gamepad[]
      setPads(list.map((p) => p.id))
      if (!binding || !list.length) return
      const p = list[0]
      if (!base.current) base.current = [...p.axes]
      let best = -1,
        bestD = 0.35
      p.axes.forEach((a, i) => {
        const d = Math.abs(a - (base.current![i] ?? 0))
        if (d > bestD) {
          bestD = d
          best = i
        }
      })
      if (best >= 0) {
        s.setControls({ [binding]: best })
        setBinding(null)
        base.current = null
      }
    }, 50)
    return () => clearInterval(id)
  }, [binding, s])
  return (
    <>
      <div className="section-title">Keyboard & gamepad</div>
      <Slider label="Steering speed" value={c.steeringSensitivity} min={0.4} max={2} step={0.05} format={(v) => v.toFixed(2)} unit="×" onChange={(v) => s.setControls({ steeringSensitivity: v })} />
      <Slider label="Stick linearity" sub="Higher = finer control near centre" value={c.steeringLinearity} min={1} max={2.5} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => s.setControls({ steeringLinearity: v })} />
      <Slider label="Deadzone" value={c.deadzone} min={0} max={0.25} step={0.01} format={(v) => Math.round(v * 100) + ''} unit="%" onChange={(v) => s.setControls({ deadzone: v })} />
      <Toggle label="Vibration" value={c.vibration} onChange={(v) => s.setControls({ vibration: v })} />
      <div className="section-title">Steering wheel</div>
      <div style={{ color: 'var(--muted)', fontSize: 13, margin: '6px 0 4px' }}>{pads.length ? 'Detected: ' + pads.join(' · ') : 'No controller detected — press a button on your wheel or pad.'}</div>
      {(
        [
          ['steerAxis', 'Steering axis'],
          ['throttleAxis', 'Throttle axis'],
          ['brakeAxis', 'Brake axis'],
          ['clutchAxis', 'Clutch axis'],
        ] as const
      ).map(([k, l]) => (
        <FieldRow key={k} label={l} sub={binding === k ? 'Move the control now…' : c[k] >= 0 ? `Axis ${c[k]}` : 'Not bound (uses triggers)'}>
          <Btn onClick={() => setBinding(binding === k ? null : k)}>{binding === k ? 'Cancel' : 'Bind'}</Btn>
        </FieldRow>
      ))}
      <Toggle label="Invert pedals" value={c.invertPedals} onChange={(v) => s.setControls({ invertPedals: v })} />
      <div className="section-title">Force feedback</div>
      <FfbRow />
      <Slider label="Force feedback gain" sub="Steering-rack torque from tyre aligning moments + road texture" value={c.ffbGain} min={0} max={1.5} step={0.05} unit="%" format={(v) => Math.round(v * 100) + ''} onChange={(v) => s.setControls({ ffbGain: v })} />
      <Toggle label="Invert force direction" value={c.ffbInvert} onChange={(v) => s.setControls({ ffbInvert: v })} />
      <Slider label="Wheel rotation" value={c.wheelRange} min={180} max={1080} step={10} unit="°" onChange={(v) => s.setControls({ wheelRange: v })} />
      <div className="section-title">Keys</div>
      <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.9 }}>
        W/S or ↑/↓ throttle & brake · A/D or ←/→ steer · Space handbrake · E/Shift shift up · Q/Ctrl shift down · C camera · B look back · Z/X look left/right · R reset to track · [ ] brake balance · T traction control · L driving line · H toggle HUD · Esc pause
      </div>
    </>
  )
}

function FfbRow() {
  const range = useSettings((s) => s.controls.wheelRange)
  const [, force] = useState(0)
  const label = ffb.status === 'on' ? `Connected · ${ffb.message}` : ffb.status === 'error' ? `Error · ${ffb.message}` : ffb.status === 'unsupported' ? ffb.message : 'Logitech G29 / G923 (PS) / G27 / G25 / DFGT over WebHID — experimental'
  return (
    <FieldRow label="Wheel force feedback" sub={label}>
      {ffb.status === 'on' ? (
        <Btn
          onClick={async () => {
            await ffb.disconnect()
            force((x) => x + 1)
          }}
        >
          Disconnect
        </Btn>
      ) : (
        <Btn
          onClick={async () => {
            await ffb.connect(range)
            force((x) => x + 1)
          }}
        >
          Connect wheel
        </Btn>
      )}
    </FieldRow>
  )
}

export function Settings() {
  const g = useGameStore()
  return (
    <>
      <TopBar crumb="Settings" />
      <div className="screen" style={{ justifyContent: 'center' }}>
        <SettingsPanel onClose={() => g.setScreen('home')} />
      </div>
      <BottomBar hints={[['Esc', 'Back']]} />
    </>
  )
}

function RendererRow() {
  const s = useSettings()
  const active = useGameStore((g) => g.rendererInfo)
  const pref = s.graphics.backend ?? 'auto'
  const note = s.graphics.backendNote
  const sub = (active ? `Running on ${active}. ` : '') + (note && pref === 'webgl' ? `Switched after: ${note}` : 'WebGPU unlocks SSGI. Changing this reloads the game.')
  return (
    <FieldRow label="Renderer" sub={sub}>
      <Segmented<'auto' | 'webgl'>
        options={[
          { value: 'auto', label: 'WebGPU' },
          { value: 'webgl', label: 'WebGL2' },
        ]}
        value={pref}
        onChange={(v) => {
          if (v === pref) return
          s.setGraphics({ backend: v, backendNote: '' })
          setTimeout(() => location.reload(), 60)
        }}
      />
    </FieldRow>
  )
}

function Credits() {
  const credits = [...gltfCarCredits(), ...worldCredits()]
  if (!credits.length) return null
  return (
    <>
      <div className="section-title">Credits</div>
      {credits.map((c) => (
        <div key={c.title} style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 6 }}>
          “{c.title}” by {c.author.replace(/\s*\(.*\)/, '')} · {c.license.replace(/\s*\(.*\)/, '')} ·{' '}
          <a href={c.source} target="_blank" rel="noreferrer" style={{ color: 'var(--muted)' }}>
            source
          </a>
        </div>
      ))}
    </>
  )
}
