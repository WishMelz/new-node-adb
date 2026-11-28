<script setup lang="ts">
import { ref, watch } from 'vue'
import { ArrowRightIcon, CloseIcon, HistoryIcon, LockOnIcon, SearchIcon } from 'tdesign-icons-vue-next'

const visible = defineModel<boolean>('visible', { required: true })
const host = defineModel<string>('host', { required: true })
const props = defineProps<{
  hostError: string
  connecting: boolean
  pairing?: boolean
  pairError?: string
  busy: boolean
  canDetect: boolean
  recordCount: number
}>()
const emit = defineEmits<{
  connect: []
  pair: [host: string, code: string]
  detect: []
  records: []
  'clear-pair-error': []
}>()

const tab = ref<'connect' | 'pair'>('connect')
const pairHost = ref('')
const pairCode = ref('')

watch(visible, (open) => {
  if (!open) {
    tab.value = 'connect'
    pairHost.value = ''
    pairCode.value = ''
    emit('clear-pair-error')
  }
})
watch([pairHost, pairCode], () => emit('clear-pair-error'))

function switchTab(next: 'connect' | 'pair') {
  if (props.connecting || props.pairing) return
  tab.value = next
}

function connect() {
  if (host.value.trim() && !props.connecting && !props.pairing && !props.busy) emit('connect')
}

function submitPair() {
  if (pairHost.value.trim() && pairCode.value.trim() && !props.connecting && !props.pairing && !props.busy)
    emit('pair', pairHost.value.trim(), pairCode.value.trim())
}

function switchToConnect(prefillHost?: string) {
  if (prefillHost) host.value = prefillHost
  pairHost.value = ''
  pairCode.value = ''
  tab.value = 'connect'
}
defineExpose({ switchToConnect })
</script>

<template>
  <t-dialog
    v-model:visible="visible"
    role="dialog"
    aria-modal="true"
    aria-label="添加设备"
    width="min(420px, calc(100vw - 32px))"
    destroy-on-close
    :footer="false"
    :close-btn="false"
    :close-on-esc-keydown="!connecting && !pairing"
    :close-on-overlay-click="false"
  >
    <template #header>
      <div class="drawer-header">
        <span>添加设备</span>
        <t-button
          shape="square"
          variant="text"
          aria-label="关闭添加设备"
          :disabled="connecting || pairing"
          @click="visible = false"
        >
          <template #icon><CloseIcon /></template>
        </t-button>
      </div>
    </template>
    <div class="dialog-tabs" role="tablist" aria-label="添加设备方式">
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'connect'"
        :class="{ active: tab === 'connect' }"
        :disabled="connecting || pairing"
        @click="switchTab('connect')"
      >
        直接连接
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'pair'"
        :class="{ active: tab === 'pair' }"
        :disabled="connecting || pairing"
        @click="switchTab('pair')"
      >
        无线配对
      </button>
    </div>
    <form v-if="tab === 'connect'" class="device-connect-form" @submit.prevent="connect">
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
    <form v-else class="device-connect-form" @submit.prevent="submitPair">
      <label class="host-field">
        <span class="field-label">配对地址（IP:配对端口）</span>
        <t-input
          v-model="pairHost"
          placeholder="192.168.1.10:37123"
          :disabled="pairing || busy"
          :status="pairError ? 'error' : undefined"
        />
      </label>
      <label class="host-field pair-code-field">
        <span class="field-label">6 位配对码</span>
        <t-input
          v-model="pairCode"
          placeholder="例如 123456"
          :maxlength="6"
          :disabled="pairing || busy"
          :status="pairError ? 'error' : undefined"
        />
      </label>
      <p class="host-feedback" :class="{ invalid: pairError }" :role="pairError ? 'alert' : 'status'">
        {{
          pairError ||
          (pairing ? '正在无线配对…' : '在手机「无线调试 → 使用配对码配对设备」中查看配对端口与配对码')
        }}
      </p>
      <t-button
        block
        type="submit"
        class="pair-submit-btn"
        :disabled="!pairHost.trim() || !/^\d{6}$/.test(pairCode.trim()) || busy"
        :loading="pairing"
        ><template #icon><LockOnIcon /></template>配对设备</t-button
      >
    </form>
  </t-dialog>
</template>
