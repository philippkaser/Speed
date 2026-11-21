// Time-trial ghost: replays the best lap as a translucent car.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three/webgpu'
import { abs, dot, float, normalView, positionViewDirection, vec3 } from 'three/tsl'
import { buildGltfCar, modelFor, onCarModels } from '../car/gltfCars'
import { game } from '../game/game'
import { getCar } from '../physics/spec'

const _q0 = new THREE.Quaternion(),
  _q1 = new THREE.Quaternion()

export function Ghost() {
  const entry = game.player
  // the player's own model (once it has arrived), drawn as a translucent shell
  const [shown, setShown] = useState(() => modelFor(entry?.model))
  useEffect(() => {
    setShown(modelFor(entry?.model))
    return onCarModels(() => setShown(modelFor(entry?.model)))
  }, [entry])
  const model = useMemo(() => (entry && shown ? buildGltfCar(shown, getCar(entry.carId), { color: '#9fd4ff', accent: '#9fd4ff' }) : null), [entry, shown])
  useEffect(() => {
    if (!model) return
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    mat.colorNode = vec3(0.55, 0.8, 1.0).mul(1.4)
    // rim-lit look: more opaque at grazing angles
    const rim = float(1).sub(abs(dot(normalView, positionViewDirection))).pow(2)
    mat.opacityNode = rim.mul(0.5).add(0.1)
    model.root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.material = mat
        m.castShadow = false
        m.receiveShadow = false
        m.renderOrder = 4
      }
    })
    model.setVisibleParts({ interior: false })
    // one level of detail (the model's levels cross-fade through their own materials, replaced here:
    // all of them would draw on top of each other), the middle one: enough for a translucent shell
    model.root.traverse((o) => {
      const lod = /_lod(\d)$/.exec(o.name)
      if (lod) o.visible = lod[1] === '1'
      else if (/_fixed$/.test(o.name)) o.visible = false
    })
    return () => model.dispose()
  }, [model])

  useFrame(() => {
    if (!model || !entry) return
    const g = game.ghostBest
    const t = entry.timing
    model.root.visible = false
    if (!g || !t.started || game.mode !== 'practice') return
    const time = t.current
    // binary search the sample just before `time`
    const n = g.length / 8
    let lo = 0,
      hi = n - 1
    if (time >= g[(n - 1) * 8]) return
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (g[mid * 8] <= time) lo = mid
      else hi = mid
    }
    const a = lo * 8,
      b = hi * 8
    const f = Math.min(1, Math.max(0, (time - g[a]) / Math.max(g[b] - g[a], 1e-4)))
    model.root.position.set(g[a + 1] + (g[b + 1] - g[a + 1]) * f, g[a + 2] + (g[b + 2] - g[a + 2]) * f, g[a + 3] + (g[b + 3] - g[a + 3]) * f)
    _q0.set(g[a + 4], g[a + 5], g[a + 6], g[a + 7])
    _q1.set(g[b + 4], g[b + 5], g[b + 6], g[b + 7])
    model.root.quaternion.slerpQuaternions(_q0, _q1, f)
    // fade out when you're right on top of it
    const d = model.root.position.distanceTo(entry.sim.vehicle.pos as unknown as THREE.Vector3)
    model.root.visible = d > 2.5
    model.update(entry.sim.vehicle)
  }, -4)

  return model ? <primitive object={model.root} /> : null
}
