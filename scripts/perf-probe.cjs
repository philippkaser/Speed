// Per-pass frame cost of the game: draw calls, triangles and main-thread CPU time of three's render
// calls, broken down by pass (main view, each shadow cascade, the hero car's shadow map, each probe
// face, PMREM, post passes) and by what is drawn (the scene's top-level groups and the heaviest
// objects).
//
// usage (one Chromium at a time; SwiftShader uses every core):
//   NODE_PATH=/opt/node22/lib/node_modules flock <scratchpad>/gpu.lock \
//     node scripts/perf-probe.cjs <base_url> <query> [frames=4] [warmup=4] [width=960] [height=540] [out.json]
//   e.g. node scripts/perf-probe.cjs http://localhost:4302 '?offscreen&webgpu&q=high&race' 4 4
// `?perfprobe` is added to the query: the game then exposes its renderer and the shadow lights
// (Environment.tsx) and the probe wraps, at runtime:
//   renderer._renderScene  every render call (the scene pass, each shadow map, each probe face, every
//                          post-processing quad); nested calls (shadow maps render inside the scene
//                          pass) are counted exclusively
//   renderer.backend.draw  every draw: which object, in which pass
//   renderer.info.reset    the start of a frame (GameCanvas resets the counters first thing)
//   window.__onFrame       the end of a frame (GameCanvas' capture hook runs after the post chain)
// CPU times are main-thread JS (three's render objects, bindings, uniforms, command encoding and the
// WebGPU wire), meaningful on SwiftShader too; they are noisy on a shared machine: medians are given.
const { chromium } = require('playwright')
const fs = require('fs')
const [base = 'http://localhost:4302', query0 = '?offscreen&webgpu&q=high&race', nFrames = '4', warm = '4', W = '960', H = '540', outJson] = process.argv.slice(2)
const query = query0 + (query0.includes('perfprobe') ? '' : (query0.includes('?') ? '&' : '?') + 'perfprobe')

function instrument() {
  const H = window.__perfHook
  const r = H.renderer
  const info = r.info.render
  const stack = []
  let cur = null
  const frames = []
  const newFrame = () => ({ t0: performance.now(), passes: {}, cats: {}, objs: {}, renders: 0 })
  cur = newFrame()
  const add = (o, k, d, t, ms) => {
    const e = (o[k] ??= { calls: 0, draws: 0, tris: 0, ms: 0, projectMs: 0, objectMs: 0, drawMs: 0 })
    e.calls++
    e.draws += d
    e.tris += t
    e.ms += ms
  }
  const csmIndex = (camera) => {
    const lights = H.csm()?.lights ?? []
    for (let i = 0; i < lights.length; i++) if (lights[i].shadow.camera === camera) return i
    return -1
  }
  const classify = (scene, camera) => {
    if (scene.isQuadMesh) return 'post:' + (scene.material?.name || scene.name || 'quad')
    if (camera?.userData?.probe) {
      const rt = r.getRenderTarget()
      return 'probe' + (rt ? rt.width : '') + ':face'
    }
    const c = csmIndex(camera)
    if (c >= 0) return 'shadow:cascade' + c
    if (camera === H.heroLight.shadow.camera) return 'shadow:hero'
    if (scene === H.scene) return camera === H.camera() ? 'main' : 'scene/' + (camera.type || '?') + (camera.name ? ':' + camera.name : '')
    if (scene === H.particleScene) return 'particles'
    if (scene.isMesh) return 'mesh:' + (scene.material?.name || scene.material?.type || scene.name || '?')
    return 'other:' + (scene.name || scene.type)
  }
  const orig = r._renderScene
  r._renderScene = function (scene, camera, ...rest) {
    const label = classify(scene, camera)
    const e = { label, t0: performance.now(), d0: info.drawCalls, tri0: info.triangles, cT: 0, cD: 0, cTri: 0 }
    stack.push(e)
    try {
      return orig.call(this, scene, camera, ...rest)
    } finally {
      stack.pop()
      const ms = performance.now() - e.t0
      const d = info.drawCalls - e.d0
      const t = info.triangles - e.tri0
      add(cur.passes, label, d - e.cD, t - e.cTri, ms - e.cT)
      cur.renders++
      const p = stack[stack.length - 1]
      if (p) {
        p.cT += ms
        p.cD += d
        p.cTri += t
      }
    }
  }
  // where a pass's time goes: traversal and culling (project), preparing each render object (nodes,
  // bindings, pipelines: _renderObjectDirect minus the draw), encoding the draw (backend.draw)
  const passOf = () => (stack.length ? stack[stack.length - 1].label : '(outside)')
  const timeIn = (key) => (ms) => {
    const e = (cur.passes[passOf()] ??= { calls: 0, draws: 0, tris: 0, ms: 0, projectMs: 0, objectMs: 0, drawMs: 0 })
    e[key] += ms
  }
  const dp = r.drawingPipeline
  const project0 = dp.project
  let projDepth = 0
  const addProject = timeIn('projectMs')
  dp.project = function (...a) {
    if (projDepth++ > 0) {
      try {
        return project0.apply(this, a)
      } finally {
        projDepth--
      }
    }
    const t0 = performance.now()
    try {
      return project0.apply(this, a)
    } finally {
      projDepth--
      addProject(performance.now() - t0)
    }
  }
  const rod0 = r._renderObjectDirect
  const addObject = timeIn('objectMs')
  r._renderObjectDirect = function (...a) {
    // (exclusive: shadow maps render from inside the first object that needs them)
    const top = stack[stack.length - 1]
    const c0 = top ? top.cT : 0
    const t0 = performance.now()
    try {
      return rod0.apply(this, a)
    } finally {
      addObject(performance.now() - t0 - (top ? top.cT - c0 : 0))
    }
  }
  const addDraw = timeIn('drawMs')
  // what each draw is
  const top = (o) => {
    let p = o,
      name = ''
    const chain = []
    while (p && p !== H.scene && p !== H.particleScene) {
      if (p.name) chain.push(p.name)
      if (!p.parent || p.parent === H.scene) break
      p = p.parent
    }
    name = chain.length ? chain[chain.length - 1] : '(' + o.type + ')'
    // cars: 'car:<id>' -> 'car'
    if (/^car:/.test(name)) name = 'car'
    // unnamed objects: what they are (geometry, instances)
    const what = o.name ? '' : `${o.type}(${o.geometry?.type ?? ''}${o.isInstancedMesh ? ' x' + o.count : ''})`
    return { cat: name, detail: [...chain.slice(0, 2).reverse(), what].filter(Boolean).join('>') || o.type }
  }
  const bd = r.backend
  const draw0 = bd.draw
  bd.draw = function (ro, inf) {
    const d0 = info.drawCalls,
      t0 = info.triangles
    const tDraw = performance.now()
    const res = draw0.call(this, ro, inf)
    addDraw(performance.now() - tDraw)
    const dd = info.drawCalls - d0,
      dt = info.triangles - t0
    const label = stack.length ? stack[stack.length - 1].label : '(outside)'
    const passKey = label.replace(/:face$/, '').replace(/^post:.*/, 'post')
    const { cat, detail } = top(ro.object)
    const cats = (cur.cats[passKey] ??= {})
    const c = (cats[cat] ??= { draws: 0, tris: 0 })
    c.draws += dd
    c.tris += dt
    const k = passKey + ' | ' + detail + ' [' + (ro.material?.name || ro.material?.type || '') + ']'
    const ob = (cur.objs[k] ??= { draws: 0, tris: 0 })
    ob.draws += dd
    ob.tris += dt
    return res
  }
  const reset0 = r.info.reset.bind(r.info)
  r.info.reset = function () {
    // GameLoop resets once per frame, first thing
    cur.t0 = performance.now()
    return reset0()
  }
  window.__onFrame = () => {
    cur.frameMs = performance.now() - cur.t0
    cur.drawCalls = info.drawCalls
    cur.triangles = info.triangles
    frames.push(cur)
    cur = newFrame()
  }
  window.__perfFrames = frames
  let objects = 0,
    meshes = 0
  H.scene.traverse((o) => {
    objects++
    if (o.isMesh) meshes++
  })
  window.__perfScene = { objects, meshes }
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? (s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0
}
const fmt = (n, w = 8) => String(n).padStart(w)
const M = (n) => (n / 1e6).toFixed(2) + 'M'

;(async () => {
  const t0 = Date.now()
  const browser = await chromium.launch({
    args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--ignore-gpu-blocklist'],
  })
  const page = await browser.newPage({ viewport: { width: +W, height: +H } })
  const logs = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || /\[car\]|\[world\]|\[perf\]/.test(m.text())) logs.push(m.type() + ': ' + m.text().slice(0, 300))
  })
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message.slice(0, 300)))
  if (process.env.POSE) await page.addInitScript((p) => (window.__camPose = JSON.parse(p)), process.env.POSE)
  await page.goto(base + '/' + query, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.speed?.store?.getState().sceneReady && window.__perfHook && (window.__frames ?? 0) > 2, null, { timeout: 1200000, polling: 1000 })
  const tReady = Date.now()
  if (process.env.EVAL) await page.evaluate(process.env.EVAL)
  await page.evaluate(instrument)
  // warm-up frames (pipelines compile, probes fill), then the measured ones
  await page.waitForFunction((n) => window.__perfFrames.length >= n, +warm + +nFrames, { timeout: 2400000, polling: 500 })
  const all = await page.evaluate(() => window.__perfFrames)
  const sceneSize = await page.evaluate(() => window.__perfScene)
  const fr = all.slice(+warm)
  await browser.close()

  // ---- aggregate: medians per pass over the measured frames
  const passNames = [...new Set(fr.flatMap((f) => Object.keys(f.passes)))]
  const rows = passNames.map((p) => {
    const get = (k) => median(fr.map((f) => f.passes[p]?.[k] ?? 0))
    return { pass: p, calls: get('calls'), draws: get('draws'), tris: get('tris'), ms: get('ms'), projectMs: get('projectMs'), objectMs: get('objectMs') - get('drawMs'), drawMs: get('drawMs') }
  })
  // group the post quads into one line (kept in the json)
  const order = (p) => (p === 'main' ? 0 : p.startsWith('shadow:') ? 1 : p.startsWith('probe') ? 2 : p.startsWith('mesh:') ? 3 : p === 'particles' ? 4 : p.startsWith('post:') ? 5 : 6)
  rows.sort((a, b) => order(a.pass) - order(b.pass) || a.pass.localeCompare(b.pass))
  const sum = (rs, k) => rs.reduce((s, r) => s + r[k], 0)
  const lines = []
  lines.push(`${query}  ${W}x${H}  frames ${fr.length} (after ${warm} warm-up)  ${((Date.now() - t0) / 1000) | 0} s (ready after ${((tReady - t0) / 1000) | 0} s)`)
  lines.push(`frame: drawCalls ${median(fr.map((f) => f.drawCalls))}  triangles ${M(median(fr.map((f) => f.triangles)))}  JS ms/frame ${median(fr.map((f) => f.frameMs)).toFixed(1)}  render ms ${median(fr.map((f) => Object.values(f.passes).reduce((s, p) => s + p.ms, 0))).toFixed(1)}`)
  lines.push(`scene graph: ${sceneSize.objects} objects, ${sceneSize.meshes} meshes`)
  lines.push('')
  lines.push('pass                                   calls    draws     tris    cpu ms   us/draw | project  objects   encode')
  const post = rows.filter((r) => r.pass.startsWith('post:'))
  const shown = rows.filter((r) => !r.pass.startsWith('post:'))
  if (post.length) shown.push({ pass: `post (${post.length} kinds of quad)`, calls: sum(post, 'calls'), draws: sum(post, 'draws'), tris: sum(post, 'tris'), ms: sum(post, 'ms'), projectMs: sum(post, 'projectMs'), objectMs: sum(post, 'objectMs'), drawMs: sum(post, 'drawMs') })
  for (const r of shown) lines.push(`${r.pass.padEnd(36)} ${fmt(r.calls)} ${fmt(r.draws)} ${fmt(M(r.tris), 9)} ${fmt(r.ms.toFixed(2), 9)} ${fmt(r.draws ? ((r.ms * 1000) / r.draws).toFixed(0) : '-', 9)} | ${fmt(r.projectMs.toFixed(2), 7)} ${fmt(r.objectMs.toFixed(2), 8)} ${fmt(r.drawMs.toFixed(2), 8)}`)
  lines.push(`${'TOTAL'.padEnd(36)} ${fmt(sum(rows, 'calls'))} ${fmt(sum(rows, 'draws'))} ${fmt(M(sum(rows, 'tris')), 9)} ${fmt(sum(rows, 'ms').toFixed(2), 9)}`)
  // categories per pass (last measured frame)
  const last = fr[fr.length - 1]
  lines.push('')
  lines.push('what is drawn, per pass (last frame): category draws/tris')
  for (const [p, cats] of Object.entries(last.cats).sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))) {
    const cs = Object.entries(cats).sort((a, b) => b[1].draws - a[1].draws)
    lines.push(`  ${p.padEnd(18)} ` + cs.slice(0, 12).map(([k, v]) => `${k} ${v.draws}/${M(v.tris)}`).join(', '))
  }
  lines.push('')
  lines.push('heaviest objects (last frame), by draws:')
  const objs = Object.entries(last.objs).sort((a, b) => b[1].draws - a[1].draws)
  for (const [k, v] of objs.slice(0, 40)) lines.push(`  ${fmt(v.draws, 5)} ${fmt(M(v.tris), 8)}  ${k}`)
  lines.push('')
  lines.push('heaviest objects (last frame), by triangles:')
  for (const [k, v] of Object.entries(last.objs).sort((a, b) => b[1].tris - a[1].tris).slice(0, 25)) lines.push(`  ${fmt(v.draws, 5)} ${fmt(M(v.tris), 8)}  ${k}`)
  lines.push('')
  for (const l of [...new Set(logs)].slice(0, 25)) lines.push('  ' + l)
  console.log(lines.join('\n'))
  if (outJson) fs.writeFileSync(outJson, JSON.stringify({ query, W, H, rows, frames: fr }, null, 1))
})().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
