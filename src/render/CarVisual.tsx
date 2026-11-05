import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three/webgpu'
import type { CarEntry } from '../game/game'
import { game } from '../game/game'
import { buildCarModel, type CarModel } from '../car/carModel'
import { buildGltfCar, gltfState, hasGltfCar, onCarModels } from '../car/gltfCars'
import { getCar } from '../physics/spec'
import { registerWheels } from './motionHistory'

const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()

/** Pose of every car in the current frame (interpolated), shared with cameras & effects. */
export const carPoses = new Map<string, { pos: THREE.Vector3; quat: THREE.Quaternion; model?: CarModel }>()

/** accent for cars without a team livery: light on dark paint, dark on light paint */
function autoAccent(color: string) {
  const c = new THREE.Color(color)
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.35 ? '#141518' : '#e9ebee'
}

export function CarVisual({ entry, lod = 0 }: { entry: CarEntry; lod?: number }) {
  const [modelsReady, setModelsReady] = useState(gltfState.ready)
  useEffect(() => onCarModels(() => setModelsReady(gltfState.ready)), [])
  const model = useMemo(
    () =>
      modelsReady && hasGltfCar(entry.model)
        ? buildGltfCar(entry.model, getCar(entry.carId), { color: entry.color, accent: entry.accent ?? autoAccent(entry.color) })
        : buildCarModel(entry.carId, entry.color, lod, { accent: entry.accent, number: entry.number }),
    [entry.carId, entry.color, lod, entry.accent, entry.number, entry.model, entry.isPlayer, modelsReady],
  )
  useEffect(() => {
    // no screen-space AO / GI on the cars (PostFX): its noise would sit on the clear coat's reflections
    model.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.userData.noAO = true
        // a car in the velocity target: the motion blur keeps it in front of the ground (motionHistory.ts)
        o.userData.mbCar = true
      }
    })
    const pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), model }
    carPoses.set(entry.id, pose)
    return () => {
      carPoses.delete(entry.id)
      model.dispose()
    }
  }, [entry.id, model])

  // spinning wheels: the motion blur reconstructs their rotation from the physics wheel speed
  useEffect(
    () =>
      registerWheels(
        (model.wheels ?? []).map((w) => ({
          pivot: w.pivot,
          spin: w.spin,
          radius: w.radius,
          omega: () => entry.sim.vehicle.wheels[w.index]?.omega ?? 0,
        })),
      ),
    [model, entry],
  )

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

  const tag = useRef<HTMLDivElement>(null)
  const showTags = !entry.isPlayer && (game.mode === 'race' || game.mode === 'online')
  useFrame(({ camera }) => {
    const el = tag.current
    if (!el) return
    const d = camera.position.distanceTo(model.root.position)
    const vis = d > 6 && d < 140
    el.style.opacity = vis ? String(Math.min(1, (140 - d) / 40)) : '0'
    const pos = entry.timing.position
    if (el.dataset.p !== String(pos)) {
      el.dataset.p = String(pos)
      el.firstChild!.textContent = String(pos)
    }
  })

  return (
    <primitive object={model.root}>
      {showTags && (
        <Html position={[0, 1.15, 0]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
          <div ref={tag} className="name-tag">
            <b>{entry.timing.position}</b>
            <span>{entry.name}</span>
          </div>
        </Html>
      )}
    </primitive>
  )
}
