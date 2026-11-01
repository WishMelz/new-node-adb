import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ command, mode }) => {
  if (command === 'build') return { plugins: [vue()] }
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const environment = loadEnv(mode, root, ['DEV_WEB_PORT', 'DEV_API_PORT'])
  function port(name: string, fallback: number) {
    const value = Number(environment[name] || fallback)
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${name} must be an integer between 1 and 65535`)
    }
    return value
  }
  const webPort = port('DEV_WEB_PORT', 23111)
  const apiPort = port('DEV_API_PORT', 23110)
  if (webPort === apiPort) throw new Error('DEV_WEB_PORT and DEV_API_PORT must differ')
  return {
    plugins: [vue()],
    server: {
      host: '0.0.0.0',
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': { target: `http://127.0.0.1:${apiPort}` },
        '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
      },
    },
  }
})
