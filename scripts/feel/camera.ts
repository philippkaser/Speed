// Camera probe: the player's chase and cockpit cameras run headlessly (no renderer) behind a car
// driven around the real circuit, over a kerb and through a slide. Measures what the player sees:
//  - car jitter: high-frequency motion (> ~5 Hz) of the car's position on a 1920 x 1080 screen
//  - frame jitter: high-frequency rotation of the camera (the whole world shaking), degrees
//  - frame bob: high-frequency vertical motion of the camera, mm
//  - car drift: how far the car wanders from its mean screen position (low frequency), px
//  - fov: the widest field of view (top speed)
//  - slide shown: how much of a slide's angle the car shows on screen (car heading vs camera)
// `legacy` is a frozen copy of the chase camera before it was rebuilt on springs (for comparison).
import * as THREE from 'three/webgpu'
import { AIDriver } from '../../src/ai/aiDriver'
import { clamp, valueNoise2 } from '../../src/physics/math'
import { getCar } from '../../src/physics/spec'
import { Vehicle } from '../../src/physics/vehicle'
import { PhysicsWorld, type SimCar } from '../../src/physics/world'
import { DriveCamera, type DriveCam, type DriveCarState, makeDriveCarState } from '../../src/render/CameraRig'
import { FlatGround, type Ground } from '../../src/physics/ground'
import { track, warm, launch, Probe } from './probe'

const DEG = 180 / Math.PI
const W = 1920,
  H = 1080

interface CamImpl {
  update(cam: THREE.PerspectiveCamera, car: DriveCarState, dt: number, mode: DriveCam): void
}

/** The new driving cameras (src/render/CameraRig.tsx). */
export function current(): CamImpl {
  const d = new DriveCamera()
  return { update: (cam, car, dt, mode) => void d.update(cam, car, dt, { mode, fov: 58, shake: 0.6, lookBack: false, side: 0 }) }
}

/** Frozen copy of the chase / cockpit camera as it was (lerps, +13 deg FOV, road and kerb shake). */
export function legacy(): CamImpl {
  const s = { init: false, yaw: 0, pitch: 0, gLong: 0, gLat: 0, fovKick: 0, t: 0, headX: 0, headY: 0 }
  const _f = new THREE.Vector3(),
    _v = new THREE.Vector3(),
    _l = new THREE.Vector3(),
    _sh = new THREE.Vector3()
  return {
    update(cam, car, dt, mode) {
      s.t += dt
      _f.set(0, 0, 1).applyQuaternion(car.quat)
      const speed = car.speed
      const heading = Math.atan2(_f.x, _f.z)
      const velHeading = speed > 3 ? Math.atan2(car.vel.x, car.vel.z) : heading
      if (!s.init) {
        s.yaw = heading
        s.init = true
        cam.fov = 58
      }
      const targetYaw = heading + angleDiff(velHeading, heading) * clamp(speed / 30, 0, 1) * 0.45
      s.yaw += angleDiff(targetYaw, s.yaw) * clamp(dt * 7.5, 0, 1)
      const fwdPitch = Math.asin(clamp(_f.y, -0.5, 0.5))
      s.pitch += (fwdPitch * 0.7 - s.pitch) * clamp(dt * 4, 0, 1)
      const road = Math.pow(clamp(speed / 85, 0, 1), 2)
      const shakeMag = (road * 0.006 + car.kerb * 0.018 + car.scrape * 0.03) * 0.6
      const shx = (valueNoise2(s.t * 31, 1.3) - 0.5) * shakeMag,
        shy = (valueNoise2(s.t * 37, 7.1) - 0.5) * shakeMag
      const kg = 1 - Math.exp(-dt / 0.25)
      s.gLong += (clamp(car.accelLong, -2, 2) - s.gLong) * kg
      s.gLat += (clamp(car.accelLat, -2.5, 2.5) - s.gLat) * kg
      s.fovKick += (clamp(s.gLong, -1.5, 1) * 2.2 - s.fovKick) * clamp(dt * 3, 0, 1)
      const speedFov = 13 * Math.pow(clamp((speed - 8) / 80, 0, 1), 1.2)
      const carPos = car.pos
      if (mode !== 'cockpit') {
        const dist = 6.2 + clamp(s.gLong, -1.5, 1.2) * 0.22 + speed * 0.004
        const cy = Math.cos(s.yaw),
          sy = Math.sin(s.yaw)
        _v.set(carPos.x - sy * dist, carPos.y + 1.75 + Math.sin(-s.pitch) * dist * 0.5, carPos.z - cy * dist)
        const lat = clamp(s.gLat, -2, 2) * 0.12
        _v.x += cy * lat
        _v.z += -sy * lat
        if (_v.y < carPos.y + 0.6) _v.y = carPos.y + 0.6
        cam.position.copy(_v)
        _l.set(carPos.x + sy * 3.0, carPos.y + 0.95, carPos.z + cy * 3.0)
        cam.up.set(0, 1, 0)
        cam.lookAt(_l)
        cam.position.x += shx
        cam.position.y += shy
        cam.lookAt(_l)
        cam.fov += (58 + speedFov + s.fovKick - cam.fov) * clamp(dt * 5, 0, 1)
      } else {
        s.headX += (clamp(s.gLat, -2.5, 2.5) * 0.022 - s.headX) * clamp(dt * 8, 0, 1)
        s.headY += (clamp(-s.gLong, -2, 2) * 0.012 - s.headY) * clamp(dt * 8, 0, 1)
        _v.set(0.36 + s.headX, 0.55, -0.3 + s.headY).applyQuaternion(car.quat).add(carPos)
        cam.position.copy(_v)
        cam.quaternion.copy(car.quat)
        cam.rotateY(Math.PI)
        cam.rotateZ(-s.headX * 0.8)
        cam.rotateX(-0.03)
        cam.position.add(_sh.set(0, shy * 0.6, 0).applyQuaternion(car.quat))
        cam.rotateX(shx * 0.5)
        cam.fov += (58 + 12 + speedFov * 0.6 - cam.fov) * clamp(dt * 5, 0, 1)
      }
      cam.updateProjectionMatrix()
      cam.updateMatrixWorld()
    },
  }
}

function angleDiff(a: number, b: number) {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

interface Frame {
  t: number
  kerb: boolean
  sx: number
  sy: number
  yaw: number
  pitch: number
  camY: number
  fov: number
  /** car heading minus camera yaw (rad) and the car's body slip (rad) */
  shown: number
  slip: number
}

/** Runs a camera behind a SimCar for n frames at the given rate; drive() sets the car's inputs. */
function film(world: PhysicsWorld, sim: SimCar, impl: CamImpl, mode: DriveCam, fps: number, seconds: number, drive: (dt: number) => void, dtJitter = 0) {
  const cam = new THREE.PerspectiveCamera(58, W / H, 0.1, 12000)
  const car = makeDriveCarState()
  const v = sim.vehicle
  const out: Frame[] = []
  const qa = new THREE.Quaternion(),
    qb = new THREE.Quaternion()
  const p = new THREE.Vector3(),
    f = new THREE.Vector3()
  let yawPrev = 0,
    yawAcc = 0
  // uneven frame times (a browser): +-dtJitter of the frame, from a fixed pseudo-random sequence
  let seed = 7,
    time = 0
  for (let i = 0; i < seconds * fps; i++) {
    seed = (seed * 16807) % 2147483647
    const dt = (1 / fps) * (1 + dtJitter * (2 * (seed / 2147483647) - 1))
    time += dt
    drive(dt)
    world.update(dt)
    // the pose CarVisual renders: interpolated between the last two physics steps
    const a = world.alpha
    car.pos.set(sim.prevPos.x + (v.pos.x - sim.prevPos.x) * a, sim.prevPos.y + (v.pos.y - sim.prevPos.y) * a, sim.prevPos.z + (v.pos.z - sim.prevPos.z) * a)
    qa.set(sim.prevQuat.x, sim.prevQuat.y, sim.prevQuat.z, sim.prevQuat.w)
    qb.set(v.q.x, v.q.y, v.q.z, v.q.w)
    car.quat.slerpQuaternions(qa, qb, a)
    car.vel.set(v.vel.x, v.vel.y, v.vel.z)
    car.speed = v.speed
    car.accelLong = v.accelLong
    car.accelLat = v.accelLat
    car.kerb = v.wheels.reduce((acc, w) => acc + (w.surface === 1 || w.surface === 2 || w.surface === 3 ? 1 : 0), 0) / 4
    car.scrape = v.scrape
    impl.update(cam, car, dt, mode)
    cam.updateMatrixWorld()
    cam.updateProjectionMatrix()
    // the car's middle on screen
    p.copy(car.pos).add(f.set(0, 0.35, 0)).project(cam)
    // camera direction (unwrapped yaw)
    f.set(0, 0, -1).applyQuaternion(cam.quaternion)
    const y = Math.atan2(f.x, f.z)
    if (i === 0) yawAcc = y
    else yawAcc += angleDiff(y, yawPrev)
    yawPrev = y
    const heading = Math.atan2(v.fwd.x, v.fwd.z)
    const vl = v.vel.x * v.left.x + v.vel.z * v.left.z,
      vf = v.vel.x * v.fwd.x + v.vel.z * v.fwd.z
    out.push({ kerb: car.kerb > 0, t: time, sx: ((p.x + 1) / 2) * W, sy: ((1 - p.y) / 2) * H, yaw: yawAcc, pitch: Math.asin(clamp(f.y, -1, 1)), camY: cam.position.y, fov: cam.fov, shown: angleDiff(heading, y), slip: Math.atan2(vl, Math.max(Math.abs(vf), 1)) })
  }
  return out
}

/**
 * RMS of what is left of x above ~2 Hz: x minus a local quadratic least-squares fit in time over
 * +-0.25 s, so the road's slopes and crests (slow, curved trends) do not count as jolts, and uneven
 * frame times do not either.
 */
function hf(fr: Frame[], get: (f: Frame) => number, offKerb = false) {
  const n = fr.length
  let sum = 0,
    cnt = 0
  let lo = 0,
    hi = 0
  for (let i = 0; i < n; i++) {
    const t0 = fr[i].t
    if (t0 - fr[0].t < 0.25 || fr[n - 1].t - t0 < 0.25) continue
    while (fr[lo].t < t0 - 0.25) lo++
    while (hi < n - 1 && fr[hi + 1].t <= t0 + 0.25) hi++
    if (offKerb) {
      let k = false
      for (let j = lo; j <= hi && !k; j++) k = fr[j].kerb
      if (k) continue
    }
    // normal equations of y = a + b u + c u^2, u = t - t0
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, y0 = 0, y1 = 0, y2 = 0
    for (let j = lo; j <= hi; j++) {
      const u = fr[j].t - t0,
        y = get(fr[j]),
        u2 = u * u
      s0 += 1; s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2
      y0 += y; y1 += y * u; y2 += y * u2
    }
    // solve for a (the fit at u = 0) by Cramer's rule
    const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2)
    const da = y0 * (s2 * s4 - s3 * s3) - s1 * (y1 * s4 - s3 * y2) + s2 * (y1 * s3 - s2 * y2)
    const d = get(fr[i]) - da / det
    sum += d * d
    cnt++
  }
  return Math.sqrt(sum / Math.max(cnt, 1))
}

export interface CamMetrics {
  'car jitter px': number
  /** the same, leaving out +-0.25 s around any wheel on a kerb (the car's real vibration there) */
  'car jitter px off kerbs': number
  'frame jitter deg': number
  'frame bob mm': number
  'car drift x px': number
  'car drift y px': number
  'max fov deg': number
}

function metrics(fr: Frame[], skip = 0.5): CamMetrics {
  const f = fr.filter((x) => x.t >= skip)
  const mx = f.reduce((a, x) => a + x.sx, 0) / f.length,
    my = f.reduce((a, x) => a + x.sy, 0) / f.length
  return {
    'car jitter px': Math.hypot(hf(f, (x) => x.sx), hf(f, (x) => x.sy)),
    'car jitter px off kerbs': Math.hypot(hf(f, (x) => x.sx, true), hf(f, (x) => x.sy, true)),
    'frame jitter deg': Math.hypot(hf(f, (x) => x.yaw), hf(f, (x) => x.pitch)) * DEG,
    'frame bob mm': hf(f, (x) => x.camY) * 1000,
    'car drift x px': Math.max(...f.map((x) => Math.abs(x.sx - mx))),
    'car drift y px': Math.max(...f.map((x) => Math.abs(x.sy - my))),
    'max fov deg': Math.max(...f.map((x) => x.fov)),
  }
}

/** A lap's opening: start / finish straight, T1, the esses and the hairpin, AI driving at full pace. */
export function lapRun(impl: CamImpl, mode: DriveCam = 'chase', fps = 60, seconds = 40, dtJitter = 0) {
  const tr = track()
  const world = new PhysicsWorld(tr)
  const v = new Vehicle(getCar('vanta-gt3'))
  v.contactQuality = 2
  const s0 = tr.length - 260
  const p = tr.pointAt(s0, tr.racing[tr.idx(s0)], { x: 0, y: 0, z: 0 })
  v.reset(p.x, p.z, tr.headingAt(s0), tr)
  warm(v)
  const sim = world.addCar('player', v)
  const ai = new AIDriver(v, tr, 1.0)
  ai.id = 'player'
  v.setVelocityForward(40)
  v.gear = 3
  return metrics(film(world, sim, impl, mode, fps, seconds, (dt) => ai.drive(dt, sim.input, [], true), dtJitter), 1)
}

/** The kerb strike of the feel probe (160 km/h across an exit kerb), filmed. */
export function kerbRun(impl: CamImpl, mode: DriveCam = 'chase', fps = 60) {
  const tr = track()
  let si = -1
  for (let i = 0; i < tr.n; i++) {
    const k = (i + 200) % tr.n
    if (tr.L.kerb[k] > 0.8 && Math.abs(tr.curv[k]) < 0.0025 && Math.abs(tr.curv[(k + 30) % tr.n]) < 0.0025 && Math.abs(tr.curv[(k - 40 + tr.n) % tr.n]) < 0.0025) {
      si = k
      break
    }
  }
  const pr = new Probe({ ground: tr as Ground })
  const sKerb = (si / tr.n) * tr.length
  const s0 = sKerb - 45
  const dKerb = tr.hw[si] + tr.L.kerb[si] * 0.5 - pr.v.spec.trackFront * 0.5
  const pt = tr.pointAt(s0, dKerb - 45 * Math.tan(1.6 / DEG), { x: 0, y: 0, z: 0 })
  pr.v.reset(pt.x, pt.z, tr.headingAt(s0) + 1.6 / DEG, tr)
  warm(pr.v)
  launch(pr, 160 / 3.6)
  return metrics(
    film(pr.world, pr.sim, impl, mode, fps, 2.2, () => {
      const c = pr.cruise(160 / 3.6)
      pr.sim.input.throttle = c.throttle
      pr.sim.input.brake = c.brake
      pr.sim.input.steer = 0
    }),
    0.2,
  )
}

/** A slide (the feel probe's yaw kick at 110 km/h, nobody catching it for 0.6 s): how much the frame shows. */
export function slideRun(impl: CamImpl, fps = 60) {
  const pr = new Probe({ ground: new FlatGround() })
  launch(pr, 110 / 3.6)
  pr.settle(110 / 3.6, 0.6)
  let kicked = false
  let t = 0
  const fr = film(pr.world, pr.sim, impl, 'chase', fps, 2.4, (dt) => {
    t += dt
    pr.sim.input.steer = t < 1.2 ? 0.6 : t < 1.8 ? 0.6 : 0
    pr.sim.input.throttle = 0.3
    if (t > 1.2 && !kicked) {
      kicked = true
      pr.v.w.addScaled(pr.v.up, -45 / DEG)
    }
  })
  let best = { slip: 0, shown: 0 }
  for (const f of fr) if (f.t > 1.2 && Math.abs(f.slip) > Math.abs(best.slip)) best = f
  return { 'slide deg': Math.abs(best.slip) * DEG, 'shown deg': Math.abs(best.shown) * DEG }
}

export function allCameraRuns() {
  const rows: { name: string; legacy: Record<string, number>; current: Record<string, number> }[] = []
  const add = (name: string, f: (impl: CamImpl) => object) => rows.push({ name, legacy: f(legacy()) as Record<string, number>, current: f(current()) as Record<string, number> })
  add('lap chase 60 fps', (i) => lapRun(i, 'chase', 60))
  add('lap chase 144 fps', (i) => lapRun(i, 'chase', 144, 20))
  add('lap chase uneven dt', (i) => lapRun(i, 'chase', 60, 40, 0.35))
  add('kerb strike chase', (i) => kerbRun(i, 'chase'))
  add('kerb strike cockpit', (i) => kerbRun(i, 'cockpit'))
  add('lap cockpit', (i) => lapRun(i, 'cockpit', 60, 20))
  add('slide chase', (i) => slideRun(i))
  return rows
}
