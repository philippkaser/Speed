import { describe, expect, test } from 'bun:test'
import { FlatGround } from '../src/physics/ground'
import { CARS } from '../src/physics/spec'
import { Vehicle } from '../src/physics/vehicle'
import { PhysicsWorld, PHYSICS_DT } from '../src/physics/world'

const ground = new FlatGround()

function makeWorld(carIndex = 0, assists: Partial<Vehicle['assists']> = {}) {
  const world = new PhysicsWorld(ground)
  const v = new Vehicle(CARS[carIndex])
  Object.assign(v.assists, { abs: true, tc: 0, steering: 0, autoGear: true }, assists)
  v.reset(0, 0, 0, ground)
  const car = world.addCar('test', v)
  return { world, v, car }
}

function run(world: PhysicsWorld, seconds: number, each?: (t: number) => boolean | void) {
  const steps = Math.round(seconds / PHYSICS_DT)
  for (let i = 0; i < steps; i++) {
    world.stepOnce(PHYSICS_DT)
    for (const c of world.cars) {
      c.input.shiftUp = false
      c.input.shiftDown = false
    }
    if (each && each(i * PHYSICS_DT)) return i * PHYSICS_DT
  }
  return seconds
}

for (const [ci, spec] of CARS.entries()) {
  describe(spec.name, () => {
    test('settles at rest without drifting', () => {
      const { world, v } = makeWorld(ci)
      run(world, 4)
      const drift = Math.hypot(v.pos.x, v.pos.z)
      const loads = v.loads()
      const total = loads.reduce((a, b) => a + b, 0)
      const mass = spec.mass
      console.log(`[${spec.name}] rest: drift=${drift.toFixed(4)}m  loads=${loads.map((l) => l.toFixed(0)).join('/')}  total/weight=${(total / (mass * 9.81)).toFixed(3)} cg=${v.pos.y.toFixed(3)}`)
      expect(drift).toBeLessThan(0.02)
      expect(v.speed).toBeLessThan(0.01)
      expect(Math.abs(total / (mass * 9.81) - 1)).toBeLessThan(0.02)
      const frontShare = (loads[0] + loads[1]) / total
      expect(Math.abs(frontShare - spec.weightFront)).toBeLessThan(0.03)
    })

    test('acceleration and top speed', () => {
      const { world, v, car } = makeWorld(ci, { tc: 3 })
      car.input.throttle = 1
      let t100 = -1,
        t200 = -1,
        maxSpeed = 0
      run(world, 60, (t) => {
        const kmh = v.speed * 3.6
        if (t100 < 0 && kmh >= 100) t100 = t
        if (t200 < 0 && kmh >= 200) t200 = t
        maxSpeed = Math.max(maxSpeed, kmh)
      })
      console.log(`[${spec.name}] 0-100 ${t100.toFixed(2)}s  0-200 ${t200.toFixed(2)}s  vmax ${maxSpeed.toFixed(1)} km/h  gear ${v.gear} rpm ${v.rpm.toFixed(0)}`)
      expect(t100).toBeGreaterThan(2.4)
      expect(t100).toBeLessThan(5.5)
      expect(maxSpeed).toBeGreaterThan(250)
      expect(maxSpeed).toBeLessThan(345)
      expect(Math.abs(v.pos.x)).toBeLessThan(5) // tracks straight
    })

    test('braking from 200 km/h with ABS', () => {
      const { world, v, car } = makeWorld(ci)
      v.setVelocityForward(200 / 3.6)
      v.gear = 5
      run(world, 0.3)
      const start = v.pos.z
      car.input.brake = 1
      let peakDecel = 0
      const t = run(world, 15, () => {
        peakDecel = Math.max(peakDecel, -v.accelLong)
        return v.speed < 0.3
      })
      const dist = v.pos.z - start
      console.log(`[${spec.name}] 200-0: ${dist.toFixed(1)} m in ${t.toFixed(2)} s, peak ${peakDecel.toFixed(2)} g`)
      expect(dist).toBeGreaterThan(70)
      expect(dist).toBeLessThan(200)
      expect(Math.abs(v.pos.x)).toBeLessThan(3)
    })

    test('steady state skidpad', () => {
      // constant radius path follower, ramp speed until the car can no longer hold the line
      const { world, v, car } = makeWorld(ci, { tc: 2 })
      const R = 60
      v.reset(-R, 0, 0, ground) // start on circle, heading +z, circle centred at origin (+x = left) -> left turn
      v.setVelocityForward(12)
      v.gear = 2
      // tyres at operating temperature (as after an out-lap)
      for (const w of v.wheels) {
        w.tyre.surfTemp = w.tyre.coreTemp = w.model.compound.optTemp
        w.tyre.updatePressure()
      }
      let targetV = 12
      let bestLat = 0
      let sustained = 0
      run(world, 70, (t) => {
        const px = v.pos.x,
          pz = v.pos.z
        const r = Math.hypot(px, pz)
        // tangent for the left-hand circle
        const tx = pz / r,
          tz = -px / r
        const heading = Math.atan2(v.fwd.x, v.fwd.z)
        const desired = Math.atan2(tx, tz)
        let he = desired - heading
        while (he > Math.PI) he -= 2 * Math.PI
        while (he < -Math.PI) he += 2 * Math.PI
        const ce = r - R // positive = outside
        const kin = Math.atan(v.spec.wheelbase / R)
        const steerAngle = kin + he * 1.2 + ce * 0.05
        car.input.steer = -steerAngle / v.spec.steerLock
        targetV += 0.006 * PHYSICS_DT * 60
        const err = targetV - v.speed
        car.input.throttle = Math.max(0, Math.min(1, 0.25 + err * 0.6))
        car.input.brake = 0
        if (Math.abs(ce) < 1.5 && Math.abs(he) < 0.2) {
          const lat = (v.speed * v.speed) / r / 9.81
          sustained++
          if (sustained > 300) bestLat = Math.max(bestLat, lat)
        } else sustained = 0
        if (Math.abs(ce) > 8) return true
      })
      console.log(`[${spec.name}] skidpad R=${R}m: ${bestLat.toFixed(2)} g sustained (target speed reached ${(targetV * 3.6).toFixed(0)} km/h)`)
      expect(bestLat).toBeGreaterThan(0.85)
      expect(bestLat).toBeLessThan(2.3)
    })
  })
}

test('physics step performance', () => {
  const world = new PhysicsWorld(ground)
  for (let i = 0; i < 12; i++) {
    const v = new Vehicle(CARS[i % CARS.length])
    v.reset(i * 10, 0, 0, ground)
    const c = world.addCar('c' + i, v)
    c.input.throttle = 0.6
  }
  const t0 = performance.now()
  const steps = 600
  for (let i = 0; i < steps; i++) world.stepOnce(PHYSICS_DT)
  const ms = performance.now() - t0
  console.log(`12 cars x ${steps} steps (1 s of sim): ${ms.toFixed(1)} ms  (${((ms / steps / 12) * 1000).toFixed(2)} us per car-step)`)
  expect(ms).toBeLessThan(400)
})

test('steering assist keeps a keyboard driver near the peak slip angle at speed', () => {
  const run = (assist: number) => {
    const { world, v, car } = makeWorld(0, { steering: assist, tc: 2 })
    for (const w of v.wheels) {
      w.tyre.surfTemp = w.tyre.coreTemp = w.model.compound.optTemp
      w.tyre.updatePressure()
    }
    v.setVelocityForward(200 / 3.6)
    v.gear = 5
    car.input.throttle = 0.35
    let maxBeta = 0,
      maxFrontSlip = 0
    run_(world, 2.0, (t) => {
      // keyboard style: ramp to full lock in ~0.4 s
      car.input.steer = Math.min(1, t / 0.4)
      const vl = v.vel.x * v.left.x + v.vel.z * v.left.z
      const vf = v.vel.x * v.fwd.x + v.vel.z * v.fwd.z
      maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(vl, Math.max(vf, 1))))
      maxFrontSlip = Math.max(maxFrontSlip, Math.abs(v.wheels[0].tyre.slipAngle), Math.abs(v.wheels[1].tyre.slipAngle))
    })
    return { beta: (maxBeta * 180) / Math.PI, front: (maxFrontSlip * 180) / Math.PI, lat: Math.abs(v.accelLat) }
  }
  const on = run(0.75)
  const off = run(0)
  console.log(`full lock @200 km/h: assist on -> body slip ${on.beta.toFixed(1)} deg, front slip ${on.front.toFixed(1)} deg | assist off -> body slip ${off.beta.toFixed(1)} deg, front slip ${off.front.toFixed(1)} deg`)
  expect(on.beta).toBeLessThan(12)
  expect(on.front).toBeLessThan(11)
  expect(off.front).toBeGreaterThan(on.front)
})

function run_(world: PhysicsWorld, seconds: number, each: (t: number) => void) {
  const steps = Math.round(seconds / PHYSICS_DT)
  for (let i = 0; i < steps; i++) {
    each(i * PHYSICS_DT)
    world.stepOnce(PHYSICS_DT)
  }
}

test('locking the brakes grinds a flat spot that makes the tyre load oscillate', () => {
  const { world, v, car } = makeWorld(0, { abs: false })
  v.setVelocityForward(200 / 3.6)
  v.gear = 5
  car.input.brake = 1
  run_(world, 1.2, () => {})
  const flat = Math.max(...v.wheels.map((w) => w.flatSpot))
  car.input.brake = 0
  car.input.throttle = 0.3
  // after release, measure front load variation while rolling
  let lo = Infinity,
    hi = -Infinity
  run_(world, 1.0, (t) => {
    if (t > 0.3) {
      lo = Math.min(lo, v.wheels[0].tyre.Fz)
      hi = Math.max(hi, v.wheels[0].tyre.Fz)
    }
  })
  console.log(`lock-up: flat spot ${(flat * 1000).toFixed(2)} mm, front load swing ${(hi - lo).toFixed(0)} N`)
  expect(flat).toBeGreaterThan(0.00005)
  expect(hi - lo).toBeGreaterThan(150)
})

describe('automatic gearbox (the player\'s car)', () => {
  // pedals over time -> the gears taken (the wheels and engine start at road speed in the given gear)
  function drive(ci: number, kmh: number, gear: number, segs: { t: number; throttle: number; brake: number }[]) {
    const { world, v, car } = makeWorld(ci, { tc: 2 })
    for (const w of v.wheels) {
      w.tyre.surfTemp = w.tyre.coreTemp = w.model.compound.optTemp
      w.tyre.updatePressure()
    }
    v.racingShift = false
    v.gear = gear
    v.setVelocityForward(kmh / 3.6)
    let ups = 0,
      downs = 0,
      last = gear,
      maxRpm = 0
    for (const s of segs) {
      car.input.throttle = s.throttle
      car.input.brake = s.brake
      run(world, s.t, () => {
        if (v.gear !== last && v.gear > 0) {
          if (v.gear > last) ups++
          else downs++
          last = v.gear
        }
        maxRpm = Math.max(maxRpm, v.rpm)
      })
    }
    return { ups, downs, gear: v.gear, kmh: v.speed * 3.6, maxRpm }
  }

  test('braking into a corner in the gear the automatic holds turns the car in, without a slide', () => {
    // 57 m radius at ~85 % of the grip, held for 6 s (the automatic settles in 2nd), then 35 % brake
    // with the steering held. With the rear brakes working to the tyre's longitudinal peak whatever
    // the cornering load, the rear axle let go: 27 degrees of body slip
    const { world, v, car } = makeWorld(0, { tc: 2 })
    for (const w of v.wheels) {
      w.tyre.surfTemp = w.tyre.coreTemp = w.model.compound.optTemp
      w.tyre.updatePressure()
    }
    v.racingShift = false
    const V = 93 / 3.6,
      R = 57
    v.reset(-R, 0, 0, ground)
    v.setVelocityForward(V)
    const beta = () => Math.atan2(v.vel.x * v.left.x + v.vel.z * v.left.z, Math.max(1, v.vel.x * v.fwd.x + v.vel.z * v.fwd.z))
    // path-following steering on the circle about the origin (as scripts/physics-audit.ts)
    let ceInt = 0
    run(world, 6, () => {
      const r = Math.hypot(v.pos.x, v.pos.z)
      const want = Math.atan2(v.pos.z / r, -v.pos.x / r)
      const he = Math.atan2(Math.sin(want - Math.atan2(v.fwd.x, v.fwd.z)), Math.cos(want - Math.atan2(v.fwd.x, v.fwd.z)))
      ceInt = Math.max(-20, Math.min(20, ceInt + (r - R) * PHYSICS_DT))
      car.input.steer = -(Math.atan(CARS[0].wheelbase / R) + he * 1.5 + (r - R) * 0.12 + ceInt * 0.04) / CARS[0].steerLock
      car.input.throttle = Math.max(0, Math.min(1, 0.3 + (V - v.speed) * 0.8))
    })
    const b0 = beta(),
      g0 = Math.abs(v.accelLat),
      gear0 = v.gear
    car.input.throttle = 0
    car.input.brake = 0.35
    let slip = 0
    run(world, 2, () => {
      if (v.speed > 8) slip = Math.max(slip, Math.abs(beta() - b0))
    })
    console.log(`trail braking: ${g0.toFixed(2)} g in gear ${gear0}, body slip +${((slip * 180) / Math.PI).toFixed(1)} deg`)
    expect(g0).toBeGreaterThan(1.1)
    expect(gear0).toBeLessThanOrEqual(3)
    expect((slip * 180) / Math.PI).toBeLessThan(10)
  })

  for (const [ci, spec] of CARS.entries()) {
    const top = spec.gears.length
    test(`${spec.name}: takes each gear once through a braking zone, never one up`, () => {
      // (the old schedule upshifted off the pedals at 3900 rpm: 20 upshifts and 25 downshifts here)
      const r = drive(ci, 240, top, [{ t: 3.2, throttle: 0, brake: 1 }])
      console.log(`[${spec.name}] braking 240 km/h in ${top}th: ${r.downs} down, ${r.ups} up, in gear ${r.gear} at ${r.kmh.toFixed(0)} km/h, max ${r.maxRpm.toFixed(0)} rpm`)
      expect(r.ups).toBe(0)
      expect(r.downs).toBeGreaterThanOrEqual(2)
      expect(r.downs).toBeLessThanOrEqual(top - 1)
      expect(r.maxRpm).toBeLessThan(spec.engine.limiterRpm + 100)
    })

    test(`${spec.name}: holds the gear on a lift, and the gear taken on the brakes through the corner`, () => {
      const coast = drive(ci, 200, top - 1, [{ t: 6, throttle: 0, brake: 0 }])
      expect(coast.ups + coast.downs).toBe(0)
      // feathering the throttle on and off must not move the gear back and forth
      const feather = drive(ci, 170, top - 2, Array.from({ length: 8 }, (_, i) => ({ t: 1, throttle: i % 2 ? 0.15 : 0, brake: 0 })))
      expect(feather.ups + feather.downs).toBeLessThanOrEqual(1)
      // brake for a corner, then balance the car on part throttle: no upshift mid-corner
      const corner = drive(ci, 230, top, [
        { t: 2.6, throttle: 0, brake: 0.7 },
        { t: 2, throttle: 0.35, brake: 0 },
      ])
      console.log(`[${spec.name}] coast ${coast.ups + coast.downs} shifts, feathering ${feather.ups + feather.downs}, corner ${corner.downs} down ${corner.ups} up`)
      expect(corner.ups).toBe(0)
      expect(corner.downs).toBeGreaterThanOrEqual(2)
    })
  }
})
