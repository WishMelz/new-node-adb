import { computed, nextTick, onBeforeUnmount, ref, type Ref } from 'vue'
import JMuxer from 'jmuxer'
import * as api from '../../api'
import { mapPoint, ScreenTouch } from '../../screen'

export interface ScreenElements {
  preview: HTMLElement | null
  video: HTMLVideoElement | null
  image?: HTMLImageElement | null
}
type ReportError = (error: unknown, fallback: string) => void
type MediaSourceWindow = Window & {
  MediaSource?: typeof MediaSource
  WebKitMediaSource?: typeof MediaSource
  ManagedMediaSource?: typeof MediaSource
}

const qualityPresets: Record<Exclude<api.StreamQuality, 'balanced'>, api.StreamQualityOptions> = {
  low: { maxSize: 720, maxFps: 20, bitRate: 1_200_000 },
  high: { maxSize: 1600, maxFps: 60, bitRate: 6_000_000 },
}

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
  const displayOff = ref(false)
  const swipingHome = ref(false)
  const playbackError = ref('')
  const playbackMode = ref<api.PlaybackMode>('auto')
  const streamQuality = ref<api.StreamQuality>('balanced')
  const effectiveMode = ref<Exclude<api.PlaybackMode, 'auto'> | null>(null)
  const imageActive = ref(false)
  const imageUrl = ref('')
  const running = computed(() => !!active.value || imageActive.value)
  const modeLabel = computed(() =>
    effectiveMode.value === 'images'
      ? '兼容图像'
      : effectiveMode.value === 'h265'
        ? 'H.265'
        : effectiveMode.value === 'h264'
          ? 'H.264'
          : '',
  )
  let gestureVersion = 0
  const state = ref('未启动')
  const canTouch = computed(
    () =>
      ready.value &&
      (imageActive.value ? state.value === '兼容图像' : controlReady.value && state.value === '实时视频'),
  )
  let generation = 0
  let disposed = false
  let socket: WebSocket | null = null
  let muxer: JMuxer | null = null
  let playbackTimer: ReturnType<typeof setTimeout> | undefined
  let removeVideoErrorListener: (() => void) | undefined
  let imageTimer: ReturnType<typeof setTimeout> | undefined
  let imageAbort: AbortController | undefined
  let imageSize = { width: 0, height: 0 }
  let imageDeviceSize: { width: number; height: number } | undefined
  let imageGesture: { pointerId: number; x: number; y: number; startedAt: number } | undefined
  let imageCommandPending = false
  function sendControl(payload: object) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !controlReady.value) return false
    if (socket.bufferedAmount > 64 * 1024) {
      controlReady.value = false
      void stop().catch(() => {})
      showError(null, '控制连接拥塞，已停止控制')
      return false
    }
    socket.send(JSON.stringify(payload))
    return true
  }
  const touch = new ScreenTouch((message) => sendControl(message), 10)

  function cleanup(preservePlaybackError = false) {
    cancel()
    controlReady.value = false
    displayOff.value = false
    clearTimeout(playbackTimer)
    clearTimeout(imageTimer)
    imageAbort?.abort()
    imageAbort = undefined
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
    imageUrl.value = ''
    imageActive.value = false
    imageSize = { width: 0, height: 0 }
    imageDeviceSize = undefined
    effectiveMode.value = null
    removeVideoErrorListener?.()
    removeVideoErrorListener = undefined
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
    if (!preservePlaybackError) playbackError.value = ''
  }

  async function stop(preservePlaybackError = false) {
    generation += 1
    const id = active.value?.id
    cleanup(preservePlaybackError)
    if (id) await api.stopStream(id)
  }

  async function start() {
    if (!ready.value || loading.value || disposed) return
    playbackError.value = ''
    const mode = playbackMode.value
    const selected = serial.value
    const mediaWindow = window as MediaSourceWindow
    const mediaSource =
      mediaWindow.MediaSource || mediaWindow.WebKitMediaSource || mediaWindow.ManagedMediaSource
    const hasMediaSource = typeof mediaSource?.isTypeSupported === 'function'
    loading.value = true
    const version = generation + 1
    const fail = (message = '视频连接中断，请重新连接') => {
      if (disposed || version !== generation) return
      playbackError.value = message
      const recoveryVersion = generation + 1
      void stop(true)
        .then(() => {
          if (disposed || generation !== recoveryVersion || selected !== serial.value || !ready.value) return
          if (mode === 'auto') {
            playbackError.value = ''
            log('实时视频不可用，已切换兼容图像')
            startImages(recoveryVersion, selected)
          }
        })
        .catch(() => {})
      if (mode !== 'auto') showError(null, message)
    }
    try {
      await stop()
      if (disposed || version !== generation || selected !== serial.value || !ready.value) return
      if (!hasMediaSource && mode !== 'auto' && mode !== 'images') {
        playbackError.value =
          '当前浏览器缺少实时视频接口，可切换到兼容图像模式。iPhone 实时视频建议使用 iOS 17.1 或更新版本的 Safari。'
        showError(null, playbackError.value)
        return
      }
      if (mode === 'images' || !hasMediaSource) {
        startImages(version, selected)
        return
      }
      const videoCodec = mode === 'h265' ? 'h265' : 'h264'
      const codecLabel = videoCodec === 'h265' ? 'H.265' : 'H.264'
      const preset = streamQuality.value === 'balanced' ? undefined : qualityPresets[streamQuality.value]
      const stream = preset
        ? await api.startStream(selected, videoCodec, preset)
        : await api.startStream(selected, videoCodec)
      if (disposed || version !== generation || selected !== serial.value) {
        await api.stopStream(stream.id)
        return
      }
      active.value = stream
      effectiveMode.value = stream.options?.videoCodec ?? videoCodec
      state.value = '等待画面'
      playbackError.value = ''
      await nextTick()
      if (disposed || version !== generation) return
      const video = stage.value?.video
      if (!video) throw new Error('Video element unavailable')
      const videoError = () =>
        fail(
          video.error?.code === 3 || video.error?.code === 4
            ? `浏览器无法解码当前 ${codecLabel} 视频，请切换 H.264 或兼容图像模式`
            : '视频播放失败，请重新连接',
        )
      video.addEventListener('error', videoError)
      removeVideoErrorListener = () => video.removeEventListener('error', videoError)
      const options: JMuxer.Options & { onUnsupportedCodec: () => void; videoCodec: 'H264' | 'H265' } = {
        node: video,
        mode: 'video',
        videoCodec: effectiveMode.value === 'h265' ? 'H265' : 'H264',
        fps: stream.options?.maxFps ?? 30,
        flushingTime: 0,
        maxDelay: 200,
        clearBuffer: true,
        onError: () => fail('视频缓冲失败，请重新连接'),
        onUnsupportedCodec: () =>
          fail(`浏览器不支持设备输出的 ${codecLabel} 编码，请切换 H.264 或兼容图像模式`),
      }
      const player = new JMuxer(options)
      if (disposed || version !== generation) {
        player.destroy()
        return
      }
      muxer = player
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
        } else if (event.code === 4002) {
          fail('网络传输积压过慢，已停止投屏，可尝试重新连接或切换兼容图像')
        } else if (event.code === 4003) {
          fail('设备编码器异常退出，请切换 H.264 或兼容图像模式')
        } else if (event.code === 4004) {
          fail('控制连接过载，请重新连接')
        } else fail()
      }
      socket.onerror = () => fail()
      playbackTimer = setTimeout(() => fail('等待视频画面超时，请检查网络后重新连接'), 20_000)
      log(`开始控制：${selected}（${codecLabel}）`)
    } catch (error) {
      if (!disposed && version === generation) {
        if (active.value) {
          fail('视频播放器启动失败，请切换播放模式后重试')
          return
        }
        playbackError.value = '投屏启动失败，请重新连接'
        await stop(true).catch(() => {})
        showError(error, '投屏启动失败')
      }
    } finally {
      loading.value = false
    }
  }

  function startImages(version: number, selected: string) {
    imageActive.value = true
    effectiveMode.value = 'images'
    state.value = '等待图像'
    log(`开始兼容图像：${selected}`)
    void loadImage(version, selected)
  }

  async function loadImage(version: number, selected: string) {
    if (disposed || version !== generation || !imageActive.value || selected !== serial.value) return
    if (document.hidden) {
      imageTimer = setTimeout(() => void loadImage(version, selected), 1000)
      return
    }
    imageAbort = new AbortController()
    playbackTimer = setTimeout(() => imageFailed('等待图像超时，请检查网络后重新连接'), 20_000)
    try {
      let nextDeviceSize: { width: number; height: number } | undefined
      const blob = await api.screenshot(selected, imageAbort.signal, 960, (meta) => {
        nextDeviceSize = meta
      })
      imageAbort = undefined
      if (disposed || version !== generation || selected !== serial.value) return
      imageDeviceSize = nextDeviceSize
      const previous = imageUrl.value
      imageUrl.value = URL.createObjectURL(blob)
      if (previous) URL.revokeObjectURL(previous)
    } catch (error) {
      imageAbort = undefined
      if (!disposed && version === generation) imageFailed('图像获取失败，请检查设备连接后重试', error)
    }
  }

  function imageLoaded() {
    const image = stage.value?.image
    if (
      !imageActive.value ||
      disposed ||
      !image ||
      image.getAttribute('src') !== imageUrl.value ||
      !image.naturalWidth
    )
      return
    clearTimeout(playbackTimer)
    if (imageSize.width !== image.naturalWidth || imageSize.height !== image.naturalHeight) cancel()
    imageSize = { width: image.naturalWidth, height: image.naturalHeight }
    state.value = '兼容图像'
    clearTimeout(imageTimer)
    const version = generation
    const selected = serial.value
    imageTimer = setTimeout(() => void loadImage(version, selected), 1000)
  }

  function imageFailed(message = '浏览器无法显示图像，请更新浏览器后重试', error: unknown = null) {
    if (!imageActive.value || disposed) return
    playbackError.value = message
    void stop(true).catch(() => {})
    showError(error, message)
  }

  async function changeMode(value: unknown) {
    if (!['auto', 'h264', 'h265', 'images'].includes(value as string) || loading.value || disposed) return
    const resume = running.value || !!playbackError.value
    playbackMode.value = value as api.PlaybackMode
    if (resume) await start()
  }

  async function changeQuality(value: unknown) {
    if (!['low', 'balanced', 'high'].includes(value as string) || loading.value || disposed) return
    const next = value as api.StreamQuality
    if (next === streamQuality.value) return
    streamQuality.value = next
    if (active.value) await start()
  }

  function sendKey(keyName: string) {
    if (imageActive.value || !canTouch.value || blocked.value || disposed) return false
    return sendControl({ type: 'key', key: keyName })
  }

  function sendClipboard(text: string) {
    if (imageActive.value || !canTouch.value || blocked.value || disposed || !text) return false
    return sendControl({ type: 'clipboard', text, paste: true })
  }

  function toggleDisplayPower() {
    if (imageActive.value || !canTouch.value || blocked.value || disposed) return false
    const nextOff = !displayOff.value
    if (!sendControl({ type: 'displayPower', on: !nextOff })) return false
    displayOff.value = nextOff
    log(nextOff ? '已关闭设备实体屏幕（保持投屏）' : '已点亮设备实体屏幕')
    return true
  }

  function sendDeviceAction(action: 'expandNotifications' | 'rotateDevice') {
    if (imageActive.value || !canTouch.value || blocked.value || disposed) return false
    if (!sendControl({ type: 'action', action })) return false
    log(action === 'expandNotifications' ? '已展开通知栏' : '已切换屏幕旋转')
    return true
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

  function coordinates(event: { clientX: number; clientY: number }, clamp = false) {
    const rect = stage.value?.preview?.getBoundingClientRect()
    const media = imageActive.value
      ? imageSize
      : { width: stage.value?.video?.videoWidth || 0, height: stage.value?.video?.videoHeight || 0 }
    const device = imageActive.value ? (imageDeviceSize ?? imageSize) : media
    if (!rect) return null
    const point = mapPoint(event.clientX, event.clientY, rect, media, device, clamp)
    return point ? { point, size: media } : null
  }
  function down(event: PointerEvent) {
    const allowPointer = imageActive.value
      ? event.isPrimary && event.button === 0
      : event.pointerType === 'touch' || (event.isPrimary && event.button === 0)
    if (!allowPointer || !canTouch.value || blocked.value || swipingHome.value) return
    const mapped = coordinates(event)
    if (!mapped) return
    event.preventDefault()
    if (imageActive.value) {
      if (imageCommandPending) return
      imageGesture = { pointerId: event.pointerId, ...mapped.point, startedAt: Date.now() }
      stage.value?.preview?.setPointerCapture(event.pointerId)
      return
    }
    if (touch.begin(event.pointerId, mapped.point, mapped.size))
      stage.value?.preview?.setPointerCapture(event.pointerId)
  }
  function wheel(event: WheelEvent) {
    if (imageActive.value || !canTouch.value || blocked.value || swipingHome.value) return
    const mapped = coordinates(event)
    if (!mapped) return
    event.preventDefault()
    const normalize = (delta: number) => Math.max(-1, Math.min(1, -delta / 120))
    sendControl({
      type: 'scroll',
      x: mapped.point.x,
      y: mapped.point.y,
      screenWidth: mapped.size.width,
      screenHeight: mapped.size.height,
      horizontal: normalize(event.deltaX),
      vertical: normalize(event.deltaY),
    })
  }
  function move(event: PointerEvent) {
    if (imageActive.value) {
      if (!canTouch.value || blocked.value) cancel()
      return
    }
    if (!canTouch.value || blocked.value) {
      touch.cancel()
      return
    }
    const mapped = coordinates(event, true)
    if (mapped) touch.move(event.pointerId, mapped.point, mapped.size)
  }
  function up(event: PointerEvent) {
    if (imageActive.value) {
      const gesture = imageGesture
      imageGesture = undefined
      const mapped = coordinates(event, true)
      const preview = stage.value?.preview
      if (preview?.hasPointerCapture(event.pointerId)) preview.releasePointerCapture(event.pointerId)
      if (!gesture || gesture.pointerId !== event.pointerId || !mapped || !canTouch.value || blocked.value)
        return
      const duration = Math.max(100, Math.min(2000, Date.now() - gesture.startedAt))
      const isTap = Math.hypot(mapped.point.x - gesture.x, mapped.point.y - gesture.y) < 10 && duration < 400
      void imageCommand((selected) =>
        isTap
          ? api.tap(selected, mapped.point.x, mapped.point.y)
          : api.swipe(selected, gesture.x, gesture.y, mapped.point.x, mapped.point.y, duration),
      )
      return
    }
    move(event)
    touch.end(event.pointerId)
    const preview = stage.value?.preview
    if (preview?.hasPointerCapture(event.pointerId)) preview.releasePointerCapture(event.pointerId)
  }
  function playing() {
    if (!active.value || disposed) return
    clearTimeout(playbackTimer)
    state.value = '实时视频'
  }
  function cancel() {
    gestureVersion += 1
    swipingHome.value = false
    const preview = stage.value?.preview
    if (imageGesture && preview?.hasPointerCapture(imageGesture.pointerId))
      preview.releasePointerCapture(imageGesture.pointerId)
    imageGesture = undefined
    touch.cancel()
  }
  async function imageCommand(command: (selected: string) => Promise<unknown>) {
    if (imageCommandPending || disposed || !canTouch.value || blocked.value) return
    const version = generation
    const selected = serial.value
    imageCommandPending = true
    try {
      await command(selected)
      if (
        !disposed &&
        version === generation &&
        imageActive.value &&
        selected === serial.value &&
        !imageAbort &&
        !document.hidden
      ) {
        clearTimeout(imageTimer)
        imageTimer = setTimeout(() => void loadImage(version, selected), 200)
      }
    } catch (error) {
      if (version === generation && !disposed) showError(error, '设备操作失败')
    } finally {
      imageCommandPending = false
    }
  }
  async function swipeHome() {
    if (!canTouch.value || blocked.value || swipingHome.value || disposed) return
    if (imageActive.value) {
      const target = imageDeviceSize ?? imageSize
      const { width, height } =
        imageSize.width > imageSize.height !== target.width > target.height
          ? { width: target.height, height: target.width }
          : target
      await imageCommand((selected) =>
        api.swipe(
          selected,
          Math.floor(width / 2),
          height - 1,
          Math.floor(width / 2),
          Math.floor(height * 0.45),
        ),
      )
      return
    }
    const video = stage.value?.video
    if (!video?.videoWidth || !video.videoHeight) return
    cancel()
    const version = gestureVersion
    const size = { width: video.videoWidth, height: video.videoHeight }
    const x = Math.floor(size.width / 2)
    const startY = size.height - 1
    const endY = Math.floor(size.height * 0.45)
    const pointerId = 0
    if (!touch.begin(pointerId, { x, y: startY }, size)) return
    swipingHome.value = true
    try {
      for (let step = 1; step <= 12; step += 1) {
        await new Promise((resolve) => setTimeout(resolve, 16))
        if (version !== gestureVersion) return
        if (
          disposed ||
          !canTouch.value ||
          blocked.value ||
          video.videoWidth !== size.width ||
          video.videoHeight !== size.height
        )
          return
        touch.move(pointerId, { x, y: Math.round(startY + ((endY - startY) * step) / 12) }, size)
      }
      touch.end(pointerId)
      log('已发送上划进入桌面手势')
    } finally {
      if (version === gestureVersion) cancel()
    }
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
  const onVisibilityChange = () => {
    if (
      !document.hidden &&
      !disposed &&
      imageActive.value &&
      state.value === '兼容图像' &&
      !imageAbort &&
      serial.value
    ) {
      clearTimeout(imageTimer)
      const version = generation
      const selected = serial.value
      void loadImage(version, selected)
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
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
    displayOff,
    swipingHome,
    swipeHome,
    toggleDisplayPower,
    sendDeviceAction,
    start,
    stop,
    end,
    screenshot,
    down,
    move,
    up,
    wheel,
    cancel,
    playing,
    pageLeaving,
    playbackError,
    playbackMode,
    streamQuality,
    effectiveMode,
    modeLabel,
    running,
    imageActive,
    imageUrl,
    imageLoaded,
    imageFailed,
    changeMode,
    changeQuality,
    sendKey,
    sendClipboard,
  }
}
