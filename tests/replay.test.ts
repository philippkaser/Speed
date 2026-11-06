// Replays (src/game/replay.ts): a headless race is recorded, then played back into the cars; what
// the renderer reads must match what was simulated, physics must stand still during playback and
// the live session must come back untouched.
import { expect, test } from 'bun:test'
import { AIDriver } from '../src/ai/aiDriver'
import { game } from '../src/game/game'
import { REPLAY_HZ } from '../src/game/replay'

interface Snap {
  t: number
  id: string
  pos: number[]
  q: number[]
  steer: number[]
  travel: number[]
  omega: number[]
  brakeTemp: number
  rpm: number
  gear: number
  lap: number
  distance: number
}

function snapshot(t: number): Snap[] {
  return game.cars.map((c) => {
    const v = c.sim.vehicle
    return {
      t,
      id: c.id,
      pos: [v.pos.x, v.pos.y, v.pos.z],
      q: [v.q.x, v.q.y, v.q.z, v.q.w],
      steer: v.wheels.map((w) => w.steer),
      travel: v.wheels.map((w) => w.c - w.cStatic),
      omega: v.wheels.map((w) => w.omega),
      brakeTemp: v.wheels[0].brakeTemp,
      rpm: v.rpm,
      gear: v.gear,
      lap: c.timing.lap,
      distance: c.timing.distance,
    }
  })
}

test('record a race, play it back exactly, resume the live session untouched', () => {
  game.start({ mode: 'race', trackId: 'valle-alta', carId: 'vanta-gt3', color: '#c00', opponents: 3, laps: 1, aiSkill: 0.95, playerName: 'Test' })
  // the AI drives the player's car too
  const p = game.player!
  p.ai = new AIDriver(p.sim.vehicle, game.track, 0.97)
  p.ai.id = 'player'
  const rec = game.recorder!
  expect(rec).toBeTruthy()
  const snaps: Snap[][] = []
  let count = 0
  for (let i = 0; i < 25 * 60; i++) {
    game.update(1 / 60)
    if (rec.replay.count !== count) {
      count = rec.replay.count
      if (count % 37 === 5) snaps.push(snapshot(rec.replay.end))
    }
  }
  const R = rec.replay
  expect(game.phase).toBe('racing')
  expect(R.goAt).toBeGreaterThan(0)
  // about 30 Hz of simulated time, compact
  expect(R.count / R.duration).toBeGreaterThan(REPLAY_HZ * 0.9)
  expect(R.count / R.duration).toBeLessThan(REPLAY_HZ * 1.1)
  const perCarSample = R.bytes / (R.chunks.length * 256 * R.nCars)
  console.log(`replay: ${R.count} samples, ${R.duration.toFixed(1)} s, ${R.nCars} cars, ${perCarSample.toFixed(0)} bytes per car and sample, ${(R.bytes / 1024).toFixed(0)} kB`)
  expect(perCarSample).toBeLessThan(140)

  // the live state, to compare after the replay
  const live = snapshot(game.sessionTime)
  const sims = game.cars.map((c) => c.sim)
  const worldTime = game.world.time

  expect(game.startReplay()).toBe(true)
  const pl = game.replay!
  // a race replay starts just before the green light
  expect(pl.t).toBeLessThan(R.goAt)
  expect(pl.t).toBeGreaterThanOrEqual(R.start)
  // stand-ins, not the real cars
  game.cars.forEach((c, i) => expect(c.sim).not.toBe(sims[i]))
  pl.playing = true
  pl.speed = 1
  for (const frame of snaps) {
    pl.seek(frame[0].t)
    for (const s of frame) {
      const c = game.cars.find((e) => e.id === s.id)!
      const v = c.sim.vehicle
      for (let k = 0; k < 3; k++) expect(Math.abs([v.pos.x, v.pos.y, v.pos.z][k] - s.pos[k])).toBeLessThan(1e-3)
      const dot = Math.abs(v.q.x * s.q[0] + v.q.y * s.q[1] + v.q.z * s.q[2] + v.q.w * s.q[3])
      expect(dot).toBeGreaterThan(1 - 1e-6)
      v.wheels.forEach((w, k) => {
        expect(Math.abs(w.steer - s.steer[k])).toBeLessThan(2e-4)
        expect(Math.abs(w.c - w.cStatic - s.travel[k])).toBeLessThan(2e-5)
        expect(Math.abs(w.omega - s.omega[k])).toBeLessThan(0.02)
      })
      expect(Math.abs(v.wheels[0].brakeTemp - s.brakeTemp)).toBeLessThan(4.1)
      expect(Math.abs(v.rpm - s.rpm)).toBeLessThan(1)
      expect(v.gear).toBe(s.gear)
      // the renderer interpolates prevPos -> pos by world.alpha
      expect(c.sim.prevPos.x).toBe(v.pos.x)
      expect(c.timing.lap).toBe(s.lap)
      expect(Math.abs(c.timing.distance - s.distance)).toBeLessThan(0.01)
    }
  }
  // between two samples: in between, and the wheels keep turning with their speed
  const t0 = snaps[snaps.length - 1][0].t - 1
  pl.seek(t0)
  const a = game.cars[0].sim.vehicle
  const pa = [a.pos.x, a.pos.y, a.pos.z],
    spinA = a.wheels[2].spin
  pl.seek(t0 + 0.5 / REPLAY_HZ)
  expect(Math.hypot(a.pos.x - pa[0], a.pos.y - pa[1], a.pos.z - pa[2])).toBeGreaterThan(0.05)
  expect(Math.abs(a.wheels[2].spin - spinA - (a.wheels[2].omega * 0.5) / REPLAY_HZ)).toBeLessThan(0.05)
  // playback at 4x: the clock runs four times as fast, the blur's wheel speed with it; physics stands still
  pl.seek(t0)
  pl.speed = 4
  game.update(1 / 60)
  expect(Math.abs(pl.t - t0 - 4 / 60)).toBeLessThan(1e-9)
  expect(game.world.time).toBe(worldTime)
  pl.playing = false
  game.update(1 / 60)
  expect(Math.abs(pl.t - t0 - 4 / 60)).toBeLessThan(1e-9)
  expect(a.wheels[2].omega).toBe(0)

  game.endReplay()
  expect(game.replay).toBe(null)
  game.cars.forEach((c, i) => expect(c.sim).toBe(sims[i]))
  const back = snapshot(game.sessionTime)
  expect(back).toEqual(live)
  // the session carries on, and keeps recording
  const n = R.count
  for (let i = 0; i < 30; i++) game.update(1 / 60)
  expect(game.world.time).toBeGreaterThan(worldTime)
  expect(R.count).toBeGreaterThan(n)
})

test('a long practice keeps only its last 15 minutes', () => {
  game.start({ mode: 'practice', trackId: 'valle-alta', carId: 'vanta-gt3', color: '#c00', opponents: 0, laps: 1, aiSkill: 1, playerName: 'Test' })
  const R = game.recorder!.replay
  // fill the cap quickly with synthetic captures
  for (let i = 0; i < R.maxSamples + 600; i++) game.recorder!.capture(i / REPLAY_HZ)
  expect(R.count).toBeLessThanOrEqual(R.maxSamples)
  expect(R.duration).toBeGreaterThan(14 * 60)
  expect(R.end).toBeCloseTo((R.maxSamples + 599) / REPLAY_HZ, 6)
  game.stop()
})

test('the replay director films the recording: cuts between shots, holds still when paused', async () => {
  const THREE = await import('three/webgpu')
  const { carPoses } = await import('../src/render/CarVisual')
  const { director, replayBroadcast } = await import('../src/render/broadcastCam')
  game.start({ mode: 'race', trackId: 'valle-alta', carId: 'vanta-gt3', color: '#c00', opponents: 4, laps: 1, aiSkill: 0.95, playerName: 'Test' })
  const p = game.player!
  p.ai = new AIDriver(p.sim.vehicle, game.track, 0.97)
  p.ai.id = 'player'
  for (let i = 0; i < 50 * 60; i++) game.update(1 / 60)
  expect(game.startReplay()).toBe(true)
  const rp = game.replay!
  rp.speed = 4
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 12000)
  const focus = new THREE.Vector3()
  const poses = () => {
    for (const c of game.cars) {
      const v = c.sim.vehicle
      let pose = carPoses.get(c.id)
      if (!pose) carPoses.set(c.id, (pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }))
      pose.pos.set(v.pos.x, v.pos.y, v.pos.z)
      pose.quat.set(v.q.x, v.q.y, v.q.z, v.q.w)
    }
  }
  const field = (jumped: boolean) => ({
    cars: rp.views.map((v) => ({ id: v.id, position: v.position, s: v.s, distance: v.distance, speed: v.speed, finished: v.finished, incident: v.sliding || v.offTrack, isPlayer: v.isPlayer })),
    now: rp.t,
    raceTime: rp.raceTime,
    lastLap: false,
    focus: '',
    jumped,
  })
  const cuts0 = director.cut
  const shots = new Set<string>()
  let aimed = 0,
    frames = 0
  for (let i = 0; i < 12 * 60; i++) {
    game.update(1 / 60)
    poses()
    replayBroadcast(cam, rp.lastAdvance, focus, field(i === 0))
    cam.updateMatrixWorld()
    expect(Number.isFinite(cam.position.x + cam.position.y + cam.position.z)).toBe(true)
    if (rp.raceTime > 1) {
      shots.add(director.shot)
      // onboard shots ride on the car (the rear cam looks back at the chaser)
      if (director.shot === 'onboard' || director.shot === 'rear') continue
      // the car on air is in the picture
      const pose = carPoses.get(director.target)!
      const ndc = pose.pos.clone().project(cam)
      frames++
      if (Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && ndc.z < 1) aimed++
    }
  }
  expect(director.cut - cuts0).toBeGreaterThan(4)
  expect(shots.size).toBeGreaterThan(2)
  expect(aimed / frames).toBeGreaterThan(0.9)
  // paused: the picture holds
  rp.playing = false
  game.update(1 / 60)
  poses()
  replayBroadcast(cam, rp.lastAdvance, focus, field(false))
  const held = cam.position.clone()
  for (let i = 0; i < 30; i++) {
    game.update(1 / 60)
    poses()
    replayBroadcast(cam, rp.lastAdvance, focus, field(false))
  }
  expect(cam.position.distanceTo(held)).toBeLessThan(1e-9)
  // a jump is a fresh shot
  const c = director.cut
  rp.seek(rp.start + 20)
  poses()
  replayBroadcast(cam, rp.lastAdvance, focus, field(true))
  expect(director.cut).toBeGreaterThan(c)
  game.endReplay()
  carPoses.clear()
  game.stop()
})

test('practice: watch the replay from the pause menu and come back to it, the session as it was', async () => {
  const { exitReplay, watchReplay } = await import('../src/game/replayFlow')
  const { useGameStore } = await import('../src/state/gameStore')
  game.start({ mode: 'practice', trackId: 'valle-alta', carId: 'vanta-gt3', color: '#c00', opponents: 0, laps: 1, aiSkill: 1, playerName: 'Test' })
  const p = game.player!
  p.ai = new AIDriver(p.sim.vehicle, game.track, 0.97)
  p.ai.id = 'player'
  for (let i = 0; i < 40 * 60; i++) game.update(1 / 60)
  const timing = p.timing
  const pos = [p.sim.vehicle.pos.x, p.sim.vehicle.pos.z]
  useGameStore.getState().set({ paused: true })
  expect(watchReplay('pause')).toBe(true)
  expect(useGameStore.getState().replaying).toBe(true)
  expect(useGameStore.getState().paused).toBe(false)
  // the replay has its own timing (the practice ghost follows it), the car its stand-in
  expect(p.timing).not.toBe(timing)
  for (let i = 0; i < 120; i++) game.update(1 / 60)
  expect(game.replay!.t).toBeGreaterThan(game.replay!.start + 1.9)
  exitReplay()
  expect(useGameStore.getState().replaying).toBe(false)
  expect(useGameStore.getState().paused).toBe(true)
  expect(p.timing).toBe(timing)
  expect([p.sim.vehicle.pos.x, p.sim.vehicle.pos.z]).toEqual(pos)
  game.stop()
})
