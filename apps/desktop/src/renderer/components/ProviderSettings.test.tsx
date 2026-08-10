import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  ProviderSettingsDialog,
  type ProviderProfileSubmission,
  type ProviderProfileView
} from './ProviderSettings'

afterEach(cleanup)

describe('ProviderSettingsDialog', () => {
  it('links validation errors and clears write-only secrets before save completes', async () => {
    let finishSave!: () => void
    const save = vi.fn((_submission: ProviderProfileSubmission) => new Promise<void>((resolve) => {
      finishSave = resolve
    }))
    render(<ProviderSettingsDialog {...baseProps()} onSave={save} />)
    expect(screen.queryByRole('option', { name: /Anthropic/ })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Codex account' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))

    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }))
    expect((await screen.findByText('Enter a profile name.')).getAttribute('role')).toBe('alert')
    expect(screen.getByText('Enter a default model.').getAttribute('role')).toBe('alert')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Profile name/)))

    fireEvent.change(screen.getByLabelText(/Profile name/), { target: { value: 'Team gateway' } })
    fireEvent.click(screen.getByRole('combobox', { name: /Provider kind/ }))
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI-compatible' }))
    fireEvent.change(screen.getByLabelText(/Default model/), { target: { value: 'team-coder' } })
    fireEvent.change(screen.getByLabelText(/Custom models/), { target: { value: 'fast\nfast, precise' } })
    fireEvent.change(screen.getByLabelText(/Tool-capable models/), { target: { value: 'team-coder' } })
    fireEvent.change(screen.getByLabelText(/Vision-capable models/), { target: { value: 'team-coder' } })
    const baseUrl = screen.getByLabelText(/Base URL/)
    fireEvent.change(baseUrl, { target: { value: 'file:///private/models' } })
    fireEvent.blur(baseUrl)
    expect(await screen.findByText('Use an HTTP or HTTPS URL.')).toBeTruthy()
    for (const insecureUrl of [
      'http://models.example.test/v1',
      'http://localhost.example.test/v1'
    ]) {
      fireEvent.change(baseUrl, { target: { value: insecureUrl } })
      fireEvent.blur(baseUrl)
      expect(await screen.findByText(
        'Use HTTPS unless the host is exactly localhost, 127.0.0.1, or [::1].'
      )).toBeTruthy()
    }
    for (const localUrl of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:8080/v1'
    ]) {
      fireEvent.change(baseUrl, { target: { value: localUrl } })
      fireEvent.blur(baseUrl)
      await waitFor(() => expect(screen.queryByText(
        'Use HTTPS unless the host is exactly localhost, 127.0.0.1, or [::1].'
      )).toBeNull())
    }
    fireEvent.change(baseUrl, { target: { value: 'https://models.example.test/v1?api_key=bad' } })
    fireEvent.blur(baseUrl)
    expect(await screen.findByText('Remove query strings and fragments from the Base URL.')).toBeTruthy()
    fireEvent.change(baseUrl, { target: { value: 'https://models.example.test/v1' } })
    const secret = screen.getByLabelText('API key') as HTMLInputElement
    fireEvent.change(secret, { target: { value: 'CANARY-renderer-secret' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save).toHaveBeenCalledWith({
      name: 'Team gateway',
      kind: 'openai-compatible',
      baseUrl: 'https://models.example.test/v1',
      defaultModel: 'team-coder',
      customModels: ['fast', 'precise'],
      toolModels: ['team-coder'],
      visionModels: ['team-coder'],
      imageModels: [],
      secret: 'CANARY-renderer-secret'
    })
    expect(secret.value).toBe('')
    expect(screen.queryByDisplayValue('CANARY-renderer-secret')).toBeNull()

    finishSave()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save provider' }).textContent).toBe('Save provider'))
  })

  it('traps keyboard focus, closes with Escape, and restores the opener', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'Open settings'
    document.body.append(opener)
    opener.focus()
    const closed = vi.fn()

    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <ProviderSettingsDialog
          {...baseProps()}
          open={open}
          onClose={() => {
            closed()
            setOpen(false)
          }}
        />
      )
    }

    render(<Harness />)
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    const general = screen.getByRole('button', { name: 'General' })
    await waitFor(() => expect(document.activeElement).toBe(general))
    const close = screen.getByRole('button', { name: 'Close provider settings' })
    const done = screen.getByRole('button', { name: 'Done' })

    done.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    close.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(done)

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(closed).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it('selects, edits, and explicitly confirms deletion of provider profiles', async () => {
    const deleteProfile = vi.fn(async () => undefined)
    render(
      <ProviderSettingsDialog
        {...baseProps()}
        profiles={[savedProfile()]}
        codexAccount={{
          state: 'signed-in',
          accountLabel: 'dev@example.test',
          detail: 'Managed by the Codex desktop session.'
        }}
        onDelete={deleteProfile}
      />
    )

    expect(screen.getByRole('heading', { name: 'Codex account' }).parentElement?.textContent)
      .toContain('Signed in · dev@example.test')
    fireEvent.click(screen.getByRole('button', { name: /Team OpenAI/ }))
    await waitFor(() => expect((screen.getByLabelText(/Profile name/) as HTMLInputElement).value).toBe('Team OpenAI'))
    expect((screen.getByLabelText(/Default model/) as HTMLInputElement).value).toBe('gpt-team')
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
    expect(screen.getByText(/A credential is saved/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('Delete “Team OpenAI”? Threads using it will need another provider.').parentElement?.getAttribute('role')).toBe('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }))
    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith('provider-team'))
  })

  it('changes the global model provider from General settings', async () => {
    const changeProvider = vi.fn(async () => undefined)
    render(
      <ProviderSettingsDialog
        {...baseProps()}
        selectedProviderId="codex"
        onSelectedProviderChange={changeProvider}
      />
    )

    const provider = screen.getByRole('combobox', { name: 'Provider' })
    expect(provider.getAttribute('data-value')).toBe('codex')
    fireEvent.click(provider)
    fireEvent.click(screen.getByRole('option', { name: 'Echo demo' }))
    await waitFor(() => expect(changeProvider).toHaveBeenCalledWith('echo'))
  })

  it('shows details and actions for the currently selected Provider', async () => {
    const profile = {
      ...savedProfile(),
      baseUrl: 'https://models.example.test/v1'
    }
    const props = baseProps()

    function Harness() {
      const [selectedProviderId, setSelectedProviderId] = useState('codex')
      return (
        <ProviderSettingsDialog
          {...props}
          selectedProviderId={selectedProviderId}
          profiles={[profile]}
          providers={[
            ...props.providers,
            {
              id: profile.id,
              display_name: profile.name,
              kind: 'openai_responses',
              auth: 'configured',
              capabilities: {
                streaming: true,
                reasoning: true,
                model_catalog: true,
                custom_models: true
              },
              default_model: profile.defaultModel
            }
          ]}
          codexAccount={{
            state: 'signed-in',
            accountLabel: 'dev@example.test',
            detail: 'Codex Pro'
          }}
          onSelectedProviderChange={async (providerId) => setSelectedProviderId(providerId)}
        />
      )
    }

    render(<Harness />)
    expect(screen.getByRole('heading', { name: 'Codex account' })).toBeTruthy()

    fireEvent.click(screen.getByRole('combobox', { name: 'Provider' }))
    fireEvent.click(screen.getByRole('option', { name: 'Echo demo' }))
    expect(await screen.findByRole('heading', { name: 'Echo demo' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Codex account' })).toBeNull()
    expect(screen.getByText(/No account or API key required/)).toBeTruthy()

    fireEvent.click(screen.getByRole('combobox', { name: 'Provider' }))
    fireEvent.click(screen.getByRole('option', { name: 'Team OpenAI' }))
    expect(await screen.findByRole('heading', { name: 'Team OpenAI' })).toBeTruthy()
    expect(screen.getByText(/https:\/\/models\.example\.test\/v1/)).toBeTruthy()
    expect(screen.getByText(/Default model: gpt-team/)).toBeTruthy()
    expect(screen.getByText(/Credential saved/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }))
    await waitFor(() => expect((screen.getByLabelText(/Profile name/) as HTMLInputElement).value)
      .toBe('Team OpenAI'))
  })

  it('keeps signed-out Codex selectable so its account action remains reachable', async () => {
    const changeProvider = vi.fn(async () => undefined)
    const props = baseProps()
    render(
      <ProviderSettingsDialog
        {...props}
        providers={props.providers.map((provider) => provider.id === 'codex'
          ? { ...provider, auth: 'missing' as const }
          : provider)}
        selectedProviderId="echo"
        onSelectedProviderChange={changeProvider}
      />
    )

    fireEvent.click(screen.getByRole('combobox', { name: 'Provider' }))
    const codexOption = screen.getByRole('option', { name: 'Codex account · Setup required' })
    expect(codexOption.getAttribute('data-disabled')).toBeNull()
    fireEvent.click(codexOption)
    await waitFor(() => expect(changeProvider).toHaveBeenCalledWith('codex'))
  })
})

function baseProps() {
  return {
    open: true,
    providers: [
      {
        id: 'codex',
        display_name: 'Codex account',
        kind: 'codex_app_server',
        auth: 'configured' as const,
        capabilities: { streaming: true, reasoning: true, model_catalog: true, custom_models: false },
        default_model: 'codex-default'
      },
      {
        id: 'echo',
        display_name: 'Echo demo',
        kind: 'echo',
        auth: 'not_required' as const,
        capabilities: { streaming: true, reasoning: false, model_catalog: false, custom_models: false },
        default_model: 'kody-demo'
      }
    ],
    selectedProviderId: 'codex',
    profiles: [] as ProviderProfileView[],
    credentialStorage: { available: true, backend: 'keychain' },
    codexAccount: { state: 'signed-out' as const },
    onClose: vi.fn(),
    onSave: vi.fn(async (_profile: ProviderProfileSubmission) => undefined),
    onDelete: vi.fn(async (_profileId: string) => undefined),
    onSelectedProviderChange: vi.fn(async (_providerId: string) => undefined)
  }
}

function savedProfile(): ProviderProfileView {
  return {
    id: 'provider-team',
    name: 'Team OpenAI',
    kind: 'openai',
    defaultModel: 'gpt-team',
    customModels: ['gpt-team-fast'],
    toolModels: ['gpt-team'],
    visionModels: ['gpt-team'],
    imageModels: ['gpt-image-2'],
    hasSecret: true,
    updatedAt: '2026-07-13T00:00:00.000Z'
  }
}
