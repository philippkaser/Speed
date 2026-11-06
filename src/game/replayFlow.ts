// Opening and leaving a session's replay (UI flow; re-exported by session.ts). Kept free of the audio
// and network modules so that it runs headlessly in the tests.
import { useGameStore } from '../state/gameStore'
import { game } from './game'

/** Watch the session's replay (from the pause menu or the results); false when nothing is recorded. */
export function watchReplay(from: 'pause' | 'results') {
  if (!game.startReplay()) return false
  // the game loop runs (and plays the replay) only while not paused
  useGameStore.getState().set({ replaying: true, replayFrom: from, paused: false })
  return true
}

/** Back from the replay to where it was opened: the pause menu (the session as it was) or the results. */
export function exitReplay() {
  game.endReplay()
  const g = useGameStore.getState()
  g.set({ replaying: false, paused: g.replayFrom === 'pause' })
}
