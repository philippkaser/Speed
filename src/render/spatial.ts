// Spatial chunks for merged static geometry.
//
// Merging a whole circuit's scenery into one mesh per material makes it a handful of draw calls, but
// a mesh that spans the circuit can never be culled: every pass draws all of it (the main view, every
// shadow cascade, every reflection probe face), most of it behind the camera or outside the pass.
// Cut into cells of a few hundred metres, each pass draws only the cells it sees (a cascade only the
// cells inside its box), for a few more draw calls.
import * as THREE from 'three/webgpu'

/** Cell key of a point on the ground plane. */
const cellOf = (x: number, z: number, size: number) => `${Math.floor(x / size)},${Math.floor(z / size)}`

/**
 * Splits an indexed geometry into one geometry per ground cell (by triangle centroid; vertices are
 * duplicated where a triangle's cell differs from its neighbours'). Every attribute is kept.
 */
export function splitByCells(geo: THREE.BufferGeometry, size: number): THREE.BufferGeometry[] {
  const index = geo.getIndex()
  const pos = geo.getAttribute('position')
  if (!index || !pos) return [geo]
  const I = index.array
  const buckets = new Map<string, number[]>()
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t],
      b = I[t + 1],
      c = I[t + 2]
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3
    const k = cellOf(x, z, size)
    let l = buckets.get(k)
    if (!l) buckets.set(k, (l = []))
    l.push(a, b, c)
  }
  if (buckets.size <= 1) return [geo]
  const out: THREE.BufferGeometry[] = []
  for (const tris of buckets.values()) {
    const remap = new Map<number, number>()
    const order: number[] = []
    const idx = new Uint32Array(tris.length)
    for (let i = 0; i < tris.length; i++) {
      let r = remap.get(tris[i])
      if (r === undefined) {
        r = order.length
        remap.set(tris[i], r)
        order.push(tris[i])
      }
      idx[i] = r
    }
    const g = new THREE.BufferGeometry()
    for (const [name, attr] of Object.entries(geo.attributes)) {
      const a = attr as THREE.BufferAttribute
      const n = a.itemSize
      const src = a.array as ArrayLike<number>
      const dst = new (src.constructor as new (n: number) => THREE.TypedArray)(order.length * n)
      for (let i = 0; i < order.length; i++) for (let k = 0; k < n; k++) dst[i * n + k] = src[order[i] * n + k]
      g.setAttribute(name, new THREE.BufferAttribute(dst, n, a.normalized))
    }
    g.setIndex(new THREE.BufferAttribute(order.length > 65535 ? idx : new Uint16Array(idx), 1))
    g.computeBoundingBox()
    g.computeBoundingSphere()
    out.push(g)
  }
  return out
}

/**
 * Replaces a mesh by one mesh per ground cell (same material, flags, name and user data), in its
 * parent. The geometry is in world space (the merged scenery is). Returns the new meshes.
 */
export function chunkMesh(mesh: THREE.Mesh, size: number): THREE.Mesh[] {
  const parent = mesh.parent
  const parts = splitByCells(mesh.geometry, size)
  if (parts.length <= 1) return [mesh]
  const out = parts.map((g, i) => {
    const m = new THREE.Mesh(g, mesh.material)
    m.name = mesh.name
    m.castShadow = mesh.castShadow
    m.receiveShadow = mesh.receiveShadow
    m.renderOrder = mesh.renderOrder
    m.layers.mask = mesh.layers.mask
    m.userData = { ...mesh.userData, chunk: i }
    m.matrix.copy(mesh.matrix)
    m.matrix.decompose(m.position, m.quaternion, m.scale)
    m.matrixAutoUpdate = mesh.matrixAutoUpdate
    m.onBeforeRender = mesh.onBeforeRender
    return m
  })
  if (parent) {
    parent.remove(mesh)
    for (const m of out) parent.add(m)
  }
  mesh.geometry.dispose()
  return out
}

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
