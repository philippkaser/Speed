import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import type { ClientMsg, ServerMsg } from '../src/net/protocol'

const PORT = 3900 + Math.floor(Math.random() * 90)
let server: Subprocess

beforeAll(async () => {
  server = Bun.spawn(['bun', 'server/index.ts'], { env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'inherit' })
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100)
  }
  throw new Error('server did not start')
})

afterAll(() => {
  server?.kill()
})

class Client {
  ws: WebSocket
  inbox: ServerMsg[] = []
  constructor() {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`)
    this.ws.onmessage = (e) => this.inbox.push(JSON.parse(String(e.data)))
  }
  open() {
    return new Promise<void>((res) => (this.ws.onopen = () => res()))
  }
  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m))
  }
  async wait<T extends ServerMsg['type']>(type: T, pred: (m: Extract<ServerMsg, { type: T }>) => boolean = () => true, ms = 4000) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const i = this.inbox.findIndex((m) => m.type === type && pred(m as Extract<ServerMsg, { type: T }>))
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Extract<ServerMsg, { type: T }>
      await Bun.sleep(10)
    }
    throw new Error('timeout waiting for ' + type)
  }
}

const state = (x: number) => ({ t: Date.now(), p: [x, 0, 0] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number], v: [10, 0, 0] as [number, number, number], w: [0, 0, 0] as [number, number, number], st: 0, rpm: 5000, g: 3, th: 1, br: 0, c: [0, 0, 0, 0] as [number, number, number, number], o: [30, 30, 30, 30] as [number, number, number, number], sa: [0, 0, 0, 0] as [number, number, number, number], bt: [100, 100, 100, 100] as [number, number, number, number], d: x, lap: 0, boost: 0.5, bf: 0 })

test('lobby -> countdown -> state relay -> results', async () => {
  const a = new Client(),
    b = new Client()
  await Promise.all([a.open(), b.open()])
  const wa = await a.wait('welcome')
  const wb = await b.wait('welcome')
  a.send({ type: 'hello', name: 'Alice', carId: 'vanta-gt3', color: '#ff0000' })
  b.send({ type: 'hello', name: 'Bob', carId: 'aurel-gt', color: '#0000ff' })
  a.send({ type: 'create', laps: 2, timeOfDay: 17 })
  const r1 = await a.wait('room')
  expect(r1.room.hostId).toBe(wa.id)
  expect(r1.room.code).toHaveLength(5)
  b.send({ type: 'join', code: r1.room.code })
  const r2 = await a.wait('room', (m) => m.room.players.length === 2)
  expect(r2.room.players.map((p) => p.name).sort()).toEqual(['Alice', 'Bob'])
  b.send({ type: 'update', ready: true })
  await a.wait('room', (m) => m.room.players.some((p) => p.id === wb.id && p.ready))
  // clock sync
  a.send({ type: 'ping', t: Date.now() })
  const pong = await a.wait('pong')
  expect(Math.abs(pong.server - Date.now())).toBeLessThan(1000)
  // start
  a.send({ type: 'start' })
  const cd = await b.wait('room', (m) => m.room.phase === 'countdown')
  expect(cd.room.startAt).toBeGreaterThan(Date.now())
  expect(new Set(cd.room.players.map((p) => p.grid)).size).toBe(2)
  // states are relayed to the other player only
  a.send({ type: 'state', s: state(12.5) })
  const st = await b.wait('states')
  expect(st.s[0].id).toBe(wa.id)
  expect(st.s[0].s.p[0]).toBe(12.5)
  // finishing
  a.send({ type: 'finish', time: 180.5, bestLap: 89.1 })
  const fin = await b.wait('finish')
  expect(fin.position).toBe(1)
  b.send({ type: 'finish', time: 182.1, bestLap: 90.2 })
  const res = await a.wait('results')
  expect(res.order.map((o) => o.name)).toEqual(['Alice', 'Bob'])
  a.ws.close()
  b.ws.close()
}, 20000)

test('rejects unknown rooms and malformed messages', async () => {
  const c = new Client()
  await c.open()
  await c.wait('welcome')
  c.ws.send('not json')
  c.ws.send(JSON.stringify({ nope: 1 }))
  c.send({ type: 'join', code: 'ZZZZZ' })
  const err = await c.wait('error')
  expect(err.message).toContain('not found')
  c.ws.close()
})
