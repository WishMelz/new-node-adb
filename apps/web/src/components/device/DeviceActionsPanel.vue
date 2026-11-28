<script setup lang="ts">
import { computed } from 'vue'
import {
  AppIcon,
  EnterIcon,
  ArrowUpIcon,
  LockOnIcon,
  LogoutIcon,
  MinusIcon,
  MoonIcon,
  NotificationIcon,
  PlusIcon,
  RocketIcon,
  RotateIcon,
  SendIcon,
  SunnyIcon,
} from 'tdesign-icons-vue-next'

const input = defineModel<string>('input', { required: true })
const packageName = defineModel<string>('packageName', { required: true })
const props = defineProps<{
  selectedSerial: string
  selectedModel?: string
  selectedNote?: string
  canCommand: boolean
  canSwipeHome?: boolean
  canDisconnect: boolean
  canSendUtf8?: boolean
  displayOff?: boolean
  installedApps?: string[]
  loadingApps?: boolean
}>()
const emit = defineEmits<{
  disconnect: []
  swipeHome: []
  toggleDisplayPower: []
  deviceAction: [action: 'expandNotifications' | 'rotateDevice']
  loadApps: []
  action: [key: string, label: string]
  send: []
  launch: []
}>()
const appOptions = computed(() => (props.installedApps ?? []).map((name) => ({ label: name, value: name })))
const keys = [
  { key: 'wake', label: '唤醒', icon: SunnyIcon },
  { key: 'sleep', label: '锁屏', icon: LockOnIcon },
  { key: 'enter', label: '确认', icon: EnterIcon },
]
function action(key: string, label: string) {
  if (props.canCommand) emit('action', key, label)
}
function send() {
  if (props.canCommand && input.value.trim()) emit('send')
}
function launch() {
  if (props.canCommand && packageName.value.trim()) emit('launch')
}
function pickApp(value: unknown) {
  if (typeof value === 'string') packageName.value = value
}
</script>

<template>
  <aside class="device-controls" aria-label="当前设备操作">
    <header class="device-controls-header">
      <div>
        <h2>当前设备</h2>
        <strong>{{ selectedNote || selectedModel || selectedSerial || '未选择设备' }}</strong>
        <p v-if="selectedNote && selectedModel">{{ selectedModel }}</p>
        <p v-if="selectedSerial" class="mono">{{ selectedSerial }}</p>
      </div>
      <t-tooltip content="断开设备"
        ><t-button
          shape="square"
          variant="text"
          theme="danger"
          aria-label="断开设备"
          :disabled="!canDisconnect"
          @click="canDisconnect && emit('disconnect')"
          ><template #icon><LogoutIcon /></template></t-button
      ></t-tooltip>
    </header>
    <section class="device-control-section" aria-label="设备按键">
      <h2>设备操作</h2>
      <div class="device-key-row">
        <t-tooltip content="上划进入桌面（需开始控制）"
          ><t-button
            shape="square"
            variant="outline"
            aria-label="上划进入桌面"
            :disabled="!canCommand || !canSwipeHome"
            @click="canCommand && canSwipeHome && emit('swipeHome')"
            ><template #icon><ArrowUpIcon /></template></t-button
        ></t-tooltip>
        <t-tooltip v-for="item in keys" :key="item.key" :content="item.label"
          ><t-button
            shape="square"
            variant="outline"
            :aria-label="item.label"
            :disabled="!canCommand"
            @click="action(item.key, item.label)"
            ><template #icon><component :is="item.icon" /></template></t-button
        ></t-tooltip>
      </div>
      <div class="device-stream-row" role="group" aria-label="投屏快捷">
        <t-tooltip :content="displayOff ? '点亮设备实体屏幕' : '息屏投屏（关闭手机实体屏幕，需视频控制）'"
          ><t-button
            variant="outline"
            :theme="displayOff ? 'primary' : 'default'"
            :aria-label="displayOff ? '点亮设备屏幕' : '息屏投屏'"
            :disabled="!canCommand || !canSendUtf8"
            @click="canCommand && canSendUtf8 && emit('toggleDisplayPower')"
            ><template #icon><MoonIcon /></template><span>{{ displayOff ? '亮屏' : '息屏' }}</span></t-button
          ></t-tooltip
        >
        <t-tooltip content="展开通知栏（需视频控制）"
          ><t-button
            variant="outline"
            aria-label="展开通知栏"
            :disabled="!canCommand || !canSendUtf8"
            @click="canCommand && canSendUtf8 && emit('deviceAction', 'expandNotifications')"
            ><template #icon><NotificationIcon /></template><span>通知栏</span></t-button
          ></t-tooltip
        >
        <t-tooltip content="旋转屏幕（需视频控制）"
          ><t-button
            variant="outline"
            aria-label="旋转屏幕"
            :disabled="!canCommand || !canSendUtf8"
            @click="canCommand && canSendUtf8 && emit('deviceAction', 'rotateDevice')"
            ><template #icon><RotateIcon /></template><span>旋转</span></t-button
          ></t-tooltip
        >
      </div>
      <div class="device-volume-row" role="group" aria-label="音量">
        <span>音量</span>
        <t-tooltip content="音量 -"
          ><t-button
            shape="square"
            variant="outline"
            aria-label="音量 -"
            :disabled="!canCommand"
            @click="action('volumeDown', '音量 -')"
            ><template #icon><MinusIcon /></template></t-button
        ></t-tooltip>
        <t-tooltip content="音量 +"
          ><t-button
            shape="square"
            variant="outline"
            aria-label="音量 +"
            :disabled="!canCommand"
            @click="action('volumeUp', '音量 +')"
            ><template #icon><PlusIcon /></template></t-button
        ></t-tooltip>
      </div>
    </section>
    <section class="device-control-section">
      <h2>文本输入</h2>
      <form class="device-input-row" @submit.prevent="send">
        <label class="host-field"
          ><span class="visually-hidden">输入文本</span
          ><t-input
            v-model="input"
            :placeholder="canSendUtf8 ? '支持中文、英文及符号（粘贴发送）' : '英文、数字及常用符号'"
            :maxlength="canSendUtf8 ? 2000 : 200"
            :disabled="!canCommand"
        /></label>
        <t-tooltip content="发送文本"
          ><t-button
            shape="square"
            type="submit"
            variant="outline"
            aria-label="发送文本"
            :disabled="!canCommand || !input.trim()"
            ><template #icon><SendIcon /></template></t-button
        ></t-tooltip>
      </form>
    </section>
    <section class="device-control-section">
      <div class="section-heading-row">
        <h2>应用</h2>
        <t-tooltip content="读取手机已装第三方应用列表"
          ><t-button
            size="small"
            variant="text"
            aria-label="读取已装应用"
            :loading="loadingApps"
            :disabled="!canCommand"
            @click="canCommand && emit('loadApps')"
            ><template #icon><AppIcon /></template>已装应用</t-button
          ></t-tooltip
        >
      </div>
      <form class="device-input-row" @submit.prevent="launch">
        <label class="host-field"
          ><span class="visually-hidden">应用包名</span
          ><t-input v-model="packageName" placeholder="com.example.app" :disabled="!canCommand"
        /></label>
        <t-tooltip content="启动应用"
          ><t-button
            shape="square"
            type="submit"
            variant="outline"
            aria-label="启动应用"
            :disabled="!canCommand || !packageName.trim()"
            ><template #icon><RocketIcon /></template></t-button
        ></t-tooltip>
      </form>
      <div v-if="appOptions.length" class="device-app-picker">
        <t-select
          :value="packageName"
          :options="appOptions"
          filterable
          clearable
          size="small"
          placeholder="搜索并选择已装应用"
          aria-label="选择已装应用"
          :disabled="!canCommand"
          @change="pickApp"
        />
      </div>
    </section>
  </aside>
</template>
