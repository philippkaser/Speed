// GT-style driving line: a soft, semi-transparent ribbon lying on the asphalt, lit by the same sun
// and shaded by the same shadows as the road (it is a tint on the tarmac, not a glowing stripe).
// Red where the car brakes, deeper the harder it brakes, fading in a little before the braking point
// and out towards the apex; amber through the corners at the limit and a cool blue where the car
// accelerates (full line only). The edges are feathered, and the line fades out right under the car
// and in the distance.
import { useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { abs, attribute, cameraPosition, clamp, float, length, max, mix, positionWorld, smoothstep, uniform, vec3 } from 'three/tsl'
import { speedProfileFor } from '../ai/aiDriver'
import { game } from '../game/game'
import { DS, type Track } from '../track/track'
import { useSettings } from '../state/settings'

const modeU = uniform(1) // 1 = braking zones only, 2 = full

/** Braking (0..1, by deceleration) and cornering (0..1) along the racing line, smooth along the track. */
export function lineIntensities(track: Track, prof: Float32Array) {
  const n = track.n
  const at = (i: number) => ((i % n) + n) % n
  const raw = new Float32Array(n)
  const H = Math.max(1, Math.round(3 / DS))
  for (let i = 0; i < n; i++) {
    const a = prof[at(i - H)],
      b = prof[at(i + H)]
    const decel = -(b * b - a * a) / (2 * 2 * H * DS)
    raw[i] = Math.min(1, Math.max(0, (decel - 1.5) / 10))
  }
  // shown a little before the braking point: what lies up to 14 m ahead, tapering
  const ahead = new Float32Array(n)
  const A = Math.round(14 / DS)
  for (let i = 0; i < n; i++) {
    let m = 0
    for (let k = 0; k <= A; k++) m = Math.max(m, raw[at(i + k)] * (1 - k / (A + 1)))
    ahead[i] = m
  }
  const brake = smooth(ahead, Math.round(5 / DS))
  const corner = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const c = Math.abs(track.racingCurv[i])
    const t = Math.min(1, Math.max(0, (c - 1 / 500) / (1 / 160 - 1 / 500)))
    corner[i] = t * t * (3 - 2 * t)
  }
  return { brake, corner: smooth(corner, Math.round(8 / DS)) }
}

/** Two box passes of radius r (close to a gaussian), around the closed loop. */
function smooth(x: Float32Array, r: number): Float32Array {
  const n = x.length
  let a: Float32Array = x,
    b: Float32Array = new Float32Array(n)
  for (let pass = 0; pass < 2; pass++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += a[((k % n) + n) % n]
    for (let i = 0; i < n; i++) {
      b[i] = s / (2 * r + 1)
      s += a[(i + r + 1) % n] - a[(((i - r) % n) + n) % n]
    }
    ;[a, b] = [b, a]
  }
  return a
}

export function RacingLine({ track }: { track: Track }) {
  const mode = useSettings((s) => s.racingLine)
  modeU.value = mode === 'full' ? 2 : 1
  const mesh = useMemo(() => {
    const p = game.player
    if (!p) return null
    const prof = speedProfileFor(p.sim.vehicle, track, 1)
    const { brake, corner } = lineIntensities(track, prof)
    const n = track.n
    const pos: number[] = [],
      aBrake: number[] = [],
      aCorner: number[] = [],
      across: number[] = [],
      idx: number[] = []
    const tmp = { x: 0, y: 0, z: 0 }
    const STEP = 2
    const HALF = 0.6
    for (let i = 0; i <= n; i += STEP) {
      const ii = i % n
      const d = track.racing[ii]
      const base = pos.length / 3
      for (const side of [-1, 1]) {
        track.pointAt(i * DS, d + side * HALF, tmp)
        pos.push(tmp.x, tmp.y + 0.02, tmp.z)
        aBrake.push(brake[ii])
        aCorner.push(corner[ii])
        across.push(side)
      }
      if (i > 0) idx.push(base - 2, base, base - 1, base - 1, base, base + 1)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aBrake', new THREE.Float32BufferAttribute(aBrake, 1))
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(aCorner, 1))
    g.setAttribute('aAcross', new THREE.Float32BufferAttribute(across, 1))
    g.setIndex(idx)
    g.computeVertexNormals()
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 })
    const b = attribute('aBrake', 'float')
    const c = attribute('aCorner', 'float')
    const full = smoothstep(1.5, 2, modeU)
    // accelerate: cool blue; corner at the limit: amber; braking: red, deeper with harder braking
    const go = mix(vec3(0.05, 0.32, 0.75), vec3(0.85, 0.5, 0.05), c)
    const red = mix(vec3(0.75, 0.12, 0.05), vec3(0.8, 0.02, 0.02), b)
    const brakeShow = smoothstep(0.02, 0.35, b)
    const col = mix(go, red, brakeShow)
    // feathered edges (the across attribute runs -1..1 over the width)
    const edge = float(1).sub(smoothstep(0.3, 1.0, abs(attribute('aAcross', 'float'))))
    const dist = length(positionWorld.sub(cameraPosition))
    const fade = smoothstep(5, 14, dist).mul(smoothstep(220, 110, dist))
    // braking zones only (setting 'braking'), or the whole line, lighter where it is not braking
    const strength = max(brakeShow.mul(mix(0.32, 0.5, b)), full.mul(0.2))
    m.colorNode = col
    // a little light of its own so the line still reads in the shade
    m.emissiveNode = col.mul(0.12)
    m.roughnessNode = float(0.7)
    m.metalnessNode = float(0)
    m.opacityNode = clamp(strength.mul(edge).mul(fade), 0, 1)
    const mesh = new THREE.Mesh(g, m)
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    mesh.renderOrder = 3
    // a detail the cars' reflection probes leave out
    mesh.userData.noProbe = true
    return mesh
  }, [track])
  if (!mesh || mode === 'off' || game.mode === 'attract' || game.mode === 'showroom') return null
  return <primitive object={mesh} />
}
