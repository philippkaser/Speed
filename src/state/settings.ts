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
  taa: boolean
  motionBlur: number // 0..1
  bloom: boolean
  shadows: 0 | 1 | 2 | 3 // off, low, high, ultra
  trees: number // density multiplier
  envProbe: boolean // dynamic reflection probe on the car
  fov: number // base FOV for chase camera
  cameraShake: number // 0..1
  showFps: boolean
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

export const PRESETS: Record<QualityPreset, Omit<GraphicsSettings, 'fov' | 'cameraShake' | 'showFps' | 'preset'>> = {
  low: { resolutionScale: 0.7, ssgi: false, ssr: false, ao: false, taa: false, motionBlur: 0, bloom: true, shadows: 1, trees: 0.35, envProbe: false },
  medium: { resolutionScale: 0.85, ssgi: false, ssr: false, ao: true, taa: true, motionBlur: 0.5, bloom: true, shadows: 2, trees: 0.7, envProbe: true },
  high: { resolutionScale: 1, ssgi: true, ssr: true, ao: true, taa: true, motionBlur: 0.7, bloom: true, shadows: 2, trees: 1, envProbe: true },
  ultra: { resolutionScale: 1, ssgi: true, ssr: true, ao: true, taa: true, motionBlur: 0.8, bloom: true, shadows: 3, trees: 1.4, envProbe: true },
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
    { name: 'speed-settings-v1', version: 1 },
  ),
)
