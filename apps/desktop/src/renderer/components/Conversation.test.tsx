import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { PendingUserInput, ThreadSnapshot } from '@shared/protocol'
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
