import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import JMuxer from 'jmuxer'
import * as api from '../../api'
import { useStream } from './useStream'

vi.mock('../../api', () => ({
  startStream: vi.fn(),
  stopStream: vi.fn(),
  screenshot: vi.fn(),
  tap: vi.fn(),
  swipe: vi.fn(),
}))
vi.mock('jmuxer', () => ({ default: vi.fn() }))

describe('stream request lifecycle', () => {
  let wrapper: VueWrapper | undefined
  let stream: ReturnType<typeof useStream>
  const serial = ref('192.0.2.10:5555')
  const showError = vi.fn()
  const sockets: WebSocket[] = []

  beforeEach(() => {
    sockets.length = 0
    serial.value = '192.0.2.10:5555'
    vi.stubGlobal('MediaSource', { isTypeSupported: () => true })
    vi.stubGlobal('WebKitMediaSource', undefined)
    vi.stubGlobal('ManagedMediaSource', undefined)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    let frame = 0
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => `blob:frame-${++frame}`)
        static revokeObjectURL = vi.fn()
      },
    )
    vi.stubGlobal(
      'WebSocket',
      class {
        static OPEN = 1
        readyState = 1
        bufferedAmount = 0
        constructor() {
          sockets.push(this as unknown as WebSocket)
        }
        close() {}
        send() {}
      },
    )
    vi.mocked(JMuxer).mockImplementation(function () {
      return { destroy: vi.fn(), feed: vi.fn() } as unknown as JMuxer
    })
    wrapper = mount(
      defineComponent({
        setup() {
          stream = useStream(serial, ref(true), ref(false), vi.fn(), showError)
          return () => null
        },
      }),
    )
    stream.playbackMode.value = 'h264'
  })
  afterEach(() => {
    wrapper?.unmount()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  async function startVideo() {
    vi.mocked(api.startStream).mockResolvedValue({
      id: 'mobile',
      serial: serial.value,
      createdAt: 0,
      clientCount: 0,
      started: true,
    })
    const video = document.createElement('video')
    stream.stage.value = { preview: null, video }
    await stream.start()
    return video
  }

  it.each(['ManagedMediaSource', 'WebKitMediaSource'])(
    'starts with only %s available, matching JMuxer fallback',
    async (mediaSource) => {
      vi.stubGlobal('MediaSource', undefined)
      vi.stubGlobal(mediaSource, { isTypeSupported: () => true })
      await startVideo()
      expect(api.startStream).toHaveBeenCalledExactlyOnceWith(serial.value, 'h264')
      expect(JMuxer).toHaveBeenCalledTimes(1)
      expect(sockets).toHaveLength(1)
      expect(showError).not.toHaveBeenCalled()
    },
  )

  it('lets JMuxer check the actual stream codec instead of rejecting a guessed profile', async () => {
    const isTypeSupported = vi.fn(() => false)
    vi.stubGlobal('MediaSource', { isTypeSupported })
    await startVideo()
    expect(JMuxer).toHaveBeenCalledTimes(1)
    expect(isTypeSupported).not.toHaveBeenCalled()
    expect(showError).not.toHaveBeenCalled()
  })

  it('does not create a server stream when no streaming media API exists', async () => {
    vi.stubGlobal('MediaSource', undefined)
    await stream.start()
    expect(api.startStream).not.toHaveBeenCalled()
    expect(JMuxer).not.toHaveBeenCalled()
    expect(stream.loading.value).toBe(false)
    expect(stream.playbackError.value).toContain('iOS 17.1')
    expect(showError).toHaveBeenCalledExactlyOnceWith(null, stream.playbackError.value)
  })

  it('retains an unsupported codec error, cleans up once and supports retry', async () => {
    vi.useFakeTimers()
    const video = await startVideo()
    const close = vi.spyOn(sockets[0], 'close')
    const player = vi.mocked(JMuxer).mock.results[0].value as JMuxer
    const options = vi.mocked(JMuxer).mock.calls[0][0] as JMuxer.Options & {
      onUnsupportedCodec: () => void
    }
    options.onUnsupportedCodec()
    options.onError?.({ type: 'buffer' })
    video.dispatchEvent(new Event('error'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(stream.active.value).toBeNull()
    expect(stream.canTouch.value).toBe(false)
    expect(stream.playbackError.value).toContain('H.264 编码')
    expect(api.stopStream).toHaveBeenCalledExactlyOnceWith('mobile')
    expect(close).toHaveBeenCalledTimes(1)
    expect(player.destroy).toHaveBeenCalledTimes(1)
    expect(showError).toHaveBeenCalledExactlyOnceWith(null, stream.playbackError.value)
    await stream.start()
    expect(stream.playbackError.value).toBe('')
    expect(stream.active.value?.id).toBe('mobile')
    expect(JMuxer).toHaveBeenCalledTimes(2)
    options.onUnsupportedCodec()
    expect(stream.active.value?.id).toBe('mobile')
  })

  it('reports native video decoding errors immediately and ignores late playing events', async () => {
    const video = await startVideo()
    Object.defineProperty(video, 'error', { value: { code: 3 } })
    video.dispatchEvent(new Event('error'))
    stream.playing()
    expect(stream.active.value).toBeNull()
    expect(stream.state.value).toBe('未启动')
    expect(stream.playbackError.value).toContain('无法解码')
    expect(api.stopStream).toHaveBeenCalledExactlyOnceWith('mobile')
    await stream.stop()
    expect(stream.playbackError.value).toBe('')
  })

  it('reports first-frame timeout as a retryable error', async () => {
    vi.useFakeTimers()
    await startVideo()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(stream.active.value).toBeNull()
    expect(stream.playbackError.value).toContain('超时')
    expect(api.stopStream).toHaveBeenCalledExactlyOnceWith('mobile')
    expect(showError).toHaveBeenCalledTimes(1)
  })

  it('destroys a player that reports an error during construction without opening a socket', async () => {
    const destroy = vi.fn()
    vi.mocked(JMuxer).mockImplementationOnce(function (options) {
      options.onError?.({ type: 'buffer' })
      return { destroy, feed: vi.fn() } as unknown as JMuxer
    })
    await startVideo()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(0)
    expect(stream.active.value).toBeNull()
    expect(stream.playbackError.value).toContain('缓冲失败')
    expect(api.stopStream).toHaveBeenCalledExactlyOnceWith('mobile')
  })

  it('swipes from the bottom edge and cancels an interrupted gesture', async () => {
    vi.useFakeTimers()
    vi.mocked(api.startStream).mockResolvedValue({
      id: 'gesture',
      serial: serial.value,
      createdAt: 0,
      clientCount: 0,
      started: true,
    })
    const video = document.createElement('video')
    Object.defineProperties(video, {
      videoWidth: { value: 720 },
      videoHeight: { value: 1280 },
    })
    stream.stage.value = { preview: null, video }
    await stream.start()
    const socket = sockets[0]!
    const send = vi.spyOn(socket, 'send')
    socket.onmessage!.call(
      socket,
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'control', ready: true }),
      }),
    )
    stream.playing()
    const gesture = stream.swipeHome()
    await stream.swipeHome()
    await vi.advanceTimersByTimeAsync(200)
    await gesture
    const messages = send.mock.calls.map(([message]) => JSON.parse(message as string))
    expect(messages).toHaveLength(14)
    expect(messages[0]).toMatchObject({
      action: 'down',
      x: 360,
      y: 1279,
      screenWidth: 720,
      screenHeight: 1280,
    })
    expect(messages.at(-1)).toMatchObject({ action: 'up', x: 360, y: 576 })
    expect(stream.swipingHome.value).toBe(false)
    send.mockClear()
    const interrupted = stream.swipeHome()
    stream.cancel()
    await vi.advanceTimersByTimeAsync(200)
    await interrupted
    expect(send.mock.calls.map(([message]) => JSON.parse(message as string).action)).toEqual([
      'down',
      'cancel',
    ])
    expect(stream.swipingHome.value).toBe(false)
  })

  async function startImages(mode: api.PlaybackMode = 'images') {
    vi.useFakeTimers()
    stream.playbackMode.value = mode
    vi.mocked(api.screenshot).mockResolvedValue(new Blob(['frame'], { type: 'image/webp' }))
    const preview = document.createElement('div')
    preview.setPointerCapture = vi.fn()
    preview.hasPointerCapture = vi.fn(() => true)
    preview.releasePointerCapture = vi.fn()
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 360,
      height: 640,
    } as DOMRect)
    const image = document.createElement('img')
    Object.defineProperties(image, { naturalWidth: { value: 720 }, naturalHeight: { value: 1280 } })
    stream.stage.value = { preview, video: null, image }
    await stream.start()
    await flushPromises()
    return image
  }

  function displayImage(image: HTMLImageElement) {
    image.src = stream.imageUrl.value
    stream.imageLoaded()
  }

  it('selects H.265 for both the server and JMuxer', async () => {
    stream.playbackMode.value = 'h265'
    await startVideo()
    expect(api.startStream).toHaveBeenCalledWith(serial.value, 'h265')
    expect(JMuxer).toHaveBeenCalledWith(expect.objectContaining({ videoCodec: 'H265' }))
    expect(stream.modeLabel.value).toBe('H.265')
  })

  it('automatically uses images without media APIs and serializes frames until image load', async () => {
    vi.stubGlobal('MediaSource', undefined)
    const image = await startImages('auto')
    expect(api.startStream).not.toHaveBeenCalled()
    expect(stream.running.value).toBe(true)
    expect(stream.canTouch.value).toBe(false)
    expect(api.screenshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.screenshot).toHaveBeenCalledTimes(1)
    displayImage(image)
    expect(stream.canTouch.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.screenshot).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-1')
    await stream.stop()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-2')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.screenshot).toHaveBeenCalledTimes(2)
    expect(stream.running.value).toBe(false)
    expect(showError).not.toHaveBeenCalled()
  })

  it('falls back once after an automatic codec failure and ignores old callbacks', async () => {
    stream.playbackMode.value = 'auto'
    vi.mocked(api.screenshot).mockResolvedValue(new Blob(['frame']))
    await startVideo()
    const options = vi.mocked(JMuxer).mock.calls[0][0] as JMuxer.Options & { onUnsupportedCodec: () => void }
    options.onUnsupportedCodec()
    await flushPromises()
    expect(api.stopStream).toHaveBeenCalledExactlyOnceWith('mobile')
    expect(stream.imageActive.value).toBe(true)
    expect(stream.playbackError.value).toBe('')
    options.onUnsupportedCodec()
    expect(api.screenshot).toHaveBeenCalledTimes(1)
    expect(showError).not.toHaveBeenCalled()
    stream.imageFailed()
    expect(stream.running.value).toBe(false)
    expect(showError).toHaveBeenCalledTimes(1)
    expect(api.startStream).toHaveBeenCalledTimes(1)
  })

  it('falls back to images when the video player throws during automatic startup', async () => {
    stream.playbackMode.value = 'auto'
    vi.mocked(api.screenshot).mockResolvedValue(new Blob(['frame']))
    vi.mocked(JMuxer).mockImplementationOnce(function () {
      throw new Error('MediaSource construction failed')
    })
    await startVideo()
    await flushPromises()
    expect(api.stopStream).toHaveBeenCalledExactlyOnceWith('mobile')
    expect(sockets).toHaveLength(0)
    expect(stream.imageActive.value).toBe(true)
    expect(stream.playbackError.value).toBe('')
    expect(api.screenshot).toHaveBeenCalledTimes(1)
    expect(showError).not.toHaveBeenCalled()
  })

  it('does not hide a server startup failure with automatic image fallback', async () => {
    stream.playbackMode.value = 'auto'
    const failure = new Error('Device unavailable')
    vi.mocked(api.startStream).mockRejectedValueOnce(failure)
    await stream.start()
    expect(api.screenshot).not.toHaveBeenCalled()
    expect(stream.running.value).toBe(false)
    expect(showError).toHaveBeenCalledExactlyOnceWith(failure, '投屏启动失败')
  })

  it('does not resume automatic recovery after the user stops during cleanup', async () => {
    stream.playbackMode.value = 'auto'
    await startVideo()
    let finishStop!: () => void
    vi.mocked(api.stopStream).mockReturnValueOnce(
      new Promise((resolve) => {
        finishStop = () => resolve({} as Awaited<ReturnType<typeof api.stopStream>>)
      }),
    )
    const options = vi.mocked(JMuxer).mock.calls[0][0]!
    options.onError?.({ type: 'buffer' })
    await stream.stop()
    finishStop()
    await flushPromises()
    expect(api.screenshot).not.toHaveBeenCalled()
    expect(stream.running.value).toBe(false)
    expect(showError).not.toHaveBeenCalled()
  })

  it('aborts a pending frame and ignores its late result after stop', async () => {
    let resolveFrame!: (blob: Blob) => void
    vi.mocked(api.screenshot).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFrame = resolve
      }),
    )
    stream.playbackMode.value = 'images'
    await stream.start()
    const signal = vi.mocked(api.screenshot).mock.calls[0][1]!
    await stream.stop()
    expect(signal.aborted).toBe(true)
    resolveFrame(new Blob(['late']))
    await flushPromises()
    expect(stream.imageUrl.value).toBe('')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(showError).not.toHaveBeenCalled()
  })

  it('sends image taps and swipes in native screenshot coordinates and cancels gestures', async () => {
    const image = await startImages()
    displayImage(image)
    const pointer = (clientX: number, clientY: number) =>
      ({
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX,
        clientY,
        preventDefault: vi.fn(),
      }) as unknown as PointerEvent
    stream.down(pointer(180, 320))
    stream.up(pointer(180, 320))
    expect(api.tap).toHaveBeenCalledExactlyOnceWith(serial.value, 360, 640)
    await flushPromises()
    stream.down(pointer(180, 600))
    stream.up(pointer(180, 200))
    expect(api.swipe).toHaveBeenCalledWith(serial.value, 360, 1200, 360, 400, 100)
    await flushPromises()
    stream.down(pointer(180, 600))
    stream.cancel()
    stream.up(pointer(180, 200))
    expect(api.swipe).toHaveBeenCalledTimes(1)
    await stream.swipeHome()
    expect(api.swipe).toHaveBeenLastCalledWith(serial.value, 360, 1279, 360, 576)
  })

  it('stops images before rejecting an unsupported manual video mode', async () => {
    vi.stubGlobal('MediaSource', undefined)
    await startImages()
    await stream.changeMode('h265')
    expect(stream.running.value).toBe(false)
    expect(stream.imageUrl.value).toBe('')
    expect(stream.playbackError.value).toContain('实时视频接口')
    expect(api.startStream).not.toHaveBeenCalled()
  })

  it('does not restart after cancellation while waiting for the previous stream to stop', async () => {
    stream.active.value = {
      id: 'previous',
      serial: serial.value,
      createdAt: Date.now(),
      clientCount: 1,
      started: true,
      deviceSize: { width: 720, height: 1280 },
    }
    let finishStop!: () => void
    vi.mocked(api.stopStream).mockReturnValueOnce(
      new Promise((resolve) => {
        finishStop = () => resolve({} as Awaited<ReturnType<typeof api.stopStream>>)
      }),
    )
    const pending = stream.start()
    await stream.stop()
    finishStop()
    await pending
    expect(api.startStream).not.toHaveBeenCalled()
    expect(stream.active.value).toBeNull()
    expect(stream.loading.value).toBe(false)
    expect(showError).not.toHaveBeenCalled()
  })

  it('ignores screenshot failures from a device that is no longer selected', async () => {
    let failScreenshot!: (error: Error) => void
    vi.mocked(api.screenshot).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failScreenshot = reject
      }),
    )
    const pending = stream.screenshot()
    serial.value = '192.0.2.20:5555'
    await stream.stop()
    failScreenshot(new Error('old device disconnected'))
    await pending
    expect(showError).not.toHaveBeenCalled()
    expect(stream.loadingScreen.value).toBe(false)
  })

  it('cleans up a replaced login without sending stale stop requests or reporting a network failure', async () => {
    vi.mocked(api.startStream).mockResolvedValue({
      id: 'old',
      serial: serial.value,
      createdAt: 0,
      clientCount: 0,
      started: true,
    })
    stream.stage.value = { preview: null, video: document.createElement('video') }
    const replaced = vi.fn()
    window.addEventListener('auth-replaced', replaced)
    try {
      await stream.start()
      const oldClose = sockets[0].onclose!
      const event = new CloseEvent('close', { code: 4001, reason: 'session replaced' })
      oldClose.call(sockets[0], event)
      oldClose.call(sockets[0], event)
      expect(replaced).toHaveBeenCalledTimes(1)
      expect(stream.active.value).toBeNull()
      expect(stream.canTouch.value).toBe(false)
      expect(api.stopStream).not.toHaveBeenCalled()
      expect(showError).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('auth-replaced', replaced)
    }
  })

  it.each([20, undefined])('uses the server frame rate %s with a legacy fallback', async (fps) => {
    vi.mocked(api.startStream).mockResolvedValue({
      id: 'configured',
      serial: serial.value,
      createdAt: 0,
      clientCount: 0,
      started: true,
      ...(fps === undefined ? {} : { options: { maxSize: 1024, maxFps: fps, bitRate: 2_000_000 } }),
    })
    stream.stage.value = { preview: null, video: document.createElement('video') }
    await stream.start()
    expect(JMuxer).toHaveBeenCalledWith(expect.objectContaining({ fps: fps ?? 30 }))
    expect(showError).not.toHaveBeenCalled()
    await stream.stop()
  })
})
