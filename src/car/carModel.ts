// The car's visual model as the rest of the game sees it. Every car is one of the detailed GT3 models
// (gltfCars.ts); until its model has arrived a car is an empty stand-in that keeps its place (the
// cameras, the effects and the motion blur work as usual, there is just nothing to draw yet).
import * as THREE from 'three/webgpu'
import type { CarSpec } from '../physics/spec'
import type { Vehicle } from '../physics/vehicle'

export interface CarModel {
  root: THREE.Group
  /** body extent along the car (model space) */
  body: { zFront: number; zRear: number }
  spec: CarSpec
  update: (v: Vehicle, entry?: { id: string }) => void
  dispose: () => void
  cockpitEye: THREE.Vector3 // in root (CoG) space
  bodyOffset: THREE.Vector3
  setVisibleParts: (opts: { body?: boolean; interior?: boolean; driver?: boolean }) => void
  /** the four wheels: pivot (steers, rides), spin (child of pivot, turns about +x), physics index */
  wheels?: { pivot: THREE.Object3D; spin: THREE.Object3D; radius: number; index: number }[]
}

/** Nothing to draw yet: the stand-in while a car's detailed model loads. */
export function emptyCarModel(spec: CarSpec): CarModel {
  const root = new THREE.Group()
  root.name = 'car:' + spec.id + ':pending'
  return {
    root,
    body: { zFront: 2.3, zRear: -2.3 },
    spec,
    update: () => {},
    dispose: () => {},
    // a GT3 driver's eyes, roughly (the model calibrates its own from the helmet)
    cockpitEye: new THREE.Vector3(0.36, 0.62, -0.3),
    bodyOffset: new THREE.Vector3(),
    setVisibleParts: () => {},
    wheels: [],
  }
}
