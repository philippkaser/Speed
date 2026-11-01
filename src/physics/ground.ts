// Ground / surface interface the vehicle simulation queries every substep.

export const enum Surface {
  Asphalt = 0,
  Kerb = 1,
  Grass = 2,
  Gravel = 3,
  Runoff = 4, // painted / slightly dusty asphalt runoff
  Pit = 5,
}

export interface SurfaceProps {
  /** grip multiplier on tyre friction */
  grip: number
  /** rolling resistance coefficient added to the tyre's own */
  rolling: number
  /** extra speed-proportional drag per wheel (gravel/grass ploughing), N per (m/s) per N load */
  drag: number
  /** amplitude (m) of random roughness the tyre feels */
  roughness: number
  /** spatial frequency (1/m) of the roughness */
  roughnessFreq: number
  /** used by audio / visuals */
  name: string
}

export const SURFACES: Record<Surface, SurfaceProps> = {
  [Surface.Asphalt]: { grip: 1.0, rolling: 0, drag: 0, roughness: 0.0006, roughnessFreq: 3.0, name: 'asphalt' },
  [Surface.Kerb]: { grip: 0.94, rolling: 0.002, drag: 0, roughness: 0.0015, roughnessFreq: 1.5, name: 'kerb' },
  [Surface.Grass]: { grip: 0.58, rolling: 0.03, drag: 0.004, roughness: 0.012, roughnessFreq: 0.8, name: 'grass' },
  [Surface.Gravel]: { grip: 0.5, rolling: 0.08, drag: 0.02, roughness: 0.02, roughnessFreq: 1.2, name: 'gravel' },
  [Surface.Runoff]: { grip: 0.92, rolling: 0.002, drag: 0, roughness: 0.001, roughnessFreq: 2.0, name: 'runoff' },
  [Surface.Pit]: { grip: 0.97, rolling: 0, drag: 0, roughness: 0.0005, roughnessFreq: 2.0, name: 'pit' },
}

export interface GroundSample {
  /** surface height at query point */
  height: number
  /** surface normal (unit) */
  nx: number
  ny: number
  nz: number
  surface: Surface
  /** track-relative coordinates: distance along centreline and lateral offset (+ = left) */
  s: number
  d: number
  /** lateral distance from centreline to the barrier on each side (positive numbers) */
  wallLeft: number
  wallRight: number
  /** horizontal unit vector pointing to the left of the track direction */
  lx: number
  lz: number
  /** cached index hint for the next query (spatial coherence) */
  hint: number
}

export function makeSample(): GroundSample {
  return { height: 0, nx: 0, ny: 1, nz: 0, surface: Surface.Asphalt, s: 0, d: 0, wallLeft: 1e9, wallRight: 1e9, lx: 1, lz: 0, hint: -1 }
}

export interface Ground {
  sample(x: number, z: number, out: GroundSample): void
}

/** Infinite flat asphalt plane, used for tests and the garage. */
export class FlatGround implements Ground {
  constructor(public height = 0, public surface: Surface = Surface.Asphalt, public grip = 1) {}
  sample(x: number, z: number, out: GroundSample) {
    out.height = this.height
    out.nx = 0
    out.ny = 1
    out.nz = 0
    out.surface = this.surface
    out.s = z
    out.d = x
    out.wallLeft = 1e9
    out.wallRight = 1e9
    out.lx = 1
    out.lz = 0
  }
}
