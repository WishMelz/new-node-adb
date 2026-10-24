<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
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

const activity = reactive(useActivity())
const connectOpen = ref(false)
const recordsOpen = ref(false)
const logsOpen = ref(false)
const packageName = ref('')
const input = ref('')
const usingRecord = ref('')
const interactionBlocked = computed(() => connectOpen.value || recordsOpen.value || logsOpen.value)
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
const layoutState = useWorkspace(stream.cancel, stream.pageLeaving)
const { workspace } = layoutState
const layout = reactive(layoutState)
let disposed = false
let refreshTimer: ReturnType<typeof setInterval> | undefined

const connectionLabel = computed(() => {
  if (devices.switching || devices.loading) return '检查设备'
  if (stream.active) return stream.canTouch ? '可操作' : stream.state === '实时视频' ? '等待控制' : '连接中'
  if (devices.ready) return '设备已连接'
  return devices.selected ? `设备状态：${devices.selected.state}` : '请连接设备'
})

async function refreshDevices() {
  if (disposed || devices.loading || devices.switching) return
  await devices.refresh(selectDevice)
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
  const resume = !!stream.active
  try {
    await stream.stop()
    if (disposed) return
    devices.selectedSerial = serial
    if (serial) activity.log(`当前设备：${serial}`)
  } catch (error) {
    if (!disposed) activity.showError(error, '切换设备失败')
  } finally {
    devices.switching = false
  }
  if (!disposed && resume && devices.ready) await stream.start()
}

async function connect() {
  const connected = await devices.connect(refreshDevices, selectDevice)
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
      await refreshDevices()
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

function actionKey(key: string, label: string) {
  return devices.run((serial) => api.key(serial, key), label)
}
function launchApp() {
  const name = packageName.value.trim()
  if (name) return devices.run((serial) => api.openApp(serial, name), '应用已启动')
}
async function sendText() {
  const text = input.value
  if (
    text.trim() &&
    (await devices.run((serial) => api.inputText(serial, text), '文本已发送')) &&
    input.value === text
  )
    input.value = ''
}
async function openConnect() {
  stream.cancel()
  await layout.leaveFullscreen()
  if (!disposed) connectOpen.value = true
}
async function openRecords() {
  await layout.leaveFullscreen()
  if (disposed) return
  connectOpen.value = false
  recordsOpen.value = true
  await records.refresh()
}
async function openLogs() {
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
      :device-options="devices.options"
      :switching="devices.switching || devices.commandPending || devices.connecting"
      :loading-stream="stream.loading"
      :loading-device="devices.loading"
      :active-stream="!!stream.active"
      :loading-screen="stream.loadingScreen"
      :fullscreen="layout.fullscreen"
      :expanded="layout.expanded"
      :is-ready="devices.ready"
      :can-touch="stream.canTouch"
      :connection-label="connectionLabel"
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
          :selected-serial="devices.selectedSerial"
          :loading-stream="stream.loading"
          :loading-device="devices.loading"
          :device-records-count="records.records.length"
          :stream-state="stream.state"
          @pointerdown="stream.down"
          @pointermove="stream.move"
          @pointerup="stream.up"
          @pointercancel="stream.cancel"
          @add="openConnect"
          @start="stream.start"
          @refresh="refreshDevices"
          @records="openRecords"
          @playing="stream.playing"
          @resize="stream.cancel"
        />
        <ScreenFooter
          :caption="devices.caption"
          :can-command="devices.canCommand"
          :can-touch="stream.canTouch"
          :active-stream="!!stream.active"
          @action="actionKey"
        />
      </div>
      <DeviceActionsPanel
        v-model:input="input"
        v-model:package-name="packageName"
        :selected-serial="devices.selectedSerial"
        :selected-model="devices.selected?.model"
        :can-command="devices.canCommand"
        :can-disconnect="devices.selected?.transport === 'network' && devices.canCommand"
        @disconnect="disconnect"
        @action="actionKey"
        @send="sendText"
        @launch="launchApp"
      />
    </div>
    <DeviceConnectDialog
      v-model:visible="connectOpen"
      v-model:host="devices.host"
      :host-error="devices.hostError"
      :connecting="devices.connecting"
      :busy="devices.commandPending || devices.switching || stream.loading"
      :can-detect="devices.ready"
      :record-count="records.records.length"
      @connect="connect"
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
    <ActivityDrawer v-model:visible="logsOpen" :items="activity.items" />
  </main>
</template>
