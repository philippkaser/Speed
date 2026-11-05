// Computes the iris's diffraction star (aperture.ts) off the main thread.
import { computeStar } from './aperture'

self.onmessage = () => {
  const star = computeStar()
  ;(self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(star, [star.buffer])
}
