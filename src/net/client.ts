// Multiplayer client: lobby, clock sync, state streaming and snapshot interpolation of remote cars.
import { create } from 'zustand'
import { Quat, V3 } from '../physics/math'
import type { Vehicle } from '../physics/vehicle'
import type { CarState, ClientMsg, RoomInfo, ServerMsg } from './protocol'
import { STATE_HZ } from './protocol'

export type NetStatus = 'offline' | 'connecting' | 'online' | 'error'

interface NetUI {
  status: NetStatus
  myId: string
  room: RoomInfo | null
  error: string
  chat: { name: string; text: string }[]
  results: { id: string; name: string; time: number; bestLap: number; dnf: boolean }[] | null
  ping: number
}

export const useNet = create<NetUI>(() => ({ status: 'offline', myId: '', room: null, error: '', chat: [], results: null, ping: 0 }))

interface Snapshot {
  t: number
  s: CarState
}

export interface RemoteCar {
  id: string
  buf: Snapshot[]
  lastRecv: number
}

const INTERP_DELAY = 110 // ms

type Listener = (msg: ServerMsg) => void

class NetClient {
  ws: WebSocket | null = null
  offset = 0 // server - local (ms)
  rtt = 0
  remotes = new Map<string, RemoteCar>()
  private sendAcc = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<Listener>()
  private syncSamples: { offset: number; rtt: number }[] = []

  get myId() {
    return useNet.getState().myId
  }

  on(fn: Listener) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  url() {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env
    if (env?.VITE_SPEED_SERVER) return env.VITE_SPEED_SERVER
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}/ws`
  }

  connect(hello: { name: string; carId: string; color: string }) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return Promise.resolve()
    useNet.setState({ status: 'connecting', error: '' })
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(this.url())
      } catch (e) {
        useNet.setState({ status: 'error', error: 'Could not connect to the server' })
        reject(e)
        return
      }
      this.ws = ws
      const timer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close()
          useNet.setState({ status: 'error', error: 'Server not reachable. Start it with `bun run dev` (or `bun run start`).' })
          reject(new Error('timeout'))
        }
      }, 5000)
      ws.onopen = () => {
        clearTimeout(timer)
        this.send({ type: 'hello', ...hello })
        this.pingTimer = setInterval(() => this.send({ type: 'ping', t: Date.now() }), 1000)
        for (let i = 0; i < 4; i++) setTimeout(() => this.send({ type: 'ping', t: Date.now() }), i * 120)
        resolve()
      }
      ws.onmessage = (ev) => {
        let msg: ServerMsg
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        this.onMessage(msg)
      }
      ws.onclose = () => {
        clearTimeout(timer)
        if (this.pingTimer) clearInterval(this.pingTimer)
        this.ws = null
        this.remotes.clear()
        const st = useNet.getState()
        useNet.setState({ status: st.status === 'error' ? 'error' : 'offline', room: null })
      }
      ws.onerror = () => {
        useNet.setState({ status: 'error', error: 'Connection error. Is the multiplayer server running?' })
      }
    })
  }

  disconnect() {
    this.ws?.close()
    this.ws = null
  }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  serverNow() {
    return Date.now() + this.offset
  }

  private onMessage(msg: ServerMsg) {
    switch (msg.type) {
      case 'welcome':
        this.offset = msg.serverTime - Date.now()
        useNet.setState({ status: 'online', myId: msg.id })
        break
      case 'pong': {
        const now = Date.now()
        const rtt = now - msg.t
        const offset = msg.server - (msg.t + rtt / 2)
        this.syncSamples.push({ offset, rtt })
        if (this.syncSamples.length > 12) this.syncSamples.shift()
        // trust the samples with the lowest round trip
        const best = [...this.syncSamples].sort((a, b) => a.rtt - b.rtt).slice(0, 4)
        this.offset = best.reduce((a, b) => a + b.offset, 0) / best.length
        this.rtt = rtt
        useNet.setState({ ping: Math.round(rtt) })
        break
      }
      case 'room': {
        useNet.setState({ room: msg.room })
        // drop buffers of players that left
        for (const id of [...this.remotes.keys()]) if (!msg.room.players.some((p) => p.id === id)) this.remotes.delete(id)
        if (msg.room.phase === 'countdown') useNet.setState({ results: null })
        break
      }
      case 'left':
        useNet.setState({ room: null })
        this.remotes.clear()
        break
      case 'states':
        for (const { id, s } of msg.s) {
          let r = this.remotes.get(id)
          if (!r) {
            r = { id, buf: [], lastRecv: 0 }
            this.remotes.set(id, r)
          }
          // keep ordered by time, drop stale
          if (r.buf.length && s.t <= r.buf[r.buf.length - 1].t) continue
          r.buf.push({ t: s.t, s })
          r.lastRecv = Date.now()
          if (r.buf.length > 40) r.buf.splice(0, r.buf.length - 40)
        }
        break
      case 'results':
        useNet.setState({ results: msg.order })
        break
      case 'chat':
        useNet.setState({ chat: [...useNet.getState().chat.slice(-30), { name: msg.name, text: msg.text }] })
        break
      case 'error':
        useNet.setState({ error: msg.message })
        break
    }
    for (const l of this.listeners) l(msg)
  }

  // ------------------------------------------------------------------ lobby actions
  createRoom(laps: number, timeOfDay: number) {
    this.send({ type: 'create', laps, timeOfDay })
  }
  join(code: string) {
    this.send({ type: 'join', code })
  }
  quick() {
    this.send({ type: 'quick' })
  }
  setReady(ready: boolean) {
    this.send({ type: 'update', ready })
  }
  updateCar(carId: string, color: string, name?: string) {
    this.send({ type: 'update', carId, color, name })
  }
  configure(laps: number, timeOfDay: number) {
    this.send({ type: 'config', laps, timeOfDay })
  }
  start() {
    this.send({ type: 'start' })
  }
  leave() {
    this.send({ type: 'leave' })
    this.remotes.clear()
  }
  chat(text: string) {
    this.send({ type: 'chat', text })
  }

  // ------------------------------------------------------------------ in race
  /** Send the local car's state at STATE_HZ. */
  tick(dt: number, v: Vehicle | null, distance: number, lap: number) {
    if (!v || !this.ws) return
    this.sendAcc += dt
    if (this.sendAcc < 1 / STATE_HZ) return
    this.sendAcc = 0
    const r = (x: number, k = 1000) => Math.round(x * k) / k
    const w = v.wheels
    const s: CarState = {
      t: this.serverNow(),
      p: [r(v.pos.x), r(v.pos.y), r(v.pos.z)],
      q: [r(v.q.x, 1e4), r(v.q.y, 1e4), r(v.q.z, 1e4), r(v.q.w, 1e4)],
      v: [r(v.vel.x, 100), r(v.vel.y, 100), r(v.vel.z, 100)],
      w: [r(v.w.x, 100), r(v.w.y, 100), r(v.w.z, 100)],
      st: r(v.steerInput, 100),
      rpm: Math.round(v.rpm),
      g: v.gear,
      th: r(v.throttle, 100),
      br: r(v.brake, 100),
      c: [r(w[0].c), r(w[1].c), r(w[2].c), r(w[3].c)],
      o: [r(w[0].omega, 10), r(w[1].omega, 10), r(w[2].omega, 10), r(w[3].omega, 10)],
      sa: [r(w[0].steer, 1000), r(w[1].steer, 1000), r(w[2].tyre.combinedSlip, 100), r(w[3].tyre.combinedSlip, 100)],
      bt: [Math.round(w[0].brakeTemp), Math.round(w[1].brakeTemp), Math.round(w[2].brakeTemp), Math.round(w[3].brakeTemp)],
      d: r(distance, 10),
      lap,
      boost: r(v.engine.boost, 100),
      bf: r(v.engine.backfire, 100),
    }
    this.send({ type: 'state', s })
  }

  /** Interpolate a remote car's state into a Vehicle used purely for rendering/collisions. */
  applyRemote(id: string, v: Vehicle, dt: number): { distance: number; lap: number } | null {
    const r = this.remotes.get(id)
    if (!r || r.buf.length === 0) return null
    const rt = this.serverNow() - INTERP_DELAY
    const buf = r.buf
    let a = buf[0],
      b = buf[0]
    if (rt <= buf[0].t) {
      a = b = buf[0]
    } else if (rt >= buf[buf.length - 1].t) {
      a = b = buf[buf.length - 1]
    } else {
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= rt && buf[i + 1].t >= rt) {
          a = buf[i]
          b = buf[i + 1]
          break
        }
      }
      // drop snapshots we'll never need again
      const k = buf.indexOf(a)
      if (k > 2) buf.splice(0, k - 2)
    }
    const sa = a.s,
      sb = b.s
    if (a === b) {
      // extrapolate briefly with velocity
      const ex = Math.min(Math.max(0, rt - a.t), 300) / 1000
      v.pos.set(sa.p[0] + sa.v[0] * ex, sa.p[1] + sa.v[1] * ex, sa.p[2] + sa.v[2] * ex)
      v.q.set(sa.q[0], sa.q[1], sa.q[2], sa.q[3]).normalize()
    } else {
      const span = (b.t - a.t) / 1000
      const u = (rt - a.t) / (b.t - a.t)
      // cubic Hermite position using velocities
      const u2 = u * u,
        u3 = u2 * u
      const h00 = 2 * u3 - 3 * u2 + 1,
        h10 = u3 - 2 * u2 + u,
        h01 = -2 * u3 + 3 * u2,
        h11 = u3 - u2
      v.pos.set(
        h00 * sa.p[0] + h10 * span * sa.v[0] + h01 * sb.p[0] + h11 * span * sb.v[0],
        h00 * sa.p[1] + h10 * span * sa.v[1] + h01 * sb.p[1] + h11 * span * sb.v[1],
        h00 * sa.p[2] + h10 * span * sa.v[2] + h01 * sb.p[2] + h11 * span * sb.v[2],
      )
      slerp(v.q, sa.q, sb.q, u)
    }
    const lerp = (x: number, y: number) => x + (y - x) * (a === b ? 0 : Math.min(1, Math.max(0, (rt - a.t) / (b.t - a.t))))
    v.vel.set(lerp(sa.v[0], sb.v[0]), lerp(sa.v[1], sb.v[1]), lerp(sa.v[2], sb.v[2]))
    v.w.set(sb.w[0], sb.w[1], sb.w[2])
    v.updateAxes()
    v.speed = v.vel.len()
    v.steerInput = sb.st
    v.throttle = sb.th
    v.brake = sb.br
    v.gear = sb.g
    v.engine.omega = (lerp(sa.rpm, sb.rpm) * Math.PI) / 30
    v.engine.throttleEff = sb.th
    v.engine.boost = sb.boost
    v.engine.backfire = sb.bf
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i]
      w.c = lerp(sa.c[i], sb.c[i])
      w.omega = sb.o[i]
      w.spin += w.omega * dt
      w.brakeTemp = sb.bt[i]
    }
    v.wheels[0].steer = sb.sa[0]
    v.wheels[1].steer = sb.sa[1]
    v.updateWheelWorld()
    return { distance: lerp(sa.d, sb.d), lap: sb.lap }
  }
}

function slerp(out: Quat, a: number[], b: number[], t: number) {
  let bx = b[0],
    by = b[1],
    bz = b[2],
    bw = b[3]
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw
  if (cos < 0) {
    cos = -cos
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let k0 = 1 - t,
    k1 = t
  if (cos < 0.9995) {
    const s = Math.sqrt(1 - cos * cos)
    const ang = Math.atan2(s, cos)
    k0 = Math.sin((1 - t) * ang) / s
    k1 = Math.sin(t * ang) / s
  }
  out.set(a[0] * k0 + bx * k1, a[1] * k0 + by * k1, a[2] * k0 + bz * k1, a[3] * k0 + bw * k1).normalize()
}

export const net = new NetClient()
void V3
