// Where the forests grow: shared by the tree placement (Vegetation.tsx) and the terrain's forest floor
// (trackGeometry.ts), so the dark ground under the canopies is exactly where the trees stand.
import { valueNoise2 } from '../../physics/math'
import { smooth } from './noise'

/** Forest noise at a point (~0..1; forests above ~0.48). */
export const forestNoise = (x: number, z: number) => valueNoise2(x * 0.006 + 3.1, z * 0.006 - 7.7) * 0.7 + valueNoise2(x * 0.02, z * 0.02) * 0.3

/** Chance that a candidate tree stands here: closed canopies in the cores, thinning to the edges. */
export const treeChance = (forest: number) => (forest < 0.48 ? 0 : Math.min(1, (forest - 0.46) * 7) ** 1.5 * 0.92 + 0.04)

/** Trees keep clear of the track; on the start straight of the stands and the pits by far more. */
export function treeClearance(s: number, length: number) {
  return s > length - 420 || s < 460 ? 90 : 14
}

/**
 * Canopy cover of the ground (0..1) at a point `beyondWall` metres past the barrier at track
 * distance s (NaN: far from the circuit, no clearance).
 */
export function canopyCover(x: number, z: number, beyondWall: number, s: number, length: number) {
  const f = forestNoise(x, z)
  const clear = Number.isNaN(s) ? 0 : treeClearance(s, length)
  return smooth(0.47, 0.6, f) * smooth(clear, clear + 12, beyondWall)
}
