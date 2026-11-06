import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three/webgpu'
import type { Track } from '../track/track'
import { rubberTexture, armcoMaterial, concreteWallMaterial, fenceMaterial, kerbMaterial, markingMaterial, mountainMaterial, roadMaterial, runoffMaterial, terrainMaterial, tyreWallMaterial, vergeMaterial } from './materials'
import { Scenery } from './Scenery'
import { debugFlag } from '../util/debug'
import { buildBarriers, buildKerbs, buildMarkings, buildMountains, buildRoad, buildRunoff, buildTerrain, buildVerge, chunkGrid, type MountainSet } from './trackGeometry'
import { PROBE_LAYER } from './Reflections'
import { sunState } from './Environment'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { chunkInstances } from './spatial'
import { castInNearCascades } from './sunShadow'

/** Seen by the reflection probes only (coarse stand-ins for meshes they leave out). */
function probeOnly(m: THREE.Mesh) {
  m.layers.set(PROBE_LAYER)
  return m
}

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
    g.add(mesh(buildRoad(track), roadMaterial(rubber, track), { name: 'road' }))
    g.add(mesh(buildKerbs(track), kerbMaterial(), { name: 'kerbs' }))
    g.add(mesh(buildRunoff(track), runoffMaterial(), { name: 'runoff' }))
    g.add(mesh(buildVerge(track), vergeMaterial(), { name: 'verge' }))
    const markings = mesh(buildMarkings(track, 20), markingMaterial(), { name: 'markings' })
    // details the cars' reflection probes leave out
    markings.userData.noProbe = true
    g.add(markings)
    const terrain = buildTerrain(track)
    // in chunks (each pass draws the ones it sees); the probes see a coarse version of each
    const tMat = terrainMaterial()
    const chunks = chunkGrid(terrain.geometry, terrain.nx, terrain.nz)
    for (let k = 0; k < chunks.fine.length; k++) {
      const f = mesh(chunks.fine[k], tMat, { name: 'terrain' })
      f.userData.noProbe = true
      g.add(f)
      g.add(probeOnly(mesh(chunks.coarse[k], tMat, { name: 'terrain:probe' })))
    }
    const center = new THREE.Vector3((track.minX + track.maxX) / 2, 0, (track.minZ + track.maxZ) / 2)
    const radius = Math.max(track.maxX - track.minX, track.maxZ - track.minZ) * 0.5
    // within ~7.6 km of any camera on the circuit: the sky dome (8 km) would cut anything beyond
    const mset = buildMountains(center, radius + 900, radius + 6000)
    const mMat = mountainMaterial()
    const mountains = new THREE.Group()
    mountains.name = 'mountains'
    mset.sectors.forEach((geo, k) => {
      // receives the sun's shadow only for its own baked term (beyond the cascades the maps are lit)
      const sector = mesh(geo, mMat, { name: 'mountains', receive: true })
      // the cars' reflection probes draw the coarse mesh
      sector.userData.noProbe = true
      mountains.add(sector)
      mountains.add(probeOnly(mesh(mset.coarseSectors[k], mMat, { name: 'mountains:probe', receive: true })))
    })
    g.add(mountains)
    g.userData.mountains = mset
    const b = buildBarriers(track)
    g.add(mesh(b.armco, armcoMaterial(), { cast: true, name: 'armco' }))
    g.add(mesh(b.concrete, concreteWallMaterial(), { cast: true, name: 'concrete' }))
    g.add(mesh(b.fence, fenceMaterial('frame'), { name: 'fence-frame' }))
    const fence = mesh(b.fence, fenceMaterial('wire'), { name: 'fence' })
    fence.renderOrder = 2
    fence.userData.noProbe = true
    g.add(fence)
    const postGeo = new THREE.BoxGeometry(0.08, 1.0, 0.12)
    postGeo.translate(0, 0.45, 0)
    const postMat = new THREE.MeshStandardNodeMaterial({ color: 0x8a8d90, metalness: 0.8, roughness: 0.4 })
    const posts = instanced(postGeo, postMat, b.posts, false)
    posts.userData.noProbe = true
    g.add(posts)
    // Tyre walls: 4,400 tyres around the circuit. In cells of 150 m (each pass draws only the cells it
    // sees: one instanced mesh for the whole circuit drew every tyre in the view and in every shadow
    // cascade, 1.1 M triangles each), out of the farthest cascade (35 cm texels: a tyre is a texel or
    // two there). Shadow maps and cells far from the camera draw a coarser torus, kept in the same
    // buffers as a second index range (as the mountains do for the probes).
    const fine = new THREE.TorusGeometry(0.24, 0.1, 8, 16)
    const coarse = new THREE.TorusGeometry(0.24, 0.1, 5, 10)
    const tyreGeo = mergeGeometries([fine, coarse])
    tyreGeo.rotateX(Math.PI / 2)
    const fineRange = [0, fine.index!.count] as const,
      coarseRange = [fine.index!.count, coarse.index!.count] as const
    fine.dispose()
    coarse.dispose()
    const tyres = instanced(tyreGeo, tyreWallMaterial(), b.tyres)
    tyres.userData.noProbe = true
    g.add(tyres)
    const _c = new THREE.Vector3()
    for (const chunk of chunkInstances(tyres, 150)) {
      castInNearCascades(chunk, 2)
      chunk.onBeforeRender = (_r, scene, camera) => {
        const shadowPass = !!(scene.overrideMaterial as { isShadowPassMaterial?: boolean } | null)?.isShadowPassMaterial
        // a tyre 60 m away is ~10 px tall at 1080p: the coarse torus is indistinguishable there
        const far = !shadowPass && chunk.boundingSphere ? _c.setFromMatrixPosition(camera.matrixWorld).distanceTo(chunk.boundingSphere.center) - chunk.boundingSphere.radius > 60 : false
        const [start, count] = shadowPass || far ? coarseRange : fineRange
        tyreGeo.setDrawRange(start, count)
      }
    }
    // (only the height field is kept: the full mesh is not drawn, its chunks are)
    g.userData.terrain = { heights: terrain.heights }
    console.info(`[track] geometry built in ${(performance.now() - t0).toFixed(0)} ms`)
    return g
  }, [track])

  // the racing line darkens as the field lays rubber (refresh a few times a minute)
  const acc = useRef(0)
  // the mountains' sun visibility is baked for the sun's direction (again when it has moved ~1.5 deg)
  const bakedSun = useRef(new THREE.Vector3())
  useFrame((_, dt) => {
    acc.current += dt
    if (acc.current > 4 && track.rubberDirty) {
      acc.current = 0
      group.userData.rubber.refresh()
    }
    const mset = group.userData.mountains as MountainSet
    if (mset && sunState.dir.y > 0 && bakedSun.current.dot(sunState.dir) < 0.99966) {
      bakedSun.current.copy(sunState.dir)
      mset.bakeSun(sunState.dir)
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
