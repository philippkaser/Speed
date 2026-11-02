// Engineer's lap estimate: quasi-steady-state lap time of a car with a given setup (aero, mass, gearing,
// compound) from the same speed profile solver the AI uses. Suspension effects are not included.
import { speedProfileFor } from '../ai/aiDriver'
import { getCar, type CarSetup } from '../physics/spec'
import { Vehicle } from '../physics/vehicle'
import { DS, type Track } from '../track/track'

const cache = new Map<string, number>()

export function estimateLap(track: Track, carId: string, setup: CarSetup, skill = 0.97, fuel = 0) {
  const key = carId + JSON.stringify(setup) + skill + ':' + fuel
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const v = new Vehicle(getCar(carId), setup)
  if (fuel) v.setFuel(fuel)
  const prof = speedProfileFor(v, track, skill)
  let t = 0
  for (let i = 0; i < prof.length; i++) t += DS / Math.max(prof[i], 5)
  if (cache.size > 400) cache.clear()
  cache.set(key, t)
  return t
}
