<script setup lang="ts">
import { ClearIcon, CloseIcon } from 'tdesign-icons-vue-next'
import type { ActivityItem } from '../../composables/useActivity'

const visible = defineModel<boolean>('visible', { required: true })
defineProps<{ items: ActivityItem[] }>()
defineEmits<{ clear: [] }>()
</script>

<template>
  <t-drawer
    v-model:visible="visible"
    :footer="false"
    :close-btn="false"
    destroy-on-close
    size="min(520px, 100vw)"
  >
    <template #header>
      <div class="drawer-header">
        <span>操作日志</span>
        <div class="drawer-header-actions">
          <t-tooltip v-if="items.length" content="清空日志" destroy-on-close
            ><t-button shape="square" variant="text" aria-label="清空日志" @click="$emit('clear')">
              <template #icon><ClearIcon /></template> </t-button
          ></t-tooltip>
          <t-button shape="square" variant="text" aria-label="关闭操作日志" @click="visible = false">
            <template #icon><CloseIcon /></template>
          </t-button>
        </div>
      </div>
    </template>
    <p v-if="!items.length" class="records-empty">暂无操作记录</p>
    <div v-else class="activity">
      <p v-for="item in items" :key="item.id" :class="{ 'is-error': item.level === 'error' }">
        <i class="activity-dot" aria-hidden="true" />
        <time>{{ item.time }}</time
        ><span>{{ item.message }}</span>
      </p>
    </div>
  </t-drawer>
</template>
