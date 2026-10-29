<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { isAxiosError } from 'axios'
import { MessagePlugin } from 'tdesign-vue-next'
import { CheckIcon, CloseIcon, DownloadIcon, LockOnIcon, RefreshIcon } from 'tdesign-icons-vue-next'
import * as api from '../../api'

const emit = defineEmits<{ close: [] }>()
const status = ref<api.SecurityStatus | null>(null)
const setup = ref<api.FactorSetup | null>(null)
const recoveryCodes = ref<string[]>([])
const saved = ref(false)
const pending = ref(false)
const password = ref('')
const code = ref('')
const action = ref<'setup' | 'disable' | 'revoke-trusted' | null>(null)
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
  code.value = ''
  setup.value = null
}

async function submit() {
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
  const blob = new Blob(['ADB Control Room recovery codes\n\n', recoveryCodes.value.join('\n')], {
    type: 'text/plain',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'adb-recovery-codes.txt'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

onMounted(() => void run(refresh))
onBeforeUnmount(() => {
  disposed = true
  password.value = ''
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
    width="min(440px, calc(100vw - 32px))"
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
        <ul class="recovery-codes">
          <li v-for="item in recoveryCodes" :key="item">
            <code>{{ item }}</code>
          </li>
        </ul>
        <t-button variant="outline" @click="download"
          ><template #icon><DownloadIcon /></template>下载恢复码</t-button
        >
        <label class="security-checkbox"><input v-model="saved" type="checkbox" />我已妥善保存恢复码</label>
        <t-button block :disabled="!saved || pending" @click="emit('close')"
          ><template #icon><CheckIcon /></template>完成</t-button
        >
      </template>
      <template v-else-if="status">
        <div class="security-status">
          <strong>验证器双重验证（2FA）</strong>
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
        <dl v-if="status.enabled && !action" class="security-summary">
          <dt>可信浏览器</dt>
          <dd>{{ status.trustedBrowsers }}</dd>
          <dt>此浏览器免验证至</dt>
          <dd>{{ status.trustedUntil ? new Date(status.trustedUntil).toLocaleString() : '未记忆' }}</dd>
          <dt>剩余恢复码</dt>
          <dd>{{ status.recoveryCodesRemaining }}</dd>
        </dl>
        <t-button
          v-if="status.enabled && !action"
          variant="outline"
          :disabled="pending || !status.trustedBrowsers"
          @click="choose('revoke-trusted')"
        >
          <template #icon><RefreshIcon /></template>撤销所有免验证浏览器
        </t-button>
        <form v-if="action" class="security-form" @submit.prevent="submit">
          <template v-if="setup">
            <img :src="setup.qrCode" alt="验证器绑定二维码" width="240" height="240" />
            <label for="factor-secret">手动绑定密钥</label>
            <input id="factor-secret" :value="setup.secret" readonly autocomplete="off" spellcheck="false" />
            <p class="security-deadline">绑定有效至 {{ new Date(setup.expiresAt).toLocaleTimeString() }}</p>
          </template>
          <template v-else>
            <h2 v-if="action !== 'setup'">
              {{ action === 'disable' ? '确认关闭双重验证' : '确认撤销所有免验证浏览器' }}
            </h2>
            <label for="security-password">访问密码</label>
            <input
              id="security-password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              :disabled="pending"
            />
          </template>
          <template v-if="setup || status.enabled">
            <label for="security-code">{{ setup ? '验证器验证码' : '验证码或恢复码' }}</label>
            <input
              id="security-code"
              v-model.trim="code"
              autocomplete="one-time-code"
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
              :disabled="pending || (setup ? !code : !password || (status.enabled && !code))"
            >
              <template #icon><LockOnIcon /></template
              >{{ setup ? '验证并启用' : action === 'setup' ? '开始绑定' : '确认' }}
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
.security-status,
.security-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.security-status strong {
  font-size: 14px;
  font-weight: 500;
}
.security-toggle {
  width: 40px;
  height: 24px;
  border: 0;
  border-radius: 12px;
  padding: 3px;
  background: #87938e;
  flex-shrink: 0;
  cursor: pointer;
}
.security-toggle span {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
}
.security-toggle[aria-checked='true'] {
  background: var(--accent);
}
.security-toggle[aria-checked='true'] span {
  transform: translateX(16px);
}
.security-toggle:disabled {
  opacity: 0.5;
  cursor: default;
}
.security-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.security-summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  margin: 24px 0;
  font-size: 13px;
}
.security-summary dt,
.security-deadline {
  color: var(--muted);
}
.security-summary dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
}
.security-form {
  margin-top: 20px;
}
.security-form label {
  display: block;
  margin: 12px 0 8px;
  font-size: 13px;
}
.security-form input {
  width: 100%;
  min-width: 0;
  height: 40px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 10px;
}
.security-form input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.security-form img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
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
  margin: 0 0 16px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 8px;
  font-size: 12px;
}
.recovery-codes code {
  overflow-wrap: anywhere;
}
.security-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 20px 0;
  font-size: 13px;
}
</style>
