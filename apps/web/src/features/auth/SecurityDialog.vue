<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { isAxiosError } from 'axios'
import { MessagePlugin } from 'tdesign-vue-next/es/message'
import {
  BrowseIcon,
  BrowseOffIcon,
  CheckIcon,
  CloseIcon,
  DownloadIcon,
  LockOnIcon,
  RefreshIcon,
  ShieldErrorIcon,
} from 'tdesign-icons-vue-next'
import * as api from '../../api'

const emit = defineEmits<{ close: [] }>()
const status = ref<api.SecurityStatus | null>(null)
const setup = ref<api.FactorSetup | null>(null)
const recoveryCodes = ref<string[]>([])
const saved = ref(false)
const pending = ref(false)
const password = ref('')
const showPassword = ref(false)
const newPassword = ref('')
const showNewPassword = ref(false)
const confirmPassword = ref('')
const code = ref('')
const action = ref<'setup' | 'disable' | 'revoke-trusted' | 'password' | null>(null)
const canClose = computed(() => !pending.value && (!recoveryCodes.value.length || saved.value))
let disposed = false

function failure(error: unknown) {
  const statusCode = isAxiosError(error) ? error.response?.status : undefined
  const content =
    statusCode === 429
      ? '尝试次数过多，请稍后重试'
      : statusCode === 400
        ? '密码或验证码无效、已使用或绑定已过期，请重试'
        : statusCode === 401
          ? '登录已失效，请重新登录'
          : '安全设置操作失败，请重试'
  void MessagePlugin.error({ content, duration: 5000, closeBtn: true })
}

async function run(operation: () => Promise<void>) {
  if (pending.value || disposed) return
  pending.value = true
  try {
    await operation()
  } catch (error) {
    if (!disposed) failure(error)
  } finally {
    pending.value = false
  }
}

async function refresh() {
  const result = await api.securityStatus()
  if (!disposed) status.value = result
}

function choose(next: typeof action.value) {
  if (pending.value) return
  action.value = next
  password.value = ''
  showPassword.value = false
  newPassword.value = ''
  showNewPassword.value = false
  confirmPassword.value = ''
  code.value = ''
  setup.value = null
}

async function submit() {
  if (action.value === 'password' && newPassword.value !== confirmPassword.value) {
    void MessagePlugin.error({ content: '两次输入的新密码不一致', duration: 4000, closeBtn: true })
    return
  }
  await run(async () => {
    if (setup.value) {
      const result = await api.enableTwoFactor(code.value)
      if (disposed) return
      recoveryCodes.value = result.recoveryCodes
      setup.value = null
      action.value = null
      code.value = ''
      await refresh()
    } else if (action.value === 'setup') {
      const result = await api.setupTwoFactor(password.value)
      if (!disposed) {
        setup.value = result
        password.value = ''
      }
    } else if (action.value === 'password') {
      await api.changePassword(password.value, newPassword.value, confirmPassword.value, code.value)
      if (disposed) return
      action.value = null
      password.value = ''
      newPassword.value = ''
      confirmPassword.value = ''
      code.value = ''
      void MessagePlugin.success({ content: '管理员密码已修改，请使用新密码重新登录', duration: 4000 })
      emit('close')
      window.dispatchEvent(new Event('auth-expired'))
    } else if (action.value) {
      await api.changeTwoFactor(action.value, password.value, code.value)
      if (disposed) return
      action.value = null
      password.value = ''
      code.value = ''
      await refresh()
      void MessagePlugin.success({ content: '安全设置已更新', duration: 3000 })
    }
  })
}

function download() {
  const blob = new Blob(['ADB Desk recovery codes\n\n', recoveryCodes.value.join('\n')], {
    type: 'text/plain',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'adb-desk-recovery-codes.txt'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

onMounted(() => void run(refresh))
onBeforeUnmount(() => {
  disposed = true
  password.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  code.value = ''
  setup.value = null
  recoveryCodes.value = []
})
</script>

<template>
  <t-dialog
    :visible="true"
    role="dialog"
    aria-modal="true"
    aria-label="安全设置"
    width="min(450px, calc(100vw - 32px))"
    destroy-on-close
    :footer="false"
    :close-btn="false"
    :close-on-esc-keydown="canClose"
    :close-on-overlay-click="false"
    @close="canClose && emit('close')"
  >
    <template #header>
      <div class="drawer-header">
        <span>安全设置</span>
        <t-button
          shape="square"
          variant="text"
          aria-label="关闭安全设置"
          :disabled="!canClose"
          @click="emit('close')"
        >
          <template #icon><CloseIcon /></template>
        </t-button>
      </div>
    </template>
    <section class="security-content">
      <template v-if="recoveryCodes.length">
        <h2>一次性恢复码</h2>
        <p class="security-hint">以下恢复码仅展示一次，丢失验证器时可用于登录，请立即离线保存。</p>
        <ul class="recovery-codes">
          <li v-for="item in recoveryCodes" :key="item">
            <code>{{ item }}</code>
          </li>
        </ul>
        <t-button variant="outline" @click="download"
          ><template #icon><DownloadIcon /></template>下载恢复码</t-button
        >
        <label class="security-checkbox"><input v-model="saved" type="checkbox" />我已妥善保存恢复码</label>
        <t-button block theme="primary" :disabled="!saved || pending" @click="emit('close')"
          ><template #icon><CheckIcon /></template>完成</t-button
        >
      </template>
      <template v-else-if="status">
        <div class="security-status-card">
          <div class="security-status">
            <div>
              <strong>验证器双重验证（2FA）</strong>
              <p class="security-hint">
                {{
                  status.enabled
                    ? '已开启：登录时需配合 TOTP 动态码或受信任浏览器校验'
                    : '未开启：开启后登录需配合 TOTP 验证器，提升远程访问安全性'
                }}
              </p>
            </div>
            <button
              type="button"
              class="security-toggle"
              role="switch"
              :aria-checked="status.enabled || action === 'setup'"
              aria-label="验证器双重验证"
              :disabled="pending || !!setup"
              @click="choose(status.enabled ? 'disable' : action === 'setup' ? null : 'setup')"
            >
              <span />
            </button>
          </div>
        </div>
        <dl v-if="status.enabled && !action" class="security-summary">
          <dt>可信浏览器</dt>
          <dd>{{ status.trustedBrowsers }} 台</dd>
          <dt>此浏览器免验证至</dt>
          <dd>{{ status.trustedUntil ? new Date(status.trustedUntil).toLocaleString() : '未记忆' }}</dd>
          <dt>剩余恢复码</dt>
          <dd>{{ status.recoveryCodesRemaining }} 个</dd>
        </dl>
        <t-button
          v-if="status.enabled && !action"
          variant="outline"
          theme="danger"
          block
          :disabled="pending || !status.trustedBrowsers"
          @click="choose('revoke-trusted')"
        >
          <template #icon><ShieldErrorIcon /></template>撤销所有免验证浏览器
        </t-button>
        <div v-if="!action" class="security-password-card">
          <div class="security-status">
            <div>
              <strong>管理员密码</strong>
              <p class="security-hint">
                {{
                  status.canChangePassword
                    ? '修改后将撤销当前会话和免验证浏览器，需使用新密码重新登录'
                    : '当前密码由环境变量 ADMIN_PASSWORD 管理，请修改配置并重启服务'
                }}
              </p>
            </div>
            <t-button
              v-if="status.canChangePassword"
              variant="outline"
              size="small"
              :disabled="pending"
              @click="choose('password')"
            >
              修改密码
            </t-button>
          </div>
        </div>
        <form v-if="action" class="security-form" @submit.prevent="submit">
          <template v-if="setup">
            <img :src="setup.qrCode" alt="验证器绑定二维码" width="220" height="220" />
            <label for="factor-secret">手动绑定密钥</label>
            <input id="factor-secret" :value="setup.secret" readonly autocomplete="off" spellcheck="false" />
            <p class="security-deadline">绑定有效至 {{ new Date(setup.expiresAt).toLocaleTimeString() }}</p>
          </template>
          <template v-else>
            <h2 v-if="action !== 'setup'">
              {{
                action === 'disable'
                  ? '确认关闭双重验证'
                  : action === 'password'
                    ? '修改管理员密码'
                    : '确认撤销所有免验证浏览器'
              }}
            </h2>
            <label for="security-password">{{ action === 'password' ? '当前密码' : '访问密码' }}</label>
            <div class="security-password-field">
              <input
                id="security-password"
                v-model="password"
                class="has-toggle"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="请输入当前访问密码"
                required
                :disabled="pending"
              />
              <button
                type="button"
                class="security-password-toggle"
                :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                :disabled="pending"
                @click="showPassword = !showPassword"
              >
                <BrowseOffIcon v-if="showPassword" /><BrowseIcon v-else />
              </button>
            </div>
            <template v-if="action === 'password'">
              <label for="security-new-password">新密码</label>
              <div class="security-password-field">
                <input
                  id="security-new-password"
                  v-model="newPassword"
                  class="has-toggle"
                  :type="showNewPassword ? 'text' : 'password'"
                  autocomplete="new-password"
                  placeholder="建议使用至少 12 位强密码"
                  required
                  :disabled="pending"
                />
                <button
                  type="button"
                  class="security-password-toggle"
                  :aria-label="showNewPassword ? '隐藏新密码' : '显示新密码'"
                  :disabled="pending"
                  @click="showNewPassword = !showNewPassword"
                >
                  <BrowseOffIcon v-if="showNewPassword" /><BrowseIcon v-else />
                </button>
              </div>
              <label for="security-confirm-password">确认新密码</label>
              <input
                id="security-confirm-password"
                v-model="confirmPassword"
                :type="showNewPassword ? 'text' : 'password'"
                autocomplete="new-password"
                placeholder="请再次输入新密码"
                required
                :disabled="pending"
              />
            </template>
          </template>
          <template v-if="setup || status.enabled">
            <label for="security-code">{{ setup ? '验证器验证码' : '验证码或恢复码' }}</label>
            <input
              id="security-code"
              v-model.trim="code"
              autocomplete="one-time-code"
              :placeholder="setup ? '输入 6 位动态验证码' : '输入 6 位验证码或 20 位恢复码'"
              required
              minlength="6"
              :maxlength="setup ? 6 : 20"
              :disabled="pending"
            />
          </template>
          <div class="security-actions">
            <t-button variant="text" :disabled="pending" @click="choose(null)">取消</t-button>
            <t-button
              type="submit"
              :theme="action === 'disable' ? 'danger' : 'primary'"
              :loading="pending"
              :disabled="
                pending ||
                (setup
                  ? !code
                  : action === 'password'
                    ? !password || !newPassword || !confirmPassword || (status.enabled && !code)
                    : !password || (status.enabled && !code))
              "
            >
              <template #icon><LockOnIcon /></template
              >{{
                setup
                  ? '验证并启用'
                  : action === 'setup'
                    ? '开始绑定'
                    : action === 'password'
                      ? '保存新密码'
                      : '确认'
              }}
            </t-button>
          </div>
        </form>
      </template>
      <t-loading v-else-if="pending" text="正在读取安全设置" />
      <t-button v-else variant="outline" @click="run(refresh)"
        ><template #icon><RefreshIcon /></template>重新加载</t-button
      >
    </section>
  </t-dialog>
</template>

<style scoped>
.security-content {
  max-height: calc(100dvh - 180px);
  overflow: auto;
  padding: 2px;
}
.security-status-card,
.security-password-card {
  padding: 14px 16px;
  border-radius: 10px;
  background: #f7faf9;
  border: 1px solid var(--line);
}
.security-password-card {
  margin-top: 12px;
}
.security-status,
.security-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.security-status strong {
  font-size: 14px;
  font-weight: 600;
}
.security-hint {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.security-toggle {
  width: 44px;
  height: 26px;
  border: 0;
  border-radius: 13px;
  padding: 3px;
  background: #9aa8a2;
  flex-shrink: 0;
  cursor: pointer;
  transition: background-color 0.2s ease;
}
.security-toggle span {
  display: block;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.16);
  transition: transform 0.2s ease;
}
.security-toggle[aria-checked='true'] {
  background: var(--accent);
}
.security-toggle[aria-checked='true'] span {
  transform: translateX(18px);
}
.security-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.security-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.security-summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px 14px;
  margin: 16px 0;
  padding: 14px 16px;
  border-radius: 10px;
  background: #fafcfb;
  border: 1px solid var(--line);
  font-size: 13px;
}
.security-summary dt,
.security-deadline {
  color: var(--muted);
}
.security-summary dd {
  margin: 0;
  text-align: right;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.security-form {
  margin-top: 18px;
}
.security-form label {
  display: block;
  margin: 12px 0 7px;
  font-size: 13px;
  font-weight: 500;
  color: #46534f;
}
.security-password-field {
  position: relative;
}
.security-form input {
  width: 100%;
  min-width: 0;
  height: 40px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fafcfb;
  padding: 0 12px;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    box-shadow 0.15s ease;
}
.security-form input.has-toggle {
  padding-right: 40px;
}
.security-form input:focus-visible {
  outline: none;
  background: #fff;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(8, 126, 112, 0.14);
}
.security-password-toggle {
  position: absolute;
  top: 50%;
  right: 5px;
  transform: translateY(-50%);
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  display: grid;
  place-items: center;
  cursor: pointer;
}
.security-password-toggle:hover:not(:disabled) {
  background: #eef3f1;
  color: #202826;
}
.security-password-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.security-form img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto 8px;
  padding: 8px;
  border-radius: 10px;
  background: #fff;
  border: 1px solid var(--line);
}
.security-deadline {
  font-size: 12px;
}
.security-actions {
  justify-content: flex-end;
  margin-top: 20px;
  flex-wrap: wrap;
}
.recovery-codes {
  list-style: none;
  padding: 0;
  margin: 14px 0 16px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 8px;
  font-size: 12px;
}
.recovery-codes li {
  padding: 8px 10px;
  border-radius: 6px;
  background: #f5f8f7;
  border: 1px solid var(--line);
  text-align: center;
}
.recovery-codes code {
  overflow-wrap: anywhere;
}
.security-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 0;
  font-size: 13px;
}
</style>
