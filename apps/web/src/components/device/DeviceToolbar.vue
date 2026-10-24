<script setup lang="ts">
import {
  DownloadIcon,
  Fullscreen1Icon,
  FullscreenExit1Icon,
  HistoryIcon,
  AddIcon,
  PlayCircleIcon,
  RefreshIcon,
  StopCircleIcon,
  ViewModuleIcon,
} from 'tdesign-icons-vue-next'

interface DeviceOption {
  label: string
  value: string
  disabled?: boolean
}
defineProps<{
  selectedSerial: string
  deviceOptions: DeviceOption[]
  switching: boolean
  loadingStream: boolean
  loadingDevice: boolean
  activeStream: boolean
  loadingScreen: boolean
  fullscreen: boolean
  expanded: boolean
  isReady: boolean
  canTouch: boolean
  connectionLabel: string
}>()
defineEmits<{
  select: [value: unknown]
  refresh: []
  records: []
  start: []
  stop: []
  screenshot: []
  fullscreen: []
  add: []
  logs: []
}>()
</script>

<template>
  <div class="control-toolbar">
    <div class="device-picker">
      <t-select
        :value="selectedSerial"
        :options="deviceOptions"
        :disabled="switching || loadingStream"
        aria-label="当前设备"
        placeholder="选择设备"
        @change="$emit('select', $event)"
      />
      <t-tooltip content="添加设备"
        ><t-button
          shape="square"
          variant="outline"
          aria-label="添加设备"
          :disabled="switching || loadingStream"
          @click="$emit('add')"
          ><template #icon><AddIcon /></template></t-button
      ></t-tooltip>
      <t-tooltip content="刷新设备"
        ><t-button
          shape="square"
          variant="text"
          aria-label="刷新设备"
          :loading="loadingDevice"
          @click="$emit('refresh')"
          ><template #icon><RefreshIcon /></template></t-button
      ></t-tooltip>
      <t-tooltip content="已保存设备"
        ><t-button shape="square" variant="text" aria-label="已保存设备" @click="$emit('records')"
          ><template #icon><HistoryIcon /></template></t-button
      ></t-tooltip>
    </div>
    <span class="connection-status" role="status" :class="{ connected: isReady, live: canTouch }"
      ><i />{{ connectionLabel }}</span
    >
    <div class="control-actions">
      <t-button
        v-if="!activeStream"
        theme="primary"
        :disabled="!isReady"
        :loading="loadingStream"
        @click="$emit('start')"
        ><PlayCircleIcon />开始控制</t-button
      >
      <t-button v-else theme="danger" variant="outline" @click="$emit('stop')"
        ><StopCircleIcon />停止</t-button
      >
      <t-tooltip content="下载截图"
        ><t-button
          shape="square"
          variant="text"
          aria-label="下载截图"
          :loading="loadingScreen"
          :disabled="!isReady"
          @click="$emit('screenshot')"
          ><template #icon><DownloadIcon /></template></t-button
      ></t-tooltip>
      <t-tooltip :content="fullscreen || expanded ? '退出全屏' : '全屏'"
        ><t-button
          shape="square"
          variant="text"
          :aria-label="fullscreen || expanded ? '退出全屏' : '全屏'"
          @click="$emit('fullscreen')"
          ><FullscreenExit1Icon v-if="fullscreen || expanded" /><Fullscreen1Icon v-else /></t-button
      ></t-tooltip>
      <t-tooltip content="操作日志"
        ><t-button shape="square" variant="text" aria-label="操作日志" @click="$emit('logs')"
          ><template #icon><ViewModuleIcon /></template></t-button
      ></t-tooltip>
    </div>
  </div>
</template>
