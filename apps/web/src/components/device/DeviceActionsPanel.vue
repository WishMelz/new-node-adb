<script setup lang="ts">
import {
  EnterIcon,
  LockOnIcon,
  LogoutIcon,
  MinusIcon,
  PlayCircleIcon,
  PlusIcon,
} from 'tdesign-icons-vue-next'

const input = defineModel<string>('input', { required: true })
const packageName = defineModel<string>('packageName', { required: true })
const props = defineProps<{
  selectedSerial: string
  selectedModel?: string
  canCommand: boolean
  canDisconnect: boolean
}>()
const emit = defineEmits<{
  disconnect: []
  action: [key: string, label: string]
  send: []
  launch: []
}>()
const keys = [
  { key: 'wake', label: '唤醒', icon: PlayCircleIcon },
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
</script>

<template>
  <aside class="device-controls" aria-label="当前设备操作">
    <header class="device-controls-header">
      <div>
        <h2>当前设备</h2>
        <strong>{{ selectedModel || selectedSerial || '未选择设备' }}</strong>
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
            placeholder="英文、数字及常用符号"
            :maxlength="200"
            :disabled="!canCommand"
        /></label>
        <t-tooltip content="发送文本"
          ><t-button
            shape="square"
            type="submit"
            variant="outline"
            aria-label="发送文本"
            :disabled="!canCommand || !input.trim()"
            ><template #icon><EnterIcon /></template></t-button
        ></t-tooltip>
      </form>
    </section>
    <section class="device-control-section">
      <h2>应用</h2>
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
            ><template #icon><PlayCircleIcon /></template></t-button
        ></t-tooltip>
      </form>
    </section>
  </aside>
</template>
