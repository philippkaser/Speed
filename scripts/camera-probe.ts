// Camera audit: the chase and cockpit cameras before (frozen copy) and now, headlessly.
//   bun scripts/camera-probe.ts   (see scripts/feel/camera.ts)
import { allCameraRuns } from './feel/camera'

const f = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2))
for (const r of allCameraRuns()) {
  console.log(`${r.name.padEnd(22)} ${Object.keys(r.current).map((k) => `${k} ${f(r.legacy[k])} -> ${f(r.current[k])}`).join(' | ')}`)
}
