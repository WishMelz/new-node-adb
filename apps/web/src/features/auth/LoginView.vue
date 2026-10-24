<script setup lang="ts">
import { ref } from 'vue'
import { EnterIcon, LockOnIcon, RefreshIcon } from 'tdesign-icons-vue-next'

defineProps<{ pending: boolean; error: string; sessionHours: number }>()
const emit = defineEmits<{ login: [password: string]; retry: [] }>()
const password = ref('')
function submit() {
  emit('login', password.value)
  password.value = ''
}
</script>

<template>
  <main class="login-view">
    <section class="login-panel" aria-labelledby="login-title">
      <div class="login-symbol"><LockOnIcon /></div>
      <h1 id="login-title">登录手机控制台</h1>
      <form @submit.prevent="submit">
        <label for="password">访问密码</label>
        <input
          id="password"
          v-model="password"
          class="password-input"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="256"
          :disabled="pending"
          :aria-invalid="!!error"
          :aria-describedby="error ? 'login-error' : undefined"
          autofocus
        />
        <t-button
          theme="primary"
          type="submit"
          size="large"
          block
          :loading="pending"
          :disabled="!password || pending"
          ><template #icon><EnterIcon /></template>登录</t-button
        >
      </form>
      <p class="session-duration">会话有效期 {{ sessionHours }} 小时</p>
      <div v-if="error" class="login-feedback">
        <p id="login-error" role="alert" class="login-error">{{ error }}</p>
        <t-tooltip content="重新检查服务"
          ><t-button
            shape="square"
            variant="text"
            aria-label="重新检查服务"
            :disabled="pending"
            @click="emit('retry')"
            ><RefreshIcon /></t-button
        ></t-tooltip>
      </div>
    </section>
  </main>
</template>

<style scoped>
.login-view {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 32px 20px;
  overflow: auto;
}
.login-panel {
  width: min(360px, 100%);
  padding-bottom: 60px;
}
.login-symbol {
  color: var(--accent);
  font-size: 32px;
  margin-bottom: 16px;
}
h1 {
  margin-bottom: 28px;
}
label {
  display: block;
  color: var(--muted);
  font-size: 13px;
  margin: 12px 0 8px;
}
.password-input {
  width: 100%;
  height: 44px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #fff;
  color: inherit;
  outline-offset: 3px;
}
.password-input:focus-visible {
  outline: 2px solid var(--accent);
}
.password-input[aria-invalid='true'] {
  border-color: #b64537;
}
form .t-button {
  margin-top: 18px;
}
.session-duration {
  font-size: 12px;
  color: var(--muted);
  margin-top: 16px;
}
.login-feedback {
  display: flex;
  gap: 8px;
  align-items: center;
}
.login-error {
  color: #b64537;
  font-size: 13px;
  overflow-wrap: anywhere;
  flex: 1;
}
</style>
