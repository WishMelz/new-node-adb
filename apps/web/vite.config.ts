import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

const buildOptions = {
  rollupOptions: {
    output: {
      manualChunks(id: string) {
        if (!id.includes('node_modules')) return undefined
        if (id.includes('jmuxer')) return 'jmuxer'
        if (id.includes('tdesign-icons-vue-next')) return 'tdesign-icons'
        if (id.includes('tdesign-vue-next') || id.includes('@popperjs')) return 'tdesign'
        if (id.includes('/vue/') || id.includes('@vue/') || id.includes('axios')) return 'vendor'
        return undefined
      },
    },
  },
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build') return { plugins: [vue()], build: buildOptions }
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
