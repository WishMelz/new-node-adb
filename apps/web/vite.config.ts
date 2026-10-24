import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 23111,
    proxy: {
      '/api': { target: 'http://127.0.0.1:23110' },
      '/ws': { target: 'ws://127.0.0.1:23110', ws: true },
    },
  },
})