import { describe, expect, it } from 'vitest'
import { validateRpcInvocation } from './security'

describe('renderer RPC allowlist', () => {
  it('accepts only the strict Thread workflow update schema', () => {
    for (const workflowState of ['new_progress', 'deferred', 'handled']) {
      expect(() => validateRpcInvocation('thread/workflow/update', {
        thread_id: 'thread-1',
        workflow_state: workflowState
      })).not.toThrow()
    }
    expect(() => validateRpcInvocation('thread/workflow/update', {
      thread_id: 'thread-1',
      workflow_state: 'running'
    })).toThrow(/workflow_state/)
    expect(() => validateRpcInvocation('thread/workflow/update', {
      thread_id: 'thread-1'
    })).toThrow(/missing/)
    expect(() => validateRpcInvocation('thread/workflow/update', {
      thread_id: 'thread-1',
      workflow_state: 'handled',
      title: 'Unexpected mutation'
    })).toThrow(/unsupported/)
  })

  it('accepts bounded Process Manager methods', () => {
    expect(() => validateRpcInvocation('process/list', { thread_id: 'thread-1' })).not.toThrow()
    expect(() => validateRpcInvocation('process/get', {
      thread_id: 'thread-1',
      process_id: 'process-1'
    })).not.toThrow()
    expect(() => validateRpcInvocation('process/read-output', {
      thread_id: 'thread-1',
      process_id: 'process-1',
      after_cursor: 42,
      limit: 64 * 1024
    })).not.toThrow()
    expect(() => validateRpcInvocation('process/stop', {
      thread_id: 'thread-1',
      process_id: 'process-1'
    })).not.toThrow()
  })

  it('rejects unbounded output reads and unsupported stop controls', () => {
    expect(() => validateRpcInvocation('process/read-output', {
      thread_id: 'thread-1',
      process_id: 'process-1',
      limit: 256 * 1024 + 1
    })).toThrow(/limit/)
    expect(() => validateRpcInvocation('process/stop', {
      thread_id: 'thread-1',
      process_id: 'process-1',
      grace_ms: 1
    })).toThrow(/unsupported/)
  })

  it('accepts bounded structured user input and rejects extra or oversized values', () => {
    expect(() => validateRpcInvocation('user-input/respond', {
      interaction_id: 'interaction-1',
      answers: { approach: { answers: ['Recommended'] } },
      cancelled: false
    })).not.toThrow()
    expect(() => validateRpcInvocation('user-input/respond', {
      interaction_id: 'interaction-1',
      answers: {},
      cancelled: true
    })).not.toThrow()
    expect(() => validateRpcInvocation('user-input/respond', {
      interaction_id: 'interaction-1',
      answers: { secret: { answers: ['x'.repeat(32_769)] } },
      cancelled: false
    })).toThrow(/answer/)
    expect(() => validateRpcInvocation('user-input/respond', {
      interaction_id: 'interaction-1',
      answers: {},
      cancelled: false,
      unexpected: true
    })).toThrow(/unsupported/)
  })

  it('allows only explicit supported permission modes when starting a turn', () => {
    const params = {
      thread_id: 'thread-1',
      message: 'Inspect the project',
      images: [],
      references: [],
      provider: 'codex',
      model: 'codex-default',
      permission_mode: 'ask'
    }
    expect(() => validateRpcInvocation('turn/start', params)).not.toThrow()
    expect(() => validateRpcInvocation('turn/start', {
      ...params,
      permission_mode: 'unrestricted'
    })).toThrow(/permission_mode/)
    const { permission_mode: _omitted, ...withoutPermissionMode } = params
    expect(() => validateRpcInvocation('turn/start', withoutPermissionMode)).toThrow(/missing/)
  })

  it('accepts bounded image inputs and rejects empty or unsupported Turn content', () => {
    const params = {
      thread_id: 'thread-1',
      message: '',
      images: [{
        file_name: 'reference.png',
        mime_type: 'image/png',
        data_base64: 'aGVsbG8='
      }],
      references: [],
      provider: 'codex',
      permission_mode: 'ask'
    }
    expect(() => validateRpcInvocation('turn/start', params)).not.toThrow()
    expect(() => validateRpcInvocation('turn/start', { ...params, images: [] })).toThrow(/message or image/)
    expect(() => validateRpcInvocation('turn/start', {
      ...params,
      images: [{ ...params.images[0], mime_type: 'image/svg+xml' }]
    })).toThrow(/mime_type/)
    expect(() => validateRpcInvocation('turn/start', {
      ...params,
      images: Array.from({ length: 5 }, () => params.images[0])
    })).toThrow(/uploaded images/)
  })
})
