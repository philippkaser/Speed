// Motion vectors that advance once per frame.
//
// three's VelocityNode stores an object's "previous" world matrix after *every draw* of the object.
// A mesh with several material groups (the car body: paint, grille, glass, carbon, lights...) is
// drawn once per group, so every group after the first sees previous == current and gets the motion
// vector of a parked object (the road's motion), which smeared those parts in the motion blur.
// Here the previous matrix advances once per animation frame instead, and an object that was not
// drawn in the previous frame (culled, hidden) starts with zero motion instead of a one-frame streak.
import * as THREE from 'three/webgpu'
import { velocity } from 'three/tsl'

let frame = 0
/** Call once per animation frame, before rendering. */
export function advanceVelocityFrame() {
  frame++
}

interface Track {
  f: number
  prev: THREE.Matrix4
  cur: THREE.Matrix4
}
const tracks = new WeakMap<object, Track>()

const proto = Object.getPrototypeOf(velocity) as {
  update(frame: { object: THREE.Object3D }): void
  updateAfter(frame: unknown): void
  previousModelWorldMatrix: { value: THREE.Matrix4 }
  __speedPatched?: boolean
}

if (!proto.__speedPatched) {
  proto.__speedPatched = true
  const update = proto.update
  proto.update = function (this: typeof proto, nodeFrame: { object: THREE.Object3D }) {
    update.call(this, nodeFrame)
    const o = nodeFrame.object
    let t = tracks.get(o)
    if (!t) {
      t = { f: frame, prev: o.matrixWorld.clone(), cur: o.matrixWorld.clone() }
      tracks.set(o, t)
    } else if (t.f !== frame) {
      if (t.f === frame - 1) t.prev.copy(t.cur)
      else t.prev.copy(o.matrixWorld)
      t.cur.copy(o.matrixWorld)
      t.f = frame
    }
    this.previousModelWorldMatrix.value.copy(t.prev)
  }
  proto.updateAfter = function () {}
}
