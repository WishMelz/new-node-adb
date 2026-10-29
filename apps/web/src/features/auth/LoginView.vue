<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { ArrowLeftIcon, EnterIcon, LockOnIcon, RefreshIcon } from 'tdesign-icons-vue-next'

const props = defineProps<{
  pending: boolean
  error: string
  sessionHours: number
  twoFactor?: boolean
  maxTrustDays?: number
}>()
const emit = defineEmits<{
  login: [password: string]
  verify: [code: string, days: number]
  cancel: []
  retry: []
}>()
const password = ref('')
const code = ref('')
const remember = ref(false)
const days = ref(7)
const passwordInput = ref<HTMLInputElement>()
const codeInput = ref<HTMLInputElement>()
watch(
  () => props.twoFactor,
  async () => {
    code.value = ''
    remember.value = false
    await nextTick()
    if (props.twoFactor) codeInput.value?.focus()
    else passwordInput.value?.focus()
  },
)
function submit() {
  if (props.pending) return
  if (props.twoFactor) {
    emit('verify', code.value, remember.value ? days.value : 0)
    code.value = ''
    return
  }
  emit('login', password.value)
  password.value = ''
}
</script>

<template>
  <main class="login-view">
    <section class="login-panel" aria-labelledby="login-title">
      <div class="login-symbol"><LockOnIcon /></div>
      <h1 id="login-title">{{ twoFactor ? '双重验证' : '登录 ADB Desk' }}</h1>
      <form @submit.prevent="submit">
        <template v-if="twoFactor">
          <label for="verification-code">验证码或恢复码</label>
          <input
            id="verification-code"
            ref="codeInput"
            v-model.trim="code"
            class="password-input"
            name="one-time-code"
            autocomplete="one-time-code"
            required
            minlength="6"
            maxlength="20"
            :disabled="pending"
            :aria-invalid="!!error"
            :aria-describedby="error ? 'login-error' : undefined"
          />
          <div class="remember-row">
            <label class="remember-label"
              ><input v-model="remember" type="checkbox" :disabled="pending" />此浏览器免 2FA</label
            >
            <label v-if="remember" class="remember-days"
              ><input
                v-model.number="days"
                aria-label="免 2FA 天数"
                type="number"
                min="1"
                :max="maxTrustDays ?? 90"
                step="1"
                required
                :disabled="pending"
              />天</label
            >
          </div>
        </template>
        <template v-else>
          <label for="password">访问密码</label>
          <input
            id="password"
            ref="passwordInput"
            v-model="password"
            class="password-input"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            :disabled="pending"
            :aria-invalid="!!error"
            :aria-describedby="error ? 'login-error' : undefined"
            autofocus
          />
        </template>
        <t-button
          theme="primary"
          type="submit"
          size="large"
          block
          :loading="pending"
          :disabled="(twoFactor ? !code : !password) || pending"
          ><template #icon><EnterIcon /></template>{{ twoFactor ? '验证并登录' : '登录' }}</t-button
        >
        <t-button v-if="twoFactor" variant="text" block :disabled="pending" @click="emit('cancel')">
          <template #icon><ArrowLeftIcon /></template>返回密码登录
        </t-button>
      </form>
      <p class="session-duration">会话有效期 {{ sessionHours }} 小时</p>
      <div v-if="error" class="login-feedback">
        <p id="login-error" role="alert" class="login-error">{{ error }}</p>
        <t-tooltip v-if="!twoFactor" content="重新检查服务"
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
.remember-row,
.remember-label,
.remember-days {
  display: flex;
  align-items: center;
  gap: 8px;
}
.remember-row {
  flex-wrap: wrap;
  justify-content: space-between;
}
.remember-days input {
  width: 64px;
  min-height: 32px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px;
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
