// Fixed-step physics world: integrates vehicles, resolves barrier / ground / car-car contacts and
// keeps previous poses for render interpolation.
import { type Ground, type GroundSample, makeSample } from './ground'
import { clamp, Quat, V3 } from './math'
import { makeInput, Vehicle, type VehicleInput } from './vehicle'

export const PHYSICS_HZ = 600
export const PHYSICS_DT = 1 / PHYSICS_HZ

/** A body that takes part in collisions but is driven externally (network players). */
export interface KinematicBody {
  id: string
  pos: V3
  vel: V3
  fwd: V3 // horizontal-ish forward axis
  halfLength: number
  halfWidth: number
  active: boolean
}

export interface CollisionEvent {
  x: number
  y: number
  z: number
  impulse: number
  kind: 'wall' | 'car' | 'ground'
  car: number
}

export class SimCar {
  input: VehicleInput = makeInput()
  prevPos = new V3()
  prevQuat = new Quat()
  hullSamples: GroundSample[] = []
  slipstream = 0
  frozen = false // e.g. on the grid before the start
  constructor(
    public id: string,
    public vehicle: Vehicle,
  ) {
    for (let i = 0; i < vehicle.hull.length; i++) this.hullSamples.push(makeSample())
    this.snapshot()
  }
  snapshot() {
    this.prevPos.copy(this.vehicle.pos)
    this.prevQuat.copy(this.vehicle.q)
  }
}

const _p = new V3(),
  _r = new V3(),
  _n = new V3(),
  _v = new V3(),
  _t = new V3(),
  _J = new V3(),
  _a = new V3(),
  _b = new V3()

export class PhysicsWorld {
  cars: SimCar[] = []
  kinematics: KinematicBody[] = []
  accumulator = 0
  time = 0
  steps = 0
  alpha = 0 // render interpolation factor
  events: CollisionEvent[] = []
  paused = false
  constructor(public ground: Ground) {}

  addCar(id: string, vehicle: Vehicle) {
    const c = new SimCar(id, vehicle)
    this.cars.push(c)
    return c
  }

  removeCar(id: string) {
    this.cars = this.cars.filter((c) => c.id !== id)
  }

  /** Advance by real frame time. Returns number of substeps taken. */
  update(frameDt: number) {
    if (this.paused) {
      this.alpha = 1
      return 0
    }
    this.accumulator += Math.min(frameDt, 0.1)
    let n = 0
    while (this.accumulator >= PHYSICS_DT) {
      for (const c of this.cars) c.snapshot()
      this.stepOnce(PHYSICS_DT)
      this.accumulator -= PHYSICS_DT
      n++
      // edge-triggered inputs only apply once
      for (const c of this.cars) {
        c.input.shiftUp = false
        c.input.shiftDown = false
      }
    }
    this.alpha = this.accumulator / PHYSICS_DT
    if (n > 0) this.computeSlipstream()
    return n
  }

  stepOnce(h: number) {
    for (const c of this.cars) {
      if (c.frozen) {
        // hold position but let the engine rev on the grid
        const v = c.vehicle
        const savedPos = _a.copy(v.pos)
        const savedQ = new Quat().copy(v.q)
        v.step(h, c.input, this.ground, c)
        v.pos.copy(savedPos)
        v.q.copy(savedQ)
        v.vel.set(0, 0, 0)
        v.w.set(0, 0, 0)
        for (const w of v.wheels) w.omega = 0
        continue
      }
      c.vehicle.step(h, c.input, this.ground, c)
    }
    // barrier / body-ground contacts at half rate (300 Hz is plenty, saves ~40% of the query cost)
    if ((this.steps & 1) === 0) for (let i = 0; i < this.cars.length; i++) this.resolveEnvironment(i)
    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) this.collideCars(this.cars[i], this.cars[j], i)
      for (const k of this.kinematics) if (k.active) this.collideKinematic(this.cars[i], k, i)
    }
    for (const c of this.cars) {
      const v = c.vehicle
      if (!v.isFinite()) {
        // never let a numerical blow-up propagate
        v.reset(v.pos.isFinite() ? v.pos.x : 0, v.pos.isFinite() ? v.pos.z : 0, 0, this.ground)
      }
      v.scrape *= 0.96
    }
    this.time += h
    this.steps++
  }

  private resolveEnvironment(ci: number) {
    const car = this.cars[ci]
    const v = car.vehicle
    const R = v.R
    v.updateAxes()
    for (let i = 0; i < v.hull.length; i++) {
      const hp = v.hull[i]
      R.apply(hp.x, hp.y, hp.z, _r)
      _p.copy(v.pos).add(_r)
      const s = car.hullSamples[i]
      this.ground.sample(_p.x, _p.z, s)
      // --- barriers (vertical walls along the track edges)
      if (i < 12) {
        let pen = 0
        if (s.d > s.wallLeft) {
          pen = s.d - s.wallLeft
          _n.set(-s.lx, 0, -s.lz)
        } else if (s.d < -s.wallRight) {
          pen = -s.wallRight - s.d
          _n.set(s.lx, 0, s.lz)
        }
        if (pen > 0) this.contact(v, ci, _r, _n, pen, 0.18, 0.32, 'wall')
      }
      // --- ground contact of the body (bottoming / rollovers)
      if (i >= 12) {
        const depth = s.height - _p.y
        if (depth > 0) {
          _n.set(s.nx, s.ny, s.nz)
          const j = this.contact(v, ci, _r, _n, depth * s.ny, 0.05, 0.45, 'ground')
          if (j > 0) v.scrape = Math.min(1, v.scrape + j * 0.004)
        }
      }
    }
  }

  /** Impulse-based contact against static geometry. Returns normal impulse. */
  private contact(v: Vehicle, ci: number, r: V3, n: V3, pen: number, e: number, mu: number, kind: CollisionEvent['kind']) {
    v.pointVelocity(r, _v)
    const vn = _v.dot(n)
    // positional correction (split: body slides out of the wall)
    v.pos.addScaled(n, pen * 0.85)
    if (vn >= 0) return 0
    const kN = v.invMassAt(r, n)
    const jn = (-(1 + (vn < -1.5 ? e : 0)) * vn) / kN
    _J.copy(n).scale(jn)
    // friction
    _t.copy(_v).addScaled(n, -vn)
    const vt = _t.len()
    if (vt > 1e-4) {
      _t.scale(1 / vt)
      const kT = v.invMassAt(r, _t)
      const jt = Math.min(vt / kT, mu * jn)
      _J.addScaled(_t, -jt)
    }
    v.applyImpulse(r, _J)
    if (jn > 50) {
      v.impact = Math.max(v.impact, jn)
      this.events.push({ x: v.pos.x + r.x, y: v.pos.y + r.y, z: v.pos.z + r.z, impulse: jn, kind, car: ci })
    }
    return jn
  }

  private collideCars(A: SimCar, B: SimCar, ai: number) {
    const a = A.vehicle,
      b = B.vehicle
    if (Math.abs(a.pos.y - b.pos.y) > 1.6) return
    const dx = b.pos.x - a.pos.x,
      dz = b.pos.z - a.pos.z
    const reach = a.spec.length * 0.5 + b.spec.length * 0.5
    if (dx * dx + dz * dz > reach * reach) return
    const res = obbOverlap(
      a.pos.x,
      a.pos.z,
      a.fwd.x,
      a.fwd.z,
      a.spec.length * 0.5,
      a.spec.width * 0.5,
      b.pos.x,
      b.pos.z,
      b.fwd.x,
      b.fwd.z,
      b.spec.length * 0.5,
      b.spec.width * 0.5,
    )
    if (!res) return
    // normal points from A to B
    _n.set(res.nx, 0, res.nz)
    const cy = (a.pos.y + b.pos.y) * 0.5
    _a.set(res.px - a.pos.x, cy - a.pos.y, res.pz - a.pos.z)
    _b.set(res.px - b.pos.x, cy - b.pos.y, res.pz - b.pos.z)
    // separate
    a.pos.addScaled(_n, -res.depth * 0.5)
    b.pos.addScaled(_n, res.depth * 0.5)
    const va = a.pointVelocity(_a, new V3())
    const vb = b.pointVelocity(_b, new V3())
    const vrel = vb.sub(va).dot(_n)
    if (vrel >= 0) return
    const k = a.invMassAt(_a, _n) + b.invMassAt(_b, _n)
    const jn = (-(1 + 0.25) * vrel) / k
    _J.copy(_n).scale(jn)
    b.applyImpulse(_b, _J)
    _J.scale(-1)
    a.applyImpulse(_a, _J)
    if (jn > 50) this.events.push({ x: res.px, y: cy, z: res.pz, impulse: jn, kind: 'car', car: ai })
  }

  private collideKinematic(A: SimCar, k: KinematicBody, ai: number) {
    const a = A.vehicle
    if (Math.abs(a.pos.y - k.pos.y) > 1.6) return
    const dx = k.pos.x - a.pos.x,
      dz = k.pos.z - a.pos.z
    const reach = a.spec.length * 0.5 + k.halfLength
    if (dx * dx + dz * dz > reach * reach) return
    const fl = Math.hypot(k.fwd.x, k.fwd.z) || 1
    const res = obbOverlap(a.pos.x, a.pos.z, a.fwd.x, a.fwd.z, a.spec.length * 0.5, a.spec.width * 0.5, k.pos.x, k.pos.z, k.fwd.x / fl, k.fwd.z / fl, k.halfLength, k.halfWidth)
    if (!res) return
    _n.set(res.nx, 0, res.nz)
    _a.set(res.px - a.pos.x, 0, res.pz - a.pos.z)
    a.pos.addScaled(_n, -res.depth * 0.6)
    const va = a.pointVelocity(_a, new V3())
    const vrel = _v.copy(k.vel).sub(va).dot(_n)
    if (vrel >= 0) return
    const jn = (-(1 + 0.2) * vrel) / a.invMassAt(_a, _n) * 0.5
    _J.copy(_n).scale(-jn)
    a.applyImpulse(_a, _J)
    if (jn > 50) this.events.push({ x: res.px, y: a.pos.y, z: res.pz, impulse: jn, kind: 'car', car: ai })
  }

  private computeSlipstream() {
    const all: { pos: V3; fwd: V3 }[] = [...this.cars.map((c) => c.vehicle), ...this.kinematics.filter((k) => k.active)]
    for (const c of this.cars) {
      const v = c.vehicle
      let best = 0
      if (v.speed > 20) {
        for (const o of all) {
          if (o === v) continue
          const dx = o.pos.x - v.pos.x,
            dz = o.pos.z - v.pos.z
          const along = dx * v.fwd.x + dz * v.fwd.z
          if (along < 3 || along > 45) continue
          const lat = Math.abs(dx * v.fwd.z - dz * v.fwd.x)
          const cone = 1.2 + along * 0.03
          if (lat > cone) continue
          const f = (1 - along / 45) * (1 - lat / cone)
          if (f > best) best = f
        }
      }
      c.slipstream += (clamp(best, 0, 1) - c.slipstream) * 0.1
    }
  }
}

const _res = { nx: 0, nz: 0, depth: 0, px: 0, pz: 0 }

/** 2D oriented box overlap (SAT). Normal points from A to B. */
export function obbOverlap(
  ax: number,
  az: number,
  afx: number,
  afz: number,
  ahl: number,
  ahw: number,
  bx: number,
  bz: number,
  bfx: number,
  bfz: number,
  bhl: number,
  bhw: number,
) {
  // normalise forward vectors in the plane
  let l = Math.hypot(afx, afz) || 1
  afx /= l
  afz /= l
  l = Math.hypot(bfx, bfz) || 1
  bfx /= l
  bfz /= l
  const axes = [
    [afx, afz],
    [afz, -afx],
    [bfx, bfz],
    [bfz, -bfx],
  ]
  const dx = bx - ax,
    dz = bz - az
  let minPen = Infinity,
    mnx = 0,
    mnz = 0
  for (const [x, z] of axes) {
    const ra = ahl * Math.abs(afx * x + afz * z) + ahw * Math.abs(afz * x - afx * z)
    const rb = bhl * Math.abs(bfx * x + bfz * z) + bhw * Math.abs(bfz * x - bfx * z)
    const dist = dx * x + dz * z
    const pen = ra + rb - Math.abs(dist)
    if (pen <= 0) return null
    if (pen < minPen) {
      minPen = pen
      const s = dist >= 0 ? 1 : -1
      mnx = x * s
      mnz = z * s
    }
  }
  // contact point: deepest corner of B inside A, else of A inside B
  let bestD = -Infinity,
    px = (ax + bx) / 2,
    pz = (az + bz) / 2
  for (const sl of [-1, 1])
    for (const sw of [-1, 1]) {
      const cx = bx + bfx * bhl * sl + bfz * bhw * sw
      const cz = bz + bfz * bhl * sl - bfx * bhw * sw
      const d = -((cx - ax) * mnx + (cz - az) * mnz)
      if (d > bestD) {
        bestD = d
        px = cx
        pz = cz
      }
    }
  _res.nx = mnx
  _res.nz = mnz
  _res.depth = minPen
  _res.px = px
  _res.pz = pz
  return _res
}
