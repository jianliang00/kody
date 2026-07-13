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
})
