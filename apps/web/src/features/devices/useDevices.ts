import { computed, onBeforeUnmount, ref, watch } from 'vue'
import * as api from '../../api'

export function useDevices(
  log: (message: string) => void,
  showError: (error: unknown, fallback: string) => void,
) {
  const devices = ref<api.Device[]>([])
  const selectedSerial = ref('')
  const host = ref('')
  const hostError = ref('')
  const loading = ref(false)
  const connecting = ref(false)
  const switching = ref(false)
  const commandPending = ref(false)
  const selected = computed(() => devices.value.find((item) => item.serial === selectedSerial.value))
  const ready = computed(() => !switching.value && selected.value?.state === 'device')
  const canCommand = computed(() => ready.value && !commandPending.value)
  const options = computed(() =>
    devices.value.map((device) => ({
      label: `${device.model || '未知设备'} · ${device.serial}`,
      value: device.serial,
      disabled: device.state !== 'device',
    })),
  )
  const caption = computed(() =>
    selected.value
      ? `${selected.value.transport === 'network' ? '网络 ADB' : 'USB'} · ${selected.value.model || selected.value.serial}`
      : '未连接设备',
  )
  let disposed = false
  let refreshVersion = 0
  watch(host, () => {
    hostError.value = ''
  })

  async function refresh(select: (value: string) => Promise<void>, force = false) {
    if ((loading.value && !force) || disposed) return
    const version = ++refreshVersion
    loading.value = true
    try {
      const result = await api.listDevices()
      if (disposed || version !== refreshVersion) return
      devices.value = result
      if (!result.some((device) => device.serial === selectedSerial.value && device.state === 'device')) {
        await select(result.find((device) => device.state === 'device')?.serial || '')
      }
    } catch (error) {
      if (!disposed && version === refreshVersion) showError(error, '设备列表读取失败')
    } finally {
      if (version === refreshVersion) loading.value = false
    }
  }

  async function connect(refreshDevices: () => Promise<void>, select: (value: string) => Promise<void>) {
    if (commandPending.value || connecting.value || switching.value || disposed) return false
    let address: string
    try {
      address = api.normalizeDeviceHost(host.value)
    } catch (error) {
      hostError.value = error instanceof Error ? error.message : '设备地址无效'
      return false
    }
    host.value = address
    hostError.value = ''
    connecting.value = true
    commandPending.value = true
    try {
      await api.connectDevice(address)
      if (disposed) return false
      log(`已连接 ${address}`)
      await refreshDevices()
      if (disposed) return false
      if (devices.value.some((device) => device.serial === address && device.state === 'device'))
        await select(address)
      return true
    } catch (error) {
      if (!disposed) {
        hostError.value = api.connectionErrorMessage(error)
        log(`连接 ${address} 失败：${hostError.value}`)
      }
      return false
    } finally {
      connecting.value = false
      commandPending.value = false
    }
  }

  async function run(action: (serial: string) => Promise<unknown>, message: string) {
    if (!canCommand.value || disposed) return false
    const serial = selectedSerial.value
    commandPending.value = true
    try {
      await action(serial)
      if (!disposed) log(message)
      return !disposed
    } catch (error) {
      if (!disposed) showError(error, '操作失败')
      return false
    } finally {
      commandPending.value = false
    }
  }

  async function detectHost() {
    if (!ready.value) return
    const serial = selectedSerial.value
    try {
      const result = await api.getHost(serial)
      if (!disposed && serial === selectedSerial.value) host.value = result.host
    } catch (error) {
      if (!disposed) showError(error, '地址读取失败')
    }
  }
  onBeforeUnmount(() => {
    disposed = true
  })
  return {
    devices,
    selectedSerial,
    selected,
    host,
    hostError,
    loading,
    connecting,
    switching,
    commandPending,
    ready,
    canCommand,
    options,
    caption,
    refresh,
    connect,
    run,
    detectHost,
  }
}
