import { onBeforeUnmount, onMounted, ref } from 'vue'

export function useWorkspace(cancel: () => void, pageLeaving: () => void) {
  const workspace = ref<HTMLElement | null>(null)
  const fullscreen = ref(false)
  const expanded = ref(false)
  function changed() {
    fullscreen.value = document.fullscreenElement === workspace.value
  }
  function visibility() {
    if (document.hidden) cancel()
  }
  function escape(event: KeyboardEvent) {
    if (event.key === 'Escape') expanded.value = false
  }
  async function leaveFullscreen() {
    cancel()
    expanded.value = false
    if (document.fullscreenElement === workspace.value) await document.exitFullscreen().catch(() => {})
  }
  async function toggle() {
    cancel()
    try {
      if (expanded.value || document.fullscreenElement) await leaveFullscreen()
      else if (workspace.value?.requestFullscreen && document.fullscreenEnabled)
        await workspace.value.requestFullscreen()
      else expanded.value = true
    } catch {
      expanded.value = !expanded.value
    }
  }
  onMounted(() => {
    window.addEventListener('blur', cancel)
    window.addEventListener('pagehide', pageLeaving)
    window.addEventListener('keydown', escape)
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('fullscreenchange', changed)
  })
  onBeforeUnmount(() => {
    void leaveFullscreen()
    window.removeEventListener('blur', cancel)
    window.removeEventListener('pagehide', pageLeaving)
    window.removeEventListener('keydown', escape)
    document.removeEventListener('visibilitychange', visibility)
    document.removeEventListener('fullscreenchange', changed)
  })
  return { workspace, fullscreen, expanded, toggle, leaveFullscreen }
}
