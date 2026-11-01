import { useEffect } from 'react'
import { startAttract, startDriving, startShowroom } from './game/session'
import { input } from './input/input'
import { GameCanvas } from './render/GameCanvas'
import { useGameStore } from './state/gameStore'
import { UIRoot } from './ui/UIRoot'

export function App() {
  useEffect(() => {
    input.attach()
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
      <GameCanvas />
      <UIRoot />
    </div>
  )
}
