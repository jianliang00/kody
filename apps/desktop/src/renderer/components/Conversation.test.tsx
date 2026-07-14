import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { PendingApproval, PendingUserInput, ThreadSnapshot } from '@shared/protocol'
import { Conversation } from './Conversation'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(cleanup)

const pending: PendingUserInput = {
  interaction_id: 'interaction-1',
  thread_id: 'thread-1',
  turn_id: 'turn-1',
  item_id: 'item-1',
  questions: [
    {
      id: 'approach',
      header: 'Approach',
      question: 'Which implementation should Kody use?',
      is_other: true,
      is_secret: false,
      options: [
        { label: 'Safe default', description: 'Use the proven implementation.' },
        { label: 'Experimental', description: 'Try the newer implementation.' }
      ]
    },
    {
      id: 'token',
      header: 'Temporary token',
      question: 'Enter the one-time token.',
      is_other: false,
      is_secret: true,
      options: [{ label: 'Do not expose this choice', description: 'Secret metadata.' }]
    }
  ]
}

const snapshot: ThreadSnapshot = {
  thread: {
    id: 'thread-1',
    title: 'Input test',
    workspace_id: 'workspace-1',
    status: 'running',
    default_references: [],
    created_at: '2026-07-13T00:00:00Z',
    updated_at: '2026-07-13T00:00:00Z'
  },
  workspace: {
    id: 'workspace-1',
    thread_id: 'thread-1',
    root: '/tmp/workspace-1',
    created_at: '2026-07-13T00:00:00Z'
  },
  messages: [],
  turns: [],
  pending_approvals: [],
  pending_user_inputs: [pending],
  processes: []
}

function renderConversation(onUserInput = vi.fn(async () => undefined)) {
  render(
    <Conversation
      snapshot={snapshot}
      threads={[snapshot.thread]}
      projects={[]}
      events={[]}
      pendingApprovals={[]}
      pendingUserInputs={[pending]}
      running
      resolvingApprovals={new Set()}
      resolvingUserInputs={new Set()}
      bottomInset={140}
      onApproval={vi.fn(async () => undefined)}
      onUserInput={onUserInput}
    />
  )
  return onUserInput
}

describe('structured user input', () => {
  it('renders labelled choices, Other text, and a protected secret field', async () => {
    const respond = renderConversation()

    fireEvent.click(screen.getByLabelText(/^Other/))
    fireEvent.change(screen.getByLabelText('Other answer'), { target: { value: 'My approach' } })
    const secretInput = screen.getByLabelText(/^Your answer/) as HTMLInputElement
    expect(secretInput.type).toBe('password')
    expect(screen.queryByText('Do not expose this choice')).toBeNull()
    fireEvent.change(secretInput, { target: { value: 'one-time-secret' } })
    expect(document.body.textContent).not.toContain('one-time-secret')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith(
      'interaction-1',
      {
        approach: { answers: ['My approach'] },
        token: { answers: ['one-time-secret'] }
      },
      false
    ))
  })

  it('keeps submit available, reports missing answers, and supports cancellation', async () => {
    const respond = renderConversation()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('alert').textContent).toContain('Approach')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith('interaction-1', {}, true))
  })
})

describe('conversation bottom safe area', () => {
  it('keeps pending approval controls above a growing composer', async () => {
    const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
    scrollIntoView.mockClear()
    const approval: PendingApproval = {
      approval_id: 'approval-1',
      thread_id: snapshot.thread.id,
      turn_id: 'turn-1',
      tool_call_id: 'tool-1',
      name: 'shell',
      arguments: { command: 'cargo test --workspace', cwd: '/tmp/workspace-1' },
      reason: 'This command executes code.'
    }
    const props = {
      snapshot,
      threads: [snapshot.thread],
      projects: [],
      events: [],
      pendingUserInputs: [],
      running: true,
      resolvingApprovals: new Set<string>(),
      resolvingUserInputs: new Set<string>(),
      onApproval: vi.fn(async () => undefined),
      onUserInput: vi.fn(async () => undefined)
    }
    const { container, rerender } = render(
      <Conversation {...props} pendingApprovals={[]} bottomInset={120} />
    )

    scrollIntoView.mockClear()
    rerender(<Conversation {...props} pendingApprovals={[approval]} bottomInset={120} />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect(container.querySelector('.conversation-end-spacer')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()

    scrollIntoView.mockClear()
    rerender(<Conversation {...props} pendingApprovals={[approval]} bottomInset={240} />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
  })
})
