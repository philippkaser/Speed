// Lane lines: build cost, separation, bounds and the GT3 lap time on each line.
//   bun scripts/lane-check.ts [track]
import { AIDriver } from '../src/ai/aiDriver'
import { CARS } from '../src/physics/spec'
import { Vehicle } from '../src/physics/vehicle'
import { Track } from '../src/track/track'
import { getTrackDef, TRACKS } from '../src/track/trackDef'

const t0 = performance.now()
const track = new Track(process.argv[2] ? getTrackDef(process.argv[2]) : TRACKS[0])
const tTrack = performance.now() - t0
track.ensureLanes()
const n = track.n
let minSep = Infinity, two = 0, outB = 0, minW = Infinity
for (let i = 0; i < n; i++) {
  if (track.laneTwo[i]) { two++; minSep = Math.min(minSep, track.laneL[i] - track.laneR[i]) }
  minW = Math.min(minW, track.lineHi[i] - track.lineLo[i])
  for (const a of [track.laneL[i], track.laneR[i]]) if (a < track.lineLo[i] - 1e-3 || a > track.lineHi[i] + 1e-3) outB++
}
const ai = new AIDriver(new Vehicle(CARS[0]), track, 1)
const lap = (p: Float32Array) => track.lapTime(p).toFixed(2)
console.log(`track ${tTrack.toFixed(0)} ms, lanes ${track.laneBuildMs.toFixed(0)} ms; two lanes on ${((100 * two) / n).toFixed(1)} % (min sep ${minSep.toFixed(2)} m, min usable width ${minW.toFixed(2)} m), out of bounds ${outB}`)
console.log(`${CARS[0].name}: plan ideal ${lap(ai.profile)} s, left lane ${lap(ai.profL)} s, right lane ${lap(ai.profR)} s`)
