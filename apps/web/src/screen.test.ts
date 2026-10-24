import { describe, expect, it } from 'vitest'
import { mapPoint, ScreenTouch, type TouchMessage } from './screen'

describe('device coordinates', () => {
  const frame = { left: 10, top: 20, width: 400, height: 400 }
  const media = { width: 100, height: 200 }
  const device = { width: 1080, height: 2160 }
  it('maps the center and rejects letterboxing', () => {
    expect(mapPoint(210, 220, frame, media, device)).toEqual({ x: 540, y: 1080 })
    expect(mapPoint(50, 220, frame, media, device)).toBeNull()
  })
  it('clamps the last pixel', () => {
    expect(mapPoint(310, 420, frame, media, device)).toEqual({ x: 1079, y: 2159 })
  })
  it('maps rotated media to rotated input dimensions', () => {
    expect(mapPoint(210, 220, frame, { width: 200, height: 100 }, device)).toEqual({ x: 1080, y: 540 })
  })
  it('does not act before a frame has loaded', () => {
    expect(mapPoint(210, 220, frame, { width: 0, height: 0 }, device)).toBeNull()
  })
  it('clamps captured drags outside the frame in video coordinates', () => {
    expect(mapPoint(-100, 900, frame, media, media, true)).toEqual({ x: 0, y: 199 })
  })
})

describe('live single-pointer touch', () => {
  const size = { width: 576, height: 1280 }
  it('sends down and moves before up, allowing consecutive taps', () => {
    const messages: TouchMessage[] = []
    const touch = new ScreenTouch((message) => {
      messages.push(message)
      return true
    })
    touch.begin(1, { x: 10, y: 20 }, size)
    touch.move(1, { x: 50, y: 70 }, size)
    expect(messages.map((message) => message.action)).toEqual(['down', 'move'])
    touch.end(1)
    touch.begin(2, { x: 30, y: 40 }, size)
    touch.end(2)
    expect(messages.map((message) => message.action)).toEqual(['down', 'move', 'up', 'down', 'up'])
    expect(messages[2]).toMatchObject({ x: 50, y: 70, screenWidth: 576, screenHeight: 1280 })
  })
  it('ignores secondary pointers and releases on cancellation only once', () => {
    const messages: TouchMessage[] = []
    const touch = new ScreenTouch((message) => {
      messages.push(message)
      return true
    })
    touch.begin(1, { x: 10, y: 20 }, size)
    expect(touch.begin(2, { x: 0, y: 0 }, size)).toBe(false)
    touch.move(2, { x: 100, y: 100 }, size)
    touch.end(2)
    touch.cancel()
    touch.cancel()
    touch.end(1)
    expect(messages.map((message) => message.action)).toEqual(['down', 'cancel'])
  })
  it('cancels on rotation and does not retain failed downs', () => {
    const messages: TouchMessage[] = []
    const touch = new ScreenTouch((message) => {
      messages.push(message)
      return true
    })
    touch.begin(1, { x: 10, y: 20 }, size)
    touch.move(1, { x: 20, y: 10 }, { width: 1280, height: 576 })
    expect(messages.map((message) => message.action)).toEqual(['down', 'cancel'])
    const failed = new ScreenTouch(() => false)
    expect(failed.begin(1, { x: 10, y: 20 }, size)).toBe(false)
    expect(failed.begin(2, { x: 10, y: 20 }, size)).toBe(false)
  })
})
