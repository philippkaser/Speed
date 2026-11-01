// Circuit definitions: closed loop of control points (x, z in metres), elevation and banking.
// The spline passes through every point (centripetal Catmull-Rom). Driving direction follows the
// order of the points.

export interface ControlPoint {
  x: number
  z: number
  y?: number // elevation (m)
  bank?: number // degrees, positive raises the right side (good for left... see track.ts)
  width?: number // full asphalt width (m)
}

export interface TrackDef {
  id: string
  name: string
  location: string
  description: string
  points: ControlPoint[]
  defaultWidth: number
  /** sample index (fraction of length) of the start line along the spline */
  startOffset: number
  timeOfDay: number // hours, default lighting
  seed: number
}

export const TRACKS: TrackDef[] = [
  {
    id: 'valle-alta',
    name: 'Autodromo Valle Alta',
    location: 'Fictional · Alpine foothills',
    description: 'A 1.1 km main straight, a plunging hairpin, fast esses, a climbing back section and a heavy-braking chicane before the banked final corner.',
    defaultWidth: 13,
    startOffset: 0.0,
    timeOfDay: 17.4,
    seed: 1337,
    points: scale(1.3, [
      // main straight (east)
      { x: -450, z: 0, y: 0, width: 14 },
      { x: 0, z: 0, y: 0, width: 14 },
      { x: 400, z: 0, y: 0, width: 14 },
      // T1 90deg right
      { x: 462, z: 5, y: 0, width: 15 },
      { x: 497, z: 26, y: -0.3 },
      { x: 512, z: 60, y: -0.8 },
      // downhill run
      { x: 518, z: 170, y: -4 },
      // T2/T3 esses (left, right)
      { x: 540, z: 248, y: -5.5 },
      { x: 598, z: 300, y: -6 },
      { x: 628, z: 378, y: -6.5 },
      // T4 hairpin right
      { x: 634, z: 466, y: -7 },
      { x: 624, z: 512, y: -7 },
      { x: 600, z: 532, y: -7 },
      { x: 574, z: 522, y: -6.8 },
      { x: 562, z: 492, y: -6.2 },
      // climb north-west
      { x: 556, z: 440, y: -3 },
      { x: 522, z: 398, y: 1 },
      // T5 left
      { x: 472, z: 392, y: 4 },
      { x: 440, z: 418, y: 6 },
      // T6 long right
      { x: 418, z: 492, y: 8.5 },
      { x: 366, z: 556, y: 10.5 },
      // T7 fast left kink
      { x: 260, z: 600, y: 12 },
      // back straight (west), downhill
      { x: 100, z: 622, y: 10 },
      { x: -240, z: 622, y: 3 },
      // T8/T9 chicane right-left
      { x: -322, z: 621, y: 1.5 },
      { x: -342, z: 598, y: 1.2 },
      { x: -366, z: 590, y: 1 },
      { x: -390, z: 614, y: 0.8 },
      { x: -438, z: 624, y: 0.5 },
      // T10 right
      { x: -505, z: 614, y: 0.2 },
      { x: -545, z: 586, y: 0 },
      { x: -560, z: 535, y: 0.5 },
      // north, rising
      { x: -560, z: 420, y: 2.5 },
      // T11 fast left-right
      { x: -585, z: 340, y: 3.5 },
      { x: -598, z: 255, y: 3.5 },
      // T12 banked final right onto the straight
      { x: -585, z: 145, y: 2.5, bank: 3 },
      { x: -545, z: 55, y: 1, bank: 5 },
      { x: -495, z: 10, y: 0.3, bank: 2 },
    ]),
  },
]

function scale(k: number, pts: ControlPoint[]): ControlPoint[] {
  return pts.map((p) => ({ ...p, x: p.x * k, z: p.z * k, y: (p.y ?? 0) * 1.15 }))
}

export function getTrackDef(id: string) {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0]
}
