// Tyre smoke, dust, skid marks and sparks driven by the physics state.
//
// Smoke is emitted from the contact patch in proportion to the friction power above the point where
// the tread starts to vaporise (hotter tread smokes more). Each puff then:
//  - is carried by the car's wake (air dragged along behind the car, decaying with distance) and
//    relaxes towards it with an aerodynamic drag time constant,
//  - rises with buoyancy that fades as it cools, and wanders with turbulence (a random-walk velocity),
//  - rolls along the road instead of sinking into it,
//  - grows by turbulent diffusion (radius ~ sqrt(age)) while its optical depth drops as 1/r^2.
// Puffs are sorted back to front each frame for correct blending. Rendering is in particles.ts.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { attribute, float, mx_noise_float, smoothstep, uv, vec3 } from 'three/tsl'
import { game } from '../game/game'
import { Surface } from '../physics/ground'
import { clamp } from '../physics/math'
import { sunState } from './Environment'
import { particleScene, particleU, smokeMaterial, sparkMaterial } from './particles'

const MAX_SMOKE = 1600
const MAX_SPARKS = 400
const MAX_SKID = 6000

interface Puff {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  // turbulent velocity (random walk)
  tx: number
  ty: number
  tz: number
  ground: number
  age: number
  life: number
  r0: number
  spread: number
  density: number
  seed: number
  rot: number
  spin: number
  car: number
  r: number
  g: number
  b: number
  // per-frame
  rad: number
  depth: number
}

interface Spark {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  age: number
  life: number
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

const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15

export function Effects() {
  const { camera, scene } = useThree()
  const sys = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1)
    // ---- smoke & dust
    const smokeGeo = quad.clone()
    const inst = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(MAX_SMOKE * n), n).setUsage(THREE.DynamicDrawUsage)
    const aPuff = inst(4),
      aTint = inst(3)
    smokeGeo.setAttribute('aPuff', aPuff)
    smokeGeo.setAttribute('aTint', aTint)
    const smoke = new THREE.InstancedMesh(smokeGeo, smokeMaterial(), MAX_SMOKE)
    smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    smoke.frustumCulled = false
    smoke.count = 0
    // ---- sparks
    const sparkGeo = quad.clone()
    const sparkAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPARKS), 1).setUsage(THREE.DynamicDrawUsage)
    sparkGeo.setAttribute('aAlpha', sparkAlpha)
    const sparks = new THREE.InstancedMesh(sparkGeo, sparkMaterial(), MAX_SPARKS)
    sparks.frustumCulled = false
    sparks.count = 0
    sparks.renderOrder = 6
    // ---- skid marks: ring buffer of quads (part of the main scene, they are road decals)
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
      attrs: { aPuff, aTint },
      sparks,
      sparkAlpha,
      skids,
      skidPos,
      skidA,
      skidHead: 0,
      puffs: [] as Puff[],
      sparkP: [] as Spark[],
      // fractional emission carried between frames, per wheel
      acc: new Map<string, number>(),
      lastContact: new Map<string, { x: number; y: number; z: number; lx: number; lz: number; on: boolean }>(),
    }
  }, [])

  useEffect(() => {
    particleScene.add(sys.smoke, sys.sparks)
    return () => {
      particleScene.remove(sys.smoke, sys.sparks)
      sys.smoke.geometry.dispose()
      sys.sparks.geometry.dispose()
      sys.skids.geometry.dispose()
    }
  }, [sys])

  const m4 = useMemo(() => new THREE.Matrix4(), [])
  const sc = useMemo(() => new THREE.Vector3(), [])
  const p3 = useMemo(() => new THREE.Vector3(), [])
  const fwd = useMemo(() => new THREE.Vector3(), [])

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05)
    const camPos = camera.position
    let skidDirty = false

    // lighting of the particle scene follows the main scene
    particleU.sunDir.value.copy(sunState.dir)
    particleU.sunColor.value.copy(sunState.color).multiplyScalar(sunState.intensity)
    if (particleScene.environment !== scene.environment) particleScene.environment = scene.environment
    particleScene.environmentIntensity = scene.environmentIntensity

    // ------------------------------------------------------------- emitters
    const cars = game.cars
    for (let ci = 0; ci < cars.length; ci++) {
      const c = cars[ci]
      const v = c.sim.vehicle
      const near = camPos.distanceToSquared(v.pos as unknown as THREE.Vector3) < 350 * 350
      for (let wi = 0; wi < 4; wi++) {
        const w = v.wheels[wi]
        const key = c.id + wi
        const t = w.tyre
        const onTarmac = w.surface === Surface.Asphalt || w.surface === Surface.Kerb || w.surface === Surface.Runoff || w.surface === Surface.Pit
        const sliding = w.contact && onTarmac && (t.combinedSlip > 1.15 || Math.abs(t.slipRatio) > 0.3) && t.slideVel > 2.5
        if (near && w.contact) {
          let rate = 0
          let dust = false
          if (onTarmac) {
            // rubber only smokes when the tread surface flashes past its vaporisation point: sustained
            // sliding at several m/s with high friction power (slides, lock-ups, wheelspin), not
            // cornering at the limit, where the contact patch mostly grips (measured on a racing lap:
            // the old power-only threshold was crossed 14% of the time, this one 0.01%)
            const hot = clamp((t.surfTemp - 70) / 90, 0, 1)
            const slide = smooth01((t.slideVel - 5) / 6)
            rate = clamp((t.slipPower - 16000 * (1.25 - hot * 0.45)) / 30000, 0, 1.6) * slide * 34
          } else if (v.speed > 5 && (w.surface === Surface.Gravel || w.surface === Surface.Grass)) {
            dust = true
            rate = clamp(v.speed / 30, 0, 1) * (w.surface === Surface.Gravel ? 26 : 10)
          }
          let acc = (sys.acc.get(key) ?? 0) + rate * dt
          while (acc >= 1 && sys.puffs.length < MAX_SMOKE) {
            acc -= 1
            const gravel = w.surface === Surface.Gravel
            const cp = w.contactPoint
            // vapour leaves the patch with part of the car's speed and spreads sideways
            const sx = (Math.random() - 0.5) * 0.35,
              sz = (Math.random() - 0.5) * 0.35
            const shade = dust ? 1 : 0.9 + Math.random() * 0.08
            sys.puffs.push({
              x: cp.x + sx,
              y: cp.y + 0.16,
              z: cp.z + sz,
              vx: v.vel.x * 0.45 + gauss() * 0.7,
              vy: 0.35 + Math.random() * 0.6,
              vz: v.vel.z * 0.45 + gauss() * 0.7,
              tx: 0,
              ty: 0,
              tz: 0,
              ground: cp.y,
              age: 0,
              life: dust ? 1.8 + Math.random() * 1.2 : 3.6 + Math.random() * 2.6,
              r0: dust ? 0.35 : 0.28,
              spread: dust ? 1.25 : 1.05 + Math.random() * 0.35,
              density: dust ? (gravel ? 1.3 : 0.6) : 1.5 + Math.random() * 0.7,
              seed: Math.random(),
              rot: Math.random() * Math.PI * 2,
              spin: (Math.random() - 0.5) * 0.6,
              car: ci,
              r: dust ? (gravel ? 0.56 : 0.4) : 0.86 * shade,
              g: dust ? (gravel ? 0.48 : 0.37) : 0.86 * shade,
              b: dust ? (gravel ? 0.37 : 0.27) : 0.88 * shade,
              rad: 0,
              depth: 0,
            })
          }
          sys.acc.set(key, Math.min(acc, 1))
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
      }))
    }
    ev.length = 0

    // ------------------------------------------------------------- smoke simulation
    const P = sys.puffs
    camera.getWorldDirection(fwd)
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i]
      p.age += dt
      if (p.age >= p.life) {
        P[i] = P[P.length - 1]
        P.pop()
        continue
      }
      // air velocity: light wind plus the wake of the car that made the puff
      const car = cars[p.car]?.sim.vehicle
      let ax = 0.6,
        az = 0.25
      if (car) {
        const dx = p.x - car.pos.x,
          dy = p.y - car.pos.y,
          dz = p.z - car.pos.z
        const wake = 0.42 * Math.exp(-Math.sqrt(dx * dx + dy * dy + dz * dz) / 5)
        ax += car.vel.x * wake
        az += car.vel.z * wake
      }
      // turbulent velocity: random walk with a ~0.6 s correlation time
      const k = Math.exp(-dt / 0.6),
        sig = 0.9 * Math.sqrt(1 - k * k)
      p.tx = p.tx * k + gauss() * sig
      p.ty = p.ty * k + gauss() * sig * 0.5
      p.tz = p.tz * k + gauss() * sig
      // drag towards the air (smaller puffs follow the air faster), buoyancy while hot
      const relax = 1 - Math.exp(-dt / (0.35 + p.age * 0.25))
      p.vx += (ax + p.tx - p.vx) * relax
      p.vz += (az + p.tz - p.vz) * relax
      p.vy += (0.15 + p.ty - p.vy) * relax + 0.9 * Math.exp(-p.age / 1.2) * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      p.rot += p.spin * dt
      // turbulent diffusion
      p.rad = p.r0 + p.spread * Math.sqrt(p.age) + 0.12 * p.age
      // rolls along the road surface
      const minY = p.ground + p.rad * 0.35
      if (p.y < minY) {
        p.y = minY
        if (p.vy < 0) p.vy *= -0.2
      }
      p.depth = (p.x - camPos.x) * fwd.x + (p.y - camPos.y) * fwd.y + (p.z - camPos.z) * fwd.z
    }
    // back to front
    P.sort((a, b) => b.depth - a.depth)
    const A = sys.attrs
    let n = 0
    for (const p of P) {
      if (n >= MAX_SMOKE) break
      if (p.depth < -p.rad * 2) continue
      const t = p.age / p.life
      // mass conserved: optical depth falls with the square of the size
      const thin = Math.min(1, ((p.r0 + 0.25) / p.rad) ** 2)
      const fade = Math.min(1, p.age / 0.12) * (1 - smooth01((t - 0.55) / 0.45))
      const size = p.rad * 2.6
      m4.compose(p3.set(p.x, p.y, p.z), camera.quaternion, sc.set(size, size, size))
      sys.smoke.setMatrixAt(n, m4)
      A.aPuff.setXYZW(n, p.density * thin * fade, p.seed, p.rot, p.rad)
      A.aTint.setXYZ(n, p.r, p.g, p.b)
      n++
    }
    sys.smoke.count = n
    sys.smoke.instanceMatrix.needsUpdate = true
    for (const a of Object.values(A)) a.needsUpdate = true

    // ------------------------------------------------------------- sparks
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
      // stretched along the velocity
      const vel = Math.hypot(p.vx, p.vy, p.vz)
      m4.compose(p3.set(p.x, p.y, p.z), camera.quaternion, sc.set(0.04, 0.04 + vel * 0.012, 0.04))
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
  }, 0)

  return <primitive object={sys.skids} />
}

function smooth01(x: number) {
  const t = clamp(x, 0, 1)
  return t * t * (3 - 2 * t)
}

function emitN<T>(list: T[], rate: number, make: () => T) {
  let count = Math.floor(rate)
  if (Math.random() < rate - count) count++
  for (let i = 0; i < count && list.length < 2000; i++) list.push(make())
}
