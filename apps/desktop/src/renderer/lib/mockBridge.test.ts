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
      images: [],
      references: [],
      provider: 'echo',
      model: 'kody-demo',
      permission_mode: 'ask'
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

describe('browser mock Thread workflow', () => {
  it('creates empty Threads as deferred and marks completed work as new progress', async () => {
    vi.useFakeTimers()
    const bridge = createMockBridge()
    const startRequest = bridge.rpc('thread/create-and-start', {
      client_request_id: 'workflow-preview-test',
      message: 'Review this workspace',
      images: [],
      references: [],
      provider: 'echo',
      model: 'kody-demo',
      permission_mode: 'ask'
    })

    await vi.advanceTimersByTimeAsync(300)
    const started = await startRequest
    expect(started.thread.workflow_state).toBe('deferred')

    await vi.advanceTimersByTimeAsync(1_200)
    const completedSnapshotRequest = bridge.rpc('thread/get', { thread_id: started.thread.id })
    await vi.advanceTimersByTimeAsync(100)
    const completedSnapshot = await completedSnapshotRequest
    expect(completedSnapshot.thread.status).toBe('idle')
    expect(completedSnapshot.thread.workflow_state).toBe('new_progress')
  })

  it('updates the list and snapshot and keeps repeated requests idempotent', async () => {
    vi.useFakeTimers()
    const bridge = createMockBridge()

    const firstUpdateRequest = bridge.rpc('thread/workflow/update', {
      thread_id: 'thread-agent-loop',
      workflow_state: 'handled'
    })
    await vi.advanceTimersByTimeAsync(100)
    const firstUpdate = await firstUpdateRequest
    expect(firstUpdate.workflow_state).toBe('handled')

    const repeatedUpdateRequest = bridge.rpc('thread/workflow/update', {
      thread_id: 'thread-agent-loop',
      workflow_state: 'handled'
    })
    await vi.advanceTimersByTimeAsync(100)
    const repeatedUpdate = await repeatedUpdateRequest
    expect(repeatedUpdate).toEqual(firstUpdate)

    const listRequest = bridge.rpc('thread/list', {})
    const snapshotRequest = bridge.rpc('thread/get', { thread_id: 'thread-agent-loop' })
    await vi.advanceTimersByTimeAsync(100)
    const [list, snapshot] = await Promise.all([listRequest, snapshotRequest])
    expect(list.threads.find((thread) => thread.id === 'thread-agent-loop')).toEqual(firstUpdate)
    expect(snapshot.thread).toEqual(firstUpdate)
  })

  it('rejects workflow changes while a Thread is running', async () => {
    vi.useFakeTimers()
    const bridge = createMockBridge()
    const turnRequest = bridge.rpc('turn/start', {
      thread_id: 'thread-electron',
      message: 'Keep working',
      images: [],
      references: [],
      provider: 'echo',
      model: 'kody-demo',
      permission_mode: 'ask'
    })
    await vi.advanceTimersByTimeAsync(100)
    await turnRequest

    const updateRequest = bridge.rpc('thread/workflow/update', {
      thread_id: 'thread-electron',
      workflow_state: 'deferred'
    })
    const updateExpectation = expect(updateRequest).rejects.toThrow(/running Thread/)
    await vi.advanceTimersByTimeAsync(100)
    await updateExpectation
  })
})
