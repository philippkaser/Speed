// Racing line plot: overview + zooms of the most telling corners, line coloured by the GT3 profile speed.
//   bun scripts/plot-line.ts <outDir> <prefix> [trackId]
// Writes <prefix>-overview.png and <prefix>-<corner>.png (SVG rendered by Playwright's Chromium).
import { AIDriver } from '../src/ai/aiDriver'
import { CARS } from '../src/physics/spec'
import { Vehicle } from '../src/physics/vehicle'
import { Track } from '../src/track/track'
import { getTrackDef, TRACKS } from '../src/track/trackDef'

const outDir = process.argv[2] ?? '.'
const prefix = process.argv[3] ?? 'line'
const track = new Track(process.argv[4] ? getTrackDef(process.argv[4]) : TRACKS[0])
const n = track.n
const ds = track.length / n
const prof = new AIDriver(new Vehicle(CARS[0]), track, 1).profile
const HALF_CAR = 1.02

const P = (i: number, d: number): [number, number] => [track.px[i] + track.lx[i] * d, track.pz[i] + track.lz[i] * d]
const poly = (fn: (i: number) => number, i0: number, i1: number, step: number) => {
  const a: string[] = []
  for (let k = i0; k <= i1; k += step) { const i = ((k % n) + n) % n; const [x, z] = P(i, fn(i)); a.push(`${x.toFixed(2)},${z.toFixed(2)}`) }
  return a.join(' ')
}
const col = (v: number) => `hsl(${(Math.min(1, Math.max(0, (v * 3.6 - 60) / 220)) * 120).toFixed(0)},90%,42%)`

// corners: local minima of the profile; turn-in = start of the braking/turn phase, apex = closest point to the inside
type Corner = { i: number; v: number; dir: number; apex: number; turnIn: number }
const corners: Corner[] = []
for (let i = 0; i < n; i++) {
  let isMin = true
  for (let k = -60; k <= 60 && isMin; k++) if (prof[(i + k + n) % n] < prof[i] || (k < 0 && prof[(i + k + n) % n] === prof[i])) isMin = false
  if (!isMin || prof[i] > 0.93 * Math.max(prof[(i - 120 + n) % n], prof[(i + 120) % n])) continue
  const dir = Math.sign(track.racingCurv[i]) || 1
  let apex = i, best = 1e9
  for (let k = -40; k <= 40; k++) {
    const j = (i + k + n) % n
    const inside = dir > 0 ? track.hw[j] + track.L.kerb[j] - track.racing[j] : track.hw[j] + track.R.kerb[j] + track.racing[j]
    if (inside < best) { best = inside; apex = j }
  }
  let turnIn = i
  for (let k = 0; k < 120; k++) { const j = (i - k + n) % n; if (Math.abs(track.racingCurv[j]) < 0.25 * Math.abs(track.racingCurv[i])) { turnIn = j; break } }
  corners.push({ i, v: prof[i], dir, apex, turnIn })
}
// the longest straight: longest run without a corner, and the corner leading onto it
let longest = 0, ontoLongest = corners[0]
corners.forEach((c, k) => { const nx = corners[(k + 1) % corners.length]; const gap = (nx.i - c.i + n) % n || n; if (gap > longest) { longest = gap; ontoLongest = c } })
const picks: [string, Corner][] = []
const take = (name: string, c?: Corner) => { if (c && !picks.some(([, p]) => Math.abs(p.i - c.i) < 80)) picks.push([name, c]) }
const byV = [...corners].sort((a, b) => a.v - b.v)
take('hairpin', byV[0])
take('onto-straight', ontoLongest)
take('sweeper', byV[byV.length - 1])
// linked corners of opposite direction within 160 m: chicane / esses
for (let k = 0; k < corners.length; k++) {
  const a = corners[k], b = corners[(k + 1) % corners.length]
  if (a.dir !== b.dir && (b.i - a.i + n) % n * ds < 160) { take('chicane', a); break }
}
for (const c of byV) if (picks.length < 6) take(`t${(c.i * ds).toFixed(0)}`, c)

function svgFor(cx: number, cz: number, span: number, i0: number, i1: number, title: string) {
  const zoom = span < 1000
  const sw = span / 900
  const step = zoom ? 1 : 3
  let s = ''
  for (const [S, sg] of [[track.L, 1], [track.R, -1]] as const) {
    s += `<polyline points="${poly((i) => sg * S.wall[i], i0, i1, step)}" fill="none" stroke="#557" stroke-width="${sw * 1.5}"/>`
    // kerb strips
    let k = i0
    while (k <= i1) {
      const i = ((k % n) + n) % n
      if (S.kerb[i] > 0) {
        let e = k
        while (e + 1 <= i1 && S.kerb[(((e + 1) % n) + n) % n] > 0) e++
        const a = poly((j) => sg * track.hw[j], k, e, 1), b = poly((j) => sg * (track.hw[j] + S.kerb[j]), k, e, 1).split(' ').reverse().join(' ')
        s += `<polygon points="${a} ${b}" fill="${S.kerb[i] > 1.4 ? '#d33' : '#f80'}" opacity="0.75"/>`
        k = e + 1
      } else k++
    }
    s += `<polyline points="${poly((i) => sg * track.hw[i], i0, i1, step)}" fill="none" stroke="#111" stroke-width="${sw * 2}"/>`
  }
  if (zoom) {
    s += `<polyline points="${poly((i) => track.racing[i] + HALF_CAR, i0, i1, 1)}" fill="none" stroke="#06c" stroke-width="${sw}" opacity="0.5"/>`
    s += `<polyline points="${poly((i) => track.racing[i] - HALF_CAR, i0, i1, 1)}" fill="none" stroke="#06c" stroke-width="${sw}" opacity="0.5"/>`
  }
  for (let k = i0; k < i1; k += step) {
    const i = ((k % n) + n) % n, j = (((k + step) % n) + n) % n
    const [x0, z0] = P(i, track.racing[i]), [x1, z1] = P(j, track.racing[j])
    s += `<line x1="${x0.toFixed(2)}" y1="${z0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${z1.toFixed(2)}" stroke="${col(prof[i])}" stroke-width="${sw * (zoom ? 3 : 4)}"/>`
  }
  for (const c of corners) {
    for (const [j, fill] of [[c.turnIn, '#00f'], [c.apex, '#f0f']] as const) {
      const [x, z] = P(j, track.racing[j])
      s += `<circle cx="${x.toFixed(2)}" cy="${z.toFixed(2)}" r="${sw * (zoom ? 5 : 7)}" fill="${fill}"/>`
    }
    if (zoom) {
      const [x, z] = P(c.i, track.racing[c.i])
      s += `<text x="${(x + 6 * sw).toFixed(1)}" y="${z.toFixed(1)}" font-size="${sw * 16}" fill="#111">${(c.v * 3.6).toFixed(0)} km/h</text>`
    }
  }
  const x0 = cx - span / 2, z0 = cz - span / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="${x0} ${z0} ${span} ${span}">
<rect x="${x0}" y="${z0}" width="${span}" height="${span}" fill="#e8eee4"/>${s}
<text x="${x0 + 8 * sw}" y="${z0 + 22 * sw}" font-size="${18 * sw}" fill="#111">${title}</text></svg>`
}

let est = 0
for (let i = 0; i < n; i++) est += ds / Math.max(prof[i], 1)
const pages: [string, string][] = []
const cxA = (track.minX + track.maxX) / 2, czA = (track.minZ + track.maxZ) / 2
const spanA = Math.max(track.maxX - track.minX, track.maxZ - track.minZ) + 80
pages.push([`${prefix}-overview.png`, svgFor(cxA, czA, spanA, 0, n, `${track.def.name} ${prefix}: GT3 profile lap ${est.toFixed(2)} s (blue = turn-in, magenta = apex)`)])
for (const [name, c] of picks) {
  const [x, z] = P(c.i, 0)
  const half = Math.round(170 / ds)
  pages.push([`${prefix}-${name}.png`, svgFor(x, z, 230, c.i - half, c.i + half, `${prefix} ${name} @ ${(c.i * ds).toFixed(0)} m, min ${(c.v * 3.6).toFixed(0)} km/h`)])
}
const job = `${outDir}/.plot-job.json`
await Bun.write(job, JSON.stringify(pages.map(([f, svg]) => ({ out: `${outDir}/${f}`, svg }))))
const render = `const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:900,height:900}});for(const j of JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))){await p.setContent(j.svg);await p.screenshot({path:j.out})}await b.close()})()`
const r = Bun.spawnSync(['node', '-e', render, job], { stdout: 'inherit', stderr: 'inherit' })
console.log(`profile lap ${est.toFixed(2)} s, ${corners.length} corners; wrote`, pages.map(([f]) => f).join(' '), r.exitCode ? 'RENDER FAILED' : '')
