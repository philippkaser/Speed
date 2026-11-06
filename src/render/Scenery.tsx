// Trackside scenery: the pit building, grandstands with their crowds, the start gantry, the bridge,
// billboards, braking boards, marshal posts, floodlight masts, TV towers and the big screen, all built
// from the procedural architecture kit (scenery/), and the vegetation (Vegetation.tsx).
//
// Everything static is merged per material: the whole circuit's architecture is a handful of draw
// calls (structures, glass, signs, seats, small props and their signs, the crowd, the start lamps).
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Vegetation } from './Vegetation'
import * as THREE from 'three/webgpu'
import { color, Fn, instanceIndex, mix, step, uniform } from 'three/tsl'
import { game } from '../game/game'
import type { Track } from '../track/track'
import type { TerrainHeight } from './trackGeometry'
import { Kit, trackFrame } from './scenery/kit'
import { archMaterial, glassMaterial, signMaterial } from './scenery/archMaterials'
import { buildPitBuilding, glassKit } from './scenery/pitBuilding'
import { buildGrandstand } from './scenery/grandstand'
import { buildProps, frameDir } from './scenery/props'
import { signAtlas, signKit, SLOT, SPONSORS } from './scenery/signage'
import { crowdMesh, type Spectator } from './scenery/crowd'

export const gantryLights = uniform(0) // number of lit red pairs (0..5); -1 = green

function staticMesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, o: { cast?: boolean; noProbe?: boolean } = {}) {
  const m = new THREE.Mesh(geo, mat)
  m.name = name
  m.castShadow = !!o.cast
  m.receiveShadow = true
  if (o.noProbe) m.userData.noProbe = true
  m.matrixAutoUpdate = false
  m.updateMatrix()
  return m
}

export function Scenery({ track, heights }: { track: Track; heights: TerrainHeight }) {
  const structures = useMemo(() => {
    const t0 = performance.now()
    const g = new THREE.Group()
    g.name = 'scenery'
    const arch = new Kit(),
      glass = glassKit(),
      sign = signKit(Kit),
      seats = new Kit(),
      props = new Kit(),
      propSign = signKit(Kit)

    // ---- pit building on the outside (left side) of the main straight
    buildPitBuilding(track, { arch, glass, sign })

    // ---- grandstands on the inside (right side) of the main straight, facing the pits
    const spots: Spectator[] = []
    const stands = [
      { s0: -175, len: 110, rows: 16, seat: 0x1d3f8f, accent: 0xe8e8e8, seed: 3, hoard: [SLOT.nordkap, SLOT.helix, SLOT.vanta] },
      { s0: -40, len: 140, rows: 22, seat: 0xb01428, accent: 0xf2f2f2, seed: 7, hoard: SPONSORS },
      { s0: 130, len: 95, rows: 16, seat: 0x2e6b3a, accent: 0xf5b800, seed: 11, hoard: [SLOT.voltara, SLOT.kairo, SLOT.stratos] },
    ]
    for (const st of stands) {
      const sMid = st.s0 + st.len / 2
      const i = track.idx(sMid)
      const m = trackFrame(track, sMid, -(track.R.wall[i] + 7), 1, -0.2)
      for (const k of [arch, seats, sign]) k.setFrame(m)
      spots.push(...buildGrandstand({ length: st.len, rows: st.rows, seat: st.seat, accent: st.accent, seed: st.seed, occupancy: 0.78, hoardings: st.hoard }, { arch, seats, sign }, m))
    }

    // ---- gantry, bridge, boards, posts, masts, towers, screen, pit wall stations, wall boards
    buildProps(track, { arch, sign, props, propSign })

    const archMat = archMaterial()
    const signMat = signMaterial(signAtlas())
    g.add(staticMesh(arch.toGeometry(), archMat, 'architecture', { cast: true }))
    g.add(staticMesh(glass.toGeometry(), glassMaterial(), 'glass', { cast: true }))
    g.add(staticMesh(sign.toGeometry(), signMat, 'signs'))
    // seats and small props: no shadows of their own worth the cost, not in the reflection probes
    g.add(staticMesh(seats.toGeometry(), archMat, 'seats', { noProbe: true }))
    g.add(staticMesh(props.toGeometry(), archMat, 'props', { noProbe: true }))
    g.add(staticMesh(propSign.toGeometry(), signMat, 'prop-signs', { noProbe: true }))
    const crowd = crowdMesh(spots)
    g.add(crowd)

    // ---- start lamps on the gantry's light panel: 5 columns x 2 red, plus the green state
    {
      const m = frameDir(track, -3, 0, 0, 1)
      const lampMat = new THREE.MeshStandardNodeMaterial({ color: 0x050505, roughness: 0.3 })
      const idx = Fn(() => instanceIndex.toFloat())()
      const col = idx.mod(5)
      const lit = step(col.add(0.5), gantryLights).mul(step(0, gantryLights))
      const green = step(gantryLights, -0.5)
      lampMat.emissiveNode = mix(color(0, 0, 0), color(14, 0.2, 0.05), lit).add(color(0.2, 10, 1).mul(green))
      const disc = new THREE.CircleGeometry(0.2, 16)
      disc.rotateY(Math.PI / 2)
      const lamps = new THREE.InstancedMesh(disc, lampMat, 10)
      for (let k = 0; k < 10; k++) {
        const c = k % 5,
          row = Math.floor(k / 5)
        const lm = new THREE.Matrix4().makeTranslation(0.31, 7.25 - row * 0.5, 2 - c)
        lamps.setMatrixAt(k, m.clone().multiply(lm))
      }
      lamps.name = 'start-lamps'
      lamps.userData.noProbe = true
      g.add(lamps)
    }
    g.traverse((o) => {
      o.matrixAutoUpdate = false
      o.updateMatrix()
    })
    const tris = [arch, glass, sign, seats, props, propSign].reduce((a, k) => a + k.triangles, 0) + spots.length * 2
    console.info(`[scenery] ${tris} triangles (${arch.triangles} structures, ${seats.triangles} seats), ${spots.length} spectators, built in ${(performance.now() - t0).toFixed(0)} ms`)
    return g
  }, [track])

  useEffect(
    () => () => {
      structures.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
      })
    },
    [structures],
  )

  useFrame(() => {
    // start lights follow the race countdown
    if (game.phase === 'grid' || game.phase === 'countdown') {
      const c = game.countdown
      gantryLights.value = c > 3.5 ? 0 : Math.min(5, Math.floor((3.5 - c) / 0.6) + 1)
    } else if (game.phase === 'racing' && game.raceTime < 4) gantryLights.value = -1
    else gantryLights.value = 0
  })

  return (
    <>
      <primitive object={structures} />
      <Vegetation track={track} heights={heights} />
    </>
  )
}
