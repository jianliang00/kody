import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMockBridge } from './mockBridge'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('browser mock approvals', () => {
  it('persists pending command approvals until the user responds', async () => {
    vi.useFakeTimers()
    const bridge = createMockBridge()
    const startedRequest = bridge.rpc('thread/create-and-start', {
      client_request_id: 'approval-preview-test',
      message: 'Run cargo test for this project',
      references: [],
      provider: 'echo',
      model: 'kody-demo'
    })

    await vi.advanceTimersByTimeAsync(300)
    const started = await startedRequest
    await vi.advanceTimersByTimeAsync(1_100)

    const pendingSnapshotRequest = bridge.rpc('thread/get', { thread_id: started.thread.id })
    await vi.advanceTimersByTimeAsync(100)
    const pendingSnapshot = await pendingSnapshotRequest
    expect(pendingSnapshot.pending_approvals).toHaveLength(1)
    expect(pendingSnapshot.pending_approvals[0]?.arguments).toMatchObject({
      command: 'cargo test --workspace'
    })

    const approvalId = pendingSnapshot.pending_approvals[0]?.approval_id
    expect(approvalId).toBeTruthy()
    const responseRequest = bridge.rpc('approval/respond', {
      approval_id: approvalId ?? '',
      approved: false
    })
    await vi.advanceTimersByTimeAsync(100)
    await expect(responseRequest).resolves.toEqual({ resolved: true })

    const resolvedSnapshotRequest = bridge.rpc('thread/get', { thread_id: started.thread.id })
    await vi.advanceTimersByTimeAsync(100)
    const resolvedSnapshot = await resolvedSnapshotRequest
    expect(resolvedSnapshot.pending_approvals).toEqual([])
  })
})
