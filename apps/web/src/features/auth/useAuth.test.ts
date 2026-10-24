import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AxiosError, AxiosHeaders } from 'axios'
import { defineComponent } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { MessagePlugin } from 'tdesign-vue-next'
import * as api from '../../api'
import { authErrorMessage, useAuth } from './useAuth'

vi.mock('../../api', () => ({ authConfig: vi.fn(), session: vi.fn(), login: vi.fn(), logout: vi.fn() }))
vi.mock('tdesign-vue-next', () => ({ MessagePlugin: { error: vi.fn() } }))

function httpError(status: number) {
  return Object.assign(new AxiosError(), { response: { status } })
}

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
