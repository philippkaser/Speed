// Teams, drivers, the season calendar and points for the team (pit wall) mode. All fictional.

export interface Driver {
  id: string
  first: string
  last: string
  /** three-letter timing code */
  code: string
  number: number
  nat: string
  /** 0..1: raw speed */
  pace: number
  /** 0..1: avoids mistakes */
  consistency: number
  /** 0..1: looks after the tyres */
  tyreCare: number
  /** 0..1: overtaking and defending */
  racecraft: number
}

export interface Team {
  /** detailed car model (src/car/gltfCars.ts) */
  model?: 'ferrari-296-gt3' | 'amg-gt3'
  id: string
  name: string
  short: string
  color: string
  accent: string
  drivers: [Driver, Driver]
  /** garage index along the pit lane (0..5) */
  box: number
}

const d = (id: string, first: string, last: string, code: string, number: number, nat: string, pace: number, consistency: number, tyreCare: number, racecraft: number): Driver => ({ id, first, last, code, number, nat, pace, consistency, tyreCare, racecraft })

export const RIVAL_TEAMS: Team[] = [
  {
    id: 'nordkap',
    model: 'amg-gt3',
    name: 'Nordkap Racing',
    short: 'NKR',
    color: '#0b3d91',
    accent: '#e8f1ff',
    box: 0,
    drivers: [d('eklund', 'Lars', 'Eklund', 'EKL', 7, 'SWE', 0.9, 0.85, 0.6, 0.7), d('virtanen', 'Mika', 'Virtanen', 'VIR', 8, 'FIN', 0.78, 0.9, 0.8, 0.55)],
  },
  {
    id: 'ferro',
    model: 'ferrari-296-gt3',
    name: 'Ferro Corse',
    short: 'FER',
    color: '#a30d16',
    accent: '#f4c430',
    box: 1,
    drivers: [d('ricci', 'Matteo', 'Ricci', 'RIC', 11, 'ITA', 0.95, 0.7, 0.45, 0.9), d('bianchi', 'Lucia', 'Bianchi', 'BIA', 12, 'ITA', 0.82, 0.8, 0.7, 0.75)],
  },
  {
    id: 'halcyon',
    model: 'amg-gt3',
    name: 'Halcyon Motorsport',
    short: 'HAL',
    color: '#00897b',
    accent: '#0a0a0c',
    box: 3,
    drivers: [d('okafor', 'Jonah', 'Okafor', 'OKA', 21, 'NGA', 0.87, 0.88, 0.75, 0.8), d('raman', 'Priya', 'Raman', 'RAM', 22, 'IND', 0.84, 0.82, 0.9, 0.6)],
  },
  {
    id: 'kitsune',
    model: 'ferrari-296-gt3',
    name: 'Kitsune GP',
    short: 'KIT',
    color: '#ff6d00',
    accent: '#111214',
    box: 4,
    drivers: [d('tanaka', 'Haru', 'Tanaka', 'TAN', 33, 'JPN', 0.8, 0.75, 0.65, 0.85), d('mori', 'Kenji', 'Mori', 'MOR', 34, 'JPN', 0.72, 0.85, 0.7, 0.65)],
  },
  {
    id: 'solano',
    model: 'amg-gt3',
    name: 'Solano Works',
    short: 'SOL',
    color: '#f2f2ef',
    accent: '#1b5e20',
    box: 5,
    drivers: [d('alvarez', 'Diego', 'Alvarez', 'ALV', 44, 'ARG', 0.76, 0.7, 0.55, 0.95), d('duarte', 'Sofia', 'Duarte', 'DUA', 45, 'POR', 0.7, 0.9, 0.85, 0.5)],
  },
]

export function defaultPlayerTeam(): Team {
  return {
    id: 'player',
    model: 'ferrari-296-gt3',
    name: 'Apex Valley Racing',
    short: 'AVR',
    color: '#111316',
    accent: '#c6ff00',
    box: 2,
    drivers: [d('brandt', 'Alex', 'Brandt', 'BRA', 3, 'GER', 0.86, 0.84, 0.72, 0.78), d('laurent', 'Noa', 'Laurent', 'LAU', 4, 'FRA', 0.83, 0.8, 0.8, 0.72)],
  }
}

export const TEAM_PAINTS = ['#111316', '#f2f2ef', '#c8102e', '#ff6f00', '#f5b800', '#c6ff00', '#2e7d32', '#00838f', '#00bcd4', '#0d47a1', '#1d3b6e', '#6a1b9a', '#c51162', '#9ea3a8', '#b08d57']

export interface Round {
  name: string
  laps: number
  /** time of day (hours) */
  hour: number
}

// low sun for every round: warm light, long shadows and lens flares on the broadcast
export const SEASON: Round[] = [
  { name: 'Valle Alta 300', laps: 10, hour: 17.7 },
  { name: 'Morning Sprint', laps: 8, hour: 7.9 },
  { name: 'Golden Hour Trophy', laps: 12, hour: 18.6 },
  { name: 'Grand Prix of the Valley', laps: 14, hour: 17.1 },
  { name: 'Dusk Classic', laps: 10, hour: 19.3 },
  { name: 'Season Finale', laps: 16, hour: 18.2 },
]

export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
export const FASTEST_LAP_POINT = 1

export function driverName(dr: Driver) {
  return `${dr.first[0]}. ${dr.last}`
}
