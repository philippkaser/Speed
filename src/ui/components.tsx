import type { ReactNode } from 'react'
import { audio } from '../audio/audio'

export function fmtTime(t: number, signed = false) {
  if (!Number.isFinite(t) || t <= 0) return signed ? '±0.000' : '-:--.---'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

export function fmtDelta(d: number) {
  const s = d >= 0 ? '+' : '−'
  return `${s}${Math.abs(d).toFixed(3)}`
}

export function Slider(props: { label: string; sub?: string; value: number; min: number; max: number; step: number; unit?: string; format?: (v: number) => string; onChange: (v: number) => void }) {
  const { value, min, max, step } = props
  const p = ((value - min) / (max - min)) * 100
  return (
    <div className="field">
      <div>
        <div className="lab">{props.label}</div>
        {props.sub && <div className="sub">{props.sub}</div>}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ['--p' as string]: `${p}%` }}
        onChange={(e) => {
          props.onChange(Number(e.target.value))
          audio.ui('move')
        }}
      />
      <div className="val num">
        {props.format ? props.format(value) : value}
        {props.unit && <small>{props.unit}</small>}
      </div>
    </div>
  )
}

export function Toggle(props: { label: string; sub?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="field">
      <div>
        <div className="lab">{props.label}</div>
        {props.sub && <div className="sub">{props.sub}</div>}
      </div>
      <div />
      <button
        className={'toggle' + (props.value ? ' on' : '')}
        onClick={() => {
          props.onChange(!props.value)
          audio.ui('select')
        }}
        aria-pressed={props.value}
        aria-label={props.label}
      />
    </div>
  )
}

export function Segmented<T extends string | number>(props: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          className={o.value === props.value ? 'on' : ''}
          onClick={() => {
            props.onChange(o.value)
            audio.ui('select')
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function FieldRow(props: { label: string; sub?: string; children: ReactNode }) {
  return (
    <div className="field" style={{ gridTemplateColumns: '1fr auto' }}>
      <div>
        <div className="lab">{props.label}</div>
        {props.sub && <div className="sub">{props.sub}</div>}
      </div>
      <div>{props.children}</div>
    </div>
  )
}

export function Btn(props: { children: ReactNode; onClick?: () => void; primary?: boolean; ghost?: boolean; disabled?: boolean; style?: React.CSSProperties; sound?: 'select' | 'back' | 'start' }) {
  return (
    <button
      className={'btn' + (props.primary ? ' primary' : '') + (props.ghost ? ' ghost' : '')}
      disabled={props.disabled}
      style={props.style}
      onClick={() => {
        audio.ui(props.sound ?? 'select')
        props.onClick?.()
      }}
    >
      {props.children}
    </button>
  )
}

export function Key({ k }: { k: string }) {
  return <span className="key">{k}</span>
}
