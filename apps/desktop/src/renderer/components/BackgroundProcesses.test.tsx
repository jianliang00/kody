import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ManagedProcess, ProcessOutputPage } from '@shared/protocol'
import { BackgroundProcesses } from './BackgroundProcesses'

const now = '2026-07-13T00:00:00.000Z'

afterEach(cleanup)

describe('BackgroundProcesses', () => {
  it('reads bounded output by cursor and exposes a non-live log', async () => {
    const process = managedProcess()
    process.output_truncated = true
    const firstPage: ProcessOutputPage = {
      process_id: process.id,
      requested_cursor: 0,
      start_cursor: 0,
      next_cursor: 5,
      end_cursor: 5,
      truncated: false,
      has_more: false,
      chunks: [{ stream: 'stdout', cursor: 0, next_cursor: 5, bytes: [104, 101, 108, 108, 111], text: 'hello' }]
    }
    const secondPage: ProcessOutputPage = {
      ...firstPage,
      requested_cursor: 5,
      start_cursor: 5,
      next_cursor: 11,
      end_cursor: 11,
      chunks: [{ stream: 'stderr', cursor: 5, next_cursor: 11, bytes: [10, 119, 97, 114, 110], text: '\nwarn' }]
    }
    const readOutput = vi.fn(async (_processId: string, afterCursor: number) => (
      afterCursor === 0 ? firstPage : secondPage
    ))

    render(
      <BackgroundProcesses
        processes={[process]}
        projects={[]}
        stoppingProcessIds={new Set()}
        liveOutputCursors={{ [process.id]: 11 }}
        onReadOutput={readOutput}
        onStop={vi.fn(async () => undefined)}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'View output' }))
    const log = await screen.findByRole('log', { name: `Output for ${process.command}` })
    expect(log.getAttribute('aria-live')).toBe('off')
    expect(log.textContent).toBe('hello')
    expect(screen.getByText('Earlier output omitted')).toBeTruthy()
    expect(readOutput).toHaveBeenLastCalledWith(process.id, 0, 64 * 1024)

    fireEvent.click(screen.getByRole('button', { name: 'Read new output' }))
    await waitFor(() => expect(log.textContent).toBe('hello[stderr] \nwarn'))
    expect(readOutput).toHaveBeenLastCalledWith(process.id, 5, 64 * 1024)
  })

  it('presents an explicit stopping state instead of allowing duplicate stops', () => {
    const process = managedProcess()
    render(
      <BackgroundProcesses
        processes={[{ ...process, status: 'stopping' }]}
        projects={[]}
        stoppingProcessIds={new Set([process.id])}
        liveOutputCursors={{}}
        onReadOutput={vi.fn()}
        onStop={vi.fn()}
      />
    )

    const stop = screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    expect(screen.getByText('Stopping', { selector: '.process-status' })).toBeTruthy()
  })

  it('keeps terminal history compact until the user asks for older records', () => {
    const processes = Array.from({ length: 10 }, (_, index) => ({
      ...managedProcess(),
      id: `process-${index}`,
      status: 'exited' as const,
      exit_code: 0,
      created_at: new Date(Date.parse(now) - index * 1_000).toISOString()
    }))
    const { container } = render(
      <BackgroundProcesses
        processes={processes}
        projects={[]}
        stoppingProcessIds={new Set()}
        liveOutputCursors={{}}
        onReadOutput={vi.fn()}
        onStop={vi.fn()}
      />
    )

    expect(container.querySelectorAll('.process-card')).toHaveLength(8)
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 older process records' }))
    expect(container.querySelectorAll('.process-card')).toHaveLength(10)
  })
})

function managedProcess(): ManagedProcess {
  return {
    id: 'process-web',
    thread_id: 'thread-current',
    origin: { turn_id: 'turn-current', tool_call_id: 'tool-process' },
    spec_fingerprint: 'a'.repeat(64),
    project_id: 'project-web',
    command: 'npm run dev',
    cwd: '/projects/web',
    pid: 4242,
    process_group_id: 4242,
    status: 'running',
    output_truncated: false,
    output_start_cursor: 0,
    output_end_cursor: 5,
    last_event_sequence: 2,
    created_at: now,
    started_at: now
  }
}
