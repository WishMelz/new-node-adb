<script setup lang="ts">
import { ArrowLeftIcon, HomeIcon, ViewModuleIcon } from 'tdesign-icons-vue-next'

defineProps<{ caption: string; canCommand: boolean; canTouch: boolean; activeStream: boolean }>()
const emit = defineEmits<{ action: [key: string, label: string] }>()
const keys = [
  { key: 'back', label: '返回', icon: ArrowLeftIcon },
  { key: 'home', label: '主页', icon: HomeIcon },
  { key: 'recent', label: '最近任务', icon: ViewModuleIcon },
]
</script>

<template>
  <footer class="screen-footer">
    <span class="device-caption">{{ caption }}</span>
    <nav class="navigation-keys" aria-label="手机导航">
      <t-tooltip v-for="item in keys" :key="item.key" :content="item.label"
        ><t-button
          shape="square"
          variant="text"
          :aria-label="item.label"
          :disabled="!canCommand"
          @click="emit('action', item.key, item.label)"
          ><component :is="item.icon" /></t-button
      ></t-tooltip>
    </nav>
    <span class="live-label" :class="{ active: canTouch }">{{
      canTouch ? '可操作' : activeStream ? '连接中' : '待命'
    }}</span>
  </footer>
</template>
