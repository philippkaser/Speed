// Spatial chunks for instanced scenery spread over the circuit.
//
// One instanced mesh for a whole circuit is one draw call, but it can never be culled: every pass
// draws all of it (the main view, every shadow cascade, every reflection probe face), most of it
// behind the camera or outside the pass. Cut into cells of a few hundred metres, each pass draws only
// the cells it sees (a cascade only the cells inside its box), for a few more draw calls.
import * as THREE from 'three/webgpu'

/** Cell key of a point on the ground plane. */
const cellOf = (x: number, z: number, size: number) => `${Math.floor(x / size)},${Math.floor(z / size)}`

/**
 * Splits an instanced mesh into one instanced mesh per ground cell (by instance position), each with
 * its own bounding sphere and frustum culling on. Returns the new meshes (added to the parent).
 */
export function chunkInstances(mesh: THREE.InstancedMesh, size: number): THREE.InstancedMesh[] {
  const parent = mesh.parent
  const m4 = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const buckets = new Map<string, number[]>()
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m4)
    p.setFromMatrixPosition(m4)
    const k = cellOf(p.x, p.z, size)
    let l = buckets.get(k)
    if (!l) buckets.set(k, (l = []))
    l.push(i)
  }
  if (buckets.size <= 1) {
    mesh.computeBoundingSphere()
    mesh.frustumCulled = true
    return [mesh]
  }
  const colors = mesh.instanceColor
  const c = new THREE.Color()
  const out = [...buckets.values()].map((list, n) => {
    const m = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length)
    list.forEach((src, j) => {
      mesh.getMatrixAt(src, m4)
      m.setMatrixAt(j, m4)
      if (colors) {
        mesh.getColorAt(src, c)
        m.setColorAt(j, c)
      }
    })
    m.count = list.length
    m.name = mesh.name
    m.castShadow = mesh.castShadow
    m.receiveShadow = mesh.receiveShadow
    m.renderOrder = mesh.renderOrder
    m.layers.mask = mesh.layers.mask
    m.userData = { ...mesh.userData, chunk: n }
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
    m.frustumCulled = true
    return m
  })
  if (parent) {
    parent.remove(mesh)
    for (const m of out) parent.add(m)
  }
  return out
}
