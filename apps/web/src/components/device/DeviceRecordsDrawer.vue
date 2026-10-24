<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  ArrowRightIcon,
  CheckIcon,
  DeleteIcon,
  DesktopIcon,
  EditIcon,
  RefreshIcon,
  CloseIcon,
} from 'tdesign-icons-vue-next'
import type { DeviceRecord } from '../../api'

const visible = defineModel<boolean>('visible', { required: true })
const pendingDelete = defineModel<DeviceRecord | null>('pendingDelete', { required: true })
const props = defineProps<{
  records: (DeviceRecord & { online: boolean; reconnectable: boolean })[]
  loading: boolean
  error: string
  deleting: string
  saving: string
  using: string
  busy: boolean
}>()
const emit = defineEmits<{
  refresh: []
  select: [record: DeviceRecord]
  remove: []
  'update-note': [serial: string, note: string]
}>()
const editing = ref('')
const draft = ref('')

watch(
  () => props.saving,
  (saving, previous) => {
    if (!saving && previous === editing.value && !props.error) cancelEditing()
  },
)
watch(visible, (open) => {
  if (!open) cancelEditing()
})

function startEditing(record: DeviceRecord) {
  if (props.saving || props.deleting || props.using || props.busy) return
  editing.value = record.serial
  draft.value = record.note
}

function cancelEditing() {
  editing.value = ''
  draft.value = ''
}

function saveNote(record: DeviceRecord) {
  if (props.saving || props.deleting || props.using || props.busy) return
  if (draft.value.trim() === record.note) {
    cancelEditing()
    return
  }
  emit('update-note', record.serial, draft.value)
}
</script>

<template>
  <t-drawer v-model:visible="visible" header="已保存设备" :footer="false" size="min(440px, 100vw)">
    <div class="records-toolbar">
      <span>{{ records.length }} 台设备</span
      ><t-tooltip content="刷新记录"
        ><t-button
          shape="square"
          variant="text"
          aria-label="刷新记录"
          :loading="loading"
          :disabled="!!deleting || !!saving"
          @click="$emit('refresh')"
          ><template #icon><RefreshIcon /></template></t-button
      ></t-tooltip>
    </div>
    <p v-if="error && !editing" class="records-error" role="alert">{{ error }}</p>
    <p v-if="!records.length" class="records-empty" role="status">
      {{ loading ? '正在读取设备记录…' : error ? '设备记录暂不可用' : '暂无设备记录' }}
    </p>
    <ul v-else class="device-records">
      <li v-for="record in records" :key="record.serial" class="device-record">
        <DesktopIcon class="record-icon" />
        <div class="record-details">
          <strong>{{ record.note || record.model || record.serial }}</strong>
          <span v-if="record.note" class="record-model">{{ record.model }}</span>
          <span class="mono">{{ record.serial }}</span>
          <div class="record-meta">
            <span>{{ record.transport === 'usb' ? 'USB' : '网络 ADB' }}</span
            ><span :class="{ online: record.online }">{{ record.online ? '在线' : '离线' }}</span>
          </div>
          <time :datetime="new Date(record.lastConnectedAt).toISOString()"
            >最近连接 {{ new Date(record.lastConnectedAt).toLocaleString('zh-CN', { hour12: false }) }}</time
          >
        </div>
        <div class="record-actions">
          <t-tooltip
            :content="record.online ? '选择设备' : record.reconnectable ? '重新连接' : '请重新接入设备'"
            ><t-button
              shape="square"
              variant="outline"
              :aria-label="`${record.online ? '选择' : '重连'} ${record.serial}`"
              :loading="using === record.serial"
              :disabled="
                (!record.online && !record.reconnectable) || busy || !!using || !!deleting || !!saving
              "
              @click="$emit('select', record)"
              ><template #icon><ArrowRightIcon /></template></t-button
          ></t-tooltip>
          <t-tooltip content="编辑备注"
            ><t-button
              shape="square"
              variant="text"
              :aria-label="`编辑备注 ${record.serial}`"
              :disabled="busy || !!using || !!deleting || !!saving"
              @click="startEditing(record)"
              ><template #icon><EditIcon /></template></t-button
          ></t-tooltip>
          <t-tooltip content="删除记录"
            ><t-button
              shape="square"
              theme="danger"
              variant="text"
              :aria-label="`删除记录 ${record.serial}`"
              :disabled="!!deleting || !!using || !!saving"
              @click="pendingDelete = record"
              ><template #icon><DeleteIcon /></template></t-button
          ></t-tooltip>
        </div>
        <form v-if="editing === record.serial" class="record-note-form" @submit.prevent="saveNote(record)">
          <label class="host-field">
            <span class="visually-hidden">设备备注</span>
            <t-input
              v-model="draft"
              autofocus
              placeholder="例如：客厅手机"
              :maxlength="120"
              :disabled="!!saving"
              @keydown.esc.stop="!saving && cancelEditing()"
            />
          </label>
          <t-tooltip content="保存备注"
            ><t-button
              type="submit"
              shape="square"
              aria-label="保存备注"
              :loading="saving === record.serial"
              :disabled="busy || !!using || !!deleting || !!saving"
              ><template #icon><CheckIcon /></template></t-button
          ></t-tooltip>
          <t-tooltip content="取消编辑"
            ><t-button
              shape="square"
              variant="text"
              aria-label="取消编辑"
              :disabled="!!saving"
              @click="cancelEditing"
              ><template #icon><CloseIcon /></template></t-button
          ></t-tooltip>
        </form>
      </li>
    </ul>
  </t-drawer>
  <t-dialog
    role="dialog"
    aria-modal="true"
    aria-label="删除设备记录"
    :visible="!!pendingDelete"
    header="删除设备记录"
    :confirm-btn="{ content: '删除记录', theme: 'danger', loading: !!deleting }"
    :cancel-btn="{ content: '取消', disabled: !!deleting }"
    :close-btn="!deleting"
    :close-on-esc-keydown="!deleting"
    :close-on-overlay-click="false"
    @confirm="$emit('remove')"
    @close="!deleting && (pendingDelete = null)"
  >
    <p class="mono">{{ pendingDelete?.model }} · {{ pendingDelete?.serial }}</p>
    <p>删除记录不会断开设备。</p>
  </t-dialog>
</template>
