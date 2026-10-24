import axios, { isAxiosError } from 'axios'

export interface Device {
  serial: string
  state: string
  model: string
  transport: 'network' | 'usb'
}

export interface DeviceRecord extends Omit<Device, 'state'> {
  lastConnectedAt: number
}

export interface StreamSummary {
  id: string
  serial: string
  createdAt: number
  clientCount: number
  started: boolean
  deviceSize?: { width: number; height: number }
}

const http = axios.create({ baseURL: '/api', timeout: 30_000, withCredentials: true })
http.interceptors.response.use(response => response, error => {
  if (error.response?.status === 401 && !error.config?.url?.includes('/auth/login')) window.dispatchEvent(new Event('auth-expired'))
  return Promise.reject(error)
})

export async function login(password: string) { return http.post('/auth/login', { password }) }
export async function session() { return http.get('/auth/session') }
export async function logout() { return http.post('/auth/logout') }
export async function listDevices() { return (await http.get<Device[]>('/devices')).data }
export async function listDeviceRecords() { return (await http.get<DeviceRecord[]>('/devices/records')).data }
export async function deleteDeviceRecord(serial: string) { return http.delete(`/devices/records/${encodeURIComponent(serial)}`) }
export function normalizeDeviceHost(value: string) {
  const address = value.trim()
  if (!address) throw new Error('请输入设备 IP 或主机名')
  const match = address.match(/^([A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9a-fA-F:]+\])(?::(\d+))?$/)
  if (!match) throw new Error('地址格式不正确，例如 192.168.1.10:5555')
  const hostname = match[1]
  const port = match[2] === undefined ? 5555 : Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口号必须在 1-65535 之间')
  try { new URL(`http://${hostname}:${port}`) }
  catch { throw new Error('设备地址无效，请检查 IP 或主机名') }
  return `${hostname}:${port}`
}

export function connectionErrorMessage(error: unknown) {
  if (isAxiosError(error)) {
    if (error.response?.status === 401) return '登录已过期，请重新登录'
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.response?.status === 504) return '连接超时，请检查设备网络和 ADB 端口'
    if (!error.response) return '无法访问服务，请检查网络后重试'
  }
  return '连接失败，请确认设备地址、端口及 ADB 调试状态'
}

export async function connectDevice(host: string) { return http.post('/devices/connect', { host }) }
export async function disconnectDevice(serial: string) { return http.post('/devices/disconnect', { serial }) }
export async function getHost(serial: string) { return (await http.get<{ host: string }>(`/devices/${encodeURIComponent(serial)}/host`)).data }
export async function screenshot(serial: string) { return (await http.get(`/devices/${encodeURIComponent(serial)}/screenshot`, { responseType: 'blob' })).data as Blob }
export async function tap(serial: string, x: number, y: number) { return http.post('/devices/tap', { serial, x, y }) }
export async function swipe(serial: string, startX: number, startY: number, endX: number, endY: number, duration = 300) { return http.post('/devices/swipe', { serial, startX, startY, endX, endY, duration }) }
export async function key(serial: string, keyName: string) { return http.post('/devices/key', { serial, key: keyName }) }
export async function openApp(serial: string, packageName: string) { return http.post('/devices/app', { serial, packageName }) }
export async function inputText(serial: string, text: string) { return http.post('/devices/text', { serial, text }) }
export async function startStream(serial: string) { return (await http.post<StreamSummary>('/streams', { serial, maxSize: 1280, maxFps: 30, bitRate: 4_000_000 })).data }
export async function listStreams() { return (await http.get<StreamSummary[]>('/streams')).data }
export async function stopStream(id: string) { return http.delete(`/streams/${encodeURIComponent(id)}`) }