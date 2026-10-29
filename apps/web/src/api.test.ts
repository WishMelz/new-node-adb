import { describe, expect, it, vi } from 'vitest'
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { connectionErrorMessage, normalizeDeviceHost } from './api'

describe('stream configuration', () => {
  it('leaves encoding defaults to the server', async () => {
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
      data: { id: 'test-stream' },
      status: 201,
      statusText: 'Created',
      headers: {},
      config,
    }))
    const original = axios.defaults.adapter
    axios.defaults.adapter = adapter
    try {
      vi.resetModules()
      const configuredApi = await import('./api')
      const result = await configuredApi.startStream('test-device')
      expect(JSON.parse(adapter.mock.calls[0]![0].data)).toEqual({ serial: 'test-device' })
      expect(result.id).toBe('test-stream')
    } finally {
      axios.defaults.adapter = original
    }
  })
})

describe('network device address', () => {
  it.each([
    ['192.168.3.110', '192.168.3.110:5555'],
    [' 192.168.3.110:5556 ', '192.168.3.110:5556'],
    ['phone.local', 'phone.local:5555'],
    ['[::1]', '[::1]:5555'],
    ['[2001:db8::1]:65535', '[2001:db8::1]:65535'],
    ['phone.local:1', 'phone.local:1'],
  ])('normalizes %s', (value, expected) => {
    expect(normalizeDeviceHost(value)).toBe(expected)
  })

  it.each([
    '',
    'http://192.168.1.10:5555',
    'phone.local/path',
    'abc;reboot:5555',
    '192.168.3.110:',
    'phone.local:abc',
    '::1',
    '999.999.1.1',
    '[:::]:5555',
  ])('rejects malformed address %s', (value) => {
    expect(() => normalizeDeviceHost(value)).toThrow(/[\u4e00-\u9fff]/)
  })

  it.each(['phone.local:0', 'phone.local:65536', '[::1]:99999999999999999'])(
    'rejects out-of-range port %s',
    (value) => {
      expect(() => normalizeDeviceHost(value)).toThrow('端口号必须在 1-65535 之间')
    },
  )
})

describe('connection errors', () => {
  it('does not expose raw validation or command messages', () => {
    const error = Object.assign(new AxiosError('Request failed'), {
      response: { status: 400, data: { message: ['host must match /.../ regular expression'] } },
    })
    expect(connectionErrorMessage(error)).toBe('连接失败，请确认设备地址、端口及 ADB 调试状态')
    expect(connectionErrorMessage(new Error('adb command failed'))).toBe(connectionErrorMessage(error))
  })

  it('distinguishes timeout, unavailable service and expired session', () => {
    expect(connectionErrorMessage(new AxiosError('timeout', 'ECONNABORTED'))).toContain('连接超时')
    expect(connectionErrorMessage(new AxiosError('Network Error', 'ERR_NETWORK'))).toContain('无法访问服务')
    expect(connectionErrorMessage(Object.assign(new AxiosError(), { response: { status: 504 } }))).toContain(
      '连接超时',
    )
    expect(connectionErrorMessage(Object.assign(new AxiosError(), { response: { status: 401 } }))).toContain(
      '登录已过期',
    )
  })
})
