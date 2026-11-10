// Grounding: the light of the sky that a car keeps from the road beneath and around it.
//
// The sun's shadow only removes the sun; under a car the ground would still take the whole sky and
// stay light grey, and the car floats. Screen-space occlusion cannot be relied on for this: what
// occludes the ground under a car (its floor) is mostly hidden from the camera, and it changes with
// the view. So every lit surface evaluates the occlusion analytically: each car's body is an
// oriented box (its bounding box without the mirrors' and the wing's overhang, from the ground
// clearance up to the beltline), and the cosine-weighted share of the hemisphere that a box covers
// has a closed form (the contour integral over its silhouette, I. Quilez's box occlusion). It is
// exact for a box, costs nothing where no car is near (one distance test per car), needs no texture
// (the lit materials are close to WebGPU's 16 per stage) and is perfectly stable: it moves rigidly
// with the car. Under the floor (7 cm above the road, 2 m wide) the sky is all but gone, at the sill
// half of it is left, a metre to the side nine tenths: the soft dark pool a car stands in, which also
// darkens the reflections of the sky in the road there (the specular occlusion follows it).
//
// It multiplies the materials' ambient occlusion (the renderer's getAO context hook: every lit
// material, the cars' own included), i.e. only the indirect light, as occlusion of the sky must.
// A car's own surfaces lie inside its box, where the box formula does not apply: those facing down
// look at the ground under the car, which is dark, not at the sunlit ground the environment map
// assumes below the horizon, so they lose that light (the floor, the diffuser, the splitter's
// underside, the top of the wheel arches).
import * as THREE from 'three/webgpu'
import * as tsl from 'three/tsl'

type N = any

const { Fn, If, Loop, abs, acos, clamp, cross, dot, float, int, length, max, mix, normalWorldGeometry, positionView, positionWorld, smoothstep, step, uniform, uniformArray, vec3, vec4 } = tsl as N

export const MAX_GROUNDED_CARS = 24
/** Height of the body's floor above the lowest point of the car (the tyres' contact), m. */
const CLEARANCE = 0.07
/** The box's top above the lowest point: about the beltline (the cabin above is much narrower). */
const BELT = 0.92
/** Beyond this distance from the box its occlusion is faded out (m): at 2.5 m it is under 3%. */
const REACH = 2.5

const boxes: N = uniformArray(Array.from({ length: MAX_GROUNDED_CARS }, () => new THREE.Matrix4()), 'mat4')
const halves: N = uniformArray(Array.from({ length: MAX_GROUNDED_CARS }, () => new THREE.Vector4(1, 1, 1, 0)), 'vec4')
/** xyz: the box's centre in the world, w: the squared radius within which it occludes anything */
const spheres: N = uniformArray(Array.from({ length: MAX_GROUNDED_CARS }, () => new THREE.Vector4(0, -1e5, 0, 0)), 'vec4')
const count: N = uniform(0, 'int')
/** debug (window.__carGrounding.strength.value): 0 switches the occlusion off, for A/B captures */
const strength: N = uniform(1)
if (typeof window !== 'undefined') (window as unknown as { __carGrounding?: object }).__carGrounding = { strength }

/** +1 or -1, never 0 (a zero would collapse the box's silhouette) */
const sgn = (v: N): N => step(0, v).mul(2).sub(1)
const unit = (v: N): N => v.div(max(length(v), 1e-5))

/**
 * Share of the cosine-weighted hemisphere around `n` at `p` covered by the box of half extents `rad`
 * centred at the origin (p and n in the box's frame, p outside the box): the form factor of the
 * box's silhouette, a hexagon (or a quad) of box corners, as a sum over its edges.
 * https://iquilezles.org/articles/boxocclusion
 */
const boxOcclusion = (p: N, n: N, rad: N): N => {
  const f = rad.mul(sgn(p))
  const s = sgn(rad.sub(abs(p)))
  const V = (c: N) => unit(c.mul(f).sub(p)).toVar()
  const v = [V(vec3(1, 1, -1)), V(vec3(1, s.x, s.x)), V(vec3(1, -1, 1)), V(vec3(s.z, s.z, 1)), V(vec3(-1, 1, 1)), V(vec3(s.y, 1, s.y))]
  let sum: N = float(0)
  for (let i = 0; i < 6; i++) {
    const a = v[i],
      b = v[(i + 1) % 6]
    sum = sum.add(dot(n, unit(cross(a, b))).mul(acos(clamp(dot(a, b), -1, 1))))
  }
  return abs(sum).div(2 * Math.PI)
}

/** The occlusion factor (1: open sky) of the cars on the surface being shaded. */
export const carGroundAO: N = Fn(() => {
  const ao = float(1).toVar()
  // (nothing to see beyond a few hundred metres: the far world skips the loop)
  If(positionView.z.negate().lessThan(400), () => {
    Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
      const s = spheres.element(i)
      const d = positionWorld.sub(s.xyz)
      If(dot(d, d).lessThan(s.w), () => {
        const M = boxes.element(i)
        const rad = halves.element(i).xyz
        const p = M.mul(vec4(positionWorld, 1)).xyz.toVar()
        const n = unit(M.mul(vec4(normalWorldGeometry, 0)).xyz).toVar()
        const q = abs(p).sub(rad).toVar()
        const outside = max(q.x, max(q.y, q.z))
        If(outside.greaterThan(0), () => {
          // the formula does not clip the box at the surface's horizon: a surface facing away from
          // the box (judged by the nearest point of its top) takes nothing
          const top = vec3(clamp(p.x, rad.x.negate(), rad.x), rad.y, clamp(p.z, rad.z.negate(), rad.z))
          const facing = smoothstep(0, 0.2, dot(n, unit(top.sub(p))))
          const fade = float(1).sub(smoothstep(REACH * 0.5, REACH, length(max(q, 0))))
          ao.mulAssign(float(1).sub(clamp(boxOcclusion(p, n, rad).mul(facing).mul(fade), 0, 0.97)))
        }).Else(() => {
          // inside the box: the car's own surfaces. Facing down they look at the ground under the car
          // (the road itself, where a compressed suspension brings it inside the box, is as dark as
          // just below the floor).
          const h = p.y.add(rad.y)
          const down = clamp(n.y.negate().mul(1.4).sub(0.1), 0, 1).mul(mix(0.93, 0.6, smoothstep(0.3, 0.8, h)))
          const floor = step(0.5, n.y).mul(float(1).sub(smoothstep(0, 0.12, h))).mul(0.96)
          ao.mulAssign(float(1).sub(max(down, floor)))
        })
      })
    })
  })
  return mix(float(1), ao, strength)
})()

const _box = new THREE.Box3()
const _inv = new THREE.Matrix4()
const _t = new THREE.Matrix4()
const _c = new THREE.Vector3()

interface GroundBox {
  centre: THREE.Vector3
  half: THREE.Vector3
}

/** A car's bounding box in its root's frame (all of its meshes, every level of detail). */
export function carBounds(root: THREE.Object3D, target = new THREE.Box3()) {
  root.updateMatrixWorld(true)
  _inv.copy(root.matrixWorld).invert()
  target.makeEmpty()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.geometry) return
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
    target.union(_box.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld).applyMatrix4(_inv))
  })
  return target
}

/** The occluding box of a car (in its root's frame), from its bounding box. */
export function groundBox(bounds: THREE.Box3): GroundBox {
  const y0 = bounds.min.y + CLEARANCE
  const y1 = bounds.min.y + Math.min(BELT, Math.max(0.3, (bounds.max.y - bounds.min.y) * 0.75))
  return {
    centre: new THREE.Vector3((bounds.min.x + bounds.max.x) / 2, (y0 + y1) / 2, (bounds.min.z + bounds.max.z) / 2),
    // (the mirrors, the wing's endplates and the splitter reach beyond the body)
    half: new THREE.Vector3((bounds.max.x - bounds.min.x) * 0.465, (y1 - y0) / 2, (bounds.max.z - bounds.min.z) * 0.485),
  }
}

/**
 * This frame's cars (their roots, posed): call once per frame after the cars have moved, before
 * anything renders.
 */
export function updateCarGrounding(roots: Iterable<THREE.Object3D | undefined>) {
  let n = 0
  for (const root of roots) {
    if (!root || n >= MAX_GROUNDED_CARS) continue
    let g = root.userData.groundBox as GroundBox | undefined
    if (!g) {
      const b = carBounds(root)
      if (b.isEmpty()) continue
      g = root.userData.groundBox = groundBox(b)
    }
    root.updateWorldMatrix(true, false)
    // world -> the box's frame (the root is rigid: a rotation and a translation)
    ;(boxes.array[n] as THREE.Matrix4).copy(root.matrixWorld).invert().premultiply(_t.makeTranslation(-g.centre.x, -g.centre.y, -g.centre.z))
    ;(halves.array[n] as THREE.Vector4).set(g.half.x, g.half.y, g.half.z, 0)
    _c.copy(g.centre).applyMatrix4(root.matrixWorld)
    const r = g.half.length() + REACH
    ;(spheres.array[n] as THREE.Vector4).set(_c.x, _c.y, _c.z, r * r)
    n++
  }
  count.value = n
}

/** (tests) what the materials evaluate, on the CPU: the box formula above. */
export function boxOcclusionAt(p: THREE.Vector3, n: THREE.Vector3, rad: THREE.Vector3) {
  const sg = (x: number) => (x >= 0 ? 1 : -1)
  const f = new THREE.Vector3(rad.x * sg(p.x), rad.y * sg(p.y), rad.z * sg(p.z))
  const s = new THREE.Vector3(sg(rad.x - Math.abs(p.x)), sg(rad.y - Math.abs(p.y)), sg(rad.z - Math.abs(p.z)))
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x * f.x, y * f.y, z * f.z).sub(p).normalize()
  const v = [V(1, 1, -1), V(1, s.x, s.x), V(1, -1, 1), V(s.z, s.z, 1), V(-1, 1, 1), V(s.y, 1, s.y)]
  let sum = 0
  for (let i = 0; i < 6; i++) {
    const a = v[i],
      b = v[(i + 1) % 6]
    const c = new THREE.Vector3().crossVectors(a, b)
    const l = c.length()
    if (l > 1e-9) sum += (n.dot(c) / l) * Math.acos(Math.max(-1, Math.min(1, a.dot(b))))
  }
  return Math.abs(sum) / (2 * Math.PI)
}

/**
 * Makes every lit material of `renderer` take the cars' occlusion on its indirect light (once per
 * renderer; composes with a hook that is already there).
 */
export function installCarGrounding(renderer: THREE.WebGPURenderer) {
  const data = (renderer as unknown as { contextNode: { value: { getAO?: (ao: N, builder: N) => N; __carGrounding?: boolean } } }).contextNode.value
  if (data.__carGrounding) return
  data.__carGrounding = true
  const prev = data.getAO
  data.getAO = (ao: N, builder: N) => {
    const a = prev ? prev(ao, builder) : ao
    return a ? a.mul(carGroundAO) : carGroundAO
  }
}
