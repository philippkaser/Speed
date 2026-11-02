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
import { RacingLine } from './RacingLine'
import { Ghost } from './Ghost'
import { ReflectionProbe } from './ReflectionProbe'
import { debugFlag } from '../util/debug'

extend(THREE as any)

async function createRenderer(props: { canvas: HTMLCanvasElement | OffscreenCanvas }) {
  const params = new URLSearchParams(location.search)
  const forceWebGL = params.has('webgl') || !('gpu' in navigator)
  const renderer = new THREE.WebGPURenderer({
    canvas: props.canvas as HTMLCanvasElement,
    antialias: false,
    powerPreference: 'high-performance',
    forceWebGL,
    alpha: false,
  })
  await renderer.init()
  configureRenderer(renderer)
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2'
  useGameStore.getState().set({ rendererInfo: backend })
  console.info(`[render] backend: ${backend}`)
  return renderer
}

function configureRenderer(r: THREE.WebGPURenderer) {
  r.toneMapping = THREE.ACESFilmicToneMapping
  // the physical sky outputs high radiance; exposure is balanced against it
  r.toneMappingExposure = 0.58
  r.outputColorSpace = THREE.SRGBColorSpace
  r.shadowMap.enabled = true
  r.shadowMap.type = THREE.PCFShadowMap
}

function GameLoop() {
  const paused = useGameStore((s) => s.paused)
  useFrame((_, dt) => {
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
  const hour = useGameStore((s) => s.timeOfDay)
  const track = game.track
  const cars = game.cars
  void version
  return (
    <>
      <Environment hour={hour} focus={{ current: cameraFocus }} />
      <TrackScene track={track} />
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
    const tick = () => {
      if (++frames > 3) useGameStore.getState().set({ sceneReady: true })
      else raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
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
  useFrame(() => {
    const w = window as unknown as { __wantShot?: boolean; __shot?: string; __frames?: number }
    w.__frames = (w.__frames ?? 0) + 1
    if (w.__wantShot) {
      w.__wantShot = false
      w.__shot = (gl.domElement as HTMLCanvasElement).toDataURL('image/png')
    }
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
      frameloop="always"
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
      {!debugFlag('nopost') ? <PostFX /> : <PlainRender />}
      <SceneReady />
      <CaptureHook />
    </Canvas>
  )
}
