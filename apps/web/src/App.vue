<script setup lang="ts">
import { defineAsyncComponent, ref, watch } from 'vue'
import AppHeader from './components/layout/AppHeader.vue'
import LoginView from './features/auth/LoginView.vue'
import { useAuth } from './features/auth/useAuth'

const WorkspaceView = defineAsyncComponent(() => import('./features/devices/WorkspaceView.vue'))
const SecurityDialog = defineAsyncComponent(() => import('./features/auth/SecurityDialog.vue'))
const securityOpen = ref(false)
const {
  authenticated,
  checking,
  pending,
  error,
  sessionHours,
  challenge,
  login,
  verify,
  cancelVerification,
  logout,
  restore,
} = useAuth()
watch(authenticated, () => {
  if (!authenticated.value) securityOpen.value = false
})
</script>

<template>
  <div class="app-shell">
    <AppHeader :authenticated="authenticated" @logout="logout" @security="securityOpen = true" />
    <main v-if="checking" class="login-view"><t-loading text="正在检查会话" /></main>
    <LoginView
      v-else-if="!authenticated"
      :pending="pending"
      :error="error"
      :session-hours="sessionHours"
      :two-factor="!!challenge"
      :max-trust-days="challenge?.maxTrustDays"
      @login="login"
      @verify="verify"
      @cancel="cancelVerification"
      @retry="restore"
    />
    <WorkspaceView v-else :security-open="securityOpen" />
    <SecurityDialog v-if="authenticated && securityOpen" @close="securityOpen = false" />
  </div>
</template>
