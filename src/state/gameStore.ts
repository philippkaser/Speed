// React-facing UI/game state (screens, selections). The per-frame simulation lives in game/game.ts.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DriveCam } from '../render/CameraRig'
import { CARS, type CarSetup } from '../physics/spec'

export type Screen = 'boot' | 'title' | 'home' | 'garage' | 'tuning' | 'raceSetup' | 'settings' | 'lobby' | 'loading' | 'driving' | 'results' | 'teamHQ'

export interface Career {
  carId: string
  colors: Record<string, string>
  setups: Record<string, CarSetup>
  bestLaps: Record<string, number> // key: track:car
}

interface GameUIState {
  screen: Screen
  previous: Screen
  paused: boolean
  camera: DriveCam
  career: Career
  raceLaps: number
  opponents: number
  aiSkill: number
  timeOfDay: number
  sessionKind: 'practice' | 'race' | 'online' | 'team'
  sceneReady: boolean
  rendererInfo: string
  /** first fatal GPU/renderer error of this page load */
  gpuError: string
  setScreen: (s: Screen) => void
  back: () => void
  setPaused: (p: boolean) => void
  cycleCamera: () => void
  set: (p: Partial<Omit<GameUIState, 'career'>>) => void
  updateCareer: (fn: (c: Career) => Career) => void
}

const CAMS: DriveCam[] = ['chase', 'chaseNear', 'cockpit', 'hood', 'bumper']

export const useGameStore = create<GameUIState>()(
  persist(
    (set, get) => ({
      screen: 'boot',
      previous: 'home',
      paused: false,
      camera: 'chase',
      career: {
        carId: CARS[0].id,
        colors: Object.fromEntries(CARS.map((c) => [c.id, c.defaultColor])),
        setups: Object.fromEntries(CARS.map((c) => [c.id, { ...c.defaultSetup }])),
        bestLaps: {},
      },
      raceLaps: 5,
      opponents: 7,
      aiSkill: 0.95,
      timeOfDay: 18.3,
      sessionKind: 'practice',
      sceneReady: false,
      rendererInfo: '',
      gpuError: '',
      setScreen: (s) => set({ previous: get().screen, screen: s }),
      back: () => set({ screen: get().previous === get().screen ? 'home' : get().previous }),
      setPaused: (p) => set({ paused: p }),
      cycleCamera: () => set({ camera: CAMS[(CAMS.indexOf(get().camera) + 1) % CAMS.length] }),
      set: (p) => set(p),
      updateCareer: (fn) => set({ career: fn(get().career) }),
    }),
    {
      name: 'speed-career-v1',
      version: 1,
      partialize: (s) => ({ career: s.career, camera: s.camera, raceLaps: s.raceLaps, opponents: s.opponents, aiSkill: s.aiSkill, timeOfDay: s.timeOfDay }),
    },
  ),
)
