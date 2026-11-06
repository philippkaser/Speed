// High level session control used by the UI.
import { audio } from '../audio/audio'
import { net } from '../net/client'
import { useGameStore } from '../state/gameStore'
import { useSettings } from '../state/settings'
import { game } from './game'
import { startTeamRace } from '../team/session'

export function startAttract() {
  const g = useGameStore.getState()
  if (g.sessionHour !== null) g.set({ sessionHour: null })
  game.start({ mode: 'attract', trackId: 'valle-alta', carId: g.career.carId, color: '#fff', opponents: 9, laps: 999, aiSkill: 0.97, playerName: '' })
}

export function startShowroom() {
  const g = useGameStore.getState()
  if (g.sessionHour !== null) g.set({ sessionHour: null })
  const c = g.career
  game.start({ gt3Model: c.gt3Model, mode: 'showroom', trackId: 'valle-alta', carId: c.carId, color: c.colors[c.carId], setup: c.setups[c.carId], opponents: 0, laps: 1, aiSkill: 1, playerName: useSettings.getState().playerName })
}

export function startDriving(kind: 'practice' | 'race') {
  const g = useGameStore.getState()
  if (g.replaying) g.set({ replaying: false })
  if (g.sessionHour !== null) g.set({ sessionHour: null })
  const c = g.career
  audio.resume()
  game.start({
    gt3Model: c.gt3Model,
    mode: kind,
    trackId: 'valle-alta',
    carId: c.carId,
    color: c.colors[c.carId],
    setup: c.setups[c.carId],
    opponents: kind === 'race' ? g.opponents : 0,
    laps: g.raceLaps,
    aiSkill: g.aiSkill,
    playerName: useSettings.getState().playerName,
  })
  useGameStore.getState().set({ sessionKind: kind, paused: false })
  useGameStore.getState().setScreen('driving')
}

export function restartSession() {
  const kind = useGameStore.getState().sessionKind
  if (kind === 'online') return
  if (kind === 'team') {
    startTeamRace()
    return
  }
  startDriving(kind)
}

export { exitReplay, watchReplay } from './replayFlow'

export function quitToMenu() {
  if (useGameStore.getState().sessionKind === 'online') net.leave()
  game.endReplay()
  useGameStore.getState().set({ paused: false, replaying: false })
  startAttract()
  useGameStore.getState().setScreen('home')
}
