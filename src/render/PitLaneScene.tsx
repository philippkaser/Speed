// Pit lane: entry and exit roads, the lane with its painted lines and team boxes, garage name boards
// and, in team races, the pit crews (they run out for a stop and crouch at the wheels).
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { float, mix, mx_noise_float, positionWorld, texture, uv, vec3 } from 'three/tsl'
import { game } from '../game/game'
import { teamRace } from '../team/session'
import { pitLane } from '../track/pitlane'
import type { Track } from '../track/track'
import { canvasTexture, getTextures } from './textures'

const _p = { x: 0, y: 0, z: 0 }

function ribbon(track: Track, s0: number, s1: number, edges: (s: number) => [number, number], lift = 0.03, step = 2) {
  const pos: number[] = [],
    uvs: number[] = [],
    idx: number[] = []
  let k = 0
  for (let s = s0; s <= s1 + 1e-6; s += step) {
    const [a, b] = edges(s)
    track.pointAt(s, a, _p)
    pos.push(_p.x, _p.y + lift, _p.z)
    uvs.push(_p.x / 4, _p.z / 4)
    track.pointAt(s, b, _p)
    pos.push(_p.x, _p.y + lift, _p.z)
    uvs.push(_p.x / 4, _p.z / 4)
    if (k > 0) {
      const i = (k - 1) * 2
      idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3)
    }
    k++
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  // the ribbons run in +s with d to the left: make sure normals point up
  const n = g.getAttribute('normal') as THREE.BufferAttribute
  if (n.getY(0) < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]]
    g.setIndex(idx)
    g.computeVertexNormals()
  }
  return g
}

function pitAsphalt() {
  const t = getTextures().asphalt
  const m = new THREE.MeshStandardNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  const tex = texture(t.map, uv())
  const macro = mx_noise_float(vec3(positionWorld.x.mul(0.05), 0, positionWorld.z.mul(0.05))).mul(0.5).add(0.5)
  m.colorNode = tex.rgb.mul(mix(float(0.62), float(0.78), macro))
  m.roughnessNode = tex.a.mul(0.95)
  return m
}

function boardTexture(name: string, color: string, accent: string) {
  return canvasTexture(1024, 160, (ctx) => {
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1024, 160)
    ctx.fillStyle = accent
    ctx.fillRect(0, 140, 1024, 20)
    ctx.fillStyle = accent
    ctx.font = '800 86px Inter, Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(name.toUpperCase(), 512, 74)
  })
}

const CREW = 7
// service positions around the car in (ds, dd) relative to the box, and idle positions at the garage
const SERVICE: [number, number][] = [
  [1.45, 1.3],
  [1.45, -1.3],
  [-1.3, 1.3],
  [-1.3, -1.3],
  [3.0, 0],
  [-3.0, 0],
  [-0.4, 1.9],
]

export function PitLaneScene({ track }: { track: Track }) {
  const lane = pitLane(track)
  const tr = teamRace()
  const teams = tr ? [...new Map(tr.cars.map((c) => [c.team.box, c.team])).values()] : []
  const teamKey = teams.map((t) => t.id + t.color + t.name).join('|')

  const statics = useMemo(() => {
    const g = new THREE.Group()
    const mat = pitAsphalt()
    const wallI = track.idx(-110)
    const wall = track.L.wall[wallI]
    // entry and exit roads (8 m), lane between the pit wall and the garages
    const roadEdges = (d0: number) => (s: number) => {
      const c = lane.roadD(s, d0)
      return [c - 4, c + 4] as [number, number]
    }
    const parts = [ribbon(track, lane.sEntry + 20, lane.sLaneStart, roadEdges(4.5)), ribbon(track, lane.sLaneStart, lane.sLaneEnd, () => [wall + 0.6, lane.dGarage], 0.03, 2), ribbon(track, lane.sLaneEnd, lane.sExit - 10, roadEdges(0))]
    for (const geo of parts) {
      const m = new THREE.Mesh(geo, mat)
      m.receiveShadow = true
      g.add(m)
    }
    // painted lines: lane edges and the dashed line between the fast and the working lane
    const paint = new THREE.MeshStandardNodeMaterial({ color: 0xe8e8e4, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
    const sep = (lane.dFast + lane.dBox) / 2 - 1.6
    const lines = [ribbon(track, lane.sLaneStart, lane.sLaneEnd, () => [wall + 0.8, wall + 1.0], 0.035), ribbon(track, lane.sLaneStart, lane.sLaneEnd, () => [lane.dGarage - 0.35, lane.dGarage - 0.15], 0.035)]
    for (let s = lane.sLaneStart; s < lane.sLaneEnd; s += 6) lines.push(ribbon(track, s, s + 3, () => [sep - 0.1, sep + 0.1], 0.035, 1))
    // speed limit lines across the lane
    for (const s of [lane.sLaneStart, lane.sLaneEnd]) lines.push(ribbon(track, s, s + 0.4, () => [wall + 0.6, lane.dGarage], 0.036, 0.4))
    for (const geo of lines) g.add(new THREE.Mesh(geo, paint))
    return g
  }, [track, lane])

  const boxes = useMemo(() => {
    const g = new THREE.Group()
    const list = lane.boxS.map((s, i) => teams.find((t) => t.box === i) ?? { name: '', color: '#3a3d42', accent: '#9ea3a8', box: i })
    for (const t of list) {
      const s = lane.boxS[t.box]
      // box rectangle in the team colour
      const fill = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(t.color).multiplyScalar(0.8), roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
      g.add(new THREE.Mesh(ribbon(track, s - 3.2, s + 3.2, () => [lane.dBox - 1.6, lane.dBox + 1.6], 0.034, 0.8), fill))
      const edge = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(t.accent), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
      for (const ds of [-3.2, 3.0]) g.add(new THREE.Mesh(ribbon(track, s + ds, s + ds + 0.2, () => [lane.dBox - 1.6, lane.dBox + 1.6], 0.036, 0.2), edge))
      // team board above the garage door
      if (t.name) {
        const tex = boardTexture(t.name, t.color, t.accent)
        const board = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.56), new THREE.MeshBasicNodeMaterial({ map: tex }))
        track.pointAt(s, lane.dGarage + 0.45, _p)
        board.position.set(_p.x, _p.y + 4.75, _p.z)
        // face the lane (towards -d)
        board.rotation.y = track.headingAt(s) - Math.PI / 2
        g.add(board)
      }
    }
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, lane, teamKey])

  // pit crews (team races)
  const crew = useMemo(() => {
    if (!teams.length) return null
    const body = new THREE.CapsuleGeometry(0.22, 0.95, 4, 8)
    body.translate(0, 0.7, 0)
    const head = new THREE.SphereGeometry(0.16, 10, 8)
    head.translate(0, 1.55, 0)
    const n = teams.length * CREW
    const bodies = new THREE.InstancedMesh(body, new THREE.MeshStandardNodeMaterial({ roughness: 0.75 }), n)
    const heads = new THREE.InstancedMesh(head, new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.2 }), n)
    const c = new THREE.Color()
    teams.forEach((t, ti) => {
      for (let k = 0; k < CREW; k++) {
        bodies.setColorAt(ti * CREW + k, c.set(t.color))
        heads.setColorAt(ti * CREW + k, c.set(t.accent))
      }
    })
    bodies.castShadow = heads.castShadow = true
    return { bodies, heads, teams, t: new Float32Array(n), m: new THREE.Matrix4(), q: new THREE.Quaternion(), sc: new THREE.Vector3(), v: new THREE.Vector3() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamKey])

  useEffect(
    () => () => {
      crew?.bodies.dispose()
      crew?.heads.dispose()
    },
    [crew],
  )

  useFrame((_, dt) => {
    const race = teamRace()
    if (!crew || !race) return
    const up = new THREE.Vector3(0, 1, 0)
    crew.teams.forEach((t, ti) => {
      const s = lane.boxS[t.box]
      // is a car of this team arriving or in service?
      const car = race.cars.find((c) => c.team.box === t.box && c.pit && c.pit.path && ((c.pit.phase === 'in' && c.pit.u > c.pit.path.boxU - 70) || c.pit.phase === 'service'))
      const servicing = car?.pit?.phase === 'service'
      const yaw = track.headingAt(s)
      crew.q.setFromAxisAngle(up, yaw)
      for (let k = 0; k < CREW; k++) {
        const i = ti * CREW + k
        crew.t[i] += ((car ? 1 : 0) - crew.t[i]) * Math.min(1, dt * (car ? 2.2 : 0.8))
        const f = crew.t[i] * crew.t[i] * (3 - 2 * crew.t[i])
        const idleS = s - 4.5 + k * 1.5,
          idleD = lane.dGarage - 1.2
        const [ss, sd] = SERVICE[k]
        track.pointAt(idleS + (s + ss - idleS) * f, idleD + (lane.dBox + sd - idleD) * f, _p)
        const crouch = servicing && k < 4 ? 0.62 : 1
        crew.m.compose(crew.v.set(_p.x, _p.y, _p.z), crew.q, crew.sc.set(1, crouch, 1))
        crew.bodies.setMatrixAt(i, crew.m)
        crew.m.compose(crew.v.set(_p.x, _p.y - (1 - crouch) * 1.55, _p.z), crew.q, crew.sc.set(1, 1, 1))
        crew.heads.setMatrixAt(i, crew.m)
      }
    })
    crew.bodies.instanceMatrix.needsUpdate = true
    crew.heads.instanceMatrix.needsUpdate = true
    void game
  })

  return (
    <>
      <primitive object={statics} />
      <primitive object={boxes} />
      {crew && <primitive object={crew.bodies} />}
      {crew && <primitive object={crew.heads} />}
    </>
  )
}
