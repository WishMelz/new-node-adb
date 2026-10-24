export interface Size { width: number; height: number }
export interface Frame extends Size { left: number; top: number }

export function mapPoint(clientX: number, clientY: number, frame: Frame, media: Size, device: Size, clamp = false) {
  if (!frame.width || !frame.height || !media.width || !media.height) return null
  const scale = Math.min(frame.width / media.width, frame.height / media.height)
  const width = media.width * scale
  const height = media.height * scale
  const offsetX = clientX - frame.left - (frame.width - width) / 2
  const offsetY = clientY - frame.top - (frame.height - height) / 2
  if (!clamp && (offsetX < 0 || offsetY < 0 || offsetX > width || offsetY > height)) return null
  const rotated = (media.width > media.height) !== (device.width > device.height)
  const target = rotated ? { width: device.height, height: device.width } : device
  return {
    x: Math.max(0, Math.min(target.width - 1, Math.floor(offsetX / width * target.width))),
    y: Math.max(0, Math.min(target.height - 1, Math.floor(offsetY / height * target.height))),
  }
}

export interface TouchMessage {
  type: 'touch'
  action: 'down' | 'move' | 'up' | 'cancel'
  pointerId: number
  x: number
  y: number
  screenWidth: number
  screenHeight: number
}

export class ScreenTouch {
  private active: TouchMessage | null = null
  constructor(private readonly send: (message: TouchMessage) => boolean) {}

  begin(pointerId: number, point: { x: number; y: number }, size: Size) {
    if (this.active) return false
    const message: TouchMessage = { type: 'touch', action: 'down', pointerId, ...point, screenWidth: size.width, screenHeight: size.height }
    if (!this.send(message)) return false
    this.active = message
    return true
  }

  move(pointerId: number, point: { x: number; y: number }, size: Size) {
    if (!this.active || this.active.pointerId !== pointerId) return
    if (size.width !== this.active.screenWidth || size.height !== this.active.screenHeight) { this.cancel(); return }
    const message: TouchMessage = { ...this.active, ...point, action: 'move' }
    this.active = this.send(message) ? message : null
  }

  end(pointerId: number) {
    if (!this.active || this.active.pointerId !== pointerId) return
    const message: TouchMessage = { ...this.active, action: 'up' }
    this.active = null
    this.send(message)
  }

  cancel() {
    if (!this.active) return
    const message: TouchMessage = { ...this.active, action: 'cancel' }
    this.active = null
    this.send(message)
  }
}