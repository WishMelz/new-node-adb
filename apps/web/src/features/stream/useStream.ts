import { computed, nextTick, onBeforeUnmount, ref, type Ref } from 'vue'
import JMuxer from 'jmuxer'
import * as api from '../../api'
import { mapPoint, ScreenTouch } from '../../screen'

export interface ScreenElements {
  preview: HTMLElement | null
  video: HTMLVideoElement | null
}
type ReportError = (error: unknown, fallback: string) => void

export function useStream(
  serial: Ref<string>,
  ready: Ref<boolean>,
  blocked: Ref<boolean>,
  log: (message: string) => void,
  showError: ReportError,
) {
  const stage = ref<ScreenElements | null>(null)
  const active = ref<api.StreamSummary | null>(null)
  const loading = ref(false)
  const loadingScreen = ref(false)
  const controlReady = ref(false)
  const state = ref('未启动')
  const canTouch = computed(() => ready.value && controlReady.value && state.value === '实时视频')
  let generation = 0
  let disposed = false
  let socket: WebSocket | null = null
  let muxer: JMuxer | null = null
  let playbackTimer: ReturnType<typeof setTimeout> | undefined
  const touch = new ScreenTouch((message) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !controlReady.value) return false
    if (socket.bufferedAmount > 64 * 1024) {
      controlReady.value = false
      void stop().catch(() => {})
      showError(null, '控制连接拥塞，已停止控制')
      return false
    }
    socket.send(JSON.stringify(message))
    return true
  })

  function cleanup() {
    touch.cancel()
    controlReady.value = false
    clearTimeout(playbackTimer)
    if (socket) {
      socket.onclose = null
      socket.onmessage = null
      socket.onerror = null
      socket.close()
      socket = null
    }
    muxer?.destroy()
    muxer = null
    active.value = null
    state.value = '未启动'
  }

  async function stop() {
    generation += 1
    const id = active.value?.id
    cleanup()
    if (id) await api.stopStream(id)
  }

  async function start() {
    if (!ready.value || loading.value || disposed) return
    if (!('MediaSource' in window) || !MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')) {
      showError(null, '浏览器不支持 H.264 MediaSource 播放')
      return
    }
    loading.value = true
    const version = generation + 1
    try {
      await stop()
      if (disposed || version !== generation || !ready.value) return
      const selected = serial.value
      const stream = await api.startStream(selected)
      if (disposed || version !== generation || selected !== serial.value) {
        await api.stopStream(stream.id)
        return
      }
      active.value = stream
      state.value = '等待画面'
      await nextTick()
      if (disposed || version !== generation) return
      const video = stage.value?.video
      if (!video) throw new Error('Video element unavailable')
      const fail = () => {
        if (disposed || version !== generation) return
        void stop().catch(() => {})
        showError(null, '连接中断，请重新开始控制')
      }
      muxer = new JMuxer({
        node: video,
        mode: 'video',
        fps: stream.options?.maxFps ?? 30,
        flushingTime: 0,
        maxDelay: 200,
        clearBuffer: true,
        onError: fail,
      })
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${location.host}/ws/streams/${stream.id}`)
      socket.binaryType = 'arraybuffer'
      socket.onmessage = (event) => {
        if (disposed || version !== generation) return
        try {
          if (typeof event.data === 'string') {
            const status = JSON.parse(event.data)
            if (status.type === 'control') controlReady.value = status.ready === true
          } else if (event.data instanceof ArrayBuffer) muxer?.feed({ video: new Uint8Array(event.data) })
        } catch {
          fail()
        }
      }
      socket.onclose = (event) => {
        if (disposed || version !== generation) return
        if (event.code === 4001) {
          generation += 1
          cleanup()
          window.dispatchEvent(new Event('auth-replaced'))
        } else fail()
      }
      socket.onerror = fail
      playbackTimer = setTimeout(fail, 20_000)
      log(`开始控制：${selected}`)
    } catch (error) {
      if (!disposed && version === generation) {
        await stop().catch(() => {})
        showError(error, '投屏启动失败')
      }
    } finally {
      loading.value = false
    }
  }

  async function screenshot() {
    if (!ready.value || loadingScreen.value || disposed) return
    const selected = serial.value
    const version = generation
    loadingScreen.value = true
    try {
      const blob = await api.screenshot(selected)
      if (disposed || version !== generation || selected !== serial.value) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${selected.replace(/[^A-Za-z0-9_.-]/g, '_')}-${Date.now()}.webp`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      log('截图已下载')
    } catch (error) {
      if (!disposed && version === generation && selected === serial.value) showError(error, '截图失败')
    } finally {
      loadingScreen.value = false
    }
  }

  function coordinates(event: PointerEvent, clamp = false) {
    const rect = stage.value?.preview?.getBoundingClientRect()
    const size = { width: stage.value?.video?.videoWidth || 0, height: stage.value?.video?.videoHeight || 0 }
    if (!rect) return null
    const point = mapPoint(event.clientX, event.clientY, rect, size, size, clamp)
    return point ? { point, size } : null
  }
  function down(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || !canTouch.value || blocked.value) return
    const mapped = coordinates(event)
    if (!mapped) return
    event.preventDefault()
    if (touch.begin(event.pointerId, mapped.point, mapped.size))
      stage.value?.preview?.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent) {
    if (!canTouch.value || blocked.value) {
      touch.cancel()
      return
    }
    const mapped = coordinates(event, true)
    if (mapped) touch.move(event.pointerId, mapped.point, mapped.size)
  }
  function up(event: PointerEvent) {
    move(event)
    touch.end(event.pointerId)
    const preview = stage.value?.preview
    if (preview?.hasPointerCapture(event.pointerId)) preview.releasePointerCapture(event.pointerId)
  }
  function playing() {
    clearTimeout(playbackTimer)
    state.value = '实时视频'
  }
  function cancel() {
    touch.cancel()
  }
  function pageLeaving() {
    cancel()
    if (active.value)
      void fetch(`/api/streams/${active.value.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => {})
    generation += 1
    cleanup()
  }
  async function end() {
    try {
      await stop()
      log('控制已停止')
    } catch (error) {
      if (!disposed) showError(error, '停止失败')
    }
  }
  onBeforeUnmount(() => {
    disposed = true
    pageLeaving()
  })
  return {
    stage,
    active,
    loading,
    loadingScreen,
    state,
    canTouch,
    start,
    stop,
    end,
    screenshot,
    down,
    move,
    up,
    cancel,
    playing,
    pageLeaving,
  }
}
