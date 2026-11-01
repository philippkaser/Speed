// Renders a top-down SVG of the circuit (centreline, edges, barriers, kerbs, racing line by speed).
import { Track } from '../src/track/track'
import { TRACKS } from '../src/track/trackDef'

const out = process.argv[2] ?? 'track.svg'
const track = new Track(TRACKS[0])
const pad = 80
const minX = track.minX - pad, minZ = track.minZ - pad
const w = track.maxX - track.minX + 2 * pad, h = track.maxZ - track.minZ + 2 * pad
const pts = (fn: (i: number) => [number, number], step = 2) => {
  const a: string[] = []
  for (let i = 0; i < track.n; i += step) { const [x, z] = fn(i); a.push(`${(x - minX).toFixed(1)},${(z - minZ).toFixed(1)}`) }
  return a.join(' ')
}
const side = (S: typeof track.L, sg: number, key: 'wall' | 'edge') => pts((i) => {
  const off = key === 'wall' ? S.wall[i] : track.hw[i]
  return [track.px[i] + track.lx[i] * off * sg, track.pz[i] + track.lz[i] * off * sg]
})
let kerbs = ''
for (const [S, sg] of [[track.L, 1], [track.R, -1]] as const) {
  for (let i = 0; i < track.n; i += 3) if (S.kerb[i] > 0) {
    const o = track.hw[i] + S.kerb[i] * 0.5
    kerbs += `<circle cx="${(track.px[i] + track.lx[i] * o * sg - minX).toFixed(1)}" cy="${(track.pz[i] + track.lz[i] * o * sg - minZ).toFixed(1)}" r="1.4" fill="${S.kerb[i] > 1.4 ? '#e22' : '#f90'}"/>`
  }
  for (let i = 0; i < track.n; i += 6) if (S.outer[i] === 3) {
    const o = track.hw[i] + S.kerb[i] + S.paved[i] + 4
    kerbs += `<circle cx="${(track.px[i] + track.lx[i] * o * sg - minX).toFixed(1)}" cy="${(track.pz[i] + track.lz[i] * o * sg - minZ).toFixed(1)}" r="3" fill="#c9b37a"/>`
  }
}
let racing = ''
for (let i = 0; i < track.n; i += 4) {
  const j = (i + 4) % track.n
  const v = track.speed[i] * 3.6
  const t = Math.min(1, Math.max(0, (v - 60) / 220))
  const col = `hsl(${(t * 120).toFixed(0)},90%,45%)`
  const x0 = track.px[i] + track.lx[i] * track.racing[i] - minX, z0 = track.pz[i] + track.lz[i] * track.racing[i] - minZ
  const x1 = track.px[j] + track.lx[j] * track.racing[j] - minX, z1 = track.pz[j] + track.lz[j] * track.racing[j] - minZ
  racing += `<line x1="${x0.toFixed(1)}" y1="${z0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${z1.toFixed(1)}" stroke="${col}" stroke-width="2.2"/>`
}
let labels = ''
for (let i = 0; i < track.n; i += 250) labels += `<text x="${(track.px[i] - minX + 14).toFixed(0)}" y="${(track.pz[i] - minZ).toFixed(0)}" font-size="18" fill="#333">${i}m ${(track.speed[i] * 3.6).toFixed(0)}k y${track.py[i].toFixed(0)}</text>`
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="${(1500 * h / w).toFixed(0)}" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}">
<rect width="100%" height="100%" fill="#eef2ea"/>
<polygon points="${side(track.L, 1, 'wall')}" fill="none" stroke="#447" stroke-width="1.5"/>
<polygon points="${side(track.R, -1, 'wall')}" fill="none" stroke="#447" stroke-width="1.5"/>
<polygon points="${side(track.L, 1, 'edge')}" fill="none" stroke="#222" stroke-width="2"/>
<polygon points="${side(track.R, -1, 'edge')}" fill="none" stroke="#222" stroke-width="2"/>
${kerbs}${racing}${labels}
<circle cx="${track.px[0] - minX}" cy="${track.pz[0] - minZ}" r="8" fill="#000"/>
<text x="20" y="40" font-size="28" fill="#111">${track.def.name} — ${(track.length / 1000).toFixed(2)} km — est. lap ${track.lapTime(track.speed).toFixed(1)} s</text>
</svg>`
await Bun.write(out, svg)
console.log('length', track.length, 'lap', track.lapTime(track.speed).toFixed(2), 'maxV', (Math.max(...track.speed) * 3.6).toFixed(0), 'minV', (Math.min(...track.speed) * 3.6).toFixed(0))
