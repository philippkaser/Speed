// Race flow: the player is driven through the real input path to the chequered flag; then the
// cool-down lap drives itself while the results are up.
import { expect, test } from 'bun:test'
import { AIDriver } from '../src/ai/aiDriver'
import { game } from '../src/game/game'
import { input } from '../src/input/input'
import { makeInput } from '../src/physics/vehicle'

test('after the flag the cool-down lap drives itself', () => {
  game.start({ mode: 'race', trackId: 'valle-alta', carId: 'vanta-gt3', color: '#c00', opponents: 1, laps: 1, aiSkill: 0.9, playerName: 'Test' })
  const p = game.player!
  // a virtual player: an AI's controls fed through the input manager
  const bot = new AIDriver(p.sim.vehicle, game.track, 0.97)
  bot.id = 'player'
  const out = makeInput()
  const update = input.update.bind(input)
  input.update = (dt: number, speed: number, slip?: number) => {
    const c = update(dt, speed, slip)
    bot.drive(dt, out, [], game.phase === 'racing')
    c.steer = out.steer
    c.throttle = out.throttle
    c.brake = out.brake
    return c
  }
  let finish = -1
  const off = game.on((e) => {
    if (e.type === 'finish' && e.car === 'player') finish = e.position
  })
  try {
    for (let i = 0; i < 160 * 60 && finish < 0; i++) game.update(1 / 60)
    expect(finish).toBeGreaterThan(0)
    expect(game.phase).toBe('finished')
    expect(p.ai).toBeTruthy()
    for (let i = 0; i < 5 * 60; i++) game.update(1 / 60)
    expect(p.sim.vehicle.speed).toBeGreaterThan(10)
    // the race runs on until the whole field is home (the AI used to stop at the player's flag)
    for (let i = 0; i < 90 * 60 && game.finishOrder.length < game.cars.length; i++) game.update(1 / 60)
    expect(game.finishOrder.length).toBe(game.cars.length)
    for (const c of game.cars) expect(c.timing.finishTime).toBeGreaterThan(30)
  } finally {
    off()
    input.update = update
    game.stop()
  }
})
