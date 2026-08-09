import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { Composer } from './Composer'

afterEach(cleanup)

describe('Composer provider and model selection', () => {
  it('uses two labelled selectors and sends an explicit provider/model pair', async () => {
    const send = vi.fn(async () => true)
    const permissionChange = vi.fn()
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
            model_catalog: true,
            custom_models: false
          },
          default_model: 'codex-default'
        }]}
        providerId="codex"
        models={[{ id: 'codex-default', display_name: 'Codex default', capabilities: { tool_calling: true, input_modalities: ['text', 'image'] } }]}
        model="codex-default"
        permissionMode="ask"
        running={false}
        message="Inspect the workspace"
        images={[]}
        onReferencesChange={vi.fn()}
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onPermissionModeChange={permissionChange}
        onMessageChange={vi.fn()}
        onImagesChange={vi.fn()}
        onSend={send}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByRole('combobox', { name: 'Provider' }).getAttribute('data-value')).toBe('codex')
    expect(screen.getByRole('combobox', { name: 'Model' }).getAttribute('data-value')).toBe('codex-default')
    expect(screen.getByRole('combobox', { name: 'Permission mode' }).getAttribute('data-value')).toBe('ask')
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).rows).toBe(2)
    expect(screen.queryByText('Uses the Codex agent loop and tools for this Turn.')).toBeNull()

    fireEvent.click(screen.getByRole('combobox', { name: 'Permission mode' }))
    fireEvent.click(screen.getByRole('option', { name: 'Read only' }))
    expect(permissionChange).toHaveBeenCalledWith('read_only')

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(
      'Inspect the workspace',
      [],
      [],
      'codex',
      'codex-default',
      'ask'
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
            model_catalog: false,
            custom_models: true
          },
          default_model: 'team-coder'
        }]}
        providerId=""
        models={[]}
        model=""
        permissionMode="ask"
        running={false}
        message="Hello"
        images={[]}
        onReferencesChange={vi.fn()}
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onPermissionModeChange={vi.fn()}
        onMessageChange={vi.fn()}
        onImagesChange={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('combobox', { name: 'Provider' }))
    const option = screen.getByRole('option', { name: 'Team gateway · setup required' })
    expect(option.getAttribute('aria-disabled')).toBe('true')
  })

  it('reads an attached image for a vision-capable model', async () => {
    const imagesChange = vi.fn()
    render(
      <Composer
        threads={[]}
        projects={[]}
        references={[]}
        providers={[{
          id: 'vision',
          display_name: 'Vision',
          kind: 'openai',
          auth: 'configured',
          capabilities: {
            streaming: true,
            reasoning: true,
            model_catalog: true,
            custom_models: true
          },
          default_model: 'vision-model'
        }]}
        providerId="vision"
        models={[{
          id: 'vision-model',
          display_name: 'Vision model',
          capabilities: { tool_calling: true, input_modalities: ['text', 'image'] }
        }]}
        model="vision-model"
        permissionMode="ask"
        running={false}
        message=""
        images={[]}
        onReferencesChange={vi.fn()}
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onPermissionModeChange={vi.fn()}
        onMessageChange={vi.fn()}
        onImagesChange={imagesChange}
        onSend={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect((screen.getByRole('button', { name: 'Attach image' }) as HTMLButtonElement).disabled).toBe(false)
    const file = new File(['image-bytes'], 'sample.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Image files'), { target: { files: [file] } })

    await waitFor(() => expect(imagesChange).toHaveBeenCalledWith([{
      file_name: 'sample.png',
      mime_type: 'image/png',
      data_base64: btoa('image-bytes')
    }]))
  })
})
