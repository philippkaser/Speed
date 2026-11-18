import { describe, expect, test } from 'bun:test'
import { makeSample, Surface } from '../src/physics/ground'
import { GRASS_GAP, GRASS_REACH, GRASS_STRIDE, placeGrass } from '../src/render/grassPlacement'
import { Track } from '../src/track/track'
import { TRACKS } from '../src/track/trackDef'

// The grass stays on the verges: no blade on a kerb, the asphalt or a paved runoff, around the corners
// too (where a patch placed across from one point of the track can be nearer to another).
describe('grass placement', () => {
  const track = new Track(TRACKS[0])
  const g = placeGrass(track, 1)
  const n = g.room.length
  const smp = makeSample()
  const offGrass = (x: number, z: number) => {
    smp.hint = -1
    track.sample(x, z, smp)
    return smp.surface === Surface.Asphalt || smp.surface === Surface.Kerb || smp.surface === Surface.Runoff
  }
  /** does a ring of radius r around patch p touch the road? */
  const touches = (p: number, r: number) => {
    const x = g.data[p * GRASS_STRIDE],
      z = g.data[p * GRASS_STRIDE + 2]
    for (let a = 0; a < 16; a++) if (offGrass(x + Math.cos((a / 16) * 2 * Math.PI) * r, z + Math.sin((a / 16) * 2 * Math.PI) * r)) return true
    return offGrass(x, z)
  }

  test('a sward of patches, each with its room', () => {
    expect(n).toBeGreaterThan(150_000)
    expect(g.data.length).toBe(n * GRASS_STRIDE)
  })

  test('no blade reaches the road', () => {
    let bad = 0
    for (let p = 0; p < n; p += 7) if (touches(p, GRASS_REACH * g.data[p * GRASS_STRIDE + 4])) bad++
    expect(bad).toBe(0)
  })

  test('the room each patch is given is free of road (for the layers that draw it wider)', () => {
    let bad = 0
    for (let p = 0; p < n; p += 7) if (touches(p, g.room[p] - GRASS_GAP)) bad++
    expect(bad).toBe(0)
  })

  test('the sward still reaches the kerbs: patches close to the road on most of the lap', () => {
    // within a metre and a half of the road at most stretches of 10 m
    const near = new Set<number>()
    for (let p = 0; p < n; p++) {
      if (g.room[p] > 1.5) continue
      smp.hint = -1
      track.sample(g.data[p * GRASS_STRIDE], g.data[p * GRASS_STRIDE + 2], smp)
      near.add(Math.floor(smp.s / 10))
    }
    expect(near.size / Math.ceil(track.length / 10)).toBeGreaterThan(0.6)
  })
})
