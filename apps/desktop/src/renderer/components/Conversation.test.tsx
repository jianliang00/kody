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
  HTMLElement.prototype.scrollTo = vi.fn()
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
    const scrollTo = HTMLElement.prototype.scrollTo as ReturnType<typeof vi.fn>
    scrollTo.mockClear()
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

    scrollTo.mockClear()
    rerender(<Conversation {...props} pendingApprovals={[approval]} bottomInset={120} />)
    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
    expect(container.querySelector('.conversation-end-spacer')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()

    scrollTo.mockClear()
    rerender(<Conversation {...props} pendingApprovals={[approval]} bottomInset={240} />)
    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
  })
})

describe('assistant Markdown line breaks', () => {
  const markdown = [
    'First line',
    'Second line',
    '',
    'Third paragraph',
    '',
    '- item one',
    '- item two',
    '',
    '```text',
    'alpha',
    'beta',
    '```'
  ].join('\n')

  it('preserves soft line breaks without changing paragraphs, lists, or code blocks', () => {
    const assistantSnapshot: ThreadSnapshot = {
      ...snapshot,
      messages: [{
        id: 'assistant-message',
        thread_id: snapshot.thread.id,
        role: 'assistant',
        parts: [{ type: 'text', text: markdown }],
        references: [],
        created_at: '2026-07-13T00:00:01Z'
      }]
    }
    const { container } = render(
      <Conversation
        snapshot={assistantSnapshot}
        threads={[snapshot.thread]}
        projects={[]}
        events={[]}
        pendingApprovals={[]}
        pendingUserInputs={[]}
        running={false}
        resolvingApprovals={new Set()}
        resolvingUserInputs={new Set()}
        bottomInset={140}
        onApproval={vi.fn(async () => undefined)}
        onUserInput={vi.fn(async () => undefined)}
      />
    )

    const renderedMarkdown = container.querySelector('.message--assistant .markdown')
    expect(renderedMarkdown?.querySelectorAll('p')).toHaveLength(2)
    expect(renderedMarkdown?.querySelector('p br')).toBeTruthy()
    expect(renderedMarkdown?.querySelectorAll('li')).toHaveLength(2)
    expect(renderedMarkdown?.querySelector('pre code')?.textContent).toBe('alpha\nbeta\n')
  })

  it('preserves a soft line break split across streaming deltas', () => {
    const { container } = render(
      <Conversation
        snapshot={{ ...snapshot, messages: [] }}
        threads={[snapshot.thread]}
        projects={[]}
        events={[
          {
            id: 'event-1',
            thread_id: snapshot.thread.id,
            turn_id: 'turn-1',
            sequence: 1,
            created_at: '2026-07-13T00:00:01Z',
            event: { type: 'model_output_delta', delta: 'First line\n' }
          },
          {
            id: 'event-2',
            thread_id: snapshot.thread.id,
            turn_id: 'turn-1',
            sequence: 2,
            created_at: '2026-07-13T00:00:02Z',
            event: { type: 'model_output_delta', delta: 'Second line' }
          }
        ]}
        pendingApprovals={[]}
        pendingUserInputs={[]}
        running
        resolvingApprovals={new Set()}
        resolvingUserInputs={new Set()}
        bottomInset={140}
        onApproval={vi.fn(async () => undefined)}
        onUserInput={vi.fn(async () => undefined)}
      />
    )

    expect(container.querySelector('.message--live .markdown p br')).toBeTruthy()
  })
})

describe('tool activity in messages', () => {
  const baseProps = {
    threads: [snapshot.thread],
    projects: [],
    pendingApprovals: [],
    pendingUserInputs: [],
    resolvingApprovals: new Set<string>(),
    resolvingUserInputs: new Set<string>(),
    bottomInset: 140,
    onApproval: vi.fn(async () => undefined),
    onUserInput: vi.fn(async () => undefined)
  }

  it('pairs a durable call with its result and keeps details collapsed by default', () => {
    const toolSnapshot: ThreadSnapshot = {
      ...snapshot,
      messages: [
        {
          id: 'assistant-tool-call',
          thread_id: snapshot.thread.id,
          turn_id: 'turn-tool',
          role: 'assistant',
          parts: [{
            type: 'tool_call',
            id: 'call-shell',
            name: 'shell',
            arguments: { command: 'cargo test --workspace', cwd: '/tmp/workspace-1' }
          }],
          references: [],
          created_at: '2026-07-13T00:00:01Z'
        },
        {
          id: 'tool-result',
          thread_id: snapshot.thread.id,
          turn_id: 'turn-tool',
          role: 'tool',
          parts: [{
            type: 'tool_result',
            tool_call_id: 'call-shell',
            name: 'shell',
            content: 'test result: ok',
            is_error: false,
            metadata: { exit_code: 0 }
          }],
          references: [],
          created_at: '2026-07-13T00:00:02Z'
        }
      ]
    }

    const { container } = render(
      <Conversation {...baseProps} snapshot={toolSnapshot} events={[]} running={false} />
    )

    const details = container.querySelector<HTMLDetailsElement>('.tool-activity')
    expect(details).toBeTruthy()
    expect(details?.open).toBe(false)
    expect(screen.getByText('Shell')).toBeTruthy()
    expect(screen.getByTitle('cargo test --workspace')).toBeTruthy()
    expect(screen.getAllByText('Done')).toHaveLength(1)
    expect(container.querySelectorAll('.tool-activity')).toHaveLength(1)

    fireEvent.click(details!.querySelector('summary')!)
    expect(details?.open).toBe(true)
    expect(screen.getByText('test result: ok')).toBeTruthy()
    expect(screen.getByText(/"exit_code": 0/)).toBeTruthy()
  })

  it('shows live tool execution and updates the same disclosure on completion', () => {
    const started = {
      id: 'event-tool-started',
      thread_id: snapshot.thread.id,
      turn_id: 'turn-tool',
      sequence: 1,
      created_at: '2026-07-13T00:00:01Z',
      event: {
        type: 'tool_started' as const,
        tool_call_id: 'call-read',
        name: 'read_file',
        arguments: { path: 'src/main.rs' }
      }
    }
    const { container, rerender } = render(
      <Conversation
        {...baseProps}
        snapshot={{ ...snapshot, messages: [] }}
        events={[started]}
        running
      />
    )

    expect(screen.getByText('Read file')).toBeTruthy()
    expect(screen.getByTitle('src/main.rs')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    expect(container.querySelector<HTMLDetailsElement>('.tool-activity')?.open).toBe(false)
    expect(container.querySelector('.thinking-dots')).toBeNull()

    rerender(
      <Conversation
        {...baseProps}
        snapshot={{ ...snapshot, messages: [] }}
        events={[
          started,
          {
            id: 'event-tool-completed',
            thread_id: snapshot.thread.id,
            turn_id: 'turn-tool',
            sequence: 2,
            created_at: '2026-07-13T00:00:02Z',
            event: {
              type: 'tool_completed',
              tool_call_id: 'call-read',
              name: 'read_file',
              content: 'fn main() {}',
              is_error: false,
              metadata: { bytes: 12 }
            }
          }
        ]}
        running
      />
    )

    expect(screen.getByText('Done')).toBeTruthy()
    expect(container.querySelectorAll('.tool-activity')).toHaveLength(1)
  })
})
