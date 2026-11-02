// Headless calibration: one AI car per compound for a few laps on the real circuit.
// Prints lap times, tread wear per lap, engine work per lap and how much of the lap the tyres spend
// above the smoke thresholds.  bun scripts/calibrate-race.ts [laps] [fuel kg] [compound]
import { AIDriver } from '../src/ai/aiDriver'
import { getCar } from '../src/physics/spec'
import { Vehicle } from '../src/physics/vehicle'
import { PhysicsWorld, PHYSICS_DT } from '../src/physics/world'
import { Track } from '../src/track/track'
import { getTrackDef } from '../src/track/trackDef'
import { makeSample } from '../src/physics/ground'

const laps = +(process.argv[2] ?? 3)
const fuelKg = +(process.argv[3] ?? 0)
const only = process.argv[4]
const track = new Track(getTrackDef('valle-alta'))
for (const compound of only ? [only] : ['RS', 'RM', 'RH']) {
  const spec = getCar('vanta-gt3')
  const v = new Vehicle(spec, { ...spec.defaultSetup, compound })
  const world = new PhysicsWorld(track)
  const s0 = 30
  const p = track.pointAt(s0, track.racing[track.idx(s0)], { x: 0, y: 0, z: 0 })
  v.reset(p.x, p.z, track.headingAt(s0), track)
  v.setVelocityForward(40)
  v.gear = 4
  if (fuelKg) v.setFuel(fuelKg)
  const car = world.addCar('c', v)
  const ai = new AIDriver(v, track, 0.97, 0.5)
  ai.rebuildProfile()
  const smp = makeSample()
  let prevS = s0,
    t = 0,
    lapStart = -1,
    lap = 0,
    work = 0,
    wear0 = 1
  let smokeA = 0,
    smokeB = 0,
    samples = 0
  const out: string[] = []
  const frame = 1 / 60
  while (lap < laps && t < 600) {
    ai.drive(frame, car.input, [], true)
    world.update(frame)
    t += frame
    const eng = v.engine
    work += Math.max(0, eng.torque * eng.omega) * frame
    for (const w of v.wheels) {
      samples++
      const ty = w.tyre
      if (ty.slipPower > 9000) smokeA++ // old threshold
      if (ty.slipPower > 18000 && ty.slideVel > 6) smokeB++
    }
    track.sample(v.pos.x, v.pos.z, smp)
    if (prevS > track.length - 50 && smp.s < 50) {
      if (lapStart >= 0) {
        lap++
        const wear = Math.min(...v.wheels.map((w) => w.tyre.wear))
        out.push(`lap ${lap}: ${(t - lapStart).toFixed(2)} s  wear/lap (most worn tyre) ${((wear0 - wear) * 100).toFixed(3)}%  engine ${(work / 3.6e6).toFixed(2)} kWh  temps ${v.wheels.map((w) => w.tyre.surfTemp.toFixed(0)).join('/')}`)
        wear0 = wear
      }
      lapStart = t
      work = 0
    }
    prevS = smp.s
  }
  console.log(`[${compound}] ` + out.join('\n     '))
  console.log(`     tyre-time above old smoke threshold ${((smokeA / samples) * 100).toFixed(1)}%, above new ${((smokeB / samples) * 100).toFixed(2)}%`)
  void PHYSICS_DT
}
