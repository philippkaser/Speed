// Camera system: chase / near chase / hood / cockpit / bumper for driving, TV + cinematic cameras
// for attract mode and replays, orbit for the showroom. Speed-dependent FOV and camera shake.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three/webgpu'
import { game } from '../game/game'
import { input } from '../input/input'
import { clamp, valueNoise2 } from '../physics/math'
import { useSettings } from '../state/settings'
import { useGameStore } from '../state/gameStore'
import { carPoses } from './CarVisual'
import { cameraPose } from '../audio/cameraPose'
import { cameraCut } from './PostFX'
import { broadcastCamera } from './broadcastCam'
import { markCameraPath } from './motionHistory'

export const CAMERA_MODES = ['chase', 'chaseNear', 'cockpit', 'hood', 'bumper'] as const
export type DriveCam = (typeof CAMERA_MODES)[number]

const _v = new THREE.Vector3(),
  _v2 = new THREE.Vector3(),
  _look = new THREE.Vector3(),
  _fwd = new THREE.Vector3(),
  _up = new THREE.Vector3(),
  _q = new THREE.Quaternion(),
  _m = new THREE.Matrix4(),
  _e = new THREE.Euler(),
  _sh = new THREE.Vector3()

export const cameraFocus = new THREE.Vector3()

const _params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
const SIDECAM = _params?.has('sidecam') ? _params.get('sidecam') || 'side' : null

const _prevCam = new THREE.Vector3()
function publishPose(cam: THREE.PerspectiveCamera, dt: number) {
  const p = cameraPose
  if (dt > 0) {
    p.vel.x = (cam.position.x - _prevCam.x) / dt
    p.vel.y = (cam.position.y - _prevCam.y) / dt
    p.vel.z = (cam.position.z - _prevCam.z) / dt
  }
  _prevCam.copy(cam.position)
  p.pos.x = cam.position.x
  p.pos.y = cam.position.y
  p.pos.z = cam.position.z
  _v.set(0, 0, -1).applyQuaternion(cam.quaternion)
  p.fwd.x = _v.x
  p.fwd.y = _v.y
  p.fwd.z = _v.z
  _v.set(0, 1, 0).applyQuaternion(cam.quaternion)
  p.up.x = _v.x
  p.up.y = _v.y
  p.up.z = _v.z
}

export function CameraRig() {
  const { camera, gl } = useThree()
  const cam = camera as THREE.PerspectiveCamera
  const st = useRef({
    yaw: 0,
    pitch: 0,
    pos: new THREE.Vector3(0, 5, -10),
    lookPos: new THREE.Vector3(),
    initialized: false,
    shakeT: 0,
    attractTimer: 0,
    attractShot: 0,
    attractCar: 0,
    tvPos: new THREE.Vector3(),
    orbitYaw: 0.6,
    orbitPitch: 0.18,
    orbitDist: 7.5,
    dragging: false,
    lastX: 0,
    lastY: 0,
    headX: 0,
    headY: 0,
    lastMode: '' as string,
    fovKick: 0,
    wasLookBack: false,
    // g forces for the camera, low-passed: the physics values change abruptly from frame to frame
    // (gear changes, kerbs), and a camera that follows them twitches by centimetres every frame
    gLong: 0,
    gLat: 0,
    /** the player's driving cameras (chase, cockpit...) and the car state they follow */
    drive: new DriveCamera(),
    car: makeDriveCarState(),
  })

  // orbit drag in showroom
  useEffect(() => {
    const el = gl.domElement as HTMLCanvasElement
    const down = (e: PointerEvent) => {
      st.current.dragging = true
      st.current.lastX = e.clientX
      st.current.lastY = e.clientY
    }
    const move = (e: PointerEvent) => {
      if (!st.current.dragging) return
      st.current.orbitYaw -= (e.clientX - st.current.lastX) * 0.006
      st.current.orbitPitch = clamp(st.current.orbitPitch + (e.clientY - st.current.lastY) * 0.004, 0.02, 0.9)
      st.current.lastX = e.clientX
      st.current.lastY = e.clientY
    }
    const up = () => (st.current.dragging = false)
    const wheel = (e: WheelEvent) => {
      st.current.orbitDist = clamp(st.current.orbitDist + e.deltaY * 0.004, 4, 14)
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: true })
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
    }
  }, [gl])

  useFrame((_, dtRaw) => {
    publishPose(cam, Math.min(dtRaw, 0.05))
  }, -1)

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05)
    const s = st.current
    const gfx = useSettings.getState().graphics
    const mode = game.mode
    const camMode = useGameStore.getState().camera
    s.shakeT += dt

    // --------------------------------------------------------------- team race: TV broadcast
    if (mode === 'team') {
      broadcastCamera(cam, dt, cameraFocus)
      return
    }
    // --------------------------------------------------------------- attract (menu background)
    if (mode === 'attract') {
      attractCamera(cam, s, dt)
      return
    }
    const target = game.player
    if (!target) return
    const pose = carPoses.get(target.id)
    if (!pose) return
    const v = target.sim.vehicle
    const carPos = pose.pos
    const carQ = pose.quat
    _fwd.set(0, 0, 1).applyQuaternion(carQ)
    _up.set(0, 1, 0).applyQuaternion(carQ)
    const speed = v.speed
    cameraFocus.copy(carPos)

    // --------------------------------------------------------------- showroom orbit
    if (mode === 'showroom') {
      if (!s.dragging) s.orbitYaw += dt * 0.08
      const d = s.orbitDist
      const heading = Math.atan2(_fwd.x, _fwd.z)
      const a = heading + s.orbitYaw
      _v.set(carPos.x + Math.sin(a) * Math.cos(s.orbitPitch) * d, carPos.y + Math.sin(s.orbitPitch) * d + 0.2, carPos.z + Math.cos(a) * Math.cos(s.orbitPitch) * d)
      cam.position.lerp(_v, s.initialized ? clamp(dt * 6, 0, 1) : 1)
      // aim slightly right of the car so it sits in the gap between the garage panels
      _v2.set(Math.cos(a), 0, -Math.sin(a))
      _look.copy(carPos).add(_v2.multiplyScalar(1.1)).add(_up.set(0, 0.15, 0))
      cam.lookAt(_look)
      setFov(cam, 34, dt)
      cam.near = 0.1
      s.initialized = true
      pose.model?.setVisibleParts({ body: true, interior: true })
      return
    }

    // --------------------------------------------------------------- debug: tracking shot alongside
    // (?sidecam, ?sidecam=front|rear) to look at wheels and background streaks side-on
    if (SIDECAM) {
      const heading = Math.atan2(_fwd.x, _fwd.z)
      if (!s.initialized) {
        s.yaw = heading
        s.initialized = true
        cameraCut.frames = 3
      }
      s.yaw += angleDiff(heading, s.yaw) * clamp(dt * 4, 0, 1)
      if (SIDECAM === 'heli') {
        // the broadcast helicopter (broadcastCam.ts): 75 m out, 58 m up, long lens, lagging operator
        const a = heading + Math.PI + 1.2
        _v.set(carPos.x + Math.sin(a) * 75, carPos.y + 58, carPos.z + Math.cos(a) * 75)
        if (s.lastMode !== 'heli') {
          s.pos.copy(_v)
          s.lookPos.copy(carPos)
          s.lastMode = 'heli'
        }
        s.pos.lerp(_v, clamp(dt * 1.2, 0, 1))
        s.lookPos.lerp(carPos, clamp(dt * 5, 0, 1))
        cam.position.copy(s.pos)
        cam.up.set(0, 1, 0)
        cam.lookAt(s.lookPos)
        cam.fov = clamp((2 * Math.atan(22 / 2 / Math.max(cam.position.distanceTo(s.lookPos), 1)) * 180) / Math.PI, 8, 45)
        cam.near = 0.5
        cam.far = 12000
        cam.updateProjectionMatrix()
        cameraFocus.copy(carPos)
        return
      }
      if (SIDECAM === 'post') {
        // fixed camera beside the track, 9 m ahead of where the car was when window.__postcam was set
        const w = window as unknown as { __postcam?: boolean }
        if (w.__postcam) {
          w.__postcam = false
          _v2.set(Math.cos(heading), 0, -Math.sin(heading))
          s.tvPos.copy(carPos).addScaledVector(_fwd, 9).addScaledVector(_v2, 6.5)
          s.tvPos.y = carPos.y + 0.7
          s.pos.copy(carPos).addScaledVector(_fwd, 9)
          s.pos.y = carPos.y + 0.4
          cameraCut.frames = 1
        }
        cam.position.copy(s.tvPos)
        cam.up.set(0, 1, 0)
        cam.lookAt(s.pos)
        cam.fov = 50
        cam.near = 0.1
        cam.far = 12000
        cam.updateProjectionMatrix()
        cameraFocus.copy(carPos)
        return
      }
      const off = SIDECAM === 'front' ? 0.9 : SIDECAM === 'rear' ? 2.4 : 1.57
      const a = s.yaw + off
      _v.set(carPos.x + Math.sin(a) * 4.8, carPos.y + 0.45, carPos.z + Math.cos(a) * 4.8)
      cam.position.copy(_v)
      _look.copy(carPos).add(_v2.set(0, 0.35, 0))
      cam.up.set(0, 1, 0)
      cam.lookAt(_look)
      cam.fov = 42
      cam.near = 0.1
      cam.far = 12000
      cam.updateProjectionMatrix()
      cameraFocus.copy(carPos)
      pose.model?.setVisibleParts({ body: true, interior: true, driver: true })
      return
    }

    // --------------------------------------------------------------- driving cameras
    const model = pose.model
    const lookBack = input.lookBack()
    const inside = camMode === 'cockpit' || camMode === 'hood' || camMode === 'bumper'
    model?.setVisibleParts({ body: camMode !== 'hood' && camMode !== 'bumper', interior: true, driver: camMode !== 'cockpit' || lookBack })
    const car = s.car
    car.pos.copy(carPos)
    car.quat.copy(carQ)
    car.vel.set(v.vel.x, v.vel.y, v.vel.z)
    car.speed = speed
    car.accelLong = v.accelLong
    car.accelLat = v.accelLat
    car.kerb = v.wheels.reduce((a, w) => a + (w.surface === 1 || w.surface === 2 || w.surface === 3 ? 1 : 0), 0) / 4
    car.scrape = v.scrape
    const r = s.drive.update(cam, car, dt, { mode: camMode, fov: gfx.fov, shake: gfx.cameraShake, lookBack, side: input.lookSide(), model })
    if (r.cut) cameraCut.frames = 3
    cameraFocus.copy(carPos)
    void inside
  }, -2)

  return null
}

// ------------------------------------------------------------------------------- driving cameras

/** Critically damped spring with an exact step: the same motion at any frame rate. */
export class Spring {
  x = 0
  v = 0
  reset(x: number) {
    this.x = x
    this.v = 0
    return x
  }
  /** omega: natural frequency (rad/s); settles to the target in about 4.7 / omega seconds */
  step(target: number, omega: number, dt: number) {
    const d = this.x - target
    const e = Math.exp(-omega * dt)
    const t = (this.v + omega * d) * dt
    this.x = target + (d + t) * e
    this.v = (this.v - omega * t) * e
    return this.x
  }
}

/** What the driving cameras need from the car (its interpolated pose and a little telemetry). */
export interface DriveCarState {
  pos: THREE.Vector3
  quat: THREE.Quaternion
  vel: THREE.Vector3
  /** m/s */
  speed: number
  /** g */
  accelLong: number
  accelLat: number
  /** share of the wheels on kerbs, grass or gravel */
  kerb: number
  /** body scraping the ground 0..1 */
  scrape: number
}

export function makeDriveCarState(): DriveCarState {
  return { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), vel: new THREE.Vector3(), speed: 0, accelLong: 0, accelLat: 0, kerb: 0, scrape: 0 }
}

export interface DriveCamOptions {
  mode: DriveCam
  /** base field of view (deg) */
  fov: number
  /** camera shake setting 0..1 */
  shake: number
  lookBack: boolean
  /** -1 look left, 1 look right */
  side: number
  /** the car's model, for the eye positions of the in-car cameras */
  model?: { cockpitEye: THREE.Vector3; bodyOffset: THREE.Vector3; body: { zFront: number } }
}

/** Chase camera tuning (measured with scripts/feel/camera.ts). */
export const CHASE = {
  /** yaw follows the car's heading (rad/s natural frequency): a slight lag shows rotation */
  yawW: 7,
  /** share of the slide angle (heading vs velocity) the camera turns with: slides show on screen */
  slipShare: 0.4,
  /** vertical follow: kerbs and bumps do not jolt the frame */
  heightW: 5.5,
  /** share of the car's own (unsmoothed) vertical motion the aim follows: the car bobs a little in a steady frame */
  aimRaw: 0.15,
  /** road pitch follow and its share (the body's dive and squat are not the road's slope) */
  pitchW: 2.2,
  pitchShare: 0.8,
  /** distance and lateral offset from g forces */
  gW: 2.5,
  /** extra field of view (deg) at full speed, reached around 250 km/h */
  speedFov: 4,
  fovW: 2.5,
}

const _cv = new THREE.Vector3(),
  _cl = new THREE.Vector3(),
  _cf = new THREE.Vector3(),
  _cs = new THREE.Vector3()

/**
 * The player's driving cameras: chase (far / near) and the in-car views (cockpit, hood, bumper).
 * Pure (no React, no renderer): CameraRig runs it every frame, scripts/feel/camera.ts headlessly.
 *
 * Chase: every degree of freedom is a critically damped spring, so nothing overshoots and the motion
 * is the same at any frame rate. The frame follows the car's heading with a slight lag and turns with
 * part of a slide (the slide shows as the car's angle on screen); the car's vertical motion and the
 * road's pitch are smoothed, so kerbs and bumps move the car a little inside a steady frame instead
 * of jolting the frame; the field of view opens only a little with speed. Shake (kerbs, scraping) is a
 * small translation added after markCameraPath, so it never blurs and never rotates the world.
 *
 * In-car: rigidly on the chassis (the cockpit stays sharp in the motion blur), head sway from g forces.
 */
export class DriveCamera {
  private init = false
  private lastMode = ''
  private wasLookBack = false
  private lastSide = 0
  private yaw = new Spring()
  private height = new Spring()
  private pitch = new Spring()
  private dist = new Spring()
  private lat = new Spring()
  private fov = new Spring()
  private gLong = new Spring()
  private gLat = new Spring()
  private headX = new Spring()
  private headY = new Spring()
  private t = 0
  /** the camera's path this frame (before shake), for tests */
  readonly pathPos = new THREE.Vector3()

  reset() {
    this.init = false
  }

  update(cam: THREE.PerspectiveCamera, car: DriveCarState, dt: number, o: DriveCamOptions): { cut: boolean } {
    const A = CHASE
    this.t += dt
    _cf.set(0, 0, 1).applyQuaternion(car.quat)
    const heading = Math.atan2(_cf.x, _cf.z)
    const velHeading = car.speed > 3 ? Math.atan2(car.vel.x, car.vel.z) : heading
    const roadPitch = Math.asin(clamp(_cf.y, -0.5, 0.5)) * A.pitchShare
    let yawTarget = heading + angleDiff(velHeading, heading) * A.slipShare * smooth01((car.speed - 3) / 22)
    if (o.lookBack) yawTarget += Math.PI
    yawTarget += o.side * Math.PI * 0.5
    const inside = (o.mode === 'cockpit' || o.mode === 'hood' || o.mode === 'bumper') && !o.lookBack
    const near = o.mode === 'chaseNear'
    const speedFov = A.speedFov * smooth01((car.speed - 8) / 62)
    // a new view (mode, looking back or sideways) is a cut: every spring starts where it should be
    let cut = false
    if (!this.init || this.lastMode !== o.mode || this.wasLookBack !== o.lookBack || this.lastSide !== o.side) {
      cut = true
      this.init = true
      this.yaw.reset(yawTarget)
      this.height.reset(car.pos.y)
      this.pitch.reset(roadPitch)
      this.dist.reset((near ? 4.6 : 6.2) + car.speed * 0.004)
      this.lat.reset(0)
      this.gLong.reset(clamp(car.accelLong, -2, 2))
      this.gLat.reset(clamp(car.accelLat, -2.5, 2.5))
      this.headX.reset(0)
      this.headY.reset(0)
      this.fov.reset(inside ? o.fov + (o.mode === 'cockpit' ? 12 : 4) + speedFov * 0.5 : o.fov + speedFov)
    }
    this.lastMode = o.mode
    this.wasLookBack = o.lookBack
    this.lastSide = o.side
    // g forces, smoothed (the physics values change abruptly from step to step: gear changes, kerbs)
    const gl = this.gLong.step(clamp(car.accelLong, -2, 2), A.gW * 1.6, dt)
    const gt = this.gLat.step(clamp(car.accelLat, -2.5, 2.5), A.gW * 1.6, dt)
    // shake: kerbs, gravel and scraping only; the chase camera has no road buzz
    const t = this.t
    const shakeMag = (car.kerb * 0.006 + car.scrape * 0.02) * o.shake
    const shx = (valueNoise2(t * 11, 1.3) - 0.5) * shakeMag,
      shy = (valueNoise2(t * 13, 7.1) - 0.5) * shakeMag

    if (!inside) {
      const yaw = this.yaw.step(this.yaw.x + angleDiff(yawTarget, this.yaw.x), A.yawW, dt)
      const y = this.height.step(car.pos.y, A.heightW, dt)
      const pitch = this.pitch.step(roadPitch, A.pitchW, dt)
      const dist = this.dist.step((near ? 4.6 : 6.2) + clamp(gl, -1.5, 1.2) * 0.22 + car.speed * 0.004, A.gW, dt)
      const lat = this.lat.step(clamp(gt, -2, 2) * 0.12, A.gW, dt)
      const height = near ? 1.35 : 1.75
      const cy = Math.cos(yaw),
        sy = Math.sin(yaw)
      // behind the car along the (smoothed) road slope, pushed slightly out by lateral g
      _cv.set(car.pos.x - sy * dist + cy * lat, y + height - Math.sin(pitch) * dist, car.pos.z - cy * dist - sy * lat)
      if (_cv.y < car.pos.y + 0.6) _cv.y = car.pos.y + 0.6
      const aimY = y + (car.pos.y - y) * A.aimRaw + (near ? 0.75 : 0.95)
      _cl.set(car.pos.x + sy * 3.0, aimY + Math.sin(pitch) * 3.0, car.pos.z + cy * 3.0)
      cam.position.copy(_cv)
      cam.up.set(0, 1, 0)
      cam.lookAt(_cl)
      // the camera's path ends here; the shake on top of it does not blur
      markCameraPath(cam)
      this.pathPos.copy(cam.position)
      // the shake moves the camera (no rotation: the horizon never shakes)
      cam.position.x += cy * shx
      cam.position.z -= sy * shx
      cam.position.y += shy
      const fovT = o.fov + speedFov + clamp(gl, -1.5, 1) * 0.8
      cam.fov = this.fov.step(fovT, A.fovW, dt)
      cam.near = 0.1
      cam.far = 12000
      cam.updateProjectionMatrix()
      return { cut }
    }

    // in-car cameras: rigidly attached to the chassis, head motion from g forces
    const model = o.model
    const eye = model ? model.cockpitEye : _cs.set(0.36, 0.55, -0.3)
    let lx = eye.x,
      ly = eye.y,
      lz = eye.z
    if (o.mode === 'hood') {
      lx = 0
      ly = eye.y + 0.12
      lz = (model?.bodyOffset.z ?? 0) + (model?.body.zFront ?? 2) * 0.35
    } else if (o.mode === 'bumper') {
      lx = 0
      ly = (model?.bodyOffset.y ?? -0.4) + 0.42
      lz = (model?.bodyOffset.z ?? 0) + (model?.body.zFront ?? 2.3) - 0.05
    }
    // head sway (cockpit only): the head leans with the g forces, settling without bounce
    const k = o.mode === 'cockpit' ? 1 : 0.15
    const hx = this.headX.step(clamp(gt, -2.5, 2.5) * 0.022 * k, 9, dt)
    const hy = this.headY.step(clamp(-gl, -2, 2) * 0.012 * k, 9, dt)
    _cv.set(lx + hx, ly, lz + hy)
    _cv.applyQuaternion(car.quat).add(car.pos)
    cam.position.copy(_cv)
    cam.quaternion.copy(car.quat)
    // three cameras look down -z; the car faces +z
    cam.rotateY(Math.PI + o.side * Math.PI * 0.5)
    cam.rotateZ(-hx * 0.8 * k)
    cam.rotateX(-0.03)
    // the camera's path ends here (it rides with the chassis, so the cockpit stays sharp); the shake
    // on top of it does not blur
    markCameraPath(cam)
    this.pathPos.copy(cam.position)
    cam.position.add(_cs.set(0, shy * 0.6, 0).applyQuaternion(car.quat))
    cam.rotateX(shx * 0.3)
    cam.fov = this.fov.step((o.mode === 'cockpit' ? o.fov + 12 : o.fov + 4) + speedFov * 0.5, A.fovW, dt)
    cam.near = 0.04
    cam.far = 12000
    cam.updateProjectionMatrix()
    return { cut }
  }
}

function smooth01(x: number) {
  const t = clamp(x, 0, 1)
  return t * t * (3 - 2 * t)
}

function setFov(cam: THREE.PerspectiveCamera, fov: number, dt: number) {
  cam.fov += (fov - cam.fov) * clamp(dt * 5, 0, 1)
  cam.far = 12000
  cam.updateProjectionMatrix()
}

function angleDiff(a: number, b: number) {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

/** Cinematic camera director for the menu background. */
function attractCamera(cam: THREE.PerspectiveCamera, s: any, dt: number) {
  const cars = game.cars
  if (!cars.length) return
  s.attractTimer -= dt
  if (s.attractTimer <= 0) {
    s.attractTimer = 7 + Math.random() * 4
    s.attractShot = (s.attractShot + 1) % 4
    cameraCut.frames = 3
    // follow the car that leads a small pack if possible
    s.attractCar = Math.floor(Math.random() * cars.length)
    const e = cars[s.attractCar]
    const v = e.sim.vehicle
    // place a trackside camera ahead of the car
    const tr = game.track
    const sAhead = e.timing.s + 60 + v.speed * 2.2
    const i = tr.idx(sAhead)
    const sideSign = tr.curv[i] > 0 ? -1 : 1
    const S = sideSign > 0 ? tr.L : tr.R
    const low = s.attractShot === 1
    const p = tr.pointAt(sAhead, sideSign * (low ? tr.hw[i] + S.kerb[i] + 1.5 : S.wall[i] + 9), { x: 0, y: 0, z: 0 })
    s.tvPos.set(p.x, p.y + (low ? 0.5 : 7.5), p.z)
    s.initialized = false
  }
  const e = cars[s.attractCar % cars.length]
  const pose = carPoses.get(e.id)
  if (!pose) return
  cameraFocus.copy(pose.pos)
  _fwd.set(0, 0, 1).applyQuaternion(pose.quat)
  const shot = s.attractShot
  if (shot === 0 || shot === 1) {
    // trackside TV camera with long lens tracking the car
    cam.position.copy(s.tvPos)
    _look.copy(pose.pos).add(_v2.set(0, 0.6, 0))
    cam.lookAt(_look)
    const dist = cam.position.distanceTo(pose.pos)
    const fov = clamp((2 * Math.atan(5.5 / Math.max(dist, 1)) * 180) / Math.PI, 7, 50)
    cam.fov = fov
    cam.near = 0.5
    cam.far = 12000
    cam.updateProjectionMatrix()
    if (dist > 260) s.attractTimer = 0
  } else if (shot === 2) {
    // low chase alongside
    const heading = Math.atan2(_fwd.x, _fwd.z)
    if (!s.initialized) {
      s.yaw = heading
      s.initialized = true
    }
    s.yaw += angleDiff(heading, s.yaw) * clamp(dt * 3, 0, 1)
    const a = s.yaw + 0.55
    _v.set(pose.pos.x - Math.sin(a) * 5.5, pose.pos.y + 0.55, pose.pos.z - Math.cos(a) * 5.5)
    cam.position.copy(_v)
    _look.copy(pose.pos).add(_v2.set(0, 0.45, 0)).addScaledVector(_fwd, 1.2)
    cam.lookAt(_look)
    cam.fov = 40
    cam.near = 0.1
    cam.updateProjectionMatrix()
  } else {
    // helicopter: high, slow orbit
    const t = performance.now() / 1000
    _v.set(pose.pos.x + Math.sin(t * 0.12) * 45, pose.pos.y + 26, pose.pos.z + Math.cos(t * 0.12) * 45)
    if (!s.initialized) {
      s.pos.copy(_v)
      s.initialized = true
    }
    s.pos.lerp(_v, clamp(dt * 1.5, 0, 1))
    cam.position.copy(s.pos)
    cam.lookAt(pose.pos)
    cam.fov = 24
    cam.near = 0.5
    cam.updateProjectionMatrix()
  }
  void _q
  void _m
  void _e
}
