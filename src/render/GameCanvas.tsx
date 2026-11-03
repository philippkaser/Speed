import { Canvas, extend, useFrame, useThree } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { useEffect, useState } from 'react'
import * as THREE from 'three/webgpu'
import { audio } from '../audio/audio'
import { ffb } from '../input/ffb'
import { game } from '../game/game'
import { useGameStore } from '../state/gameStore'
import { useSettings } from '../state/settings'
import { CameraRig, cameraFocus } from './CameraRig'
import { CarVisual } from './CarVisual'
import { Effects } from './Effects'
import { Environment } from './Environment'
import { PostFX } from './PostFX'
import { TrackScene } from './TrackScene'
import { PitLaneScene } from './PitLaneScene'
import { RacingLine } from './RacingLine'
import { Ghost } from './Ghost'
import { ReflectionProbe } from './ReflectionProbe'
import { debugFlag } from '../util/debug'
import { loadCarModels } from '../car/gltfCars'
import { installGpuErrorHook, rendererStarted, switchToWebGL } from './gpuHealth'

extend(THREE as any)

async function createRenderer(props: { canvas: HTMLCanvasElement | OffscreenCanvas }) {
  installGpuErrorHook()
  const params = new URLSearchParams(location.search)
  const pref = useSettings.getState().graphics.backend ?? 'auto'
  const hasGpu = 'gpu' in navigator
  let forceWebGL = !hasGpu || params.has('webgl') || (pref === 'webgl' && !params.has('webgpu'))
  // Ask for the adapter's full colour-attachment budget (the WebGPU default is only 32 bytes per
  // sample); the G-buffer is laid out to fit the default anyway.
  let requiredLimits: Record<string, number> | undefined
  if (!forceWebGL) {
    try {
      const gpu = (navigator as unknown as { gpu: { requestAdapter(o: object): Promise<any> } }).gpu
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) forceWebGL = true
      else requiredLimits = { maxColorAttachmentBytesPerSample: adapter.limits.maxColorAttachmentBytesPerSample }
    } catch {
      forceWebGL = true
    }
  }
  const renderer = new THREE.WebGPURenderer({
    canvas: props.canvas as HTMLCanvasElement,
    antialias: false,
    powerPreference: 'high-performance',
    forceWebGL,
    alpha: false,
    ...(requiredLimits ? { requiredLimits } : {}),
  } as ConstructorParameters<typeof THREE.WebGPURenderer>[0])
  try {
    await renderer.init()
  } catch (e) {
    const msg = 'Renderer crashed during start-up: ' + (e as Error)?.message
    if (!forceWebGL) switchToWebGL(msg)
    throw e
  }
  if (OFFSCREEN) installOffscreen(renderer)
  configureRenderer(renderer)
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2'
  rendererStarted(backend)
  useGameStore.getState().set({ rendererInfo: backend })
  console.info(`[render] backend: ${backend}`)
  return renderer
}

/**
 * Test mode (`?offscreen`): everything that would go to the canvas is rendered into a render target
 * instead. Headless WebGPU (SwiftShader) loses its device when a canvas texture is presented, but works
 * offscreen, so this lets automated tests exercise the real WebGPU backend. Frames are read back by
 * CaptureHook.
 */
const offscreen: { rt: THREE.RenderTarget | null } = { rt: null }
const OFFSCREEN = new URLSearchParams(location.search).has('offscreen')

/** Offscreen mode has no presentation back-pressure: pace frames on GPU completion instead. */
function OffscreenDriver() {
  const { gl, advance } = useThree()
  useEffect(() => {
    let alive = true
    const device = (gl as any).backend?.device as { queue: { onSubmittedWorkDone(): Promise<void> } } | undefined
    // virtual clock: a steady 60 fps however long a software-rendered frame really takes
    // (R3F's advance() takes seconds)
    let t = 0
    const loop = async () => {
      while (alive) {
        t += 1 / 60
        advance(t)
        if (device) {
          await device.queue.onSubmittedWorkDone()
          await new Promise((r) => setTimeout(r, 0))
        } else await new Promise((r) => requestAnimationFrame(r))
      }
    }
    loop()
    return () => {
      alive = false
    }
  }, [gl, advance])
  return null
}
function installOffscreen(r: THREE.WebGPURenderer) {
  const rt = new THREE.RenderTarget(1, 1, { depthBuffer: true })
  offscreen.rt = rt
  const set = r.setRenderTarget.bind(r)
  const get = r.getRenderTarget.bind(r)
  ;(r as any).setRenderTarget = (t: THREE.RenderTarget | null, ...a: unknown[]) => (set as any)(t ?? rt, ...a)
  ;(r as any).getRenderTarget = () => {
    const t = get()
    return t === rt ? null : t
  }
  r.setRenderTarget(null)
}

function configureRenderer(r: THREE.WebGPURenderer) {
  r.toneMapping = THREE.ACESFilmicToneMapping
  // the physical sky outputs high radiance; exposure is balanced against it
  r.toneMappingExposure = 0.58
  r.outputColorSpace = THREE.SRGBColorSpace
  r.shadowMap.enabled = true
  r.shadowMap.type = THREE.PCFShadowMap
  // the particle pass relies on clearing to black with full transmittance in alpha
  r.setClearColor(0x000000, 1)
}

function GameLoop() {
  const paused = useGameStore((s) => s.paused)
  useFrame((state, dt) => {
    const rt = offscreen.rt
    if (rt) {
      // keep the offscreen target sized to the drawing buffer (outside of any render call)
      const s = state.gl.getDrawingBufferSize(new THREE.Vector2())
      if (rt.width !== s.x || rt.height !== s.y) rt.setSize(s.x, s.y)
    }
    if (!paused) game.update(dt)
    else {
      game.world.alpha = 1
      ffb.update(0)
    }
    audio.update(dt, paused)
  }, -10)
  return null
}

function useSessionVersion() {
  const [v, setV] = useState(game.version)
  useEffect(() => game.on((e) => e.type === 'session' && setV(game.version)), [])
  return v
}

function World() {
  const version = useSessionVersion()
  const hour = useGameStore((s) => s.sessionHour ?? s.timeOfDay)
  const track = game.track
  const cars = game.cars
  void version
  return (
    <>
      <Environment hour={hour} focus={{ current: cameraFocus }} />
      <TrackScene track={track} />
      <PitLaneScene key={'pit' + version} track={track} />
      {!debugFlag('nocar') && cars.map((c) => (
        <CarVisual key={c.id + ':' + version} entry={c} lod={c.isPlayer ? 0 : 1} />
      ))}
      <Effects key={'fx' + version} />
      <RacingLine key={'rl' + version} track={track} />
      {game.mode === 'practice' && <Ghost key={'gh' + version} />}
    </>
  )
}

function SceneReady() {
  const { gl } = useThree()
  useEffect(() => {
    configureRenderer(gl as unknown as THREE.WebGPURenderer)
    let frames = 0
    let raf = 0
    let alive = true
    const tick = () => {
      if (++frames > 3) useGameStore.getState().set({ sceneReady: true })
      else raf = requestAnimationFrame(tick)
    }
    // the detailed car models are part of the first impression: wait for them (at most 25 s)
    Promise.race([loadCarModels(), new Promise((r) => setTimeout(r, 25000))]).then(() => {
      if (alive) raf = requestAnimationFrame(tick)
    })
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [gl])
  return null
}

function PlainRender() {
  useFrame((state) => {
    state.gl.render(state.scene, state.camera)
  }, 1)
  return null
}

/** Test hook: headless WebGPU canvases can only be read back right after a frame. */
function CaptureHook() {
  const { gl } = useThree()
  useFrame((state) => {
    const w = window as unknown as { __wantShot?: boolean; __shot?: string; __frames?: number; __onFrame?: (s: unknown) => void }
    w.__frames = (w.__frames ?? 0) + 1
    w.__onFrame?.(state)
    if (!w.__wantShot) return
    w.__wantShot = false
    const rt = offscreen.rt
    if (!rt) {
      w.__shot = (gl.domElement as HTMLCanvasElement).toDataURL('image/png')
      return
    }
    const r = gl as unknown as THREE.WebGPURenderer
    const W = rt.width,
      H = rt.height
    r.readRenderTargetPixelsAsync(rt, 0, 0, W, H).then((px) => {
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const ctx = c.getContext('2d')!
      const img = ctx.createImageData(W, H)
      const flip = !(r.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
      for (let y = 0; y < H; y++) {
        const src = (flip ? H - 1 - y : y) * W * 4
        img.data.set((px as Uint8Array).subarray(src, src + W * 4), y * W * 4)
      }
      ctx.putImageData(img, 0, 0)
      let sum = 0
      for (let i = 0; i < img.data.length; i += 4) sum += img.data[i] * 0.2126 + img.data[i + 1] * 0.7152 + img.data[i + 2] * 0.0722
      ;(w as { __shotMean?: number }).__shotMean = sum / (W * H)
      w.__shot = c.toDataURL('image/png')
    }, (e) => console.error('[capture]', e))
  }, 2)
  return null
}

export function GameCanvas() {
  const scale = useSettings((s) => s.graphics.resolutionScale)
  // adaptive resolution: drei's PerformanceMonitor trims the render scale when the frame rate drops
  const [dyn, setDyn] = useState(1)
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * scale * dyn
  return (
    <Canvas
      className="game-canvas"
      gl={createRenderer as any}
      dpr={dpr}
      flat
      camera={{ fov: 58, near: 0.1, far: 12000, position: [0, 6, 12] }}
      frameloop={OFFSCREEN ? 'never' : 'always'}
      onCreated={(state) => configureRenderer(state.gl as unknown as THREE.WebGPURenderer)}
    >
      <PerformanceMonitor
        bounds={() => [50, 58]}
        flipflops={6}
        onDecline={() => setDyn((d) => Math.max(0.6, +(d - 0.1).toFixed(2)))}
        onIncline={() => setDyn((d) => Math.min(1, +(d + 0.1).toFixed(2)))}
      />
      <GameLoop />
      <World />
      <CameraRig />
      {!debugFlag('noprobe') && <ReflectionProbe />}
      {debugFlag('simonly') ? null : !debugFlag('nopost') ? <PostFX /> : <PlainRender />}
      <SceneReady />
      <CaptureHook />
      {OFFSCREEN && <OffscreenDriver />}
    </Canvas>
  )
}
