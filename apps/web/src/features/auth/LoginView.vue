<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import {
  ArrowLeftIcon,
  BrowseIcon,
  BrowseOffIcon,
  LockOnIcon,
  LoginIcon,
  RefreshIcon,
} from 'tdesign-icons-vue-next'

const props = defineProps<{
  pending: boolean
  error: string
  retryable?: boolean
  sessionHours: number
  mode?: 'password' | 'register'
  twoFactor?: boolean
  maxTrustDays?: number
}>()
const emit = defineEmits<{
  login: [password: string]
  register: [password: string, confirmPassword: string]
  verify: [code: string, days: number]
  cancel: []
  retry: []
}>()
const password = ref('')
const confirmPassword = ref('')
const showPassword = ref(false)
const showConfirmPassword = ref(false)
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
    showPassword.value = false
    showConfirmPassword.value = false
    await nextTick()
    if (props.twoFactor) codeInput.value?.focus()
    else passwordInput.value?.focus()
  },
)
const registering = () => props.mode === 'register'
function submit() {
  if (props.pending) return
  if (props.twoFactor) {
    emit('verify', code.value, remember.value ? days.value : 0)
    code.value = ''
    return
  }
  if (registering()) emit('register', password.value, confirmPassword.value)
  else emit('login', password.value)
  password.value = ''
  confirmPassword.value = ''
  showPassword.value = false
  showConfirmPassword.value = false
}
</script>

<template>
  <main class="login-view">
    <section class="login-panel" aria-labelledby="login-title">
      <div class="login-symbol"><LockOnIcon /></div>
      <h1 id="login-title">
        {{ twoFactor ? '双重验证' : registering() ? '创建管理员账户' : '登录 ADB Desk' }}
      </h1>
      <p class="login-subtitle">
        {{
          twoFactor
            ? '请输入验证器 6 位动态码或一次性恢复码'
            : registering()
              ? '设置唯一管理员密码以初始化远程控制台'
              : '自托管 Android 远程控制与实时投屏控制台'
        }}
      </p>
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
            placeholder="6 位验证码或 20 位恢复码"
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
          <label for="password">{{ registering() ? '设置管理员密码' : '访问密码' }}</label>
          <div class="password-field">
            <input
              id="password"
              ref="passwordInput"
              v-model="password"
              class="password-input has-toggle"
              name="password"
              :type="showPassword ? 'text' : 'password'"
              :autocomplete="registering() ? 'new-password' : 'current-password'"
              :placeholder="registering() ? '建议使用至少 12 位强密码' : '请输入访问密码'"
              required
              :disabled="pending"
              :aria-invalid="!!error"
              :aria-describedby="error ? 'login-error' : undefined"
              autofocus
            />
            <button
              type="button"
              class="password-toggle"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              :disabled="pending"
              @click="showPassword = !showPassword"
            >
              <BrowseOffIcon v-if="showPassword" /><BrowseIcon v-else />
            </button>
          </div>
          <template v-if="registering()">
            <label for="confirm-password">确认管理员密码</label>
            <div class="password-field">
              <input
                id="confirm-password"
                v-model="confirmPassword"
                class="password-input has-toggle"
                name="confirm-password"
                :type="showConfirmPassword ? 'text' : 'password'"
                autocomplete="new-password"
                placeholder="请再次输入密码"
                required
                :disabled="pending"
                :aria-invalid="!!error"
                :aria-describedby="error ? 'login-error' : undefined"
              />
              <button
                type="button"
                class="password-toggle"
                :aria-label="showConfirmPassword ? '隐藏确认密码' : '显示确认密码'"
                :disabled="pending"
                @click="showConfirmPassword = !showConfirmPassword"
              >
                <BrowseOffIcon v-if="showConfirmPassword" /><BrowseIcon v-else />
              </button>
            </div>
          </template>
        </template>
        <t-button
          theme="primary"
          type="submit"
          size="large"
          block
          :loading="pending"
          :disabled="(twoFactor ? !code : !password || (registering() && !confirmPassword)) || pending"
          ><template #icon><LoginIcon /></template
          >{{ twoFactor ? '验证并登录' : registering() ? '创建管理员账户' : '登录' }}</t-button
        >
        <t-button v-if="twoFactor" variant="text" block :disabled="pending" @click="emit('cancel')">
          <template #icon><ArrowLeftIcon /></template>返回密码登录
        </t-button>
      </form>
      <p class="session-duration">登录会话默认有效 {{ sessionHours }} 小时</p>
      <div v-if="error" class="login-feedback">
        <p id="login-error" role="alert" class="login-error">{{ error }}</p>
        <t-tooltip v-if="!twoFactor && retryable" content="重新检查服务"
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
  padding: 28px 20px 56px;
  overflow: auto;
}
.login-panel {
  width: min(392px, 100%);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 32px 28px 28px;
  box-shadow: 0 14px 36px -18px rgba(15, 38, 33, 0.16);
}
.login-symbol {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: #e9f5f3;
  color: var(--accent);
  font-size: 24px;
  display: grid;
  place-items: center;
  margin-bottom: 18px;
}
h1 {
  margin: 0;
  font-size: 23px;
  line-height: 1.35;
}
.login-subtitle {
  margin: 6px 0 22px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}
label {
  display: block;
  color: #46534f;
  font-size: 13px;
  font-weight: 500;
  margin: 14px 0 8px;
}
.password-field {
  position: relative;
}
.password-input {
  width: 100%;
  height: 44px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fafcfb;
  color: inherit;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    box-shadow 0.15s ease;
}
.password-input.has-toggle {
  padding-right: 42px;
}
.password-input::placeholder {
  color: #93a19c;
}
.password-input:hover:not(:disabled) {
  border-color: #b8c6c1;
}
.password-input:focus-visible {
  outline: none;
  background: #fff;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(8, 126, 112, 0.14);
}
.password-input[aria-invalid='true'] {
  border-color: #c94638;
  background: #fffafa;
}
.password-toggle {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  display: grid;
  place-items: center;
  cursor: pointer;
}
.password-toggle:hover:not(:disabled) {
  background: #eef3f1;
  color: #202826;
}
.password-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.password-toggle:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
form .t-button {
  margin-top: 18px;
  border-radius: 8px;
}
.session-duration {
  font-size: 12px;
  color: var(--muted);
  margin: 16px 0 0;
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
  margin-top: 12px;
}
.remember-label,
.remember-days {
  margin: 0;
  font-weight: 400;
  color: var(--muted);
}
.remember-days input {
  width: 64px;
  min-height: 34px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 8px;
}
.login-feedback {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #fdf2f0;
  border: 1px solid #f2ccc6;
}
.login-error {
  margin: 0;
  color: #b63d30;
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  flex: 1;
}
@media (max-width: 480px) {
  .login-panel {
    padding: 26px 20px 22px;
    border-radius: 12px;
  }
}
</style>
