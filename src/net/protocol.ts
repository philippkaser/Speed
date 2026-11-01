// Wire protocol shared by the Bun server and the browser client (JSON over WebSocket).

export type RoomPhase = 'lobby' | 'countdown' | 'racing' | 'results'

export interface PlayerInfo {
  id: string
  name: string
  carId: string
  color: string
  ready: boolean
  grid: number
  finished: boolean
  finishTime: number
  bestLap: number
  ping: number
}

export interface RoomInfo {
  code: string
  hostId: string
  phase: RoomPhase
  laps: number
  trackId: string
  timeOfDay: number
  startAt: number // server ms when the lights go out
  players: PlayerInfo[]
}

/** Compact car state (~30 Hz). Numbers are rounded by the sender. */
export interface CarState {
  t: number // sender's estimate of server time (ms)
  p: [number, number, number]
  q: [number, number, number, number]
  v: [number, number, number]
  w: [number, number, number]
  st: number // steer input (-1..1)
  rpm: number
  g: number // gear
  th: number // throttle
  br: number // brake
  c: [number, number, number, number] // suspension compression per wheel
  o: [number, number, number, number] // wheel spin speed (rad/s)
  sa: [number, number, number, number] // steer angle front left/right + slip indicators
  bt: [number, number, number, number] // brake temps
  d: number // race distance (m)
  lap: number
  boost: number
  bf: number // backfire
}

export type ClientMsg =
  | { type: 'hello'; name: string; carId: string; color: string }
  | { type: 'create'; laps: number; timeOfDay: number }
  | { type: 'join'; code: string }
  | { type: 'quick' }
  | { type: 'update'; carId?: string; color?: string; ready?: boolean; name?: string }
  | { type: 'config'; laps?: number; timeOfDay?: number }
  | { type: 'start' }
  | { type: 'state'; s: CarState }
  | { type: 'lap'; lap: number; time: number; valid: boolean }
  | { type: 'finish'; time: number; bestLap: number }
  | { type: 'chat'; text: string }
  | { type: 'ping'; t: number }
  | { type: 'leave' }

export type ServerMsg =
  | { type: 'welcome'; id: string; serverTime: number }
  | { type: 'room'; room: RoomInfo }
  | { type: 'left' }
  | { type: 'states'; s: { id: string; s: CarState }[] }
  | { type: 'lap'; id: string; lap: number; time: number; valid: boolean }
  | { type: 'finish'; id: string; time: number; position: number }
  | { type: 'results'; order: { id: string; name: string; time: number; bestLap: number; dnf: boolean }[] }
  | { type: 'chat'; id: string; name: string; text: string }
  | { type: 'pong'; t: number; server: number }
  | { type: 'error'; message: string }

export const MAX_PLAYERS = 12
export const STATE_HZ = 30
