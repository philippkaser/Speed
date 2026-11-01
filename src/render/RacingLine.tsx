// GT-style driving line: green = accelerate, yellow = at the limit, red = braking zone.
import { useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { attribute, cameraPosition, float, length, mix, positionWorld, smoothstep, uniform, vec3, step } from 'three/tsl'
import { speedProfileFor } from '../ai/aiDriver'
import { game } from '../game/game'
import { DS, type Track } from '../track/track'
import { useSettings } from '../state/settings'

const modeU = uniform(1) // 1 = braking zones only, 2 = full

export function RacingLine({ track }: { track: Track }) {
  const mode = useSettings((s) => s.racingLine)
  modeU.value = mode === 'full' ? 2 : 1
  const mesh = useMemo(() => {
    const p = game.player
    if (!p) return null
    const prof = speedProfileFor(p.sim.vehicle, track, 1)
    const n = track.n
    const pos: number[] = [],
      kind: number[] = [],
      idx: number[] = []
    const tmp = { x: 0, y: 0, z: 0 }
    const STEP = 2
    for (let i = 0; i <= n; i += STEP) {
      const ii = i % n
      const ahead = (ii + 6) % n
      const dv = prof[ahead] - prof[ii]
      // braking: profile drops ahead; limit: in a corner with nearly constant speed
      const k = dv < -0.35 ? 2 : Math.abs(track.racingCurv[ii]) > 1 / 300 && dv < 0.25 ? 1 : 0
      const d = track.racing[ii]
      const base = pos.length / 3
      for (const off of [-0.45, 0.45]) {
        // lateral offset along the track's left vector
        track.pointAt(i * DS, d + off, tmp)
        pos.push(tmp.x, tmp.y + 0.025, tmp.z)
        kind.push(k)
      }
      if (i > 0) idx.push(base - 2, base, base - 1, base - 1, base, base + 1)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1))
    g.setIndex(idx)
    g.computeVertexNormals()
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 })
    const kindA = attribute('aKind', 'float')
    const col = mix(mix(vec3(0.1, 0.9, 0.35), vec3(1.0, 0.82, 0.1), smoothstep(0.5, 1.0, kindA)), vec3(1.0, 0.12, 0.1), smoothstep(1.5, 2.0, kindA))
    const dist = length(positionWorld.sub(cameraPosition))
    const fade = smoothstep(6, 14, dist).mul(smoothstep(240, 120, dist))
    const visible = mix(step(0.5, kindA), float(1), step(1.5, modeU))
    m.colorNode = col.mul(1.6)
    m.opacityNode = fade.mul(visible).mul(0.55)
    const mesh = new THREE.Mesh(g, m)
    mesh.frustumCulled = false
    mesh.renderOrder = 3
    return mesh
  }, [track])
  if (!mesh || mode === 'off' || game.mode === 'attract' || game.mode === 'showroom') return null
  return <primitive object={mesh} />
}
