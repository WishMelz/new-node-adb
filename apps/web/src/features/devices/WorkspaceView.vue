<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next/es/message'
import * as api from '../../api'
import ActivityDrawer from '../../components/layout/ActivityDrawer.vue'
import DeviceRecordsDrawer from '../../components/device/DeviceRecordsDrawer.vue'
import DeviceToolbar from '../../components/device/DeviceToolbar.vue'
import DeviceConnectDialog from '../../components/device/DeviceConnectDialog.vue'
import DeviceActionsPanel from '../../components/device/DeviceActionsPanel.vue'
import ScreenFooter from '../../components/device/ScreenFooter.vue'
import ScreenStage from '../../components/device/ScreenStage.vue'
import { useDeviceRecords } from './useDeviceRecords'
import { useDevices } from './useDevices'
import { useStream } from '../stream/useStream'
import { useActivity } from '../../composables/useActivity'
import { useWorkspace } from '../../composables/useWorkspace'

const props = defineProps<{ securityOpen?: boolean }>()
const activity = reactive(useActivity())
const connectOpen = ref(false)
const connectDialog = ref<InstanceType<typeof DeviceConnectDialog> | null>(null)
const pairing = ref(false)
const pairError = ref('')
const recordsOpen = ref(false)
const logsOpen = ref(false)
const packageName = ref('')
const installedApps = ref<string[]>([])
const loadingApps = ref(false)
const input = ref('')
const usingRecord = ref('')
const interactionBlocked = computed(
  () => props.securityOpen || connectOpen.value || recordsOpen.value || logsOpen.value,
)
const deviceState = useDevices(activity.log, activity.showError)
const devices = reactive(deviceState)
const streamState = useStream(
  deviceState.selectedSerial,
  deviceState.ready,
  interactionBlocked,
  activity.log,
  activity.showError,
)
const { stage } = streamState
const stream = reactive(streamState)
const records = reactive(useDeviceRecords(deviceState.devices, activity.log, activity.showError))
const selectedNote = computed(() =>
  records.records.find((record) => record.serial === devices.selectedSerial)?.note.trim(),
)
const deviceOptions = computed(() => {
  const notes = new Map(records.records.map((record) => [record.serial, record.note.trim()]))
  return devices.options.map((option) => ({
    ...option,
    label: notes.get(option.value) ? `${notes.get(option.value)} · ${option.value}` : option.label,
  }))
})
const layoutState = useWorkspace(stream.cancel, stream.pageLeaving)
const { workspace } = layoutState
const layout = reactive(layoutState)
let disposed = false
let refreshTimer: ReturnType<typeof setInterval> | undefined

const connectionLabel = computed(() => {
  if (devices.switching || devices.loading) return '检查设备'
  if (stream.running)
    return stream.canTouch ? stream.modeLabel : stream.state === '实时视频' ? '等待控制' : '连接中'
  if (devices.ready) return '设备已连接'
  return devices.selected ? `设备状态：${devices.selected.state}` : '请连接设备'
})

async function refreshDevices(force = false) {
  if (disposed || (!force && devices.loading) || devices.switching) return
  await devices.refresh(selectDevice, force)
  if (!disposed) await records.refresh()
}

async function initialize() {
  try {
    const previous = await api.listStreams()
    if (disposed) return
    await Promise.all(previous.map((item) => api.stopStream(item.id)))
    if (!disposed) await refreshDevices()
  } catch (error) {
    if (!disposed) activity.showError(error, '工作台初始化失败')
  }
}

async function selectDevice(value: unknown) {
  const serial = typeof value === 'string' ? value : ''
  if (disposed || serial === devices.selectedSerial || devices.switching) return
  devices.switching = true
  const resume = stream.running
  try {
    await stream.stop()
    if (disposed) return
    devices.selectedSerial = serial
    installedApps.value = []
    if (serial) activity.log(`当前设备：${serial}`)
  } catch (error) {
    if (!disposed) activity.showError(error, '切换设备失败')
  } finally {
    devices.switching = false
  }
  if (!disposed && resume && devices.ready) await stream.start()
}

async function connect() {
  const connected = await devices.connect(() => refreshDevices(true), selectDevice)
  if (connected && !disposed) {
    recordsOpen.value = false
    connectOpen.value = false
  }
  return connected
}

async function disconnect() {
  if (!devices.canCommand || devices.selected?.transport !== 'network') return
  const serial = devices.selectedSerial
  devices.commandPending = true
  try {
    await stream.stop()
    if (disposed) return
    await api.disconnectDevice(serial)
    if (!disposed) {
      activity.log(`已断开 ${serial}`)
      await refreshDevices(true)
    }
  } catch (error) {
    if (!disposed) activity.showError(error, '断开失败')
  } finally {
    devices.commandPending = false
  }
}

async function useRecord(record: api.DeviceRecord) {
  if (devices.commandPending || devices.switching || stream.loading || usingRecord.value) return
  usingRecord.value = record.serial
  records.error = ''
  try {
    if (devices.devices.some((device) => device.serial === record.serial && device.state === 'device')) {
      await selectDevice(record.serial)
      if (!disposed) recordsOpen.value = false
    } else if (record.transport === 'network') {
      devices.host = record.serial
      await nextTick()
      if (!disposed && !(await connect())) records.error = devices.hostError
    }
  } finally {
    usingRecord.value = ''
  }
}

async function pairDevice(rawHost: string, code: string) {
  if (devices.commandPending || devices.connecting || pairing.value || devices.switching || disposed) return
  let address: string
  try {
    address = api.normalizeDeviceHost(rawHost)
  } catch (error) {
    pairError.value = error instanceof Error ? error.message : '配对地址无效'
    return
  }
  pairError.value = ''
  pairing.value = true
  devices.commandPending = true
  try {
    await api.pairDevice(address, code)
    if (disposed) return
    activity.log(`无线配对成功：${address}`)
    void MessagePlugin.success({ content: '无线配对成功，请填写调试端口完成连接', duration: 4000 })
    const hostPart = address.slice(0, address.lastIndexOf(':'))
    connectDialog.value?.switchToConnect(`${hostPart}:`)
  } catch (error) {
    if (!disposed) {
      pairError.value = api.pairErrorMessage(error)
      activity.log(`无线配对失败（${address}）：${pairError.value}`, 'error')
    }
  } finally {
    pairing.value = false
    devices.commandPending = false
  }
}

function actionKey(key: string, label: string) {
  if (stream.sendKey(key)) {
    activity.log(label)
    return true
  }
  return devices.run((serial) => api.key(serial, key), label)
}
function launchApp() {
  const name = packageName.value.trim()
  if (name) return devices.run((serial) => api.openApp(serial, name), '应用已启动')
}
async function loadInstalledApps() {
  if (!devices.canCommand || loadingApps.value || disposed) return
  const serial = devices.selectedSerial
  loadingApps.value = true
  try {
    const list = await api.listDeviceApps(serial)
    if (!disposed && serial === devices.selectedSerial) {
      installedApps.value = list
      activity.log(`已读取 ${list.length} 个第三方应用`)
    }
  } catch (error) {
    if (!disposed && serial === devices.selectedSerial) activity.showError(error, '读取应用列表失败')
  } finally {
    loadingApps.value = false
  }
}
async function sendText() {
  const text = input.value
  if (!text.trim()) return
  if (stream.sendClipboard(text)) {
    activity.log('文本已粘贴发送')
    if (input.value === text) input.value = ''
    return
  }
  if ((await devices.run((serial) => api.inputText(serial, text), '文本已发送')) && input.value === text)
    input.value = ''
}
function blurActiveElement() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

watch(connectOpen, (open) => {
  if (!open) {
    devices.hostError = ''
    devices.host = ''
  }
})

async function openConnect() {
  blurActiveElement()
  stream.cancel()
  await layout.leaveFullscreen()
  if (!disposed) {
    devices.hostError = ''
    connectOpen.value = true
  }
}
async function openRecords() {
  blurActiveElement()
  await layout.leaveFullscreen()
  if (disposed) return
  const fromConnect = connectOpen.value
  connectOpen.value = false
  if (fromConnect) {
    await new Promise((resolve) => setTimeout(resolve, 260))
    if (disposed) return
  }
  recordsOpen.value = true
  await records.refresh()
}
async function openLogs() {
  blurActiveElement()
  stream.cancel()
  await layout.leaveFullscreen()
  if (disposed) return
  logsOpen.value = true
}

onMounted(() => {
  void initialize()
  refreshTimer = setInterval(() => {
    if (!document.hidden && !devices.commandPending && !stream.loading) void refreshDevices()
  }, 15_000)
})
onBeforeUnmount(() => {
  disposed = true
  clearInterval(refreshTimer)
})
</script>

<template>
  <main ref="workspace" class="workspace" :class="{ expanded: layout.expanded }">
    <DeviceToolbar
      :selected-serial="devices.selectedSerial"
      :device-options="deviceOptions"
      :switching="devices.switching || devices.commandPending || devices.connecting"
      :loading-stream="stream.loading"
      :loading-device="devices.loading"
      :active-stream="stream.running"
      :loading-screen="stream.loadingScreen"
      :fullscreen="layout.fullscreen"
      :expanded="layout.expanded"
      :is-ready="devices.ready"
      :can-touch="stream.canTouch"
      :connection-label="connectionLabel"
      :playback-mode="stream.playbackMode"
      :stream-quality="stream.streamQuality"
      :tooltips-disabled="interactionBlocked"
      @playback-mode="stream.changeMode"
      @stream-quality="stream.changeQuality"
      @select="selectDevice"
      @refresh="refreshDevices"
      @records="openRecords"
      @start="stream.start"
      @stop="stream.end"
      @screenshot="stream.screenshot"
      @fullscreen="layout.toggle"
      @add="openConnect"
      @logs="openLogs"
    />
    <div class="workspace-content">
      <div class="screen-column">
        <ScreenStage
          ref="stage"
          :active-stream="!!stream.active"
          :can-touch="stream.canTouch"
          :is-ready="devices.ready"
          :selected-model="devices.selected?.model"
          :selected-note="selectedNote"
          :selected-serial="devices.selectedSerial"
          :loading-stream="stream.loading"
          :loading-device="devices.loading"
          :device-records-count="records.records.length"
          :stream-state="stream.state"
          :playback-error="stream.playbackError"
          :image-active="stream.imageActive"
          :image-url="stream.imageUrl"
          @image-loaded="stream.imageLoaded"
          @image-error="stream.imageFailed()"
          @pointerdown="stream.down"
          @pointermove="stream.move"
          @pointerup="stream.up"
          @pointercancel="stream.cancel"
          @wheel="stream.wheel"
          @add="openConnect"
          @start="stream.start"
          @refresh="refreshDevices"
          @records="openRecords"
          @playing="stream.playing"
          @resize="stream.cancel"
          @retry="stream.start"
        />
        <ScreenFooter
          :caption="devices.caption"
          :can-command="devices.canCommand"
          :can-touch="stream.canTouch"
          :active-stream="stream.running"
          @action="actionKey"
        />
      </div>
      <DeviceActionsPanel
        v-model:input="input"
        v-model:package-name="packageName"
        :selected-serial="devices.selectedSerial"
        :selected-model="devices.selected?.model"
        :selected-note="selectedNote"
        :can-command="devices.canCommand"
        :can-swipe-home="stream.canTouch && !stream.swipingHome && !interactionBlocked"
        :can-disconnect="devices.selected?.transport === 'network' && devices.canCommand"
        :can-send-utf8="stream.canTouch && !stream.imageActive"
        :display-off="stream.displayOff"
        :installed-apps="installedApps"
        :loading-apps="loadingApps"
        @swipe-home="stream.swipeHome"
        @toggle-display-power="stream.toggleDisplayPower"
        @device-action="stream.sendDeviceAction"
        @load-apps="loadInstalledApps"
        @disconnect="disconnect"
        @action="actionKey"
        @send="sendText"
        @launch="launchApp"
      />
    </div>
    <DeviceConnectDialog
      ref="connectDialog"
      v-model:visible="connectOpen"
      v-model:host="devices.host"
      :host-error="devices.hostError"
      :connecting="devices.connecting"
      :pairing="pairing"
      :pair-error="pairError"
      :busy="devices.commandPending || devices.switching || stream.loading"
      :can-detect="devices.ready"
      :record-count="records.records.length"
      @connect="connect"
      @pair="pairDevice"
      @clear-pair-error="pairError = ''"
      @detect="devices.detectHost"
      @records="openRecords"
    />
    <DeviceRecordsDrawer
      v-model:visible="recordsOpen"
      v-model:pending-delete="records.pendingDelete"
      :records="records.savedDevices"
      :loading="records.loading"
      :error="records.error"
      :deleting="records.deleting"
      :saving="records.saving"
      :using="usingRecord"
      :busy="devices.commandPending || devices.switching || stream.loading"
      @refresh="records.refresh"
      @select="useRecord"
      @remove="records.remove"
      @update-note="records.updateNote"
    />
    <ActivityDrawer v-model:visible="logsOpen" :items="activity.items" @clear="activity.clear" />
  </main>
</template>
