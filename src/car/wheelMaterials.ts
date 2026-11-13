// The wheels' materials: rubber, the rim's paint, the brake disc's iron, the caliper, and the light a
// wheel loses inside its arch and its rim's barrel.
//
// The source models' wheel materials are not physical: every tyre is a metal (metalness 1 on a
// near-black texture, 0.5-2% albedo), i.e. a dark, rough mirror with no diffuse light at all; the
// rims are metals (or half metals) of 0.3-8% albedo, i.e. black paint taken for metal; two of the
// three discs are mirrors (roughness 0-0.09). The result was one flat dark disc. Here:
//  - tyre: a dielectric (F0 4%), the sidewall's rubber 3.2% albedo at roughness 0.62 (a faint, broad
//    sheen), the shoulder a little lighter with track dust, the tread band 5% at 0.78 (scrubbed and
//    dusty), the printed lettering 80% of its paint (dulled, never pure white);
//  - rim: painted (dielectric, at least 4.5% albedo (satin black), roughness 0.2-0.45, a clear coat where the source
//    has one), brake dust in the barrel;
//  - disc: cast iron (metal, ~45% reflectance on its face) at a machined roughness 0.35-0.55;
//  - caliper: paint (dielectric).
// Nothing of this needs a texture beyond the source's own (map and normal map, already bound).
//
// Occlusion (the materials' aoNode: the indirect light only, combined with the cars' grounding
// occlusion by the renderer's getAO hook): analytic in the wheel's own frame, so it works with or
// without screen-space AO and is identical at every level of detail. The arch covers the upper half
// of the tread; the fender's lip overhangs the top of the outer sidewall; what faces inboard looks at
// the chassis; behind the rim's face, a point sees the sky only through the rim's opening (the form
// factor of a coaxial disc, R^2 / (h^2 + R^2)), the spokes taking ~30% of that.

import * as THREE from 'three/webgpu'
import { abs, clamp, dot, float, Fn, length, max, mix, modelWorldMatrix, normalize, normalWorldGeometry, positionWorld, smoothstep, texture, uniform, uv, vec3 } from 'three/tsl'

type N = any

/** rim radius / tyre radius (18" rims on 0.68 m slicks) */
export const RIM_RATIO = 0.67
/** the rim's spoke face sits this far inboard of the tyre's outer sidewall (m) */
const FACE_INSET = 0.035

/** per wheel mesh (userData.wheelGeo): x outward sign along the mesh's local x (the axle), y the tyre's radius, z the rim face's outboard offset from the wheel centre, w the rim's radius */
const _def = new THREE.Vector4(1, 0.34, 0.12, 0.23)
const wheelGeo: N = uniform(new THREE.Vector4().copy(_def)).onObjectUpdate(({ object }: N) => ((object as THREE.Object3D | undefined)?.userData.wheelGeo as THREE.Vector4) ?? _def)

/** userData.wheelGeo for a wheel's meshes from its outward sign and its spinning part's local bounds */
export function wheelGeometry(side: number, radius: number, halfWidthOut: number) {
  return new THREE.Vector4(side, radius, halfWidthOut - FACE_INSET, radius * RIM_RATIO)
}

/** the wheel's frame: outward axle, up (perpendicular to the axle), offsets of this fragment */
const frame = () => {
  const A = normalize((modelWorldMatrix as N).element(0).xyz).mul(wheelGeo.x).toVar()
  const U = normalize(vec3(0, 1, 0).sub(A.mul(A.y))).toVar()
  const d = positionWorld.sub((modelWorldMatrix as N).element(3).xyz).toVar()
  const a = dot(d, A).toVar()
  const u = dot(d, U)
  const r = length(d.sub(A.mul(a)))
  return { A, U, a, u, r }
}

/** visibility of the sky for a wheel's surface (multiplies the indirect light) */
export const wheelOcclusion: N = Fn(() => {
  const { A, U, a, u, r } = frame()
  const R = wheelGeo.y,
    face = wheelGeo.z,
    Rr = wheelGeo.w
  const n = normalWorldGeometry
  const na = dot(n, A).toVar(),
    nu = dot(n, U)
  const out = clamp(na, 0, 1)
  // facing up into the arch (the upper tread, the top of the rim's barrel): the liner above
  const up = clamp(nu, 0, 1).mul(float(1).sub(out))
  const arch = float(1).sub(up.mul(smoothstep(R.mul(-0.2), R.mul(0.4), u)).mul(0.85))
  // the fender's lip over the top of the outer sidewall
  const lip = float(1).sub(out.mul(smoothstep(R.mul(0.3), R, u)).mul(0.3))
  // facing inboard: the chassis, the suspension
  const inboard = float(1).sub(clamp(na.negate(), 0, 1).mul(0.7))
  // inside the rim's barrel: the sky only through the face's opening, the spokes take ~40% of it
  const h = max(face.sub(a), 0)
  const barrel = float(1).sub(smoothstep(Rr.mul(0.96), Rr.mul(1.04), r))
  const open = Rr.mul(Rr).div(h.mul(h).add(Rr.mul(Rr))).mul(mix(1, 0.7, smoothstep(0.005, 0.03, h)))
  return arch.mul(lip).mul(inboard).mul(mix(1, open, barrel))
})()

const lum = (c: N) => dot(c, vec3(0.2126, 0.7152, 0.0722))

/** the source material's albedo node (map x colour) */
const albedo = (src: THREE.MeshStandardMaterial): N => (src.map ? texture(src.map, uv()).rgb.mul(uniform(src.color.clone())) : uniform(src.color.clone()))

/** a node material carrying every property of a source material (as the renderer's own conversion does) */
function nodeCopy<T extends THREE.Material>(src: THREE.MeshStandardMaterial, m: T): T {
  for (const k in src) {
    if (k === 'uuid' || k === 'type' || k === 'id' || k.startsWith('is') || k.startsWith('_')) continue
    let v = (src as unknown as Record<string, unknown>)[k]
    if (typeof v === 'function') continue
    // own colours and vectors (the disc's emission is set per car)
    if (v && ((v as THREE.Color).isColor || (v as THREE.Vector2).isVector2)) v = (v as THREE.Color).clone()
    try {
      ;(m as unknown as Record<string, unknown>)[k] = v
    } catch {
      /* read-only */
    }
  }
  m.name = src.name
  return m
}

/** rubber: sidewall, shoulder, tread band, printed lettering (see the header) */
export function tyreMaterial(src: THREE.MeshStandardMaterial) {
  const m = new THREE.MeshStandardNodeMaterial()
  m.name = src.name + ':rubber'
  m.normalMap = src.normalMap
  if (src.normalScale) m.normalScale.copy(src.normalScale)
  m.side = src.side
  m.metalness = 0
  const { A, r } = frame()
  const R = wheelGeo.y
  const c = albedo(src)
  const letter = smoothstep(0.06, 0.2, lum(c))
  const tread = smoothstep(0.45, 0.8, float(1).sub(abs(dot(normalWorldGeometry, A))))
  const shoulder = smoothstep(R.mul(0.8), R.mul(0.97), r)
  const rubber = mix(float(0.032).add(shoulder.mul(0.01)), float(0.05), tread)
  m.colorNode = mix(vec3(rubber), c.mul(0.8), letter)
  m.roughnessNode = mix(mix(float(0.62), float(0.78), tread), float(0.5), letter)
  m.aoNode = wheelOcclusion
  return m
}

/** painted rim (a dark metal in the sources is black paint), brake dust in the barrel */
export function rimMaterial(src: THREE.MeshStandardMaterial) {
  const m = nodeCopy(src, new THREE.MeshPhysicalNodeMaterial())
  m.name = src.name + ':paint'
  m.metalness = 0
  const { a } = frame()
  const dust = smoothstep(0.0, 0.05, wheelGeo.z.sub(a)).mul(0.6)
  m.colorNode = mix(max(albedo(src), vec3(0.045)), vec3(0.09, 0.08, 0.068), dust)
  m.roughnessNode = mix(float(Math.min(0.45, Math.max(0.2, src.roughness))), float(0.7), dust)
  m.aoNode = wheelOcclusion
  return m
}

/** cast-iron disc (keeps its emission: the brake glow) */
export function discMaterial(src: THREE.MeshStandardMaterial) {
  const m = nodeCopy(src, new THREE.MeshPhysicalNodeMaterial())
  m.metalness = 1
  m.roughness = Math.min(0.55, Math.max(0.35, src.roughness))
  // iron reflects ~45% (the sources' 8-25% made a metal disc black): the texture's pattern kept, its
  // level set to that of iron's face, the slots and holes darker
  const c = albedo(src)
  const y = lum(c)
  m.colorNode = c.div(max(y, 0.01)).mul(mix(float(0.12), float(0.45), smoothstep(0.02, 0.15, y))).min(0.6)
  m.clearcoat = 0
  m.aoNode = wheelOcclusion
  return m
}

/** the steered, non-spinning parts in the wheel (caliper, upright): paint where it is a caliper */
export function hubMaterial(src: THREE.MeshStandardMaterial) {
  const m = nodeCopy(src, new THREE.MeshPhysicalNodeMaterial())
  if (/calip/i.test(src.name)) m.metalness = 0
  m.aoNode = wheelOcclusion
  return m
}

/**
 * The simplified levels' wheels (vertex-baked materials): the same corrections per vertex, so that a
 * wheel keeps its brightness when the car changes level. Tyre vertices are the baked metals of high
 * roughness, rim vertices the dark metals of low roughness, discs carry the disc mask (_pbr.w).
 * `inWheel` limits it to the wheels' vertices (the far level has them merged into the body).
 */
export function fixBakedWheel(g: THREE.BufferGeometry, inWheel: (x: number, y: number, z: number) => boolean) {
  if (g.userData.wheelFixed) return
  g.userData.wheelFixed = true
  const col = g.getAttribute('color') as THREE.BufferAttribute | undefined
  const pbr = g.getAttribute('_pbr') as THREE.BufferAttribute | undefined
  const pos = g.getAttribute('position')
  if (!col || !pbr) return
  for (let i = 0; i < pos.count; i++) {
    if (!inWheel(pos.getX(i), pos.getY(i), pos.getZ(i))) continue
    const rough = pbr.getX(i),
      metal = pbr.getY(i),
      disc = pbr.getW(i)
    const r = col.getX(i),
      gg = col.getY(i),
      b = col.getZ(i)
    const y = 0.2126 * r + 0.7152 * gg + 0.0722 * b
    if (disc > 0.5) {
      pbr.setXY(i, Math.min(0.55, Math.max(0.35, rough)), 1)
      const t = Math.min(1, Math.max(0, (y - 0.02) / 0.13)),
        k = (0.12 + 0.33 * t * t * (3 - 2 * t)) / Math.max(y, 0.01)
      col.setXYZ(i, Math.min(0.6, r * k), Math.min(0.6, gg * k), Math.min(0.6, b * k))
    } else if (metal > 0.9 && rough > 0.5) {
      // rubber (lettering is too fine for the vertices: the sidewall's and the tread's mean)
      const v = y > 0.15 ? 0.8 : 0.04
      if (y > 0.15) col.setXYZ(i, r * v, gg * v, b * v)
      else col.setXYZ(i, v, v, v)
      pbr.setXY(i, 0.68, 0)
    } else if (metal >= 0.5 && y < 0.2) {
      col.setXYZ(i, Math.max(0.045, r), Math.max(0.045, gg), Math.max(0.045, b))
      pbr.setXY(i, Math.min(0.45, Math.max(0.2, rough)), 0)
    }
  }
  col.needsUpdate = true
  pbr.needsUpdate = true
}
