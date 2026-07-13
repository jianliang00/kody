import { describe, expect, it } from 'vitest'
import type { Thread } from '@shared/protocol'
import { ThreadProjectionLedger } from './threadProjection'

function thread(title: string): Thread {
  return {
    id: '019f59e3-8ecd-79c1-bc26-0b18f6650538',
    workspace_id: '019f59e3-8ecd-79c1-bc26-0b18f6650539',
    title,
    status: 'idle',
    default_references: [],
    created_at: '2026-07-13T00:00:00Z',
    updated_at: '2026-07-13T00:00:00Z'
  }
}

describe('ThreadProjectionLedger', () => {
  it('does not let an older placeholder snapshot overwrite a pushed title', () => {
    const ledger = new ThreadProjectionLedger()
    ledger.observeTitle(thread('New thread').id, 'Generated title')

    expect(ledger.reconcile(thread('New thread')).title).toBe('Generated title')
  })

  it('learns the durable generated title for later stale list responses', () => {
    const ledger = new ThreadProjectionLedger()
    ledger.reconcile(thread('Durable title'))

    expect(ledger.reconcileAll([thread('New thread')])[0]?.title).toBe('Durable title')
  })
})
