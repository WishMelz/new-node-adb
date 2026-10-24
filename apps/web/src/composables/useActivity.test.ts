import { AxiosError } from 'axios'
import { describe, expect, it, vi } from 'vitest'
import { MessagePlugin } from 'tdesign-vue-next'
import { useActivity } from './useActivity'

vi.mock('tdesign-vue-next', () => ({ MessagePlugin: { error: vi.fn() } }))

describe('activity messages', () => {
  it('shows one dismissible toast and retains the error in the activity log', () => {
    const activity = useActivity()
    activity.showError(new Error('private detail'), 'Connection interrupted')
    expect(MessagePlugin.error).toHaveBeenCalledExactlyOnceWith({
      content: 'Connection interrupted',
      duration: 5000,
      closeBtn: true,
    })
    expect(activity.items.value).toHaveLength(1)
    expect(activity.items.value[0]?.message).toBe('Connection interrupted')
    expect(activity).not.toHaveProperty('errorMessage')
  })

  it.each([
    [400, 'Invalid request'],
    [500, 'Operation failed'],
  ])('keeps safe error handling for HTTP %s', (status, expected) => {
    const activity = useActivity()
    const error = Object.assign(new AxiosError(), {
      response: { status, data: { message: 'Invalid request' } },
    })
    activity.showError(error, 'Operation failed')
    expect(MessagePlugin.error).toHaveBeenCalledExactlyOnceWith({
      content: expected,
      duration: 5000,
      closeBtn: true,
    })
  })
})
