// Keeps a GPU failure from ending in a black screen.
// three.js reports WebGPU failures (pipeline/shader creation, uncaptured validation errors, device
// loss) through its console hook. The first fatal one on WebGPU switches the game to the WebGL2 backend:
// automatically while loading or in the menus, from a notice with a button while driving.
import * as THREE from 'three/webgpu'
import { useGameStore } from '../state/gameStore'
import { useSettings } from '../state/settings'

const FATAL = /pipeline creation failed|Uncaptured WebGPU|Device Lost|Post-processing failed|Renderer crashed/i
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()

let backend = ''
let startedAt = 0

export function rendererStarted(b: 'WebGPU' | 'WebGL2') {
  backend = b
  startedAt = performance.now()
}

/** Switches to the WebGL2 backend (persisted in the settings) and reloads. */
export function switchToWebGL(reason: string) {
  useSettings.getState().setGraphics({ backend: 'webgl', backendNote: reason.slice(0, 240) })
  setTimeout(() => location.reload(), 60)
}

export function reportGpuError(message: string) {
  const g = useGameStore.getState()
  if (g.gpuError) return
  const text = message.replace(/^THREE\./, '').slice(0, 400)
  g.set({ gpuError: text })
  // never fall back automatically in test runs that force WebGPU
  if (backend !== 'WebGPU' || params.has('webgpu') || (params.has('offscreen') && !params.has('fallback'))) return
  const early = performance.now() - startedAt < 30000
  if (early || g.screen !== 'driving') switchToWebGL(text)
}

let installed = false
export function installGpuErrorHook() {
  if (installed) return
  installed = true
  THREE.setConsoleFunction((level: string, message: string, ...rest: any[]) => {
    const out = (console as any)[level] ?? console.log
    if (rest[0]?.isStackTrace) out(rest[0].getError(message))
    else out(message, ...rest)
    if (level === 'error' && FATAL.test(String(message))) reportGpuError(String(message))
  })
}
