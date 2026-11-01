// Dynamic reflection probe around the player's car: a cube camera re-renders the surroundings every
// few frames so paint, glass and rims reflect the actual trees, stands and barriers (complements SSR,
// which can only reflect what is on screen).
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three/webgpu'
import { game } from '../game/game'
import { useSettings } from '../state/settings'
import { carPoses } from './CarVisual'

export function ReflectionProbe() {
  const { gl, scene } = useThree()
  const enabled = useSettings((s) => s.graphics.envProbe)
  const probe = useMemo(() => {
    const rt = new THREE.CubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter })
    const cam = new THREE.CubeCamera(0.4, 900, rt)
    return { rt, cam }
  }, [])
  const assigned = useRef<THREE.Object3D | null>(null)
  const frame = useRef(0)

  useEffect(() => () => probe.rt.dispose(), [probe])

  useFrame(() => {
    const player = game.player
    const pose = player ? carPoses.get(player.id) : undefined
    const root = pose?.model?.root ?? null
    // (re)assign the probe as environment map of the player's car materials
    if (root !== assigned.current || !enabled) {
      const setEnv = (obj: THREE.Object3D | null, tex: THREE.Texture | null) =>
        obj?.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined
          if (!m) return
          for (const mat of Array.isArray(m) ? m : [m]) {
            if (!('envMap' in mat) || mat.side === THREE.BackSide) continue
            mat.envMap = tex
            mat.needsUpdate = true
          }
        })
      if (assigned.current && assigned.current !== root) setEnv(assigned.current, null)
      if (root && enabled) setEnv(root, probe.rt.texture)
      if (!enabled && root) setEnv(root, null)
      assigned.current = enabled ? root : null
    }
    if (!enabled || !root || game.mode === 'attract') return
    if (frame.current++ % 4 !== 0) return
    probe.cam.position.copy(root.position)
    probe.cam.position.y += 0.6
    const vis = root.visible
    root.visible = false
    probe.cam.update(gl as unknown as THREE.WebGPURenderer, scene)
    root.visible = vis
  }, -1)

  return null
}
