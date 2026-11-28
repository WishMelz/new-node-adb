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
  SystemLogIcon,
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
  playbackMode: string
  streamQuality?: string
  tooltipsDisabled?: boolean
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
  playbackMode: [value: unknown]
  streamQuality: [value: unknown]
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
      <t-tooltip content="添加设备" :z-index="1200" destroy-on-close :disabled="tooltipsDisabled"
        ><t-button
          shape="square"
          variant="outline"
          aria-label="添加设备"
          :disabled="switching || loadingStream"
          @click="$emit('add')"
          ><template #icon><AddIcon /></template></t-button
      ></t-tooltip>
      <t-tooltip content="刷新设备" :z-index="1200" destroy-on-close :disabled="tooltipsDisabled"
        ><t-button
          shape="square"
          variant="text"
          aria-label="刷新设备"
          :loading="loadingDevice"
          @click="$emit('refresh')"
          ><template #icon><RefreshIcon /></template></t-button
      ></t-tooltip>
      <t-tooltip content="已保存设备" :z-index="1200" destroy-on-close :disabled="tooltipsDisabled"
        ><t-button shape="square" variant="text" aria-label="已保存设备" @click="$emit('records')"
          ><template #icon><HistoryIcon /></template></t-button
      ></t-tooltip>
    </div>
    <span class="connection-status" role="status" :class="{ connected: isReady, live: canTouch }"
      ><i />{{ connectionLabel }}</span
    >
    <label class="playback-picker">
      <span class="visually-hidden">播放模式</span>
      <t-select
        :value="playbackMode"
        :options="[
          { label: '自动', value: 'auto' },
          { label: 'H.264', value: 'h264' },
          { label: 'H.265', value: 'h265' },
          { label: '兼容图像', value: 'images' },
        ]"
        :disabled="switching || loadingStream"
        aria-label="播放模式"
        @change="$emit('playbackMode', $event)"
      />
    </label>
    <label v-if="playbackMode !== 'images'" class="quality-picker">
      <span class="visually-hidden">视频画质</span>
      <t-select
        :value="streamQuality ?? 'balanced'"
        :options="[
          { label: '省流', value: 'low' },
          { label: '均衡', value: 'balanced' },
          { label: '高清', value: 'high' },
        ]"
        :disabled="switching || loadingStream"
        aria-label="视频画质"
        @change="$emit('streamQuality', $event)"
      />
    </label>
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
      <t-tooltip content="下载截图" :z-index="1200" destroy-on-close :disabled="tooltipsDisabled"
        ><t-button
          shape="square"
          variant="text"
          aria-label="下载截图"
          :loading="loadingScreen"
          :disabled="!isReady"
          @click="$emit('screenshot')"
          ><template #icon><DownloadIcon /></template></t-button
      ></t-tooltip>
      <t-tooltip
        :content="fullscreen || expanded ? '退出全屏' : '全屏'"
        :z-index="1200"
        destroy-on-close
        :disabled="tooltipsDisabled"
        ><t-button
          shape="square"
          variant="text"
          :aria-label="fullscreen || expanded ? '退出全屏' : '全屏'"
          @click="$emit('fullscreen')"
          ><FullscreenExit1Icon v-if="fullscreen || expanded" /><Fullscreen1Icon v-else /></t-button
      ></t-tooltip>
      <t-tooltip content="操作日志" :z-index="1200" destroy-on-close :disabled="tooltipsDisabled"
        ><t-button shape="square" variant="text" aria-label="操作日志" @click="$emit('logs')"
          ><template #icon><SystemLogIcon /></template></t-button
      ></t-tooltip>
    </div>
  </div>
</template>
