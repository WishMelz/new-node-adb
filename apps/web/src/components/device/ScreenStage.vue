<script setup lang="ts">
import { ref } from 'vue'
import { AddIcon, DesktopIcon, HistoryIcon, PlayCircleIcon, RefreshIcon } from 'tdesign-icons-vue-next'

defineProps<{
  activeStream: boolean
  canTouch: boolean
  isReady: boolean
  selectedModel?: string
  selectedSerial: string
  loadingStream: boolean
  loadingDevice: boolean
  deviceRecordsCount: number
  streamState: string
}>()
const emit = defineEmits<{
  pointerdown: [event: PointerEvent]
  pointermove: [event: PointerEvent]
  pointerup: [event: PointerEvent]
  pointercancel: []
  add: []
  start: []
  refresh: []
  records: []
  playing: []
  resize: []
}>()
const preview = ref<HTMLElement | null>(null)
const video = ref<HTMLVideoElement | null>(null)
defineExpose({ preview, video })
</script>

<template>
  <div
    ref="preview"
    class="screen-stage"
    :class="{ interactive: canTouch }"
    aria-label="手机实时画面"
    @pointerdown="emit('pointerdown', $event)"
    @pointermove="emit('pointermove', $event)"
    @pointerup="emit('pointerup', $event)"
    @pointercancel="emit('pointercancel')"
    @lostpointercapture="emit('pointercancel')"
    @contextmenu.prevent
  >
    <video
      v-if="activeStream"
      ref="video"
      autoplay
      muted
      playsinline
      disablepictureinpicture
      @playing="emit('playing')"
      @resize="emit('resize')"
    />
    <div v-else class="screen-empty">
      <DesktopIcon /><strong>{{ isReady ? selectedModel : '暂无在线设备' }}</strong>
      <span v-if="selectedSerial" class="mono">{{ selectedSerial }}</span>
      <template v-if="isReady">
        <span class="screen-empty-hint">启动后可直接点击、滑动操作手机</span>
        <t-button theme="primary" :loading="loadingStream" @click="emit('start')"
          ><template #icon><PlayCircleIcon /></template>开始控制</t-button
        >
      </template>
      <template v-else-if="selectedSerial">
        <span class="screen-empty-hint">当前设备暂不可控制，请检查设备状态</span>
        <t-button variant="outline" :loading="loadingDevice" @click="emit('refresh')"
          ><template #icon><RefreshIcon /></template>刷新设备</t-button
        >
      </template>
      <div v-else class="empty-connect">
        <t-button theme="primary" @click="emit('add')"
          ><template #icon><AddIcon /></template>添加设备</t-button
        >
        <t-button v-if="deviceRecordsCount" variant="outline" @click="emit('records')"
          ><template #icon><HistoryIcon /></template>已保存设备 ({{ deviceRecordsCount }})</t-button
        >
      </div>
    </div>
    <div v-if="activeStream && !canTouch" class="playback-status" role="status">
      <t-loading size="small" />{{ streamState === '实时视频' ? '等待控制通道' : streamState }}
    </div>
  </div>
</template>
