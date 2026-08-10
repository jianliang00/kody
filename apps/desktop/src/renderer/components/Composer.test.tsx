import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { Composer } from './Composer'

afterEach(cleanup)

describe('Composer model options', () => {
  it('keeps Provider out of the composer and sends model, effort, and Speedy settings', async () => {
    const send = vi.fn(async () => true)
    const permissionChange = vi.fn()
    render(
      <Composer
        threads={[]}
        projects={[]}
        references={[]}
        providerId="codex"
        providerName="Codex account"
        models={[{
          id: 'codex-default',
          display_name: 'Codex default',
          capabilities: { tool_calling: true, input_modalities: ['text', 'image'] },
          default_reasoning_effort: 'medium',
          reasoning_efforts: ['low', 'medium', 'high'],
          supports_speedy: true
        }]}
        model="codex-default"
        reasoningEffort="medium"
        speedy
        permissionMode="ask"
        running={false}
        message="Inspect the workspace"
        images={[]}
        onReferencesChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onSpeedyChange={vi.fn()}
        onPermissionModeChange={permissionChange}
        onMessageChange={vi.fn()}
        onImagesChange={vi.fn()}
        onSend={send}
        onCancel={vi.fn()}
      />
    )

    expect(screen.queryByRole('combobox', { name: 'Provider' })).toBeNull()
    const modelMenu = screen.getByRole('button', { name: 'Model options: Codex default' })
    expect(modelMenu.getAttribute('data-model')).toBe('codex-default')
    expect(modelMenu.getAttribute('data-effort')).toBe('medium')
    expect(modelMenu.getAttribute('data-speedy')).toBe('true')
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
      'medium',
      true,
      'ask'
    ))
  })

  it('routes missing Provider setup to Settings without showing a Provider list', () => {
    const openSettings = vi.fn()
    render(
      <Composer
        threads={[]}
        projects={[]}
        references={[]}
        providerId=""
        providerName="Team gateway"
        models={[]}
        model=""
        reasoningEffort=""
        speedy={false}
        permissionMode="ask"
        running={false}
        message="Hello"
        images={[]}
        onReferencesChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onSpeedyChange={vi.fn()}
        onPermissionModeChange={vi.fn()}
        onMessageChange={vi.fn()}
        onImagesChange={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        onOpenProviderSettings={openSettings}
      />
    )

    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('combobox', { name: 'Provider' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Set up Team gateway…' }))
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('reads an attached image for a vision-capable model', async () => {
    const imagesChange = vi.fn()
    render(
      <Composer
        threads={[]}
        projects={[]}
        references={[]}
        providerId="vision"
        providerName="Vision"
        models={[{
          id: 'vision-model',
          display_name: 'Vision model',
          capabilities: { tool_calling: true, input_modalities: ['text', 'image'] }
        }]}
        model="vision-model"
        reasoningEffort=""
        speedy={false}
        permissionMode="ask"
        running={false}
        message=""
        images={[]}
        onReferencesChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onSpeedyChange={vi.fn()}
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
