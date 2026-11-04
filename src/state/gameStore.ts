// React-facing UI/game state (screens, selections). The per-frame simulation lives in game/game.ts.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DriveCam } from '../render/CameraRig'
import { CARS, type CarSetup } from '../physics/spec'
import type { GltfCarId } from '../car/gltfCars'

export type Screen = 'boot' | 'title' | 'home' | 'garage' | 'tuning' | 'raceSetup' | 'settings' | 'lobby' | 'loading' | 'driving' | 'results' | 'teamHQ'

export interface Career {
  /** bodywork of the GT3 car */
  gt3Model?: GltfCarId
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
  /** time of day imposed by the current session (team round, online room); not saved */
  sessionHour: number | null
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
      sessionHour: null,
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
      version: 2,
      // v1 saved the hour of team rounds as the player's own time of day (midday and morning
      // rounds left every mode in flat, washed-out light): back to the default golden hour
      migrate: (persisted, version) => {
        const st = (persisted ?? {}) as { timeOfDay?: number }
        if (version < 2 && st.timeOfDay !== undefined && [14.5, 9.8, 13, 16.2].includes(st.timeOfDay)) st.timeOfDay = 18.3
        return st as never
      },
      partialize: (s) => ({ career: s.career, camera: s.camera, raceLaps: s.raceLaps, opponents: s.opponents, aiSkill: s.aiSkill, timeOfDay: s.timeOfDay }),
    },
  ),
)
