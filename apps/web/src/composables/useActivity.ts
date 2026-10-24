import { ref } from 'vue'
import { isAxiosError } from 'axios'
import { MessagePlugin } from 'tdesign-vue-next'

export interface ActivityItem {
  id: number
  time: string
  message: string
}

export function useActivity() {
  const items = ref<ActivityItem[]>([])
  let sequence = 0
  function log(message: string) {
    items.value.unshift({ id: ++sequence, time: new Date().toLocaleTimeString(), message })
    items.value = items.value.slice(0, 80)
  }
  function showError(error: unknown, fallback: string) {
    const detail: unknown = isAxiosError(error) ? error.response?.data?.message : null
    const status = isAxiosError(error) ? error.response?.status : undefined
    const message = typeof detail === 'string' && status !== undefined && status < 500 ? detail : fallback
    log(message)
    void MessagePlugin.error({ content: message, duration: 5000, closeBtn: true })
  }
  return { items, log, showError }
}
