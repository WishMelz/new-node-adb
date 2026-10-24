<script setup lang="ts">
import { DesktopIcon, LogoutIcon } from 'tdesign-icons-vue-next'

defineProps<{ authenticated: boolean }>()
defineEmits<{ logout: [] }>()
</script>

<template>
  <header class="topbar">
    <div class="brand-lockup"><DesktopIcon /><strong>手机远程控制</strong><span>ADB Control Room</span></div>
    <div v-if="authenticated" class="topbar-actions">
      <t-tooltip content="退出登录"
        ><t-button shape="square" variant="text" aria-label="退出登录" @click="$emit('logout')"
          ><LogoutIcon /></t-button
      ></t-tooltip>
    </div>
  </header>
</template>
