import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AxiosError, AxiosHeaders } from 'axios'
import { defineComponent } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import TDesign, { MessagePlugin } from 'tdesign-vue-next'
import * as api from '../../api'
import { authErrorMessage, useAuth } from './useAuth'
import LoginView from './LoginView.vue'
import SecurityDialog from './SecurityDialog.vue'
import AppHeader from '../../components/layout/AppHeader.vue'

vi.mock('../../api', () => ({
  authConfig: vi.fn(),
  session: vi.fn(),
  login: vi.fn(),
  verifyLogin: vi.fn(),
  logout: vi.fn(),
  securityStatus: vi.fn(),
  setupTwoFactor: vi.fn(),
  enableTwoFactor: vi.fn(),
  changeTwoFactor: vi.fn(),
}))
vi.mock('tdesign-vue-next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('tdesign-vue-next')>()),
  MessagePlugin: { error: vi.fn(), success: vi.fn() },
}))

function httpError(status: number) {
  return Object.assign(new AxiosError(), { response: { status } })
}

it('shows ADB Desk branding on the header and login screen', async () => {
  const header = mount(AppHeader, { props: { authenticated: false }, global: { plugins: [TDesign] } })
  const login = mount(LoginView, {
    props: { pending: false, error: '', sessionHours: 24 },
    global: { plugins: [TDesign] },
  })
  try {
    expect(header.get('.brand-lockup strong').text()).toBe('ADB Desk')
    expect(header.get('.brand-lockup > span').text()).toBe('安卓控制台')
    expect(login.get('h1').text()).toBe('登录 ADB Desk')
    await header.setProps({ authenticated: true })
    await header.get('button[aria-label="安全设置"]').trigger('click')
    await header.get('button[aria-label="退出登录"]').trigger('click')
    expect(header.emitted('security')).toHaveLength(1)
    expect(header.emitted('logout')).toHaveLength(1)
    await login.setProps({ twoFactor: true })
    expect(login.get('h1').text()).toBe('双重验证')
  } finally {
    header.unmount()
    login.unmount()
  }
})

describe('authentication lifecycle', () => {
  let wrapper: VueWrapper | undefined
  let auth: ReturnType<typeof useAuth>
  const expiresAt = () => Date.now() + 86_400_000
  function create() {
    wrapper = mount(
      defineComponent({
        setup() {
          auth = useAuth()
          return () => null
        },
      }),
    )
    return flushPromises()
  }
  beforeEach(() => {
    vi.mocked(api.authConfig).mockResolvedValue({ mode: 'password', sessionHours: 24 })
    vi.mocked(api.session).mockRejectedValue(httpError(401))
    vi.mocked(api.login).mockResolvedValue({ expiresAt: expiresAt() })
    vi.mocked(api.logout).mockResolvedValue({
      data: undefined,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  it('treats an absent session as a normal login screen', async () => {
    await create()
    expect(auth.checking.value).toBe(false)
    expect(auth.authenticated.value).toBe(false)
    expect(auth.error.value).toBe('')
    expect(MessagePlugin.error).not.toHaveBeenCalled()
  })
  it('restores a session and expires on an unauthorized response event', async () => {
    vi.mocked(api.session).mockResolvedValue({ expiresAt: expiresAt() })
    await create()
    expect(auth.authenticated.value).toBe(true)
    window.dispatchEvent(new Event('auth-expired'))
    expect(auth.authenticated.value).toBe(false)
    expect(auth.error.value).toContain('过期')
  })
  it('returns to login on takeover and preserves the reason through late unauthorized responses', async () => {
    vi.mocked(api.session).mockResolvedValue({ expiresAt: expiresAt() })
    await create()
    window.dispatchEvent(new Event('auth-replaced'))
    expect(auth.authenticated.value).toBe(false)
    expect(auth.checking.value).toBe(false)
    expect(auth.error.value).toContain('其他位置登录')
    window.dispatchEvent(new Event('auth-expired'))
    expect(auth.error.value).toContain('其他位置登录')
    expect(api.logout).not.toHaveBeenCalled()
  })
  it('does not resurrect a session from a late login response', async () => {
    await create()
    let complete!: (value: { expiresAt: number }) => void
    vi.mocked(api.login).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const pending = auth.login('test-password')
    window.dispatchEvent(new Event('auth-expired'))
    complete({ expiresAt: expiresAt() })
    await pending
    expect(auth.authenticated.value).toBe(false)
    expect(auth.pending.value).toBe(false)
  })
  it('requires a second factor before accepting a session and sends the selected days', async () => {
    await create()
    vi.mocked(api.login).mockResolvedValue({
      requiresTwoFactor: true,
      challenge: 'test-challenge',
      expiresAt: Date.now() + 300_000,
      maxTrustDays: 90,
    })
    await auth.login('test-password')
    expect(auth.authenticated.value).toBe(false)
    expect(auth.challenge.value?.challenge).toBe('test-challenge')
    vi.mocked(api.verifyLogin).mockRejectedValueOnce(httpError(401))
    await auth.verify('000000', 7)
    expect(auth.authenticated.value).toBe(false)
    expect(auth.error.value).toContain('验证码')
    vi.mocked(api.verifyLogin).mockResolvedValueOnce({ expiresAt: expiresAt() })
    await auth.verify('123456', 7)
    expect(api.verifyLogin).toHaveBeenLastCalledWith('test-challenge', '123456', 7)
    expect(auth.authenticated.value).toBe(true)
    expect(auth.challenge.value).toBeNull()
  })
  it('expires and cancels challenges without retaining passwords', async () => {
    vi.useFakeTimers()
    await create()
    vi.mocked(api.login).mockImplementation(async () => ({
      requiresTwoFactor: true,
      challenge: 'test',
      expiresAt: Date.now() + 1000,
      maxTrustDays: 90,
    }))
    await auth.login('test-password')
    auth.cancelVerification()
    expect(auth.challenge.value).toBeNull()
    await auth.login('test-password')
    await vi.advanceTimersByTimeAsync(1000)
    expect(auth.challenge.value).toBeNull()
    expect(auth.authenticated.value).toBe(false)
    expect(auth.error.value).toContain('过期')
  })
  it('does not accept late verification after takeover', async () => {
    await create()
    vi.mocked(api.login).mockResolvedValue({
      requiresTwoFactor: true,
      challenge: 'test',
      expiresAt: Date.now() + 300_000,
      maxTrustDays: 90,
    })
    await auth.login('test-password')
    let finish!: (value: { expiresAt: number }) => void
    vi.mocked(api.verifyLogin).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const request = auth.verify('123456', 0)
    window.dispatchEvent(new Event('auth-replaced'))
    finish({ expiresAt: expiresAt() })
    await request
    expect(auth.authenticated.value).toBe(false)
    expect(auth.error.value).toContain('其他位置')
  })
  it('retains the session when logout fails, and permits retry', async () => {
    await create()
    await auth.login('test-password')
    vi.mocked(api.logout).mockRejectedValueOnce(new Error('offline'))
    await auth.logout()
    expect(auth.authenticated.value).toBe(true)
    expect(auth.error.value).toContain('退出失败')
    expect(MessagePlugin.error).toHaveBeenCalledExactlyOnceWith({
      content: '退出失败，请检查网络后重试',
      duration: 5000,
      closeBtn: true,
    })
    vi.mocked(api.logout).mockRejectedValueOnce(new Error('offline'))
    await auth.logout()
    expect(MessagePlugin.error).toHaveBeenCalledTimes(2)
    await auth.logout()
    expect(auth.authenticated.value).toBe(false)
    expect(MessagePlugin.error).toHaveBeenCalledTimes(2)
  })
  it('expires at the deadline and cancels timers on unmount', async () => {
    vi.useFakeTimers()
    vi.mocked(api.session).mockResolvedValue({ expiresAt: Date.now() + 1000 })
    await create()
    await vi.advanceTimersByTimeAsync(1000)
    expect(auth.authenticated.value).toBe(false)
    await auth.login('test-password')
    wrapper?.unmount()
    wrapper = undefined
    expect(vi.getTimerCount()).toBe(0)
  })
  it('ignores restoration after unmount', async () => {
    let complete!: (value: { expiresAt: number }) => void
    vi.mocked(api.session).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    await create()
    wrapper?.unmount()
    wrapper = undefined
    complete({ expiresAt: expiresAt() })
    await flushPromises()
    expect(auth.authenticated.value).toBe(false)
  })
})

describe('security controls', () => {
  let wrapper: VueWrapper | undefined
  const global = {
    plugins: [TDesign],
    stubs: { TDialog: { template: '<section><slot name="header" /><slot /></section>' } },
  }
  const disabled: api.SecurityStatus = {
    enabled: false,
    trustedBrowsers: 0,
    trustedUntil: null,
    maxTrustDays: 90,
    recoveryCodesRemaining: 0,
  }
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.resetAllMocks()
  })

  it('requires explicit browser trust and sends the selected number of days', async () => {
    wrapper = mount(LoginView, {
      props: { pending: false, error: '', sessionHours: 24, twoFactor: true, maxTrustDays: 90 },
      global,
    })
    await wrapper.get('#verification-code').setValue('123456')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('verify')).toEqual([['123456', 0]])
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await wrapper.get('input[type="number"]').setValue(14)
    expect(wrapper.get('input[type="number"]').attributes('max')).toBe('90')
    await wrapper.get('#verification-code').setValue('654321')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('verify')?.at(-1)).toEqual(['654321', 14])
    expect(wrapper.get<HTMLInputElement>('#verification-code').element.value).toBe('')
  })

  it.each([1, 257])('submits a %i-character login password without length restrictions', async (length) => {
    wrapper = mount(LoginView, {
      props: { pending: false, error: '', sessionHours: 24, twoFactor: false, maxTrustDays: 90 },
      global,
    })
    const input = wrapper.get<HTMLInputElement>('#password')
    expect(input.attributes('minlength')).toBeUndefined()
    expect(input.attributes('maxlength')).toBeUndefined()
    expect(input.element.checkValidity()).toBe(false)
    const password = 'x'.repeat(length)
    await input.setValue(password)
    expect(input.element.checkValidity()).toBe(true)
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('login')).toEqual([[password]])
  })

  it.each([1, 257])(
    'enrolls with a %i-character password only after code confirmation and recovery acknowledgement',
    async (length) => {
      vi.mocked(api.securityStatus).mockResolvedValue(disabled)
      vi.mocked(api.setupTwoFactor).mockResolvedValue({
        secret: 'TESTSECRET',
        uri: 'otpauth://test',
        qrCode: 'data:image/png;base64,AA==',
        expiresAt: Date.now() + 600_000,
      })
      vi.mocked(api.enableTwoFactor).mockResolvedValue({ recoveryCodes: ['12345678901234567890'] })
      wrapper = mount(SecurityDialog, { global })
      await flushPromises()
      await wrapper.get('[role="switch"]').trigger('click')
      const input = wrapper.get<HTMLInputElement>('#security-password')
      expect(input.attributes('minlength')).toBeUndefined()
      expect(input.attributes('maxlength')).toBeUndefined()
      expect(input.element.checkValidity()).toBe(false)
      const password = 'x'.repeat(length)
      await input.setValue(password)
      expect(input.element.checkValidity()).toBe(true)
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      expect(api.setupTwoFactor).toHaveBeenCalledExactlyOnceWith(password)
      expect(api.enableTwoFactor).not.toHaveBeenCalled()
      expect(wrapper.find('#security-password').exists()).toBe(false)
      expect(wrapper.get('img').attributes('alt')).toContain('二维码')
      await wrapper.get('#security-code').setValue('123456')
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      expect(api.enableTwoFactor).toHaveBeenCalledExactlyOnceWith('123456')
      expect(wrapper.get('.recovery-codes').text()).toContain('12345678901234567890')
      const finish = wrapper.findAll('button').find((button) => button.text() === '完成')!
      expect(finish.attributes('disabled')).toBeDefined()
      expect(wrapper.get('[aria-label="关闭安全设置"]').attributes('disabled')).toBeDefined()
      await wrapper.get('input[type="checkbox"]').setValue(true)
      expect(wrapper.get('[aria-label="关闭安全设置"]').attributes('disabled')).toBeUndefined()
      await finish.trigger('click')
      expect(wrapper.emitted('close')).toEqual([[]])
    },
  )

  it('revalidates credentials before revoking trust and keeps the form after failure', async () => {
    vi.mocked(api.securityStatus).mockResolvedValue({
      ...disabled,
      enabled: true,
      trustedBrowsers: 2,
      recoveryCodesRemaining: 9,
    })
    vi.mocked(api.changeTwoFactor).mockRejectedValueOnce(httpError(400))
    wrapper = mount(SecurityDialog, { global })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('撤销所有'))!
      .trigger('click')
    await wrapper.get('#security-password').setValue('test-password')
    await wrapper.get('#security-code').setValue('123456')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.changeTwoFactor).toHaveBeenCalledExactlyOnceWith('revoke-trusted', 'test-password', '123456')
    expect(wrapper.find('form').exists()).toBe(true)
    expect(MessagePlugin.error).toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})

describe('authentication errors', () => {
  it.each([
    [401, '访问密码不正确'],
    [429, '尝试次数过多'],
    [403, '请求来源不被允许'],
    [500, '登录服务暂不可用'],
  ])('maps HTTP %s without exposing backend details', (status, expected) => {
    const error = Object.assign(new AxiosError(), {
      response: { status, data: { message: 'private server details' } },
    })
    expect(authErrorMessage(error)).toContain(expected)
    expect(authErrorMessage(error)).not.toContain('private')
  })
  it('reports unavailable service', () => {
    expect(authErrorMessage(new AxiosError('network'))).toContain('无法连接服务')
  })
})
