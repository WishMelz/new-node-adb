<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isAxiosError } from 'axios'
import { MessagePlugin } from 'tdesign-vue-next'
import { ArrowLeftIcon, ArrowRightIcon, DeleteIcon, DesktopIcon, DownloadIcon, EnterIcon, Fullscreen1Icon, FullscreenExit1Icon, HistoryIcon, HomeIcon, LockOnIcon, LogoutIcon, MoreIcon, PlayCircleIcon, RefreshIcon, SearchIcon, SoundIcon, StopCircleIcon, ViewModuleIcon } from 'tdesign-icons-vue-next'
import JMuxer from 'jmuxer'
import * as api from './api'
import { mapPoint, ScreenTouch } from './screen'

const authed = ref(false)
const checkingSession = ref(true)
const password = ref('')
const busy = ref(false)
const devices = ref<api.Device[]>([])
const deviceRecords = ref<api.DeviceRecord[]>([])
const recordsOpen = ref(false)
const loadingRecords = ref(false)
const recordsError = ref('')
const deletingRecord = ref('')
const usingRecord = ref('')
const recordToDelete = ref<api.DeviceRecord | null>(null)
const selectedSerial = ref('')
const host = ref('')
const hostError = ref('')
const connecting = ref(false)
const packageName = ref('')
const input = ref('')
const activeStream = ref<api.StreamSummary | null>(null)
const video = ref<HTMLVideoElement | null>(null)
const preview = ref<HTMLElement | null>(null)
const workspace = ref<HTMLElement | null>(null)
const toolsOpen = ref(false)
const fullscreen = ref(false)
const expanded = ref(false)
const controlReady = ref(false)
const loadingDevice = ref(false)
const loadingScreen = ref(false)
const loadingStream = ref(false)
const switching = ref(false)
const commandPending = ref(false)
const streamState = ref('未启动')
const errorMessage = ref('')
const logsOpen = ref(false)
const logItems = ref<{ id: number; time: string; message: string }[]>([])
let logId = 0
let generation = 0
let recordsVersion = 0
let refreshTimer = 0
let playbackTimer = 0
let socket: WebSocket | null = null
let muxer: JMuxer | null = null
const touch = new ScreenTouch(message => {
  if (!socket || socket.readyState !== WebSocket.OPEN || !controlReady.value) return false
  if (socket.bufferedAmount > 64 * 1024) {
    controlReady.value = false
    void endStream()
    showError(null, '控制连接拥塞，已停止控制')
    return false
  }
  socket.send(JSON.stringify(message))
  return true
})

const selectedDevice = computed(() => devices.value.find(item => item.serial === selectedSerial.value))
const isReady = computed(() => authed.value && !switching.value && selectedDevice.value?.state === 'device')
const canCommand = computed(() => isReady.value && !commandPending.value)
const canTouch = computed(() => isReady.value && controlReady.value && streamState.value === '实时视频')
const connectionLabel = computed(() => {
  if (switching.value || loadingDevice.value) return '检查设备'
  if (activeStream.value) return canTouch.value ? '可操作' : streamState.value === '实时视频' ? '等待控制' : '连接中'
  if (isReady.value) return '设备已连接'
  if (selectedDevice.value) return `设备状态：${selectedDevice.value.state}`
  return devices.value.length ? '请选择设备' : '请连接设备'
})
const deviceCaption = computed(() => {
  if (!selectedDevice.value) return '未连接设备'
  return `${selectedDevice.value.transport === 'network' ? '网络 ADB' : 'USB'} · ${selectedDevice.value.model || selectedDevice.value.serial}`
})
const deviceOptions = computed(() => devices.value.map(device => ({ label: `${device.model || '未知设备'} · ${device.serial}`, value: device.serial, disabled: device.state !== 'device' })))
const savedDevices = computed(() => deviceRecords.value.map(record => {
  const online = devices.value.some(device => device.serial === record.serial && device.state === 'device')
  let reconnectable = false
  if (record.transport === 'network') {
    try { api.normalizeDeviceHost(record.serial); reconnectable = true } catch {}
  }
  return { ...record, online, reconnectable }
}))
const quickKeys = [
  { key: 'back', label: '返回', icon: ArrowLeftIcon }, { key: 'home', label: '主页', icon: HomeIcon },
  { key: 'recent', label: '最近任务', icon: ViewModuleIcon }, { key: 'wake', label: '唤醒', icon: PlayCircleIcon },
  { key: 'sleep', label: '锁屏', icon: LockOnIcon }, { key: 'enter', label: '确认', icon: EnterIcon },
  { key: 'volumeUp', label: '音量 +', icon: SoundIcon }, { key: 'volumeDown', label: '音量 -', icon: SoundIcon },
]

watch(host, () => { hostError.value = '' })

function log(message: string) {
  logItems.value.unshift({ id: ++logId, time: new Date().toLocaleTimeString(), message })
  logItems.value = logItems.value.slice(0, 80)
}

function showError(error: unknown, fallback: string) {
  const detail: unknown = isAxiosError(error) ? error.response?.data?.message : error instanceof Error ? error.message : null
  const message = Array.isArray(detail) ? detail.join('；') : typeof detail === 'string' ? detail : fallback
  errorMessage.value = message
  log(message)
  void MessagePlugin.error(message)
}

function stopStreamLocal() {
  touch.cancel()
  controlReady.value = false
  window.clearTimeout(playbackTimer)
  if (socket) { socket.onclose = null; socket.onmessage = null; socket.onerror = null; socket.close(); socket = null }
  muxer?.destroy()
  muxer = null
  activeStream.value = null
  streamState.value = '未启动'
}

async function stopStream() {
  generation += 1
  const id = activeStream.value?.id
  stopStreamLocal()
  if (id) await api.stopStream(id)
}

function expireSession() {
  generation += 1
  stopStreamLocal()
  expanded.value = false
  toolsOpen.value = false
  logsOpen.value = false
  recordsOpen.value = false
  recordToDelete.value = null
  recordsVersion += 1
  deviceRecords.value = []
  recordsError.value = ''
  loadingRecords.value = false
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  authed.value = false
  devices.value = []
  selectedSerial.value = ''
}

async function refreshDevices() {
  if (loadingDevice.value || !authed.value) return
  loadingDevice.value = true
  try {
    const result = await api.listDevices()
    if (!authed.value) return
    devices.value = result
    if (!result.some(device => device.serial === selectedSerial.value && device.state === 'device')) {
      await selectDevice(result.find(device => device.state === 'device')?.serial || '')
    }
  } catch (error) { showError(error, '设备列表读取失败') }
  finally { await refreshRecords(); loadingDevice.value = false }
}

async function refreshRecords() {
  if (!authed.value) return
  const version = ++recordsVersion
  loadingRecords.value = true
  try {
    const records = await api.listDeviceRecords()
    if (version !== recordsVersion || !authed.value) return
    deviceRecords.value = records
    recordsError.value = ''
  } catch {
    if (version === recordsVersion && authed.value) recordsError.value = '设备记录读取失败，请重试'
  } finally { if (version === recordsVersion) loadingRecords.value = false }
}

async function useRecord(record: api.DeviceRecord) {
  if (commandPending.value || switching.value || usingRecord.value) return
  usingRecord.value = record.serial
  recordsError.value = ''
  try {
    if (devices.value.some(device => device.serial === record.serial && device.state === 'device')) {
      await selectDevice(record.serial)
      recordsOpen.value = false
    } else if (record.transport === 'network') {
      host.value = record.serial
      await nextTick()
      if (await connect()) recordsOpen.value = false
      else if (authed.value) recordsError.value = hostError.value
    }
  } finally { usingRecord.value = '' }
}

async function removeRecord() {
  const record = recordToDelete.value
  if (!record || deletingRecord.value) return
  deletingRecord.value = record.serial
  recordsError.value = ''
  try {
    await api.deleteDeviceRecord(record.serial)
    deviceRecords.value = deviceRecords.value.filter(item => item.serial !== record.serial)
    recordToDelete.value = null
    await refreshRecords()
    log(`已删除设备记录：${record.serial}`)
  } catch { recordsError.value = '设备记录删除失败，请重试'; recordToDelete.value = null }
  finally { deletingRecord.value = '' }
}

async function loadSession() {
  try {
    await api.session()
    authed.value = true
    const previous = await api.listStreams()
    await Promise.all(previous.map(stream => api.stopStream(stream.id)))
    await refreshDevices()
  } catch (error) { if (!isAxiosError(error) || error.response?.status !== 401) showError(error, '会话读取失败') }
  finally { checkingSession.value = false }
}

async function submitLogin() {
  if (!password.value || busy.value) return
  busy.value = true
  try { await api.login(password.value); password.value = ''; authed.value = true; errorMessage.value = ''; log('登录成功'); await refreshDevices() }
  catch (error) { showError(error, '登录失败') } finally { busy.value = false }
}

async function signOut() {
  try { await api.logout(); expireSession(); logItems.value = []; errorMessage.value = '' }
  catch (error) { showError(error, '退出失败') }
}

async function selectDevice(value: unknown) {
  const serial = typeof value === 'string' ? value : ''
  if (serial === selectedSerial.value || switching.value) return
  switching.value = true
  const resume = !!activeStream.value
  try { await stopStream(); selectedSerial.value = serial; if (serial) log(`当前设备：${serial}`) }
  catch (error) { showError(error, '切换设备失败') } finally { switching.value = false }
  if (resume && isReady.value) await startStream()
}

async function connect() {
  if (commandPending.value || connecting.value) return false
  let address: string
  try { address = api.normalizeDeviceHost(host.value) }
  catch (error) { hostError.value = error instanceof Error ? error.message : '设备地址无效'; return false }
  host.value = address
  hostError.value = ''
  errorMessage.value = ''
  connecting.value = true
  commandPending.value = true
  try {
    await api.connectDevice(address)
    if (!authed.value) return false
    log(`已连接 ${address}`)
    await refreshDevices()
    if (devices.value.some(device => device.serial === address && device.state === 'device')) await selectDevice(address)
    return true
  }
  catch (error) {
    hostError.value = api.connectionErrorMessage(error)
    const detail: unknown = isAxiosError(error) ? error.response?.data?.message : error instanceof Error ? error.message : null
    log(`连接 ${address} 失败：${Array.isArray(detail) ? detail.join('；') : typeof detail === 'string' ? detail : hostError.value}`)
    return false
  } finally { connecting.value = false; commandPending.value = false }
}

async function disconnect() {
  const serial = selectedSerial.value
  try { await stopStream(); await api.disconnectDevice(serial); log(`已断开 ${serial}`); await refreshDevices() }
  catch (error) { showError(error, '断开失败') }
}

async function detectHost() {
  if (!isReady.value) return
  const version = generation
  try { const result = await api.getHost(selectedSerial.value); if (version === generation) host.value = result.host }
  catch (error) { showError(error, '地址读取失败') }
}

async function takeScreenshot() {
  if (!isReady.value || loadingScreen.value) return
  const serial = selectedSerial.value
  const version = generation
  loadingScreen.value = true
  try {
    const blob = await api.screenshot(serial)
    if (version !== generation || serial !== selectedSerial.value || !authed.value) return
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${serial.replace(/[^A-Za-z0-9_.-]/g, '_')}-${Date.now()}.webp`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    log('截图已下载')
  } catch (error) { showError(error, '截图失败') } finally { loadingScreen.value = false }
}

async function startStream() {
  if (!isReady.value || loadingStream.value) return
  if (!('MediaSource' in window) || !MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')) return showError(null, '浏览器不支持 H.264 MediaSource 播放')
  loadingStream.value = true
  let version = generation
  try {
    await stopStream()
    version = generation
    const serial = selectedSerial.value
    const stream = await api.startStream(serial)
    if (version !== generation || serial !== selectedSerial.value || !authed.value) { await api.stopStream(stream.id); return }
    errorMessage.value = ''
    activeStream.value = stream
    streamState.value = '等待画面'
    await nextTick()
    if (version !== generation || !video.value) return
    const failPlayback = () => {
      if (version !== generation) return
      void stopStream().catch(() => {})
      showError(null, '连接中断，请重新开始控制')
    }
    muxer = new JMuxer({ node: video.value, mode: 'video', fps: 30, flushingTime: 0, maxDelay: 200, clearBuffer: true, onError: failPlayback })
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(`${protocol}//${location.host}/ws/streams/${stream.id}`)
    socket.binaryType = 'arraybuffer'
    socket.onmessage = event => {
      if (version !== generation) return
      try {
        if (typeof event.data === 'string') {
          const status = JSON.parse(event.data)
          if (status.type === 'control') controlReady.value = status.ready === true
        } else if (event.data instanceof ArrayBuffer) muxer?.feed({ video: new Uint8Array(event.data) })
      } catch { failPlayback() }
    }
    socket.onclose = failPlayback
    socket.onerror = failPlayback
    playbackTimer = window.setTimeout(failPlayback, 20_000)
    log(`开始控制：${serial}`)
  } catch (error) { if (version === generation) { await stopStream().catch(() => {}); showError(error, '投屏启动失败') } }
  finally { loadingStream.value = false }
}

function playing() { window.clearTimeout(playbackTimer); streamState.value = '实时视频' }
async function endStream() { try { await stopStream(); log('控制已停止') } catch (error) { showError(error, '停止失败') } }

function coordinates(event: PointerEvent, clamp = false) {
  const rect = preview.value?.getBoundingClientRect()
  const media = { width: video.value?.videoWidth || 0, height: video.value?.videoHeight || 0 }
  if (!rect) return null
  const point = mapPoint(event.clientX, event.clientY, rect, media, media, clamp)
  return point ? { point, size: media } : null
}

function beginGesture(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0 || !canTouch.value || toolsOpen.value || logsOpen.value) return
  const mapped = coordinates(event)
  if (!mapped) return
  event.preventDefault()
  if (touch.begin(event.pointerId, mapped.point, mapped.size)) preview.value?.setPointerCapture(event.pointerId)
}

function moveGesture(event: PointerEvent) {
  if (!canTouch.value) { touch.cancel(); return }
  const mapped = coordinates(event, true)
  if (mapped) touch.move(event.pointerId, mapped.point, mapped.size)
}

function endGesture(event: PointerEvent) {
  moveGesture(event)
  touch.end(event.pointerId)
  if (preview.value?.hasPointerCapture(event.pointerId)) preview.value.releasePointerCapture(event.pointerId)
}

function cancelGesture() { touch.cancel() }
function visibilityChanged() { if (document.hidden) cancelGesture() }
function fullscreenChanged() { fullscreen.value = document.fullscreenElement === workspace.value }
function escapeFullscreen(event: KeyboardEvent) { if (event.key === 'Escape') expanded.value = false }

async function toggleFullscreen() {
  cancelGesture()
  try {
    if (expanded.value) expanded.value = false
    else if (document.fullscreenElement) await document.exitFullscreen()
    else if (workspace.value?.requestFullscreen && document.fullscreenEnabled) await workspace.value.requestFullscreen()
    else expanded.value = true
  } catch { expanded.value = !expanded.value }
}

async function openTools() {
  cancelGesture()
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
  expanded.value = false
  toolsOpen.value = true
}

async function openRecords() {
  cancelGesture()
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
  expanded.value = false
  toolsOpen.value = false
  recordsOpen.value = true
  await refreshRecords()
}

async function runCommand(action: () => Promise<unknown>, message: string) {
  if (!canCommand.value) return
  commandPending.value = true
  try { await action(); log(message) } catch (error) { showError(error, '操作失败') } finally { commandPending.value = false }
}

function actionKey(keyName: string, label: string) {
  const serial = selectedSerial.value
  return runCommand(() => api.key(serial, keyName), label)
}

function launchApp() {
  const serial = selectedSerial.value
  const name = packageName.value.trim()
  return runCommand(() => api.openApp(serial, name), '应用已启动')
}

async function sendText() {
  if (!input.value.trim()) return
  const text = input.value
  await runCommand(async () => { await api.inputText(selectedSerial.value, text); if (input.value === text) input.value = '' }, '文本已发送')
}

function pageLeaving() {
  cancelGesture()
  if (activeStream.value) void fetch(`/api/streams/${activeStream.value.id}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true })
}

onMounted(() => {
  window.addEventListener('auth-expired', expireSession)
  window.addEventListener('pagehide', pageLeaving)
  window.addEventListener('blur', cancelGesture)
  window.addEventListener('keydown', escapeFullscreen)
  document.addEventListener('visibilitychange', visibilityChanged)
  document.addEventListener('fullscreenchange', fullscreenChanged)
  void loadSession()
  refreshTimer = window.setInterval(() => { if (authed.value && !document.hidden) void refreshDevices() }, 15_000)
})
onBeforeUnmount(() => {
  pageLeaving()
  generation += 1
  window.clearInterval(refreshTimer)
  window.removeEventListener('auth-expired', expireSession)
  window.removeEventListener('pagehide', pageLeaving)
  window.removeEventListener('blur', cancelGesture)
  window.removeEventListener('keydown', escapeFullscreen)
  document.removeEventListener('visibilitychange', visibilityChanged)
  document.removeEventListener('fullscreenchange', fullscreenChanged)
  stopStreamLocal()
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-lockup"><DesktopIcon /><strong>手机远程控制</strong><span>ADB Control Room</span></div>
      <div v-if="authed" class="topbar-actions">
        <t-tooltip content="退出登录"><t-button shape="square" variant="text" aria-label="退出登录" @click="signOut"><LogoutIcon /></t-button></t-tooltip>
      </div>
    </header>
    <main v-if="checkingSession" class="login-view"><t-loading text="正在检查会话" /></main>
    <main v-else-if="!authed" class="login-view">
      <section class="login-panel">
        <div class="login-symbol"><LockOnIcon /></div><h1>登录手机控制台</h1>
        <t-form @submit="submitLogin">
          <label for="password">访问密码</label>
          <t-input id="password" v-model="password" type="password" autocomplete="current-password" size="large" aria-label="访问密码" />
          <t-button theme="primary" type="submit" size="large" block :loading="busy" :disabled="!password">登录 <EnterIcon /></t-button>
        </t-form>
        <p v-if="errorMessage" role="alert" class="login-error">{{ errorMessage }}</p>
      </section>
    </main>
    <main v-else ref="workspace" class="workspace" :class="{ expanded }">
      <div class="control-toolbar">
        <div class="device-picker">
          <t-select :value="selectedSerial" :options="deviceOptions" :disabled="switching || loadingStream" aria-label="当前设备" placeholder="选择设备" @change="selectDevice" />
          <t-tooltip content="刷新设备"><t-button shape="square" variant="text" aria-label="刷新设备" :loading="loadingDevice" @click="refreshDevices"><template #icon><RefreshIcon /></template></t-button></t-tooltip>
          <t-tooltip content="已保存设备"><t-button shape="square" variant="text" aria-label="已保存设备" @click="openRecords"><template #icon><HistoryIcon /></template></t-button></t-tooltip>
        </div>
        <span class="connection-status" role="status" :class="{ connected: isReady, live: canTouch }"><i />{{ connectionLabel }}</span>
        <div class="control-actions">
          <t-button v-if="!activeStream" theme="primary" :disabled="!isReady" :loading="loadingStream" @click="startStream"><PlayCircleIcon />开始控制</t-button>
          <t-button v-else theme="danger" variant="outline" @click="endStream"><StopCircleIcon />停止</t-button>
          <t-tooltip v-if="activeStream" content="下载截图"><t-button shape="square" variant="text" aria-label="下载截图" :loading="loadingScreen" :disabled="!isReady" @click="takeScreenshot"><template #icon><DownloadIcon /></template></t-button></t-tooltip>
          <t-tooltip :content="fullscreen || expanded ? '退出全屏' : '全屏'"><t-button shape="square" variant="text" :aria-label="fullscreen || expanded ? '退出全屏' : '全屏'" @click="toggleFullscreen"><FullscreenExit1Icon v-if="fullscreen || expanded" /><Fullscreen1Icon v-else /></t-button></t-tooltip>
          <t-tooltip content="更多"><t-button shape="square" variant="text" aria-label="更多" @click="openTools"><MoreIcon /></t-button></t-tooltip>
        </div>
      </div>
      <t-alert v-if="errorMessage" theme="warning" :message="errorMessage" :close-btn="true" @close="errorMessage = ''" />
      <div ref="preview" class="screen-stage" :class="{ interactive: canTouch }" aria-label="手机实时画面" @pointerdown="beginGesture" @pointermove="moveGesture" @pointerup="endGesture" @pointercancel="cancelGesture" @lostpointercapture="cancelGesture" @contextmenu.prevent>
        <video v-if="activeStream" ref="video" autoplay muted playsinline disablepictureinpicture @playing="playing" @resize="cancelGesture" />
        <div v-else class="screen-empty">
          <DesktopIcon /><strong>{{ isReady ? selectedDevice?.model : '暂无在线设备' }}</strong>
          <span v-if="selectedSerial" class="mono">{{ selectedSerial }}</span>
          <template v-if="isReady">
            <span class="screen-empty-hint">启动后可直接点击、滑动操作手机</span>
            <t-button theme="primary" :loading="loadingStream" @click="startStream"><PlayCircleIcon />开始控制</t-button>
          </template>
          <template v-else-if="selectedSerial">
            <span class="screen-empty-hint">当前设备暂不可控制，请检查设备状态</span>
            <t-button variant="outline" :loading="loadingDevice" @click="refreshDevices"><RefreshIcon />刷新设备</t-button>
          </template>
          <div v-else class="empty-connect">
            <span class="screen-empty-hint">USB 设备会自动出现，也可使用网络 ADB</span>
            <div class="empty-connect-row">
              <label class="host-field"><span class="visually-hidden">网络设备地址</span><t-input v-model="host" placeholder="192.168.1.10:5555" :disabled="connecting" :status="hostError ? 'error' : undefined" @enter="connect" /></label>
              <t-tooltip :content="connecting ? '正在连接' : '连接设备'"><t-button shape="square" theme="primary" :aria-label="connecting ? '正在连接' : '连接设备'" :disabled="!host.trim() || commandPending" :loading="connecting" @click="connect"><template #icon><ArrowRightIcon /></template></t-button></t-tooltip>
            </div>
            <p id="empty-host-feedback" class="host-feedback" :class="{ invalid: hostError }" :role="hostError ? 'alert' : 'status'">{{ hostError || (connecting ? '正在连接设备…' : '默认端口 5555') }}</p>
            <t-button v-if="deviceRecords.length" variant="outline" @click="openRecords"><template #icon><HistoryIcon /></template>已保存设备 ({{ deviceRecords.length }})</t-button>
          </div>
        </div>
        <div v-if="activeStream && !canTouch" class="playback-status" role="status"><t-loading size="small" />{{ streamState === '实时视频' ? '等待控制通道' : streamState }}</div>
      </div>
      <footer class="screen-footer">
        <span class="device-caption">{{ deviceCaption }}</span>
        <nav class="navigation-keys" aria-label="手机导航"><t-tooltip v-for="item in quickKeys.slice(0, 3)" :key="item.key" :content="item.label"><t-button shape="square" variant="text" :aria-label="item.label" :disabled="!canCommand" @click="actionKey(item.key, item.label)"><component :is="item.icon" /></t-button></t-tooltip></nav>
        <span class="live-label" :class="{ active: canTouch }">{{ canTouch ? '可操作' : activeStream ? '连接中' : '待命' }}</span>
      </footer>
      <t-drawer :visible="toolsOpen" header="更多" :footer="false" size="min(380px, 100vw)" @update:visible="toolsOpen = $event">
        <section class="tool-section"><h2>设备连接</h2><p class="mono">{{ selectedSerial || '未选择设备' }}</p>
          <div class="host-label">网络地址</div><div class="connect-row"><label class="host-field"><span class="visually-hidden">网络地址</span><t-input v-model="host" placeholder="192.168.1.10:5555" :disabled="connecting" :status="hostError ? 'error' : undefined" @enter="connect" /></label><t-tooltip :content="connecting ? '正在连接' : '连接设备'"><t-button shape="square" :aria-label="connecting ? '正在连接' : '连接设备'" :disabled="!host.trim() || commandPending" :loading="connecting" @click="connect"><template #icon><ArrowRightIcon /></template></t-button></t-tooltip></div>
          <p id="drawer-host-feedback" class="host-feedback" :class="{ invalid: hostError }" :role="hostError ? 'alert' : 'status'">{{ hostError || (connecting ? '正在连接设备…' : '默认端口 5555') }}</p>
          <div class="device-actions"><t-button variant="text" :disabled="!isReady" @click="detectHost"><SearchIcon />识别地址</t-button><t-button theme="danger" variant="text" :disabled="selectedDevice?.transport !== 'network' || switching" @click="disconnect">断开</t-button></div>
        </section>
        <t-button block variant="text" @click="openRecords"><template #icon><HistoryIcon /></template>已保存设备 ({{ deviceRecords.length }})</t-button>
        <section class="tool-section"><h2>设备操作</h2><div class="utility-keys"><t-tooltip v-for="item in quickKeys.slice(3)" :key="item.key" :content="item.label"><t-button shape="square" variant="outline" :aria-label="item.label" :disabled="!canCommand" @click="actionKey(item.key, item.label)"><component :is="item.icon" /></t-button></t-tooltip></div><t-button block variant="outline" :disabled="!isReady" :loading="loadingScreen" @click="takeScreenshot"><DownloadIcon />下载截图</t-button></section>
        <section class="tool-section"><h2>文本输入</h2><t-input v-model="input" placeholder="英文、数字及常用符号" aria-label="输入文本" :maxlength="200" @enter="sendText" /><t-button block variant="outline" :disabled="!canCommand || !input.trim()" @click="sendText"><EnterIcon />发送</t-button></section>
        <section class="tool-section"><h2>应用</h2><label for="package">包名</label><t-input id="package" v-model="packageName" placeholder="com.example.app" aria-label="应用包名" /><t-button block variant="outline" :disabled="!canCommand || !packageName.trim()" @click="launchApp"><PlayCircleIcon />启动应用</t-button></section>
        <t-button block variant="text" @click="toolsOpen = false; logsOpen = true"><ViewModuleIcon />操作日志</t-button>
      </t-drawer>
      <t-drawer :visible="recordsOpen" header="已保存设备" :footer="false" size="min(440px, 100vw)" @update:visible="recordsOpen = $event">
        <div class="records-toolbar"><span>{{ deviceRecords.length }} 台设备</span><t-tooltip content="刷新记录"><t-button shape="square" variant="text" aria-label="刷新记录" :loading="loadingRecords" @click="refreshRecords"><template #icon><RefreshIcon /></template></t-button></t-tooltip></div>
        <p v-if="recordsError" class="records-error" role="alert">{{ recordsError }}</p>
        <p v-if="!deviceRecords.length" class="records-empty" role="status">{{ loadingRecords ? '正在读取设备记录…' : recordsError ? '设备记录暂不可用' : '暂无设备记录' }}</p>
        <ul v-else class="device-records">
          <li v-for="record in savedDevices" :key="record.serial" class="device-record">
            <DesktopIcon class="record-icon" />
            <div class="record-details"><strong>{{ record.model || record.serial }}</strong><span class="mono">{{ record.serial }}</span><div class="record-meta"><span>{{ record.transport === 'usb' ? 'USB' : '网络 ADB' }}</span><span :class="{ online: record.online }">{{ record.online ? '在线' : '离线' }}</span></div><time :datetime="new Date(record.lastConnectedAt).toISOString()">最近连接 {{ new Date(record.lastConnectedAt).toLocaleString('zh-CN', { hour12: false }) }}</time></div>
            <div class="record-actions">
              <t-tooltip :content="record.online ? '选择设备' : record.reconnectable ? '重新连接' : '请重新接入设备'"><t-button shape="square" variant="outline" :aria-label="`${record.online ? '选择' : '重连'} ${record.serial}`" :loading="usingRecord === record.serial" :disabled="(!record.online && !record.reconnectable) || commandPending || switching || loadingStream || !!usingRecord || !!deletingRecord" @click="useRecord(record)"><template #icon><ArrowRightIcon /></template></t-button></t-tooltip>
              <t-tooltip content="删除记录"><t-button shape="square" theme="danger" variant="text" :aria-label="`删除记录 ${record.serial}`" :disabled="!!deletingRecord || !!usingRecord" @click="recordToDelete = record"><template #icon><DeleteIcon /></template></t-button></t-tooltip>
            </div>
          </li>
        </ul>
      </t-drawer>
      <t-dialog :visible="!!recordToDelete" header="删除设备记录" confirm-btn="删除记录" :confirm-loading="!!deletingRecord" :close-on-overlay-click="false" @confirm="removeRecord" @close="!deletingRecord && (recordToDelete = null)"><p class="mono">{{ recordToDelete?.model }} · {{ recordToDelete?.serial }}</p><p>删除记录不会断开设备。</p></t-dialog>
      <t-drawer :visible="logsOpen" header="操作日志" :footer="false" size="min(520px, 100vw)" @update:visible="logsOpen = $event"><div class="activity"><p v-for="item in logItems" :key="item.id"><time>{{ item.time }}</time><span>{{ item.message }}</span></p></div></t-drawer>
    </main>
  </div>
</template>