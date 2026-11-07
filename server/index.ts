// SPEED multiplayer + static server (Bun).
//   bun server/index.ts            -> WebSocket server on :3001 (dev, Vite proxies /ws)
//   NODE_ENV=production bun ...    -> also serves ./dist on the same port
import type { ServerWebSocket } from 'bun'
import { type CarState, type ClientMsg, MAX_PLAYERS, type PlayerInfo, type RoomInfo, type ServerMsg, STATE_HZ } from '../src/net/protocol'

const PORT = Number(process.env.PORT ?? process.env.SPEED_SERVER_PORT ?? 3001)
const PROD = process.env.NODE_ENV === 'production'
const DIST = new URL('../dist/', import.meta.url).pathname

interface Conn {
  id: string
  name: string
  carId: string
  color: string
  room: Room | null
  ready: boolean
  lastState: CarState | null
  stateDirty: boolean
  finished: boolean
  finishTime: number
  bestLap: number
  ping: number
  grid: number
  lastSeen: number
  msgBudget: number
}

interface Room {
  code: string
  hostId: string
  phase: RoomInfo['phase']
  laps: number
  trackId: string
  timeOfDay: number
  startAt: number
  members: Map<string, ServerWebSocket<Conn>>
  finishOrder: string[]
  firstFinishAt: number
}

const rooms = new Map<string, Room>()
let nextId = 1

function code() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let c = ''
  do {
    c = Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join('')
  } while (rooms.has(c))
  return c
}

function send(ws: ServerWebSocket<Conn>, msg: ServerMsg) {
  ws.send(JSON.stringify(msg))
}

function broadcast(room: Room, msg: ServerMsg, except?: string) {
  const data = JSON.stringify(msg)
  for (const [id, ws] of room.members) if (id !== except) ws.send(data)
}

function roomInfo(room: Room): RoomInfo {
  const players: PlayerInfo[] = [...room.members.values()].map((ws) => {
    const d = ws.data
    return { id: d.id, name: d.name, carId: d.carId, color: d.color, ready: d.ready, grid: d.grid, finished: d.finished, finishTime: d.finishTime, bestLap: d.bestLap, ping: d.ping }
  })
  return { code: room.code, hostId: room.hostId, phase: room.phase, laps: room.laps, trackId: room.trackId, timeOfDay: room.timeOfDay, startAt: room.startAt, players }
}

function pushRoom(room: Room) {
  broadcast(room, { type: 'room', room: roomInfo(room) })
}

function leaveRoom(ws: ServerWebSocket<Conn>) {
  const room = ws.data.room
  if (!room) return
  room.members.delete(ws.data.id)
  ws.data.room = null
  ws.data.ready = false
  send(ws, { type: 'left' })
  if (room.members.size === 0) {
    rooms.delete(room.code)
    return
  }
  if (room.hostId === ws.data.id) room.hostId = room.members.keys().next().value!
  checkRaceEnd(room)
  pushRoom(room)
}

function joinRoom(ws: ServerWebSocket<Conn>, room: Room) {
  if (ws.data.room) leaveRoom(ws)
  if (room.members.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'Room is full' })
  if (room.phase !== 'lobby' && room.phase !== 'results') return send(ws, { type: 'error', message: 'Race in progress — try again shortly' })
  room.members.set(ws.data.id, ws)
  ws.data.room = room
  ws.data.ready = false
  ws.data.finished = false
  pushRoom(room)
}

function startRace(room: Room) {
  room.phase = 'countdown'
  room.startAt = Date.now() + 6500
  room.finishOrder = []
  room.firstFinishAt = 0
  let g = 0
  for (const ws of room.members.values()) {
    ws.data.grid = g++
    ws.data.finished = false
    ws.data.finishTime = 0
    ws.data.bestLap = 0
    ws.data.lastState = null
  }
  pushRoom(room)
}

function checkRaceEnd(room: Room) {
  if (room.phase !== 'racing' && room.phase !== 'countdown') return
  const all = [...room.members.values()]
  const done = all.every((w) => w.data.finished)
  const timeout = room.firstFinishAt > 0 && Date.now() - room.firstFinishAt > 60000
  if (all.length === 0 || done || timeout) {
    room.phase = 'results'
    const finished = room.finishOrder.map((id) => room.members.get(id)).filter(Boolean) as ServerWebSocket<Conn>[]
    const dnf = all.filter((w) => !w.data.finished)
    broadcast(room, {
      type: 'results',
      order: [...finished.map((w) => ({ id: w.data.id, name: w.data.name, time: w.data.finishTime, bestLap: w.data.bestLap, dnf: false })), ...dnf.map((w) => ({ id: w.data.id, name: w.data.name, time: 0, bestLap: w.data.bestLap, dnf: true }))],
    })
    for (const w of all) w.data.ready = false
    pushRoom(room)
  }
}

function handle(ws: ServerWebSocket<Conn>, msg: ClientMsg) {
  const c = ws.data
  c.lastSeen = Date.now()
  switch (msg.type) {
    case 'hello':
      c.name = String(msg.name || 'Driver').slice(0, 20)
      c.carId = String(msg.carId || 'vanta-gt3').slice(0, 32)
      c.color = /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : '#c8102e'
      break
    case 'create': {
      const room: Room = { code: code(), hostId: c.id, phase: 'lobby', laps: clampInt(msg.laps, 1, 50, 5), trackId: 'valle-alta', timeOfDay: Number(msg.timeOfDay) || 18.5, startAt: 0, members: new Map(), finishOrder: [], firstFinishAt: 0 }
      rooms.set(room.code, room)
      joinRoom(ws, room)
      break
    }
    case 'join': {
      const room = rooms.get(String(msg.code || '').toUpperCase().trim())
      if (!room) return send(ws, { type: 'error', message: 'Room not found' })
      joinRoom(ws, room)
      break
    }
    case 'quick': {
      const open = [...rooms.values()].find((r) => r.phase === 'lobby' && r.members.size < MAX_PLAYERS)
      if (open) joinRoom(ws, open)
      else handle(ws, { type: 'create', laps: 5, timeOfDay: 18.5 })
      break
    }
    case 'update':
      if (msg.name) c.name = String(msg.name).slice(0, 20)
      if (msg.carId) c.carId = String(msg.carId).slice(0, 32)
      if (msg.color && /^#[0-9a-f]{6}$/i.test(msg.color)) c.color = msg.color
      if (typeof msg.ready === 'boolean') c.ready = msg.ready
      if (c.room) pushRoom(c.room)
      break
    case 'config':
      if (c.room && c.room.hostId === c.id && c.room.phase === 'lobby') {
        if (msg.laps) c.room.laps = clampInt(msg.laps, 1, 50, c.room.laps)
        if (msg.timeOfDay) c.room.timeOfDay = Math.min(21, Math.max(6, Number(msg.timeOfDay)))
        pushRoom(c.room)
      }
      break
    case 'start':
      if (c.room && c.room.hostId === c.id && (c.room.phase === 'lobby' || c.room.phase === 'results')) startRace(c.room)
      break
    case 'state':
      if (c.room && (c.room.phase === 'racing' || c.room.phase === 'countdown')) {
        c.lastState = msg.s
        c.stateDirty = true
      }
      break
    case 'lap':
      if (c.room) broadcast(c.room, { type: 'lap', id: c.id, lap: msg.lap, time: msg.time, valid: msg.valid }, c.id)
      break
    case 'finish':
      if (c.room && !c.finished && (c.room.phase === 'racing' || c.room.phase === 'countdown')) {
        c.finished = true
        c.finishTime = Number(msg.time) || 0
        c.bestLap = Number(msg.bestLap) || 0
        c.room.finishOrder.push(c.id)
        if (!c.room.firstFinishAt) c.room.firstFinishAt = Date.now()
        broadcast(c.room, { type: 'finish', id: c.id, time: c.finishTime, position: c.room.finishOrder.length })
        checkRaceEnd(c.room)
      }
      break
    case 'chat':
      if (c.room) broadcast(c.room, { type: 'chat', id: c.id, name: c.name, text: String(msg.text).slice(0, 200) })
      break
    case 'ping':
      send(ws, { type: 'pong', t: msg.t, server: Date.now() })
      c.ping = Math.max(0, Date.now() - (Number(msg.t) || Date.now()))
      break
    case 'leave':
      leaveRoom(ws)
      break
  }
}

function clampInt(v: unknown, lo: number, hi: number, d: number) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}

// fixed-rate state relay + race phase bookkeeping
setInterval(() => {
  const now = Date.now()
  for (const room of rooms.values()) {
    if (room.phase === 'countdown' && now >= room.startAt) {
      room.phase = 'racing'
      pushRoom(room)
    }
    if (room.phase === 'racing' || room.phase === 'countdown') {
      const batch: { id: string; s: CarState }[] = []
      for (const ws of room.members.values()) {
        if (ws.data.stateDirty && ws.data.lastState) {
          batch.push({ id: ws.data.id, s: ws.data.lastState })
          ws.data.stateDirty = false
        }
      }
      if (batch.length) {
        // each client receives everybody else's state
        for (const [id, ws] of room.members) {
          const others = batch.filter((b) => b.id !== id)
          if (others.length) send(ws, { type: 'states', s: others })
        }
      }
      if (room.firstFinishAt) checkRaceEnd(room)
    }
  }
}, 1000 / STATE_HZ)

const MIME: Record<string, string> = {
  html: 'text/html',
  js: 'text/javascript',
  css: 'text/css',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  glb: 'model/gltf-binary',
  bin: 'application/octet-stream',
  json: 'application/json',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ico: 'image/x-icon',
  wasm: 'application/wasm',
}
/** Types worth gzipping (images and fonts are compressed already). */
const COMPRESSIBLE = new Set(['html', 'js', 'css', 'svg', 'json', 'glb', 'bin', 'wasm'])
/**
 * Compressed copies, made once per file version (the car models are tens of MB: meshopt geometry
 * gzips well, their WebP textures don't, so it saves 10-15% there and far more on the code).
 */
const gzCache = new Map<string, { tag: string; body: Blob | null }>()

async function serveStatic(req: Request, path: string) {
  const file = Bun.file(DIST + path.slice(1))
  if (!(await file.exists())) return new Response('Not found', { status: 404 })
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  // weak validator from size and modification time: unhashed assets (models, world textures)
  // revalidate instead of being downloaded again
  const tag = `W/"${file.size.toString(36)}-${Math.floor(file.lastModified).toString(36)}"`
  const headers: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', ETag: tag, Vary: 'Accept-Encoding' }
  headers['Cache-Control'] = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : path === '/index.html' ? 'no-cache' : 'public, max-age=3600, must-revalidate'
  if (req.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers })
  if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '')) {
    let c = gzCache.get(path)
    if (!c || c.tag !== tag) {
      const raw = new Uint8Array(await file.arrayBuffer())
      const gz = Bun.gzipSync(raw, { level: 6 })
      // keep it only where it saves something worth the decompression
      c = { tag, body: gz.length < raw.length * 0.95 ? new Blob([gz]) : null }
      gzCache.set(path, c)
    }
    if (c.body) return new Response(c.body, { headers: { ...headers, 'Content-Encoding': 'gzip' } })
  }
  return new Response(file, { headers })
}

const server = Bun.serve<Conn>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') {
      const ok = srv.upgrade(req, {
        data: { id: 'p' + (nextId++).toString(36), name: 'Driver', carId: 'vanta-gt3', color: '#c8102e', room: null, ready: false, lastState: null, stateDirty: false, finished: false, finishTime: 0, bestLap: 0, ping: 0, grid: 0, lastSeen: Date.now(), msgBudget: 200 },
      })
      return ok ? undefined : new Response('Upgrade failed', { status: 400 })
    }
    if (url.pathname === '/health') return Response.json({ ok: true, rooms: rooms.size })
    if (!PROD) return new Response('SPEED multiplayer server. Run the client with `bun run dev`.', { status: 200 })
    // static files from dist (SPA fallback)
    let path = decodeURIComponent(url.pathname)
    if (path.includes('..')) return new Response('Bad request', { status: 400 })
    if (path === '/' || !path.includes('.')) path = '/index.html'
    return serveStatic(req, path)
  },
  websocket: {
    idleTimeout: 60,
    maxPayloadLength: 64 * 1024,
    open(ws) {
      send(ws, { type: 'welcome', id: ws.data.id, serverTime: Date.now() })
    },
    message(ws, raw) {
      let msg: ClientMsg
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return
      handle(ws, msg)
    },
    close(ws) {
      leaveRoom(ws)
    },
  },
})

console.log(`SPEED server listening on :${server.port}${PROD ? ' (serving dist/)' : ''}`)
