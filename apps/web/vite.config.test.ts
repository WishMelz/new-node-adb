// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadEnv } from 'vite'
import configuration from './vite.config'

vi.mock('vite', () => ({
  defineConfig: (config: unknown) => config,
  loadEnv: vi.fn(),
}))

const resolve = () => configuration({ command: 'serve', mode: 'development' })

beforeEach(() => vi.mocked(loadEnv).mockReturnValue({}))

describe('development server configuration', () => {
  it('builds static assets without reading development configuration', () => {
    vi.mocked(loadEnv).mockReturnValue({ DEV_WEB_PORT: 'invalid', DEV_API_PORT: 'invalid' })
    vi.mocked(loadEnv).mockClear()
    expect(configuration({ command: 'build', mode: 'production' }).server).toBeUndefined()
    expect(loadEnv).not.toHaveBeenCalled()
  })

  it('uses root configuration without exposing password variables', () => {
    const config = resolve()
    expect(config.server).toMatchObject({ host: '0.0.0.0', port: 23111, strictPort: true })
    expect(loadEnv).toHaveBeenCalledWith('development', expect.any(String), ['DEV_WEB_PORT', 'DEV_API_PORT'])
    expect(config.envPrefix).toBeUndefined()
    expect(config.define).toBeUndefined()
  })

  it('follows development ports and ignores Docker and legacy settings', () => {
    vi.mocked(loadEnv).mockReturnValue({
      DEV_WEB_PORT: '24111',
      DEV_API_PORT: '24110',
      DOCKER_PORT: 'invalid',
      PORT: '24120',
      HOST: '127.0.0.2',
      FRONTEND_PORT: '24121',
      BACKEND_PORT: '24110',
    })
    expect(resolve().server).toMatchObject({
      host: '0.0.0.0',
      port: 24111,
      strictPort: true,
      proxy: {
        '/api': { target: 'http://127.0.0.1:24110' },
        '/ws': { target: 'ws://127.0.0.1:24110', ws: true },
      },
    })
  })

  it.each(['0', '65536', '1.5', 'invalid'])('rejects invalid port %s', (value) => {
    for (const name of ['DEV_WEB_PORT', 'DEV_API_PORT']) {
      vi.mocked(loadEnv).mockReturnValue({ [name]: value })
      expect(resolve).toThrow(`${name} must be an integer between 1 and 65535`)
    }
  })

  it('rejects conflicting development ports', () => {
    vi.mocked(loadEnv).mockReturnValue({ DEV_WEB_PORT: '24110', DEV_API_PORT: '24110' })
    expect(resolve).toThrow('DEV_WEB_PORT and DEV_API_PORT must differ')
  })

  it('uses defaults for empty development ports', () => {
    vi.mocked(loadEnv).mockReturnValue({ DEV_WEB_PORT: '', DEV_API_PORT: '' })
    expect(resolve().server).toMatchObject({
      port: 23111,
      proxy: { '/api': { target: 'http://127.0.0.1:23110' } },
    })
  })
})
