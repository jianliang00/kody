import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { Composer } from './Composer'

afterEach(cleanup)

describe('Composer provider and model selection', () => {
  it('uses two labelled selectors and sends an explicit provider/model pair', async () => {
    const send = vi.fn(async () => true)
    render(
      <Composer
        threads={[]}
        projects={[]}
        references={[]}
        providers={[{
          id: 'codex',
          display_name: 'Codex account',
          kind: 'codex',
          auth: 'configured',
          capabilities: {
            streaming: true,
            reasoning: true,
            tools: true,
            model_catalog: true,
            custom_models: false
          },
          default_model: 'codex-default'
        }]}
        providerId="codex"
        models={[{ id: 'codex-default', display_name: 'Codex default' }]}
        model="codex-default"
        running={false}
        message="Inspect the workspace"
        onReferencesChange={vi.fn()}
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onMessageChange={vi.fn()}
        onSend={send}
        onCancel={vi.fn()}
      />
    )

    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('codex')
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('codex-default')
    expect(screen.getByText('Uses the Codex agent loop and tools for this Turn.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(
      'Inspect the workspace',
      [],
      'codex',
      'codex-default'
    ))
  })

  it('marks providers without authentication as requiring setup', () => {
    render(
      <Composer
        threads={[]}
        projects={[]}
        references={[]}
        providers={[{
          id: 'team',
          display_name: 'Team gateway',
          kind: 'openai-compatible',
          auth: 'missing',
          capabilities: {
            streaming: true,
            reasoning: false,
            tools: true,
            model_catalog: false,
            custom_models: true
          },
          default_model: 'team-coder'
        }]}
        providerId=""
        models={[]}
        model=""
        running={false}
        message="Hello"
        onReferencesChange={vi.fn()}
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onMessageChange={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    const option = screen.getByRole('option', { name: 'Team gateway · setup required' }) as HTMLOptionElement
    expect(option.disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
