// Force feedback for Logitech wheels over WebHID (experimental).
//
// Browsers have no force-feedback API for wheels, but WebHID lets us talk to the device directly.
// Logitech G29 / G27 / G25 / Driving Force GT / G923 (PlayStation version) accept the "classic"
// 7-byte slot commands used by the Linux hid-lg4ff driver:
//   0xf5 ...                  -> disable the built-in autocentre spring
//   0xf8 0x81 lo hi ...       -> set rotation range (degrees)
//   0x11 0x08 F 0x80 0 0 0    -> constant force in slot 1, F = 0x80 is no force
//   0x13 0 ...                -> stop slot 1
// The force we send is the simulated steering-rack torque (tyre self-aligning moments + mechanical
// trail), so the wheel goes light when the front tyres pass their peak, exactly as in a real car.

const LOGITECH = 0x046d
const PRODUCTS = [0xc24f, 0xc29b, 0xc299, 0xc29a, 0xc298, 0xc266, 0xc267, 0xc262]

interface HIDLike {
  opened: boolean
  productName: string
  open(): Promise<void>
  close(): Promise<void>
  sendReport(reportId: number, data: Uint8Array): Promise<void>
}

class LogitechFFB {
  device: HIDLike | null = null
  status: 'off' | 'connecting' | 'on' | 'error' | 'unsupported' = 'off'
  message = ''
  private last = -1
  private lastSend = 0
  private busy = false

  get supported() {
    return typeof navigator !== 'undefined' && 'hid' in navigator
  }

  /** Must be called from a user gesture (opens the browser's device chooser). */
  async connect(rangeDeg = 900) {
    if (!this.supported) {
      this.status = 'unsupported'
      this.message = 'WebHID is not available in this browser (use Chrome or Edge).'
      return false
    }
    this.status = 'connecting'
    try {
      const hid = (navigator as unknown as { hid: { requestDevice(o: object): Promise<HIDLike[]> } }).hid
      const list = await hid.requestDevice({ filters: PRODUCTS.map((productId) => ({ vendorId: LOGITECH, productId })) })
      const dev = list[0]
      if (!dev) {
        this.status = 'off'
        return false
      }
      if (!dev.opened) await dev.open()
      this.device = dev
      await this.raw([0xf5, 0, 0, 0, 0, 0, 0]) // autocentre off
      const r = Math.max(40, Math.min(1080, Math.round(rangeDeg)))
      await this.raw([0xf8, 0x81, r & 0xff, (r >> 8) & 0xff, 0, 0, 0])
      this.status = 'on'
      this.message = dev.productName
      return true
    } catch (e) {
      this.status = 'error'
      this.message = (e as Error).message
      return false
    }
  }

  private async raw(bytes: number[]) {
    if (!this.device) return
    await this.device.sendReport(0, new Uint8Array(bytes))
  }

  /** force in -1..1 (+ = towards the right). Throttled to ~120 Hz, skipped when unchanged. */
  update(force: number) {
    if (this.status !== 'on' || !this.device || this.busy) return
    const now = performance.now()
    const v = Math.max(1, Math.min(255, Math.round(0x80 + Math.max(-1, Math.min(1, force)) * 127)))
    if (v === this.last && now - this.lastSend < 250) return
    if (now - this.lastSend < 8) return
    this.last = v
    this.lastSend = now
    this.busy = true
    this.raw([0x11, 0x08, v, 0x80, 0, 0, 0])
      .catch((e) => {
        this.status = 'error'
        this.message = (e as Error).message
      })
      .finally(() => (this.busy = false))
  }

  async stop() {
    if (!this.device) return
    try {
      await this.raw([0x13, 0, 0, 0, 0, 0, 0])
    } catch {
      /* ignore */
    }
  }

  async disconnect() {
    await this.stop()
    await this.device?.close().catch(() => {})
    this.device = null
    this.status = 'off'
  }
}

export const ffb = new LogitechFFB()
