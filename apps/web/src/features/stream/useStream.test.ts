import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import JMuxer from 'jmuxer'
import * as api from '../../api'
import { useStream } from './useStream'

vi.mock('../../api', () => ({ startStream: vi.fn(), stopStream: vi.fn(), screenshot: vi.fn() }))
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
  })
  afterEach(() => {
    wrapper?.unmount()
    vi.unstubAllGlobals()
    vi.resetAllMocks()
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
