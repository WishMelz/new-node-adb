import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import * as api from '../../api'

export function useDeviceRecords(
  devices: Ref<api.Device[]>,
  log: (message: string) => void,
  showError: (error: unknown, fallback: string) => void,
) {
  const records = ref<api.DeviceRecord[]>([])
  const loading = ref(false)
  const error = ref('')
  const deleting = ref('')
  const saving = ref('')
  const pendingDelete = ref<api.DeviceRecord | null>(null)
  let version = 0
  let disposed = false
  const savedDevices = computed(() =>
    records.value.map((record) => {
      const online = devices.value.some(
        (device) => device.serial === record.serial && device.state === 'device',
      )
      let reconnectable = false
      if (record.transport === 'network') {
        try {
          api.normalizeDeviceHost(record.serial)
          reconnectable = true
        } catch {
          reconnectable = false
        }
      }
      return { ...record, online, reconnectable }
    }),
  )

  async function refresh() {
    if (disposed || saving.value || deleting.value) return
    const current = ++version
    loading.value = true
    try {
      const result = await api.listDeviceRecords()
      if (disposed || current !== version) return
      records.value = result
      error.value = ''
    } catch {
      if (!disposed && current === version) error.value = '设备记录读取失败，请重试'
    } finally {
      if (current === version) loading.value = false
    }
  }

  async function remove() {
    const record = pendingDelete.value
    if (!record || deleting.value || saving.value || disposed) return
    version += 1
    loading.value = false
    deleting.value = record.serial
    error.value = ''
    try {
      await api.deleteDeviceRecord(record.serial)
      if (disposed) return
      records.value = records.value.filter((item) => item.serial !== record.serial)
      pendingDelete.value = null
      deleting.value = ''
      await refresh()
      log(`已删除设备记录：${record.serial}`)
    } catch {
      if (!disposed) error.value = '设备记录删除失败，请重试'
    } finally {
      deleting.value = ''
      pendingDelete.value = null
    }
  }

  async function updateNote(serial: string, note: string) {
    if (saving.value || deleting.value || disposed) return false
    const record = records.value.find((item) => item.serial === serial)
    if (!record) return false
    version += 1
    loading.value = false
    saving.value = serial
    error.value = ''
    try {
      await api.updateDeviceRecord(serial, note.trim())
      if (disposed) return false
      record.note = note.trim()
      log(`已更新设备备注：${record.note || serial}`)
      return true
    } catch (cause) {
      if (!disposed) {
        error.value = '设备备注保存失败，请重试'
        showError(cause, error.value)
      }
      return false
    } finally {
      saving.value = ''
    }
  }

  onBeforeUnmount(() => {
    disposed = true
    version += 1
  })
  return {
    records,
    savedDevices,
    loading,
    error,
    deleting,
    saving,
    pendingDelete,
    refresh,
    remove,
    updateNote,
  }
}
