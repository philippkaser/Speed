import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import type { CarEntry } from '../game/game'
import { game } from '../game/game'
import { buildCarModel, type CarModel } from '../car/carModel'

const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()

/** Pose of every car in the current frame (interpolated), shared with cameras & effects. */
export const carPoses = new Map<string, { pos: THREE.Vector3; quat: THREE.Quaternion; model?: CarModel }>()

export function CarVisual({ entry, lod = 0 }: { entry: CarEntry; lod?: number }) {
  const model = useMemo(() => buildCarModel(entry.carId, entry.color, lod), [entry.carId, entry.color, lod])
  useEffect(() => {
    const pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), model }
    carPoses.set(entry.id, pose)
    return () => {
      carPoses.delete(entry.id)
      model.dispose()
    }
  }, [entry.id, model])

  useFrame(() => {
    const sim = entry.sim
    const v = sim.vehicle
    const a = entry.isRemote ? 1 : game.world.alpha
    const root = model.root
    root.position.set(sim.prevPos.x + (v.pos.x - sim.prevPos.x) * a, sim.prevPos.y + (v.pos.y - sim.prevPos.y) * a, sim.prevPos.z + (v.pos.z - sim.prevPos.z) * a)
    _q.set(sim.prevQuat.x, sim.prevQuat.y, sim.prevQuat.z, sim.prevQuat.w)
    _q2.set(v.q.x, v.q.y, v.q.z, v.q.w)
    root.quaternion.slerpQuaternions(_q, _q2, a)
    const pose = carPoses.get(entry.id)
    if (pose) {
      pose.pos.copy(root.position)
      pose.quat.copy(root.quaternion)
    }
    model.update(v, entry)
  }, -5)

  return <primitive object={model.root} />
}
