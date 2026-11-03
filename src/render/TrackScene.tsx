import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three/webgpu'
import type { Track } from '../track/track'
import { rubberTexture, armcoMaterial, concreteWallMaterial, fenceMaterial, kerbMaterial, markingMaterial, mountainMaterial, roadMaterial, runoffMaterial, terrainMaterial, tyreWallMaterial, vergeMaterial } from './materials'
import { Scenery } from './Scenery'
import { debugFlag } from '../util/debug'
import { buildBarriers, buildKerbs, buildMarkings, buildMountains, buildRoad, buildRunoff, buildTerrain, buildVerge } from './trackGeometry'

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, opts: { cast?: boolean; receive?: boolean; name?: string } = {}) {
  const m = new THREE.Mesh(geo, mat)
  m.castShadow = !!opts.cast
  m.receiveShadow = opts.receive ?? true
  m.name = opts.name ?? ''
  m.matrixAutoUpdate = false
  m.updateMatrix()
  return m
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, matrices: THREE.Matrix4[], cast = true) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, matrices.length))
  matrices.forEach((mx, i) => m.setMatrixAt(i, mx))
  m.count = matrices.length
  m.castShadow = cast
  m.receiveShadow = true
  m.instanceMatrix.needsUpdate = true
  m.computeBoundingSphere()
  m.frustumCulled = false
  return m
}

export function TrackScene({ track }: { track: Track }) {
  const group = useMemo(() => {
    const g = new THREE.Group()
    g.name = 'track'
    const t0 = performance.now()
    const rubber = rubberTexture(track)
    g.userData.rubber = rubber
    g.add(mesh(buildRoad(track), roadMaterial(rubber), { name: 'road' }))
    g.add(mesh(buildKerbs(track), kerbMaterial(), { name: 'kerbs' }))
    g.add(mesh(buildRunoff(track), runoffMaterial(), { name: 'runoff' }))
    g.add(mesh(buildVerge(track), vergeMaterial(), { name: 'verge' }))
    g.add(mesh(buildMarkings(track, 20), markingMaterial(), { name: 'markings' }))
    const terrain = buildTerrain(track)
    g.add(mesh(terrain.geometry, terrainMaterial(), { name: 'terrain' }))
    const center = new THREE.Vector3((track.minX + track.maxX) / 2, 0, (track.minZ + track.maxZ) / 2)
    const radius = Math.max(track.maxX - track.minX, track.maxZ - track.minZ) * 0.5
    const mountains = mesh(buildMountains(center, radius + 900, radius + 7000), mountainMaterial(), { name: 'mountains', receive: false })
    g.add(mountains)
    const b = buildBarriers(track)
    g.add(mesh(b.armco, armcoMaterial(), { cast: true, name: 'armco' }))
    g.add(mesh(b.concrete, concreteWallMaterial(), { cast: true, name: 'concrete' }))
    g.add(mesh(b.fence, fenceMaterial('frame'), { name: 'fence-frame' }))
    const fence = mesh(b.fence, fenceMaterial('wire'), { name: 'fence' })
    fence.renderOrder = 2
    g.add(fence)
    const postGeo = new THREE.BoxGeometry(0.08, 1.0, 0.12)
    postGeo.translate(0, 0.45, 0)
    const postMat = new THREE.MeshStandardNodeMaterial({ color: 0x8a8d90, metalness: 0.8, roughness: 0.4 })
    g.add(instanced(postGeo, postMat, b.posts, false))
    const tyreGeo = new THREE.TorusGeometry(0.24, 0.1, 8, 16)
    tyreGeo.rotateX(Math.PI / 2)
    g.add(instanced(tyreGeo, tyreWallMaterial(), b.tyres))
    g.userData.terrain = terrain
    console.info(`[track] geometry built in ${(performance.now() - t0).toFixed(0)} ms`)
    return g
  }, [track])

  // the racing line darkens as the field lays rubber (refresh a few times a minute)
  const acc = useRef(0)
  useFrame((_, dt) => {
    acc.current += dt
    if (acc.current > 4 && track.rubberDirty) {
      acc.current = 0
      group.userData.rubber.refresh()
    }
  })

  useEffect(
    () => () => {
      group.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
      })
    },
    [group],
  )

  return (
    <>
      {!debugFlag('notrack') && <primitive object={group} />}
      {!debugFlag('noscenery') && <Scenery track={track} heights={group.userData.terrain.heights} />}
    </>
  )
}
