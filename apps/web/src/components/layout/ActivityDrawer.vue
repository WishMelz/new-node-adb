<script setup lang="ts">
import type { ActivityItem } from '../../composables/useActivity'

const visible = defineModel<boolean>('visible', { required: true })
defineProps<{ items: ActivityItem[] }>()
</script>

<template>
  <t-drawer v-model:visible="visible" header="操作日志" :footer="false" size="min(520px, 100vw)">
    <p v-if="!items.length" class="records-empty">暂无操作记录</p>
    <div class="activity">
      <p v-for="item in items" :key="item.id">
        <time>{{ item.time }}</time
        ><span>{{ item.message }}</span>
      </p>
    </div>
  </t-drawer>
</template>
