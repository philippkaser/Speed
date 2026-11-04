import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Assists } from '../physics/vehicle'

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra'

export interface GraphicsSettings {
  preset: QualityPreset
  resolutionScale: number // 0.5 .. 1 (of device pixel ratio, capped)
  ssgi: boolean
  ssr: boolean
  ao: boolean
  autoExposure: boolean
  /** exposure compensation in stops (applies with and without auto exposure) */
  exposureComp?: number
  /** shutter angle / 360: the share of each frame the shutter is open (1 = 360 degrees: continuous motion) */
  motionBlur: number
  bloom: boolean
  shadows: 0 | 1 | 2 | 3 // off, low, high, ultra
  trees: number // density multiplier
  envProbe: boolean // (superseded by reflections)
  /** car reflections (Reflections.tsx): 0 off (sky only), 1 medium, 2 high, 3 ultra */
  reflections?: 0 | 1 | 2 | 3
  fov: number // base FOV for chase camera
  cameraShake: number // 0..1
  showFps: boolean
  /** 'photo': the HDRI sky (its sun, fixed at 48 degrees); 'dynamic': procedural sky following the time of day */
  sky?: 'photo' | 'dynamic'
  /** renderer backend: 'auto' = WebGPU where available, else WebGL2 */
  backend?: 'auto' | 'webgl'
  /** why the game switched itself to WebGL2 (shown in Settings) */
  backendNote?: string
}

export interface ControlSettings {
  steeringSensitivity: number // keyboard/pad steering speed
  steeringLinearity: number // 1 = linear, >1 = more precision near centre
  deadzone: number
  wheelRange: number // degrees of steering wheel rotation for wheel users
  throttleAxis: number
  brakeAxis: number
  clutchAxis: number
  steerAxis: number
  invertPedals: boolean
  vibration: boolean
  ffbGain: number
  ffbInvert: boolean
}

export interface AudioSettings {
  master: number
  engine: number
  effects: number
  music: number
}

export interface SettingsState {
  graphics: GraphicsSettings
  controls: ControlSettings
  audio: AudioSettings
  assists: Assists
  units: 'metric' | 'imperial'
  playerName: string
  hudVisible: boolean
  racingLine: 'off' | 'braking' | 'full'
  setGraphics: (g: Partial<GraphicsSettings>) => void
  applyPreset: (p: QualityPreset) => void
  setControls: (c: Partial<ControlSettings>) => void
  setAudio: (a: Partial<AudioSettings>) => void
  setAssists: (a: Partial<Assists>) => void
  set: (s: Partial<Pick<SettingsState, 'units' | 'playerName' | 'hudVisible' | 'racingLine'>>) => void
}

export const PRESETS: Record<QualityPreset, Omit<GraphicsSettings, 'fov' | 'cameraShake' | 'showFps' | 'preset' | 'backend' | 'backendNote' | 'sky'>> = {
  low: { resolutionScale: 0.7, autoExposure: false, ssgi: false, ssr: false, ao: false, motionBlur: 0, bloom: true, shadows: 1, trees: 0.35, envProbe: false, reflections: 1 },
  medium: { resolutionScale: 1, autoExposure: true, ssgi: false, ssr: false, ao: true, motionBlur: 1, bloom: true, shadows: 2, trees: 0.7, envProbe: true, reflections: 1 },
  high: { resolutionScale: 1, autoExposure: true, ssgi: true, ssr: false, ao: true, motionBlur: 1, bloom: true, shadows: 2, trees: 1, envProbe: true, reflections: 2 },
  ultra: { resolutionScale: 1, autoExposure: true, ssgi: true, ssr: false, ao: true, motionBlur: 1, bloom: true, shadows: 3, trees: 1.4, envProbe: true, reflections: 3 },
}

function defaultPreset(): QualityPreset {
  if (typeof navigator === 'undefined') return 'high'
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
  if (mobile) return 'low'
  return 'gpu' in navigator ? 'high' : 'medium'
}

const preset: QualityPreset = (typeof location !== 'undefined' && (new URLSearchParams(location.search).get('q') as QualityPreset)) || defaultPreset()

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      graphics: { preset, ...PRESETS[preset], fov: 58, cameraShake: 0.6, showFps: false },
      controls: {
        steeringSensitivity: 1,
        steeringLinearity: 1.35,
        deadzone: 0.06,
        wheelRange: 900,
        throttleAxis: -1,
        brakeAxis: -1,
        clutchAxis: -1,
        steerAxis: 0,
        invertPedals: false,
        vibration: true,
        ffbGain: 0.8,
        ffbInvert: false,
      },
      audio: { master: 0.85, engine: 1, effects: 0.85, music: 0.5 },
      assists: { abs: true, tc: 2, steering: 0.75, autoGear: true, stability: false },
      units: 'metric',
      playerName: 'Driver' + Math.floor(Math.random() * 900 + 100),
      hudVisible: true,
      racingLine: 'braking',
      setGraphics: (g) => set((s) => ({ graphics: { ...s.graphics, ...g } })),
      applyPreset: (p) => set((s) => ({ graphics: { ...s.graphics, ...PRESETS[p], preset: p } })),
      setControls: (c) => set((s) => ({ controls: { ...s.controls, ...c } })),
      setAudio: (a) => set((s) => ({ audio: { ...s.audio, ...a } })),
      setAssists: (a) => set((s) => ({ assists: { ...s.assists, ...a } })),
      set: (v) => set(v),
    }),
    {
      name: 'speed-settings-v1',
      version: 4,
      // v3: motion blur is a shutter angle relative to each frame, 360 degrees by default (streaks
      // join from frame to frame). Earlier preset defaults move to it; custom values stay.
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<SettingsState>
        const mb = p.graphics?.motionBlur
        const oldDefaults = version < 2 ? [0.5, 0.7, 0.8] : version < 3 ? [0.5] : []
        if (p.graphics && mb !== undefined && oldDefaults.includes(mb)) p.graphics = { ...p.graphics, motionBlur: 1 }
        // v4: car reflections are cubemap probes; screen-space reflections are off by default
        if (version < 4 && p.graphics) {
          const pr = (p.graphics.preset ?? 'high') as QualityPreset
          p.graphics = { ...p.graphics, ssr: false, reflections: PRESETS[pr]?.reflections ?? 2 }
        }
        return p as SettingsState
      },
      // nested merge so settings added in later versions get their defaults
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>
        return {
          ...current,
          ...p,
          graphics: { ...current.graphics, ...p.graphics },
          controls: { ...current.controls, ...p.controls },
          audio: { ...current.audio, ...p.audio },
          assists: { ...current.assists, ...p.assists },
        }
      },
    },
  ),
)
