import { describe, expect, test } from 'bun:test'
import { Track } from '../src/track/track'
import { TRACKS } from '../src/track/trackDef'
import { bakeSkidMarks, SKID_COLS, SKID_HALF } from '../src/track/skidMarks'

// The baked skid marks: messy, as a race weekend leaves them — most through the corners and braking
// zones, many off the racing line, some on the straights, none on the grass.
describe('skid marks', () => {
  const track = new Track(TRACKS[0])
  const map = bakeSkidMarks(track)
  const cell = (2 * SKID_HALF) / SKID_COLS
  const at = (s: number) => Math.min(track.n - 1, Math.round((s / track.length) * track.n))
  // darkness summed per row
  const rowSum = (row: number) => {
    let a = 0
    for (let c = 0; c < SKID_COLS; c++) a += map.data[row * SKID_COLS + c]
    return a
  }

  test('a lot of them, of every kind', () => {
    expect(map.tracks).toBeGreaterThan(500)
    for (const k of ['lockup', 'slide', 'wheelspin', 'straight'] as const) expect(map.counts[k]).toBeGreaterThan(10)
  })

  test('the same marks every time', () => {
    expect(bakeSkidMarks(track).data).toEqual(map.data)
  })

  test('heaviest where the tyres work, but some on the straights', () => {
    let hard = 0,
      hardN = 0,
      easy = 0,
      easyN = 0,
      easyMarked = 0
    for (let row = 0; row < map.rows; row++) {
      const i = at((row + 0.5) * map.rowLen)
      const v = track.speed[i]
      const work = Math.max(track.brakeZone[i], (v * v * Math.abs(track.racingCurv[i])) / 13)
      const a = rowSum(row)
      if (work > 0.5) (hard += a), hardN++
      else if (work < 0.05) {
        easy += a
        easyN++
        if (a > 0) easyMarked++
      }
    }
    expect(hard / hardN).toBeGreaterThan(4 * (easy / easyN))
    // the straights are not clean: a few percent of their length carries a mark
    expect(easyMarked / easyN).toBeGreaterThan(0.03)
  })

  test('many off the racing line', () => {
    expect(map.offLine / map.tracks).toBeGreaterThan(0.08)
  })

  test('on the asphalt and the kerbs only', () => {
    let bad = 0
    for (let row = 0; row < map.rows; row++) {
      const i = at((row + 0.5) * map.rowLen)
      for (let c = 0; c < SKID_COLS; c++) {
        if (!map.data[row * SKID_COLS + c]) continue
        const d = (c + 0.5) * cell - SKID_HALF
        const lim = (d > 0 ? track.hw[i] + track.L.kerb[i] : track.hw[i] + track.R.kerb[i]) + 0.35
        if (Math.abs(d) > lim) bad++
      }
    }
    expect(bad).toBe(0)
  })
})
