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

export const CAMERA_MODES = ['chase', 'chaseNear', 'cockpit', 'hood', 'bumper'] as const
export type DriveCam = (typeof CAMERA_MODES)[number]

const _v = new THREE.Vector3(),
  _v2 = new THREE.Vector3(),
  _look = new THREE.Vector3(),
  _fwd = new THREE.Vector3(),
  _up = new THREE.Vector3(),
  _q = new THREE.Quaternion(),
  _m = new THREE.Matrix4(),
  _e = new THREE.Euler()

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
    const lookBack = input.lookBack()
    const side = input.lookSide()
    const heading = Math.atan2(_fwd.x, _fwd.z)
    const velHeading = speed > 3 ? Math.atan2(v.vel.x, v.vel.z) : heading
    if (!s.initialized || s.lastMode !== camMode) {
      s.yaw = heading
      s.pitch = 0
      s.initialized = true
      cameraCut.frames = 3
    }
    s.lastMode = camMode
    // camera yaw blends between heading and velocity (shows the slide angle)
    let targetYaw = heading + angleDiff(velHeading, heading) * clamp(speed / 30, 0, 1) * 0.45
    if (lookBack) targetYaw += Math.PI
    targetYaw += side * Math.PI * 0.5
    if (lookBack !== s.wasLookBack) {
      cameraCut.frames = 3
      s.wasLookBack = lookBack
    }
    s.yaw += angleDiff(targetYaw, s.yaw) * clamp(dt * (lookBack || side ? 30 : 7.5), 0, 1)
    const fwdPitch = Math.asin(clamp(_fwd.y, -0.5, 0.5))
    s.pitch += (fwdPitch * 0.7 - s.pitch) * clamp(dt * 4, 0, 1)

    const shakeAmt = gfx.cameraShake
    const kerb = v.wheels.reduce((a, w) => a + (w.surface === 1 || w.surface === 2 || w.surface === 3 ? 1 : 0), 0) / 4
    const road = Math.pow(clamp(speed / 85, 0, 1), 2)
    const t = s.shakeT
    const shakeMag = (road * 0.006 + kerb * 0.018 + v.scrape * 0.03) * shakeAmt
    const shx = (valueNoise2(t * 31, 1.3) - 0.5) * shakeMag,
      shy = (valueNoise2(t * 37, 7.1) - 0.5) * shakeMag

    // FOV: widen with speed (sense of speed), small kick on acceleration
    const kg = 1 - Math.exp(-dt / 0.25)
    s.gLong += (clamp(v.accelLong, -2, 2) - s.gLong) * kg
    s.gLat += (clamp(v.accelLat, -2.5, 2.5) - s.gLat) * kg
    s.fovKick += (clamp(s.gLong, -1.5, 1) * 2.2 - s.fovKick) * clamp(dt * 3, 0, 1)
    const speedFov = 13 * Math.pow(clamp((speed - 8) / 80, 0, 1), 1.2)

    const model = pose.model
    const inside = camMode === 'cockpit' || camMode === 'hood' || camMode === 'bumper'
    model?.setVisibleParts({ body: camMode !== 'hood' && camMode !== 'bumper', interior: true, driver: camMode !== 'cockpit' || lookBack })

    if (!inside || lookBack) {
      const near = camMode === 'chaseNear'
      const dist = (near ? 4.6 : 6.2) + clamp(s.gLong, -1.5, 1.2) * 0.22 + speed * 0.004
      const height = near ? 1.35 : 1.75
      const cy = Math.cos(s.yaw),
        sy = Math.sin(s.yaw)
      _v.set(carPos.x - sy * dist, carPos.y + height + Math.sin(-s.pitch) * dist * 0.5, carPos.z - cy * dist)
      // lateral g pushes the camera slightly outwards
      const lat = clamp(s.gLat, -2, 2) * 0.12
      _v.x += cy * lat
      _v.z += -sy * lat
      // keep above terrain / road
      const minY = carPos.y + 0.6
      if (_v.y < minY) _v.y = minY
      cam.position.copy(_v)
      cam.position.x += shx
      cam.position.y += shy
      _look.set(carPos.x + sy * 3.0, carPos.y + (near ? 0.75 : 0.95), carPos.z + cy * 3.0)
      cam.up.set(0, 1, 0)
      cam.lookAt(_look)
      setFov(cam, gfx.fov + speedFov + s.fovKick, dt)
      cam.near = 0.1
      cameraFocus.copy(carPos)
      return
    }

    // in-car cameras: rigidly attached to the chassis, head motion from g forces
    const eye = model ? model.cockpitEye : _v2.set(0.36, 0.55, -0.3)
    let lx = eye.x,
      ly = eye.y,
      lz = eye.z
    if (camMode === 'hood') {
      lx = 0
      ly = eye.y + 0.12
      lz = (model?.bodyOffset.z ?? 0) + (model?.body.zFront ?? 2) * 0.35
    } else if (camMode === 'bumper') {
      lx = 0
      ly = (model?.bodyOffset.y ?? -0.4) + 0.42
      lz = (model?.bodyOffset.z ?? 0) + (model?.body.zFront ?? 2.3) - 0.05
    }
    // head sway (cockpit only)
    const k = camMode === 'cockpit' ? 1 : 0.15
    s.headX += (clamp(s.gLat, -2.5, 2.5) * 0.022 * k - s.headX) * clamp(dt * 8, 0, 1)
    s.headY += (clamp(-s.gLong, -2, 2) * 0.012 * k - s.headY) * clamp(dt * 8, 0, 1)
    _v.set(lx + s.headX, ly + shy * 0.6, lz + s.headY)
    _v.applyQuaternion(carQ).add(carPos)
    cam.position.copy(_v)
    cam.quaternion.copy(carQ)
    // three cameras look down -z; the car faces +z
    cam.rotateY(Math.PI + side * Math.PI * 0.5)
    cam.rotateZ(-s.headX * 0.8 * k)
    cam.rotateX(-0.03 + shx * 0.5)
    setFov(cam, (camMode === 'cockpit' ? gfx.fov + 12 : gfx.fov + 4) + speedFov * 0.6, dt)
    cam.near = 0.04
    cam.updateProjectionMatrix()
  }, -2)

  return null
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
