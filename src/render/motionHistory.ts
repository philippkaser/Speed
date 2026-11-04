// Motion history: where every object, the camera and every spinning wheel was one frame ago.
//
// The motion blur reads per-pixel motion from the scene pass. three's VelocityNode keeps an
// object's previous matrix per draw call and the camera's per tick of its own animation loop, which
// breaks in several ways here:
//  - a mesh with several material groups (the car body: paint, glass, carbon, lights...) is drawn
//    once per group, so every group after the first saw previous == current and smeared;
//  - an object that was hidden in the previous frame (an LOD level switching in, culling) had no
//    history and streaked for a frame;
//  - the camera history advanced with three's internal rAF loop, not with the frames we render;
//  - wheels turn 100 degrees and more per frame at speed. The straight chord between two angles is
//    not a motion anyone can blur along: the wheels smeared out over the bodywork and the road;
//  - transparent surfaces (glass, decals, the ghost car) overwrote the motion of what is behind
//    them: the world seen through a windscreen never blurred while the screen's edges smeared.
//
// Here the history of every mesh (drawn or not) and of the camera advances exactly once per frame,
// in beginMotionFrame(). Wheels register themselves and get a slot: the motion blur reconstructs
// their screw motion (hub velocity, axle, angle swept during the exposure) analytically instead of
// following the chord. The velocity target carries, per pixel: motion in NDC per frame (xy), the
// wheel slot (z: +slot spinning, -slot steering-only parts such as calipers) and the inverse view
// distance of the surface that owns the motion (w). Transparent surfaces leave it untouched.
import * as THREE from 'three/webgpu'
import { Fn, positionView, uniform, uniformArray, vec4, velocity } from 'three/tsl'

type N = any

/** Wheels whose rotation the motion blur reconstructs (the nearest ones get a slot). */
export const MAX_WHEEL_SLOTS = 64

let frame = 0

interface Track {
  f: number
  prev: THREE.Matrix4
  cur: THREE.Matrix4
}
const tracks = new WeakMap<THREE.Object3D, Track>()

function advance(o: THREE.Object3D, m: THREE.Matrix4 = o.matrixWorld): Track {
  let t = tracks.get(o)
  if (!t) {
    t = { f: frame, prev: m.clone(), cur: m.clone() }
    tracks.set(o, t)
    return t
  }
  if (t.f !== frame) {
    // continuous history only from the frame right before; anything older is a jump
    if (t.f === frame - 1) t.prev.copy(t.cur)
    else t.prev.copy(m)
    t.cur.copy(m)
    t.f = frame
  }
  return t
}

// ------------------------------------------------------------------------------------------ camera

const cam = {
  obj: null as THREE.Camera | null,
  f: -1,
  prevView: new THREE.Matrix4(),
  curView: new THREE.Matrix4(),
  prevProj: new THREE.Matrix4(),
  curProj: new THREE.Matrix4(),
  /** the camera's path (its pose without shake) this frame and the last */
  path: new THREE.Matrix4(),
  prevPath: new THREE.Matrix4(),
  /** where the blur's camera was one frame ago: last frame's path with this frame's shake */
  blurPrevWorld: new THREE.Matrix4(),
}

/**
 * The camera the motion blur sees: the real one, exactly, minus deliberate shake. Anything the
 * camera follows (the car in a chase or helicopter shot) or is mounted on (the cockpit) must stay
 * sharp, so the blur uses the camera's true path: a smoothed path lags behind every change of
 * speed or direction and smeared exactly those things. The rigs' shake (kerbs, mount vibration) is
 * not part of the path: they report the pose before shaking (markCameraPath), and the blur takes
 * last frame's path with this frame's shake, so shake never moves anything. (The velocity target
 * itself is drawn with the true camera, shake included; the blur's prepare pass swaps the camera.)
 */
const shake = { pending: false, path: new THREE.Matrix4() }

/** Camera rigs: call once the camera sits on its path, before adding shake to it. */
export function markCameraPath(camera: THREE.Object3D) {
  camera.updateMatrixWorld()
  shake.path.copy(camera.matrixWorld)
  shake.pending = true
}

// ------------------------------------------------------------------------------------------ wheels

export interface WheelSource {
  /** steers, cambers and rides with the suspension, but does not spin (calipers hang here) */
  pivot: THREE.Object3D
  /** child of the pivot, turning about the pivot's +x axis */
  spin: THREE.Object3D
  radius: number
  /** angular velocity about +x, rad/s */
  omega: () => number
}

interface Wheel extends WheelSource {
  spinMeshes: THREE.Object3D[]
  staticMeshes: THREE.Object3D[]
  slot: number
  track: Track | null
  dist: number
}

const wheels = new Set<Wheel>()
/** spinning mesh -> its wheel (not in userData: three clones userData through JSON) */
const spinOwner = new WeakMap<THREE.Object3D, Wheel>()

/** Registers the wheels of a car; returns the function that removes them again. */
export function registerWheels(list: WheelSource[]): () => void {
  const added: Wheel[] = []
  for (const src of list) {
    const spinMeshes: THREE.Object3D[] = []
    const staticMeshes: THREE.Object3D[] = []
    src.spin.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) spinMeshes.push(o)
    })
    src.pivot.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return
      for (let p: THREE.Object3D | null = o; p && p !== src.pivot; p = p.parent) if (p === src.spin) return
      staticMeshes.push(o)
    })
    const w: Wheel = { ...src, spinMeshes, staticMeshes, slot: 0, track: null, dist: 0 }
    for (const m of spinMeshes) spinOwner.set(m, w)
    wheels.add(w)
    added.push(w)
  }
  return () => {
    for (const w of added) {
      setSlot(w, 0)
      for (const m of w.spinMeshes) spinOwner.delete(m)
      wheels.delete(w)
    }
  }
}

function setSlot(w: Wheel, slot: number) {
  if (w.slot === slot) return
  w.slot = slot
  for (const m of w.spinMeshes) m.userData.mbSlot = slot
  for (const m of w.staticMeshes) m.userData.mbSlot = -slot
}

const blank = () => Array.from({ length: MAX_WHEEL_SLOTS + 1 }, () => new THREE.Vector4())
const arrays = { hub: blank(), axle: blank(), motion: blank() }
/**
 * Per wheel slot, in the current camera's view space:
 * hub: centre xyz, w = angle swept during the exposure (rad, about `axle`)
 * axle: unit axis xyz, w = radius
 * motion: xy = the hub's motion in NDC over one frame (like the velocity target)
 */
export const wheelUniforms = {
  hub: uniformArray(arrays.hub, 'vec4'),
  axle: uniformArray(arrays.axle, 'vec4'),
  motion: uniformArray(arrays.motion, 'vec4'),
}

/** The current camera's unjittered projection (for reconstructing positions in the motion blur). */
export const motionCamera = {
  projX: uniform(1),
  projY: uniform(1),
  /** current view space -> previous clip space, with the camera that drew the velocity target */
  toPrevTrue: uniform(new THREE.Matrix4()),
  /** current view space -> previous clip space, with the blur's camera (no shake) */
  toPrevBlur: uniform(new THREE.Matrix4()),
}

/** Clock for vertex animation (wind): materials that move vertices must also move positionPrevious. */
export const motionTime = { now: uniform(0), prev: uniform(0) }

// ---------------------------------------------------------------------------------- velocity node

const proto = Object.getPrototypeOf(velocity) as {
  update(frame: { object: THREE.Object3D; camera: THREE.Camera }): void
  updateAfter(frame: unknown): void
  previousModelWorldMatrix: { value: THREE.Matrix4 }
  previousProjectionMatrix: { value: THREE.Matrix4 }
  previousCameraViewMatrix: { value: THREE.Matrix4 }
  currentProjectionMatrix: { value: THREE.Matrix4 }
  projectionMatrix: THREE.Matrix4 | null
  __speedMotion?: boolean
}

const _m = new THREE.Matrix4()
const _m2 = new THREE.Matrix4()

if (!proto.__speedMotion) {
  proto.__speedMotion = true
  proto.update = function (this: typeof proto, { object, camera }) {
    const t = tracks.get(object)
    let prev = t && t.f === frame ? t.prev : object.matrixWorld
    // a spinning part without a slot: hub motion only (a chord is no motion to blur along)
    const w = spinOwner.get(object)
    if (w && w.slot === 0 && t && t.f === frame) {
      const pt = tracks.get(w.pivot)
      if (pt && pt.f === frame) prev = _m.copy(pt.prev).multiply(_m2.copy(pt.cur).invert()).multiply(object.matrixWorld)
    }
    this.previousModelWorldMatrix.value.copy(prev)
    const tracked = camera === cam.obj && cam.f === frame
    this.previousProjectionMatrix.value.copy(tracked ? cam.prevProj : camera.projectionMatrix)
    this.previousCameraViewMatrix.value.copy(tracked ? cam.prevView : camera.matrixWorldInverse)
    this.currentProjectionMatrix.value.copy(this.projectionMatrix || camera.projectionMatrix)
  }
  proto.updateAfter = function () {}
}

/** Wheel slot of the object being drawn (0: none). */
const wheelSlot = uniform(0).onObjectUpdate(({ object }) => (object?.userData.mbSlot as number) ?? 0)

/**
 * The scene pass's velocity output. Transparent materials write zeros, which their blending turns
 * into "keep what is behind" (see motionBlendMode).
 */
export const motionVelocityOutput: N = Fn((_: unknown, builder: { material?: THREE.Material }) => {
  if (builder.material?.transparent) return vec4(0)
  return vec4(velocity as N, wheelSlot, positionView.z.negate().max(1e-4).reciprocal())
})()

/** Blend the velocity target with each material's own blending (opaque: overwrite). */
export const motionBlendMode = new THREE.BlendMode(THREE.MaterialBlending)

// ------------------------------------------------------------------------------------ frame update

const _v = new THREE.Vector3()
const _p = new THREE.Vector3()
const _a = new THREE.Vector3()
const _c = new THREE.Vector4()
const _q = new THREE.Vector4()
const _mv = new THREE.Matrix4()
const _fwd = new THREE.Vector3()
const _camPos = new THREE.Vector3()
const ranked: Wheel[] = []

function ndc(view: THREE.Vector3, proj: THREE.Matrix4, out: THREE.Vector4) {
  out.set(view.x, view.y, view.z, 1).applyMatrix4(proj)
  const w = Math.abs(out.w) > 1e-6 ? out.w : 1e-6
  out.x /= w
  out.y /= w
  return out
}

export interface MotionFrameOptions {
  /** the camera jumped (cut): no camera motion this frame */
  cut: boolean
  /** exposure time in seconds */
  exposure: number
  /** frame time in seconds */
  dt: number
}

/** Call once per frame after everything has moved and before the scene is rendered. */
export function beginMotionFrame(scene: THREE.Object3D, camera: THREE.Camera, opts: MotionFrameOptions) {
  frame++
  motionTime.prev.value = motionTime.now.value
  motionTime.now.value += opts.dt

  scene.updateMatrixWorld()
  camera.updateMatrixWorld()
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints) advance(o)
  })

  // camera
  const jump = cam.obj !== camera || cam.f !== frame - 1 || opts.cut
  if (jump) {
    cam.prevView.copy(camera.matrixWorldInverse)
    cam.prevProj.copy(camera.projectionMatrix)
  } else {
    cam.prevView.copy(cam.curView)
    cam.prevProj.copy(cam.curProj)
  }
  cam.obj = camera
  cam.f = frame
  cam.curView.copy(camera.matrixWorldInverse)
  cam.curProj.copy(camera.projectionMatrix)
  blurCamera(camera, jump)
  const P = camera.projectionMatrix.elements
  motionCamera.projX.value = P[0]
  motionCamera.projY.value = P[5]

  updateWheels(camera, opts.exposure)
}

const _rel = new THREE.Matrix4()

/** The blur's camera: the true camera with this frame's shake taken out of the motion. */
function blurCamera(camera: THREE.Camera, jump: boolean) {
  cam.path.copy(shake.pending ? shake.path : camera.matrixWorld)
  shake.pending = false
  if (jump) cam.prevPath.copy(cam.path)
  // the shake on top of this frame's path, applied to last frame's path as well
  _rel.copy(cam.path).invert().multiply(camera.matrixWorld)
  cam.blurPrevWorld.multiplyMatrices(cam.prevPath, _rel)
  cam.prevPath.copy(cam.path)
  // current view -> previous clip: true (as the velocity target was drawn) and the blur's
  const toPrevTrue = motionCamera.toPrevTrue.value as THREE.Matrix4
  toPrevTrue.multiplyMatrices(cam.prevProj, cam.prevView).multiply(camera.matrixWorld)
  const toPrevBlur = motionCamera.toPrevBlur.value as THREE.Matrix4
  toPrevBlur.copy(cam.blurPrevWorld).invert().premultiply(cam.prevProj).multiply(camera.matrixWorld)
}

function updateWheels(camera: THREE.Camera, exposure: number) {
  _camPos.setFromMatrixPosition(camera.matrixWorld)
  _fwd.set(0, 0, -1).transformDirection(camera.matrixWorld)
  const tanHalf = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360) : 1
  ranked.length = 0
  for (const w of wheels) {
    w.track = advance(w.pivot)
    let visible = true
    for (let o: THREE.Object3D | null = w.spin; o; o = o.parent) if (!o.visible) visible = false
    _p.setFromMatrixPosition(w.pivot.matrixWorld)
    const along = _v.subVectors(_p, _camPos).dot(_fwd)
    const d = _v.length()
    // in front of the camera and at least a few pixels across
    if (!visible || along < -w.radius || w.radius / Math.max(d, 1e-3) / tanHalf < 0.004) {
      setSlot(w, 0)
      continue
    }
    w.dist = d
    ranked.push(w)
  }
  ranked.sort((a, b) => a.dist - b.dist)
  const used = new Set<number>()
  // keep slots stable for wheels that keep one
  for (let i = 0; i < ranked.length; i++) {
    const w = ranked[i]
    if (i < MAX_WHEEL_SLOTS && w.slot > 0) used.add(w.slot)
    else if (i >= MAX_WHEEL_SLOTS) setSlot(w, 0)
  }
  let next = 1
  const { hub, axle, motion } = arrays
  for (let i = 0; i < Math.min(ranked.length, MAX_WHEEL_SLOTS); i++) {
    const w = ranked[i]
    if (w.slot <= 0) {
      while (used.has(next)) next++
      setSlot(w, next)
      used.add(next)
    }
    const s = w.slot
    const t = w.track!
    // hub and axle in view space
    _mv.multiplyMatrices(cam.curView, t.cur)
    _p.setFromMatrixPosition(_mv)
    _a.set(_mv.elements[0], _mv.elements[1], _mv.elements[2]).normalize()
    // angle swept while the shutter is open; beyond a full turn it is a uniform disc anyway
    let phi = w.omega() * exposure
    if (!Number.isFinite(phi)) phi = 0
    phi = Math.max(-Math.PI * 2, Math.min(Math.PI * 2, phi))
    hub[s].set(_p.x, _p.y, _p.z, phi)
    axle[s].set(_a.x, _a.y, _a.z, w.radius)
    // hub motion over the last frame in NDC, like the velocity target
    ndc(_p, cam.curProj, _c)
    _mv.multiplyMatrices(cam.prevView, t.prev)
    _v.setFromMatrixPosition(_mv)
    ndc(_v, cam.prevProj, _q)
    motion[s].set(_c.x - _q.x, _c.y - _q.y, 0, 0)
  }
}
