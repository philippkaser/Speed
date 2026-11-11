// Look-development capture: real frames of the WebGPU backend from headless Chromium (SwiftShader).
//
//   bun run dev
//   node scripts/shot.cjs <out.png> ['<query>'] [options]
//
//   query     the game's URL switches, e.g. '?drive&q=high' (offscreen and webgpu are added)
//   --size WxH        viewport (default 1280x720)
//   --frames n        frames to let pass after the scene is ready (default 40; TAA and exposure settle)
//   --seq n           capture n consecutive frames after that (out-0.png, out-1.png, ...)
//   --every k         with --seq: keep every k-th frame (default 1)
//   --pose 'x,y,z;lx,ly,lz;fov'   a fixed camera (window.__camPose)
//   --eval '<js>'     run in the page once the scene is ready (before the settle frames)
//   --hdr             also save the exposed linear frame as <out>.hdr.json (steps: "hdr": true)
//   --info            print window.__info (draw calls, triangles) and the frame time
//   --steps file.json several captures in one page load (loading costs ~100 s here, a frame ~3-10 s):
//                     [{ "out": "a.png", "pose": "x,y,z;lx,ly,lz;fov" | null, "eval": "js", "frames": 12, "seq": 0, "every": 1 }, ...]
//                     ("pose": null releases the fixed camera; out paths are relative to <out.png>'s folder)
//
// Set SPEED_URL for a dev server on another port (default http://localhost:5173).
//
// SwiftShader renders a frame in seconds, not milliseconds: the game's clock is virtual (1/60 s per
// frame) in offscreen mode, so motion between captured frames is what a 60 fps display would show.
const fs = require('fs')
const path = require('path')

// One capture at a time on this machine: a software-rendered frame uses every core, and captures
// running side by side only slow each other down (and time out). Later ones queue here.
if (!process.env.SHOT_LOCKED && process.env.SHOT_NOLOCK !== '1') {
  const r = require('child_process').spawnSync('flock', [process.env.SHOT_LOCK || '/tmp/speed-shot.lock', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, SHOT_LOCKED: '1' } })
  if (!r.error) process.exit(r.status ?? 1)
}
const { chromium } = require('playwright')

const args = process.argv.slice(2)
const out = args[0]
if (!out) {
  console.error('usage: node scripts/shot.cjs <out.png> [query] [--size WxH] [--frames n] [--seq n] [--every k] [--pose p] [--eval js] [--info]')
  process.exit(2)
}
let query = args[1] && !args[1].startsWith('--') ? args[1] : '?drive&q=high'
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : def
}
const [W, H] = opt('size', '1280x720').split('x').map(Number)
const settle = Number(opt('frames', 40))
const seq = Number(opt('seq', 0))
const every = Number(opt('every', 1))
const pose = opt('pose', null)
const evalJs = opt('eval', null)
const stepsFile = opt('steps', null)
const base = (process.env.SPEED_URL || 'http://localhost:5173').replace(/\/$/, '')
if (!/offscreen/.test(query)) query += (query.includes('?') ? '&' : '?') + 'offscreen'
if (!/webgl|webgpu/.test(query)) query += '&webgpu'

const save = (file, url) => fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'))

;(async () => {
  const browser = await chromium.launch({
    args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--ignore-gpu-blocklist'],
  })
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().split('\n')[0].slice(0, 240))
  })
  page.on('pageerror', (e) => errors.push('page error: ' + e.message.slice(0, 240)))
  const t0 = Date.now()
  let msPerFrame = 0
  try {
    await page.goto(base + '/' + query, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.speed?.store?.getState().sceneReady && (window.__frames ?? 0) > 4, null, { timeout: 600000, polling: 500 })
    // camera helpers for --eval and steps (the car's frame: +x left, +y up, +z forward):
    //   carCam(right, up, back, fov, lookUp, id)     a fixed camera placed relative to a car as it is now
    //   followCam(right, up, back, fov, lookUp, id)  a camera rigidly attached to a car (window.__camFollow)
    //   freeCam()                                    back to the game's own camera
    await page.evaluate(() => {
      const car = (id) => {
        const g = window.speed.game
        return (id && g.cars.find((c) => c.id === id)) || g.player || g.cars[0]
      }
      window.carCam = (right, up, back, fov = 40, lookUp = 0.5, id) => {
        const v = car(id).sim.vehicle
        const P = (k) => v.pos[k] - v.left[k] * right + v.up[k] * up - v.fwd[k] * back
        delete window.__camFollow
        window.__camPose = { pos: [P('x'), P('y'), P('z')], look: [v.pos.x + v.up.x * lookUp, v.pos.y + v.up.y * lookUp, v.pos.z + v.up.z * lookUp], fov }
      }
      // sunCam(dist, fov, lookUp): a camera where a level panel at lookUp above the car mirrors the sun into it
      window.sunCam = (dist = 7, fov = 30, lookUp = 1) => {
        const v = car().sim.vehicle, s = window.__sunDir, L = [v.pos.x + v.up.x * lookUp, v.pos.y + v.up.y * lookUp, v.pos.z + v.up.z * lookUp]
        delete window.__camFollow
        window.__camPose = { pos: [L[0] - s.x * dist, L[1] + s.y * dist, L[2] - s.z * dist], look: L, fov }
      }
      window.followCam = (right, up, back, fov = 40, lookUp = 0.5, id) => {
        window.__camFollow = { right, up, back, lookUp, fov, id: id ?? car().id }
      }
      window.freeCam = () => {
        delete window.__camFollow
        delete window.__camPose
      }
    })
    const capture = async (step) => {
      if (step.pose !== undefined) {
        await page.evaluate((pose) => {
          if (!pose) return void delete window.__camPose
          const [p, l, f] = pose.split(';')
          window.__camPose = { pos: p.split(',').map(Number), look: l.split(',').map(Number), ...(f ? { fov: Number(f) } : {}) }
        }, step.pose)
      }
      // (steps: "size": "WxH" resizes the viewport for this step and the ones after it)
      if (step.size) { const [w, h] = step.size.split('x').map(Number); await page.setViewportSize({ width: w, height: h }) }
      if (step.eval) await page.evaluate(step.eval)
      const start = await page.evaluate(() => window.__frames)
      const tSettle = Date.now()
      const n = step.frames ?? settle
      await page.waitForFunction((n) => window.__frames >= n, start + n, { timeout: 1800000, polling: 250 })
      msPerFrame = (Date.now() - tSettle) / Math.max(1, n)
      const k = step.every ?? 1
      if (step.seq > 0) {
        await page.evaluate((n) => {
          window.__shots = []
          window.__shotInfo = []
          window.__seq = n
        }, step.seq * k)
        await page.waitForFunction((n) => (window.__shots?.length ?? 0) >= n && window.__shots.every((s) => s), step.seq * k, { timeout: 1800000, polling: 250 })
        const shots = await page.evaluate((k) => window.__shots.filter((_, i) => i % k === 0), k)
        shots.forEach((s, i) => save(step.out.replace(/\.png$/, '') + '-' + i + '.png', s))
      } else {
        await page.evaluate(() => {
          window.__shot = null
          window.__wantShot = true
        })
        await page.waitForFunction(() => window.__shot, null, { timeout: 600000, polling: 250 })
        save(step.out, await page.evaluate(() => window.__shot))
        if (step.hdr || args.includes('--hdr')) {
          // the exposed scene-linear frame (RGBA half floats) next to the png: <out>.hdr.json
          await page.evaluate(() => { window.__hdr = null; window.__wantHdr = true })
          await page.waitForFunction(() => window.__hdr, null, { timeout: 600000, polling: 250 })
          fs.writeFileSync(step.out.replace(/\.png$/, '.hdr.json'), JSON.stringify(await page.evaluate(() => window.__hdr)))
        }
      }
      console.log(`saved ${step.out} (${Math.round(msPerFrame)} ms/frame, t+${Math.round((Date.now() - t0) / 1000)} s)`)
    }
    if (stepsFile) {
      const dir = path.dirname(out)
      for (const step of JSON.parse(fs.readFileSync(stepsFile, 'utf8'))) await capture({ ...step, out: path.resolve(dir, step.out) })
    } else await capture({ out, ...(pose ? { pose } : {}), eval: evalJs, frames: settle, seq, every })
    if (args.includes('--info')) {
      const info = await page.evaluate(() => ({ info: window.__info, backend: window.speed.store.getState().rendererInfo, mean: window.__shotMean }))
      console.log(JSON.stringify({ ...info, msPerFrame: Math.round(msPerFrame), totalSeconds: Math.round((Date.now() - t0) / 1000) }))
    }
  } catch (e) {
    errors.push(e.message.split('\n')[0])
    process.exitCode = 1
  }
  for (const e of [...new Set(errors)].slice(0, 10)) console.error('  ! ' + e)
  await browser.close()
})()
