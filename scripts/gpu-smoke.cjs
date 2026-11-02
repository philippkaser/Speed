// Smoke test of the real WebGPU backend in headless Chromium (SwiftShader adapter).
//
// Headless WebGPU loses its device when it presents to a canvas, so the game runs in its `?offscreen`
// test mode: every frame is rendered into a render target and read back. The test fails on any
// renderer error (pipeline/shader creation, validation, device loss, page errors), on a backend other
// than WebGPU, or on a black frame.
//
//   bun run dev            (or: bun run build && bun run start)
//   node scripts/gpu-smoke.cjs [http://localhost:5173] [extra query, e.g. &gpufail to check that it fails]
//
// Needs Playwright with Chromium (`npx playwright install chromium`). SwiftShader is slow: each case
// takes one to two minutes.
const { chromium } = require('playwright')

const base = (process.argv[2] || 'http://localhost:5173').replace(/\/$/, '')
const extra = process.argv[3] || ''
const cases = process.env.SMOKE_ONLY ? [['high', '?offscreen&webgpu&q=high']] : [
  ['low', '?offscreen&webgpu&q=low'],
  ['high', '?offscreen&webgpu&q=high'],
  ['ultra, driving', '?offscreen&webgpu&q=ultra&drive'],
  ['high, team race broadcast', '?offscreen&webgpu&q=high&team'],
]
const FATAL = /THREE\.|WebGPU|GPU|pipeline|shader/i

async function run(name, query) {
  const browser = await chromium.launch({
    args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--ignore-gpu-blocklist'],
  })
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
  const problems = []
  page.on('console', (m) => {
    if (m.type() === 'error' && FATAL.test(m.text())) problems.push(m.text().split('\n')[0].slice(0, 300))
  })
  page.on('pageerror', (e) => problems.push('page error: ' + e.message.slice(0, 300)))
  try {
    await page.goto(base + '/' + query + extra, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.speed?.store?.getState().sceneReady && (window.__frames ?? 0) > 8, null, { timeout: 240000, polling: 1000 })
    await page.evaluate(() => {
      window.__shot = null
      window.__wantShot = true
    })
    await page.waitForFunction(() => window.__shot, null, { timeout: 120000, polling: 500 })
    const r = await page.evaluate(() => ({ backend: window.speed.store.getState().rendererInfo, mean: window.__shotMean, gpuError: window.speed.store.getState().gpuError }))
    if (r.backend !== 'WebGPU') problems.push(`backend is ${r.backend}`)
    if (r.gpuError) problems.push('reported: ' + r.gpuError)
    if (!(r.mean > 12)) problems.push(`frame is black (mean luminance ${r.mean?.toFixed(1)})`)
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}: backend ${r.backend}, mean luminance ${r.mean?.toFixed(1)}`)
  } catch (e) {
    problems.push(e.message.split('\n')[0])
    console.log(`FAIL ${name}`)
  }
  for (const p of [...new Set(problems)].slice(0, 8)) console.log('     ' + p)
  await browser.close()
  return problems.length === 0
}

;(async () => {
  let ok = true
  for (const [name, q] of cases) ok = (await run(name, q)) && ok
  process.exit(ok ? 0 : 1)
})()
