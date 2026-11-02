import { expect, test } from 'bun:test'
import { buildTerrain } from '../src/render/trackGeometry'
import { Track } from '../src/track/track'
import { TRACKS } from '../src/track/trackDef'

test('the terrain mesh never covers the road', () => {
  for (const def of TRACKS) {
    const t = new Track(def)
    const { geometry, bounds } = buildTerrain(t)
    const pos = geometry.getAttribute('position').array as Float32Array
    const res = 6
    const nx = Math.ceil((bounds.x1 - bounds.x0) / res) + 1
    const meshH = (x: number, z: number) => {
      const fx = (x - bounds.x0) / res,
        fz = (z - bounds.z0) / res
      const i = Math.floor(fx),
        j = Math.floor(fz),
        tx = fx - i,
        tz = fz - j
      const h = (ii: number, jj: number) => pos[(jj * nx + ii) * 3 + 1]
      return (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - tz) + (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * tz
    }
    const p = { x: 0, y: 0, z: 0 }
    let worst = -Infinity,
      at = 0
    for (let s = 0; s < t.length; s += 2)
      for (const d of [-0.8, 0, 0.8]) {
        t.pointAt(s, d * t.hw[t.idx(s)], p)
        const over = meshH(p.x, p.z) - p.y
        if (over > worst) {
          worst = over
          at = s
        }
      }
    console.log(`[${def.id}] terrain highest relative to the road: ${worst.toFixed(3)} m at s=${at}`)
    expect(worst).toBeLessThan(0.03)
  }
})
