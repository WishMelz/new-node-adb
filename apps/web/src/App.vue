<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import AppHeader from './components/layout/AppHeader.vue'
import LoginView from './features/auth/LoginView.vue'
import { useAuth } from './features/auth/useAuth'

const WorkspaceView = defineAsyncComponent(() => import('./features/devices/WorkspaceView.vue'))
const { authenticated, checking, pending, error, sessionHours, login, logout, restore } = useAuth()
</script>

<template>
  <div class="app-shell">
    <AppHeader :authenticated="authenticated" @logout="logout" />
    <main v-if="checking" class="login-view"><t-loading text="正在检查会话" /></main>
    <LoginView
      v-else-if="!authenticated"
      :pending="pending"
      :error="error"
      :session-hours="sessionHours"
      @login="login"
      @retry="restore"
    />
    <WorkspaceView v-else />
  </div>
</template>
