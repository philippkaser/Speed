// Seeded generator for everything random in a race (grid, driver errors, pit crews, start-light
// hold): a race with the same seed replays identically (replays, multiplayer, tests).
let state = 0x9e3779b9

/** mulberry32: uniform in [0, 1) */
export function raceRandom() {
  state = (state + 0x6d2b79f5) | 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function seedRace(seed: number) {
  state = seed | 0
}

export function raceSeed() {
  return state
}
