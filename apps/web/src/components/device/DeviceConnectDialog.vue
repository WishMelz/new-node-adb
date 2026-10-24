<script setup lang="ts">
import { ArrowRightIcon, HistoryIcon, SearchIcon } from 'tdesign-icons-vue-next'

const visible = defineModel<boolean>('visible', { required: true })
const host = defineModel<string>('host', { required: true })
const props = defineProps<{
  hostError: string
  connecting: boolean
  busy: boolean
  canDetect: boolean
  recordCount: number
}>()
const emit = defineEmits<{ connect: []; detect: []; records: [] }>()

function connect() {
  if (host.value.trim() && !props.connecting && !props.busy) emit('connect')
}
</script>

<template>
  <t-dialog
    v-model:visible="visible"
    header="添加设备"
    role="dialog"
    aria-modal="true"
    aria-label="添加设备"
    width="min(420px, calc(100vw - 32px))"
    :footer="false"
    :close-btn="!connecting"
    :close-on-esc-keydown="!connecting"
    :close-on-overlay-click="false"
  >
    <form class="device-connect-form" @submit.prevent="connect">
      <label class="host-field">
        <span class="field-label">网络地址</span>
        <t-input
          v-model="host"
          placeholder="192.168.1.10:5555"
          :disabled="connecting || busy"
          :status="hostError ? 'error' : undefined"
        />
      </label>
      <p class="host-feedback" :class="{ invalid: hostError }" :role="hostError ? 'alert' : 'status'">
        {{ hostError || (connecting ? '正在连接设备…' : '默认端口 5555') }}
      </p>
      <div class="connection-shortcuts">
        <t-button variant="text" :disabled="!canDetect || connecting || busy" @click="emit('detect')"
          ><template #icon><SearchIcon /></template>识别当前设备地址</t-button
        >
        <t-button variant="text" :disabled="connecting || busy" @click="emit('records')"
          ><template #icon><HistoryIcon /></template>已保存设备 ({{ recordCount }})</t-button
        >
      </div>
      <t-button block type="submit" :disabled="!host.trim() || busy" :loading="connecting"
        ><template #icon><ArrowRightIcon /></template>连接设备</t-button
      >
    </form>
  </t-dialog>
</template>
