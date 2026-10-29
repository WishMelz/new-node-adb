<script setup lang="ts">
import { CloseIcon } from 'tdesign-icons-vue-next'
import type { ActivityItem } from '../../composables/useActivity'

const visible = defineModel<boolean>('visible', { required: true })
defineProps<{ items: ActivityItem[] }>()
</script>

<template>
  <t-drawer v-model:visible="visible" :footer="false" size="min(520px, 100vw)">
    <template #header>
      <div class="drawer-header">
        <span>操作日志</span>
        <t-button shape="square" variant="text" aria-label="关闭操作日志" @click="visible = false">
          <template #icon><CloseIcon /></template>
        </t-button>
      </div>
    </template>
    <p v-if="!items.length" class="records-empty">暂无操作记录</p>
    <div class="activity">
      <p v-for="item in items" :key="item.id">
        <time>{{ item.time }}</time
        ><span>{{ item.message }}</span>
      </p>
    </div>
  </t-drawer>
</template>
