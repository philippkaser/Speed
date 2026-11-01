// Tyre smoke, dust, skid marks and sparks driven by the physics state.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { attribute, color, float, mix, smoothstep, uv, vec3, length, mx_noise_float, positionWorld, time } from 'three/tsl'
import { game } from '../game/game'
import { Surface } from '../physics/ground'
import { clamp } from '../physics/math'

const MAX_SMOKE = 900
const MAX_SPARKS = 400
const MAX_SKID = 6000

interface Particle {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  age: number
  life: number
  size: number
  grow: number
  alpha: number
  r: number
  g: number
  b: number
}

function smokeMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false })
  const a = attribute('aAlpha', 'float')
  const tint = attribute('aTint', 'vec3')
  const d = length(uv().sub(0.5)).mul(2)
  const n = mx_noise_float(vec3(uv().mul(3.5), time.mul(0.3).add(positionWorld.x.mul(0.05)))).mul(0.5).add(0.5)
  const soft = smoothstep(1.0, 0.15, d).mul(n.mul(0.7).add(0.3))
  m.colorNode = tint
  m.opacityNode = soft.mul(a)
  m.roughnessNode = float(1)
  m.metalnessNode = float(0)
  // light scattering through the plume
  m.emissiveNode = tint.mul(0.12)
  return m
}

function sparkMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  const a = attribute('aAlpha', 'float')
  const d = length(uv().sub(0.5)).mul(2)
  m.colorNode = mix(color(8, 2.4, 0.4), color(12, 9, 4), a).mul(smoothstep(1, 0.2, d))
  m.opacityNode = a
  return m
}

function skidMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
  const a = attribute('aAlpha', 'float')
  const across = uv().x
  const grooves = mx_noise_float(vec3(across.mul(40), uv().y.mul(0.5), 0)).mul(0.3).add(0.7)
  m.colorNode = vec3(0.012, 0.012, 0.012)
  m.roughnessNode = float(0.7)
  m.opacityNode = a.mul(grooves).mul(smoothstep(0.0, 0.15, across).mul(smoothstep(1.0, 0.85, across)))
  return m
}

export function Effects() {
  const { camera } = useThree()
  const sys = useMemo(() => {
    // ---- smoke
    const quad = new THREE.PlaneGeometry(1, 1)
    const smokeGeo = quad.clone()
    const smokeAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SMOKE), 1)
    const smokeTint = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SMOKE * 3), 3)
    smokeGeo.setAttribute('aAlpha', smokeAlpha)
    smokeGeo.setAttribute('aTint', smokeTint)
    const smoke = new THREE.InstancedMesh(smokeGeo, smokeMaterial(), MAX_SMOKE)
    smoke.frustumCulled = false
    smoke.count = 0
    smoke.renderOrder = 5
    // ---- sparks
    const sparkGeo = quad.clone()
    const sparkAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPARKS), 1)
    sparkGeo.setAttribute('aAlpha', sparkAlpha)
    const sparks = new THREE.InstancedMesh(sparkGeo, sparkMaterial(), MAX_SPARKS)
    sparks.frustumCulled = false
    sparks.count = 0
    sparks.renderOrder = 6
    // ---- skid marks: ring buffer of quads
    const skidGeo = new THREE.BufferGeometry()
    const skidPos = new Float32Array(MAX_SKID * 4 * 3)
    const skidUV = new Float32Array(MAX_SKID * 4 * 2)
    const skidA = new Float32Array(MAX_SKID * 4)
    const skidIdx = new Uint32Array(MAX_SKID * 6)
    for (let i = 0; i < MAX_SKID; i++) {
      const b = i * 4
      skidIdx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], i * 6)
      skidUV.set([0, 0, 1, 0, 0, 1, 1, 1], i * 8)
    }
    skidGeo.setAttribute('position', new THREE.BufferAttribute(skidPos, 3).setUsage(THREE.DynamicDrawUsage))
    skidGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAX_SKID * 4 * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
    skidGeo.setAttribute('uv', new THREE.BufferAttribute(skidUV, 2))
    skidGeo.setAttribute('aAlpha', new THREE.BufferAttribute(skidA, 1).setUsage(THREE.DynamicDrawUsage))
    skidGeo.setIndex(new THREE.BufferAttribute(skidIdx, 1))
    skidGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5)
    const skids = new THREE.Mesh(skidGeo, skidMaterial())
    skids.frustumCulled = false
    skids.receiveShadow = true
    skids.renderOrder = 1
    return {
      smoke,
      smokeAlpha,
      smokeTint,
      sparks,
      sparkAlpha,
      skids,
      skidPos,
      skidA,
      skidHead: 0,
      smokeP: [] as Particle[],
      sparkP: [] as Particle[],
      lastContact: new Map<string, { x: number; y: number; z: number; lx: number; lz: number; on: boolean }>(),
      eventCursor: 0,
    }
  }, [])

  useEffect(
    () => () => {
      sys.smoke.geometry.dispose()
      sys.sparks.geometry.dispose()
      sys.skids.geometry.dispose()
    },
    [sys],
  )

  const m4 = useMemo(() => new THREE.Matrix4(), [])
  const q = useMemo(() => new THREE.Quaternion(), [])
  const sc = useMemo(() => new THREE.Vector3(), [])
  const p3 = useMemo(() => new THREE.Vector3(), [])

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05)
    const camPos = camera.position
    let skidDirty = false
    // ------------------------------------------------------------- emitters
    for (const c of game.cars) {
      const v = c.sim.vehicle
      const near = camPos.distanceToSquared(v.pos as unknown as THREE.Vector3) < 400 * 400
      for (let wi = 0; wi < 4; wi++) {
        const w = v.wheels[wi]
        const key = c.id + wi
        const t = w.tyre
        const onTarmac = w.surface === Surface.Asphalt || w.surface === Surface.Kerb || w.surface === Surface.Runoff || w.surface === Surface.Pit
        const sliding = w.contact && onTarmac && (t.combinedSlip > 1.15 || Math.abs(t.slipRatio) > 0.3) && t.slideVel > 2.5
        // smoke from hard sliding (slip power), dust off-track
        if (near && w.contact) {
          if (sliding) {
            const rate = clamp((t.slipPower - 9000) / 30000, 0, 1) * 60 * dt
            emitN(sys.smokeP, rate, () => ({
              x: w.contactPoint.x + (Math.random() - 0.5) * 0.3,
              y: w.contactPoint.y + 0.15,
              z: w.contactPoint.z + (Math.random() - 0.5) * 0.3,
              vx: v.vel.x * 0.25 + (Math.random() - 0.5) * 1.2,
              vy: 0.6 + Math.random() * 0.8,
              vz: v.vel.z * 0.25 + (Math.random() - 0.5) * 1.2,
              age: 0,
              life: 2.2 + Math.random() * 1.8,
              size: 0.7,
              grow: 1.6,
              alpha: 0.32,
              r: 0.82,
              g: 0.82,
              b: 0.84,
            }))
          } else if (!onTarmac && v.speed > 6 && (w.surface === Surface.Gravel || w.surface === Surface.Grass)) {
            const gravel = w.surface === Surface.Gravel
            const rate = clamp(v.speed / 30, 0, 1) * (gravel ? 45 : 18) * dt
            emitN(sys.smokeP, rate, () => ({
              x: w.contactPoint.x,
              y: w.contactPoint.y + 0.1,
              z: w.contactPoint.z,
              vx: v.vel.x * 0.4 + (Math.random() - 0.5) * 2,
              vy: 0.8 + Math.random() * 1.5,
              vz: v.vel.z * 0.4 + (Math.random() - 0.5) * 2,
              age: 0,
              life: 1.6 + Math.random(),
              size: 0.9,
              grow: 2.2,
              alpha: gravel ? 0.4 : 0.22,
              r: gravel ? 0.55 : 0.36,
              g: gravel ? 0.47 : 0.33,
              b: gravel ? 0.36 : 0.22,
            }))
          }
        }
        // skid marks
        const prev = sys.lastContact.get(key)
        const cp = w.contactPoint
        if (sliding || (w.contact && !onTarmac && v.speed > 4)) {
          const alpha = onTarmac ? clamp((t.combinedSlip - 1.1) * 0.9, 0.15, 0.75) : 0.35
          if (prev && prev.on) {
            const dx = cp.x - prev.x,
              dz = cp.z - prev.z
            const d2 = dx * dx + dz * dz
            if (d2 > 0.16) {
              const len = Math.sqrt(d2)
              const hw = w.model.spec.width * 0.5
              const lx = (-dz / len) * hw,
                lz = (dx / len) * hw
              const i = sys.skidHead
              const b = i * 12
              const lift = 0.012
              sys.skidPos.set([prev.x - prev.lx, prev.y + lift, prev.z - prev.lz, prev.x + prev.lx, prev.y + lift, prev.z + prev.lz, cp.x - lx, cp.y + lift, cp.z - lz, cp.x + lx, cp.y + lift, cp.z + lz], b)
              sys.skidA.set([alpha, alpha, alpha, alpha], i * 4)
              sys.skidHead = (i + 1) % MAX_SKID
              skidDirty = true
              sys.lastContact.set(key, { x: cp.x, y: cp.y, z: cp.z, lx, lz, on: true })
            }
          } else {
            const hw = w.model.spec.width * 0.5
            sys.lastContact.set(key, { x: cp.x, y: cp.y, z: cp.z, lx: v.left.x * hw, lz: v.left.z * hw, on: true })
          }
        } else if (prev) prev.on = false
      }
      // sparks from scraping
      if (near && v.scrape > 0.05) {
        emitN(sys.sparkP, v.scrape * 160 * dt, () => ({
          x: v.pos.x + (Math.random() - 0.5) * 1.6,
          y: v.pos.y - 0.35,
          z: v.pos.z + (Math.random() - 0.5) * 3,
          vx: v.vel.x * 0.8 + (Math.random() - 0.5) * 5,
          vy: Math.random() * 3,
          vz: v.vel.z * 0.8 + (Math.random() - 0.5) * 5,
          age: 0,
          life: 0.25 + Math.random() * 0.4,
          size: 0.05,
          grow: 0,
          alpha: 1,
          r: 1,
          g: 1,
          b: 1,
        }))
      }
    }
    // collision sparks
    const ev = game.world.events
    for (const e of ev) {
      if (e.kind === 'ground') continue
      const n = clamp(e.impulse / 400, 2, 40)
      emitN(sys.sparkP, n, () => ({
        x: e.x,
        y: e.y,
        z: e.z,
        vx: (Math.random() - 0.5) * 9,
        vy: Math.random() * 5,
        vz: (Math.random() - 0.5) * 9,
        age: 0,
        life: 0.3 + Math.random() * 0.5,
        size: 0.05,
        grow: 0,
        alpha: 1,
        r: 1,
        g: 1,
        b: 1,
      }))
    }
    ev.length = 0

    // ------------------------------------------------------------- simulate & upload
    const camQ = camera.quaternion
    let n = 0
    const P = sys.smokeP
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i]
      p.age += dt
      if (p.age >= p.life) {
        P[i] = P[P.length - 1]
        P.pop()
        continue
      }
      const drag = Math.exp(-dt * 1.4)
      p.vx *= drag
      p.vz *= drag
      p.vy = p.vy * drag + 0.25 * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
    }
    for (const p of P) {
      if (n >= MAX_SMOKE) break
      const t = p.age / p.life
      const size = p.size + p.grow * Math.sqrt(t) * 2.2
      m4.compose(p3.set(p.x, p.y, p.z), camQ, sc.set(size, size, size))
      sys.smoke.setMatrixAt(n, m4)
      sys.smokeAlpha.setX(n, p.alpha * (1 - t) * Math.min(1, t * 8))
      sys.smokeTint.setXYZ(n, p.r, p.g, p.b)
      n++
    }
    sys.smoke.count = n
    sys.smoke.instanceMatrix.needsUpdate = true
    sys.smokeAlpha.needsUpdate = true
    sys.smokeTint.needsUpdate = true

    let k = 0
    const S = sys.sparkP
    for (let i = S.length - 1; i >= 0; i--) {
      const p = S[i]
      p.age += dt
      if (p.age >= p.life || p.y < -100) {
        S[i] = S[S.length - 1]
        S.pop()
        continue
      }
      p.vy -= 9.81 * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
    }
    for (const p of S) {
      if (k >= MAX_SPARKS) break
      const t = p.age / p.life
      // stretch along velocity
      const vel = Math.hypot(p.vx, p.vy, p.vz)
      m4.compose(p3.set(p.x, p.y, p.z), camQ, sc.set(0.04, 0.04 + vel * 0.012, 0.04))
      sys.sparks.setMatrixAt(k, m4)
      sys.sparkAlpha.setX(k, 1 - t)
      k++
    }
    sys.sparks.count = k
    sys.sparks.instanceMatrix.needsUpdate = true
    sys.sparkAlpha.needsUpdate = true

    if (skidDirty) {
      ;(sys.skids.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
      ;(sys.skids.geometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true
    }
    void q
  }, 0)

  return (
    <>
      <primitive object={sys.skids} />
      <primitive object={sys.smoke} />
      <primitive object={sys.sparks} />
    </>
  )
}

function emitN(list: Particle[], rate: number, make: () => Particle) {
  let count = Math.floor(rate)
  if (Math.random() < rate - count) count++
  for (let i = 0; i < count && list.length < 2000; i++) list.push(make())
}
