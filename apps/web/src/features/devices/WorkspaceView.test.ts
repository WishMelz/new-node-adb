import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, shallowMount, type VueWrapper } from '@vue/test-utils'
import TDesign from 'tdesign-vue-next'
import * as api from '../../api'
import DeviceActionsPanel from '../../components/device/DeviceActionsPanel.vue'
import DeviceConnectDialog from '../../components/device/DeviceConnectDialog.vue'
import DeviceToolbar from '../../components/device/DeviceToolbar.vue'
import DeviceRecordsDrawer from '../../components/device/DeviceRecordsDrawer.vue'
import WorkspaceView from './WorkspaceView.vue'

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listDevices: vi.fn(),
  listStreams: vi.fn(),
  listDeviceRecords: vi.fn(),
  connectDevice: vi.fn(),
  key: vi.fn(),
  inputText: vi.fn(),
  openApp: vi.fn(),
  disconnectDevice: vi.fn(),
  updateDeviceRecord: vi.fn(),
}))

describe('device workspace controls', () => {
  let wrapper: VueWrapper | undefined
  const device: api.Device = {
    serial: '192.0.2.10:5555',
    model: 'Test device',
    state: 'device',
    transport: 'network',
  }
  beforeEach(() => {
    vi.mocked(api.listDevices).mockResolvedValue([device])
    vi.mocked(api.listStreams).mockResolvedValue([])
    vi.mocked(api.listDeviceRecords).mockResolvedValue([])
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.resetAllMocks()
  })

  async function workspace() {
    wrapper = shallowMount(WorkspaceView)
    await flushPromises()
    return wrapper
  }

  it('edits notes in the drawer, keeps failed drafts and closes only after successful saving', async () => {
    const record = { ...device, lastConnectedAt: 1000, note: '测试机', online: true, reconnectable: true }
    wrapper = mount(DeviceRecordsDrawer, {
      props: {
        visible: true,
        pendingDelete: null,
        records: [record],
        loading: false,
        error: '',
        deleting: '',
        saving: '',
        using: '',
        busy: false,
      },
      global: {
        plugins: [TDesign],
        stubs: { TDrawer: { template: '<section><slot /></section>' }, TDialog: true },
      },
    })
    await flushPromises()
    expect(wrapper.get('.record-details strong').text()).toBe('测试机')
    expect(wrapper.get('.record-model').text()).toBe(device.model)
    await wrapper.get('button[aria-label^="编辑备注"]').trigger('click')
    const input = wrapper.get('input')
    expect(input.element.value).toBe('测试机')
    await input.setValue('客厅手机')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('update-note')).toEqual([[device.serial, '客厅手机']])
    await wrapper.setProps({ saving: device.serial })
    expect(input.attributes('disabled')).toBeDefined()
    expect(wrapper.get('button[aria-label="取消编辑"]').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('update-note')).toHaveLength(1)
    await wrapper.setProps({ saving: '', error: '设备备注保存失败，请重试' })
    expect(wrapper.get('input').element.value).toBe('客厅手机')
    await wrapper.get('form').trigger('submit')
    await wrapper.setProps({ saving: device.serial, error: '' })
    await wrapper.setProps({ saving: '', records: [{ ...record, note: '客厅手机' }] })
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.get('.record-details strong').text()).toBe('客厅手机')
    await wrapper.get('button[aria-label^="编辑备注"]').trigger('click')
    await wrapper.get('input').setValue('discard')
    await wrapper.get('button[aria-label="取消编辑"]').trigger('click')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.emitted('update-note')).toHaveLength(2)
    await wrapper.get('button[aria-label^="编辑备注"]').trigger('click')
    await wrapper.get('input').setValue('')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('update-note')?.at(-1)).toEqual([device.serial, ''])
  })

  it('saves notes, blocks duplicate writes and ignores stale refresh responses', async () => {
    const record: api.DeviceRecord = { ...device, lastConnectedAt: 1000, note: '' }
    vi.mocked(api.listDeviceRecords).mockResolvedValue([record])
    const view = await workspace()
    const drawer = view.getComponent(DeviceRecordsDrawer)
    let finishRefresh!: (records: api.DeviceRecord[]) => void
    vi.mocked(api.listDeviceRecords).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRefresh = resolve
      }),
    )
    drawer.vm.$emit('refresh')
    let finishSave!: (result: Awaited<ReturnType<typeof api.updateDeviceRecord>>) => void
    vi.mocked(api.updateDeviceRecord).mockReturnValueOnce(
      new Promise((resolve) => {
        finishSave = resolve
      }),
    )
    drawer.vm.$emit('update-note', device.serial, ' 客厅手机 ')
    drawer.vm.$emit('update-note', device.serial, 'duplicate')
    drawer.vm.$emit('refresh')
    await flushPromises()
    expect(drawer.props('saving')).toBe(device.serial)
    expect(api.updateDeviceRecord).toHaveBeenCalledExactlyOnceWith(device.serial, '客厅手机')
    finishSave({} as Awaited<ReturnType<typeof api.updateDeviceRecord>>)
    await flushPromises()
    finishRefresh([{ ...record, note: 'stale' }])
    await flushPromises()
    expect(drawer.props('records')[0].note).toBe('客厅手机')
    expect(drawer.props('loading')).toBe(false)
    expect(drawer.props('saving')).toBe('')
  })

  it('retains the previous note on failure and allows retrying with an empty note', async () => {
    vi.mocked(api.listDeviceRecords).mockResolvedValue([{ ...device, lastConnectedAt: 1000, note: '测试机' }])
    const view = await workspace()
    const drawer = view.getComponent(DeviceRecordsDrawer)
    vi.mocked(api.updateDeviceRecord).mockRejectedValueOnce(new Error('unavailable'))
    drawer.vm.$emit('update-note', device.serial, '新备注')
    await flushPromises()
    expect(drawer.props('records')[0].note).toBe('测试机')
    expect(drawer.props('error')).toContain('保存失败')
    expect(drawer.props('saving')).toBe('')
    drawer.vm.$emit('update-note', device.serial, ' ')
    await flushPromises()
    expect(drawer.props('records')[0].note).toBe('')
    expect(drawer.props('error')).toBe('')
  })

  it('keeps device actions visible and routes commands to the selected device without starting a stream', async () => {
    const view = await workspace()
    const actions = view.getComponent(DeviceActionsPanel)
    expect(actions.props('canCommand')).toBe(true)
    expect(actions.props('canDisconnect')).toBe(true)
    actions.vm.$emit('action', 'wake', '唤醒')
    await flushPromises()
    expect(api.key).toHaveBeenCalledExactlyOnceWith(device.serial, 'wake')
    actions.vm.$emit('update:input', 'hello')
    actions.vm.$emit('send')
    await flushPromises()
    expect(api.inputText).toHaveBeenCalledExactlyOnceWith(device.serial, 'hello')
    expect(actions.props('input')).toBe('')
    actions.vm.$emit('update:packageName', ' com.example.app ')
    actions.vm.$emit('launch')
    await flushPromises()
    expect(api.openApp).toHaveBeenCalledExactlyOnceWith(device.serial, 'com.example.app')
  })

  it('disables device actions when offline and disables disconnect for USB', async () => {
    vi.mocked(api.listDevices).mockResolvedValue([{ ...device, transport: 'usb' }])
    const view = await workspace()
    expect(view.getComponent(DeviceActionsPanel).props('canDisconnect')).toBe(false)
    vi.mocked(api.listDevices).mockResolvedValue([])
    view.getComponent(DeviceToolbar).vm.$emit('refresh')
    await flushPromises()
    expect(view.getComponent(DeviceActionsPanel).props('canCommand')).toBe(false)
    view.getComponent(DeviceActionsPanel).vm.$emit('action', 'wake', '唤醒')
    await flushPromises()
    expect(api.key).not.toHaveBeenCalled()
  })

  it('opens the connection dialog from the toolbar and closes it only on success', async () => {
    const view = await workspace()
    view.getComponent(DeviceToolbar).vm.$emit('add')
    await flushPromises()
    const dialog = view.getComponent(DeviceConnectDialog)
    expect(dialog.props('visible')).toBe(true)
    dialog.vm.$emit('update:host', 'invalid/address')
    await flushPromises()
    dialog.vm.$emit('connect')
    await flushPromises()
    expect(api.connectDevice).not.toHaveBeenCalled()
    expect(dialog.props('hostError')).toContain('地址格式')
    expect(dialog.props('visible')).toBe(true)
    vi.mocked(api.connectDevice).mockRejectedValueOnce(new Error('offline'))
    dialog.vm.$emit('update:host', '192.0.2.20')
    await flushPromises()
    dialog.vm.$emit('connect')
    await flushPromises()
    expect(dialog.props('visible')).toBe(true)
    expect(dialog.props('hostError')).toContain('连接失败')
    vi.mocked(api.listDevices).mockResolvedValue([device, { ...device, serial: '192.0.2.20:5555' }])
    dialog.vm.$emit('connect')
    await flushPromises()
    expect(api.connectDevice).toHaveBeenLastCalledWith('192.0.2.20:5555')
    expect(dialog.props('visible')).toBe(false)
    expect(view.getComponent(DeviceActionsPanel).props('selectedSerial')).toBe('192.0.2.20:5555')
  })

  it('shows screenshot and add controls without a running stream and removes the more entry', async () => {
    wrapper = mount(DeviceToolbar, {
      props: {
        selectedSerial: device.serial,
        deviceOptions: [{ label: device.model, value: device.serial }],
        switching: false,
        loadingStream: false,
        loadingDevice: false,
        activeStream: false,
        loadingScreen: false,
        fullscreen: false,
        expanded: false,
        isReady: true,
        canTouch: false,
        connectionLabel: '设备已连接',
      },
      global: { plugins: [TDesign] },
    })
    await wrapper.get('button[aria-label="下载截图"]').trigger('click')
    await wrapper.get('.device-picker button[aria-label="添加设备"]').trigger('click')
    expect(wrapper.emitted('screenshot')).toHaveLength(1)
    expect(wrapper.emitted('add')).toHaveLength(1)
    expect(wrapper.find('[aria-label="更多"]').exists()).toBe(false)
  })

  it('submits visible input forms and blocks empty or busy commands', async () => {
    wrapper = mount(DeviceActionsPanel, {
      props: {
        input: 'hello',
        packageName: 'com.example.app',
        selectedSerial: device.serial,
        canCommand: true,
        canDisconnect: true,
      },
      global: { plugins: [TDesign] },
    })
    const forms = wrapper.findAll('form')
    await forms[0]!.trigger('submit')
    await forms[1]!.trigger('submit')
    await wrapper.get('button[aria-label="音量 -"]').trigger('click')
    expect(wrapper.emitted('send')).toHaveLength(1)
    expect(wrapper.emitted('launch')).toHaveLength(1)
    expect(wrapper.emitted('action')).toEqual([['volumeDown', '音量 -']])
    await wrapper.setProps({ input: ' ', packageName: ' ' })
    await forms[0]!.trigger('submit')
    await forms[1]!.trigger('submit')
    await wrapper.setProps({
      input: 'hello',
      packageName: 'com.example.app',
      canCommand: false,
      canDisconnect: false,
    })
    await forms[0]!.trigger('submit')
    await forms[1]!.trigger('submit')
    expect(wrapper.emitted('send')).toHaveLength(1)
    expect(wrapper.emitted('launch')).toHaveLength(1)
    expect(wrapper.findAll('button').every((button) => button.attributes('disabled') !== undefined)).toBe(
      true,
    )
  })
})
