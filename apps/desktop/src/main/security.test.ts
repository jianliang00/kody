import { describe, expect, it } from 'vitest'
import { validateRpcInvocation } from './security'

describe('renderer RPC allowlist', () => {
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
})
