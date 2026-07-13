import { describe, expect, it } from 'vitest'
import { shouldRefreshProcessSnapshot } from './processes'

describe('Process event reconciliation', () => {
  it('keeps output on the cursor path and refreshes lifecycle snapshots', () => {
    expect(shouldRefreshProcessSnapshot({
      type: 'output',
      stream: 'stdout',
      cursor: 0,
      next_cursor: 2
    })).toBe(false)
    expect(shouldRefreshProcessSnapshot({ type: 'started', pid: 42 })).toBe(true)
    expect(shouldRefreshProcessSnapshot({ type: 'stopping' })).toBe(true)
    expect(shouldRefreshProcessSnapshot({ type: 'stopped', forced: false })).toBe(true)
    expect(shouldRefreshProcessSnapshot({ type: 'lost', reason: 'server restarted' })).toBe(true)
  })
})
