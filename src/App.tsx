import { Component, type ReactNode, useEffect } from 'react'
import { reportGpuError } from './render/gpuHealth'
import { startAttract, startDriving, startShowroom } from './game/session'
import { input } from './input/input'
import { GameCanvas } from './render/GameCanvas'
import { useGameStore } from './state/gameStore'
import { useSettings } from './state/settings'
import { game } from './game/game'
import { UIRoot } from './ui/UIRoot'

export function App() {
  useEffect(() => {
    input.attach()
    // small handle for automated tests / debugging from the console
    ;(window as unknown as { speed: object }).speed = { store: useGameStore, settings: useSettings, game, setCamera: (c: string) => useGameStore.getState().set({ camera: c as never }) }
    // URL shortcuts (handy for testing): ?drive, ?race, ?showroom, ?car=<id>
    const p = new URLSearchParams(location.search)
    const car = p.get('car')
    if (car) useGameStore.getState().updateCareer((c) => ({ ...c, carId: car }))
    if (p.has('drive') || p.has('race')) {
      startDriving(p.has('race') ? 'race' : 'practice')
      useGameStore.getState().set({ screen: 'driving' })
    } else if (p.has('showroom')) {
      startShowroom()
      useGameStore.getState().set({ screen: 'garage' })
    } else {
      startAttract()
      useGameStore.getState().set({ screen: 'boot' })
    }
  }, [])
  return (
    <div className="app">
      <CanvasBoundary>
        <GameCanvas />
      </CanvasBoundary>
      <UIRoot />
    </div>
  )
}

/** A renderer crash must not take the menus down with it (React unmounts everything on an uncaught error). */
class CanvasBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(e: unknown) {
    return { error: (e as Error)?.message || String(e) }
  }
  componentDidCatch(e: unknown) {
    console.error(e)
    useGameStore.getState().set({ sceneReady: true }) // let the menus through
    reportGpuError('Renderer crashed: ' + ((e as Error)?.message || String(e)))
  }
  render() {
    return this.state.error ? <div className="game-canvas canvas-failed" /> : this.props.children
  }
}
