import { onBeforeUnmount, onMounted, ref } from 'vue'
import { isAxiosError } from 'axios'
import { MessagePlugin } from 'tdesign-vue-next'
import * as api from '../../api'

export function authErrorMessage(error: unknown) {
  if (!isAxiosError(error) || !error.response) return '无法连接服务，请稍后重试'
  if (error.response.status === 401) return '访问密码不正确'
  if (error.response.status === 429) return '尝试次数过多，请稍后重试'
  if (error.response.status === 403) return '请求来源不被允许，请检查服务端配置'
  return '登录服务暂不可用，请稍后重试'
}

export function useAuth() {
  const authenticated = ref(false)
  const checking = ref(true)
  const pending = ref(false)
  const error = ref('')
  const sessionHours = ref(24)
  const challenge = ref<api.TwoFactorChallenge | null>(null)
  let version = 0
  let expiryTimer: ReturnType<typeof setTimeout> | undefined

  function expire(message = '登录已过期，请重新登录') {
    version += 1
    clearTimeout(expiryTimer)
    checking.value = false
    authenticated.value = false
    challenge.value = null
    error.value = message
  }

  function accept(expiresAt: number) {
    clearTimeout(expiryTimer)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      expire()
      return
    }
    authenticated.value = true
    challenge.value = null
    error.value = ''
    const schedule = () => {
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) expire()
      else expiryTimer = setTimeout(schedule, Math.min(remaining, 2_147_483_647))
    }
    schedule()
  }

  async function restore() {
    const current = ++version
    checking.value = true
    error.value = ''
    try {
      const config = await api.authConfig()
      if (current !== version) return
      sessionHours.value = config.sessionHours
      const session = await api.session()
      if (current === version) accept(session.expiresAt)
    } catch (failure) {
      if (current === version && (!isAxiosError(failure) || failure.response?.status !== 401)) {
        error.value = authErrorMessage(failure)
      }
    } finally {
      if (current === version) checking.value = false
    }
  }

  async function login(password: string) {
    if (!password || pending.value) return
    const current = ++version
    pending.value = true
    error.value = ''
    try {
      const result = await api.login(password)
      if (current !== version) return
      if ('requiresTwoFactor' in result) {
        challenge.value = result
        clearTimeout(expiryTimer)
        expiryTimer = setTimeout(
          () => expire('验证已过期，请重新输入密码'),
          Math.max(0, result.expiresAt - Date.now()),
        )
      } else accept(result.expiresAt)
    } catch (failure) {
      if (current === version) error.value = authErrorMessage(failure)
    } finally {
      pending.value = false
    }
  }

  function cancelVerification() {
    if (pending.value) return
    version += 1
    clearTimeout(expiryTimer)
    challenge.value = null
    error.value = ''
  }

  async function verify(code: string, rememberDays: number) {
    if (!challenge.value || !code || pending.value) return
    const current = ++version
    const token = challenge.value.challenge
    pending.value = true
    error.value = ''
    try {
      const result = await api.verifyLogin(token, code.trim(), rememberDays)
      if (current === version) accept(result.expiresAt)
    } catch (failure) {
      if (current === version)
        error.value =
          isAxiosError(failure) && failure.response?.status === 401
            ? '验证码无效、已使用或验证已过期，请重试或返回密码登录'
            : authErrorMessage(failure)
    } finally {
      pending.value = false
    }
  }

  async function logout() {
    if (pending.value) return
    pending.value = true
    try {
      await api.logout()
      expire('')
    } catch (failure) {
      if (isAxiosError(failure) && failure.response?.status === 401) expire('')
      else {
        error.value = '退出失败，请检查网络后重试'
        void MessagePlugin.error({ content: error.value, duration: 5000, closeBtn: true })
      }
    } finally {
      pending.value = false
    }
  }

  const onExpired = () => {
    if (authenticated.value || checking.value || pending.value) expire()
  }
  const onReplaced = () => expire('账号已在其他位置登录，当前连接已断开')
  onMounted(() => {
    window.addEventListener('auth-expired', onExpired)
    window.addEventListener('auth-replaced', onReplaced)
    void restore()
  })
  onBeforeUnmount(() => {
    version += 1
    clearTimeout(expiryTimer)
    window.removeEventListener('auth-expired', onExpired)
    window.removeEventListener('auth-replaced', onReplaced)
  })
  return {
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
  }
}
