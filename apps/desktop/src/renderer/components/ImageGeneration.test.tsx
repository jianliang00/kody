import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Artifact, ImageModelDescriptor, ImageProviderDescriptor } from '@shared/protocol'
import { ArtifactCard } from './ArtifactCard'
import { ImageComposer } from './ImageComposer'

afterEach(cleanup)

const provider: ImageProviderDescriptor = {
  id: 'openai-team',
  display_name: 'OpenAI team',
  kind: 'openai_images',
  auth: 'configured',
  default_model: 'gpt-image-2'
}

const model: ImageModelDescriptor = {
  id: 'gpt-image-2',
  display_name: 'GPT Image 2',
  is_default: true,
  capabilities: {
    generation: true,
    editing: false,
    masking: false,
    max_images: 4,
    sizes: ['auto', '1024x1024'],
    qualities: ['auto', 'high'],
    output_formats: ['png', 'webp']
  }
}

describe('image generation UI', () => {
  it('submits the selected provider, model, and capability defaults', async () => {
    const generate = vi.fn(async () => undefined)
    const changeMessage = vi.fn()
    render(
      <ImageComposer
        providers={[provider]}
        modelsByProvider={{ [provider.id]: [model] }}
        message="A red panda reading Rust documentation"
        generating={false}
        onMessageChange={changeMessage}
        onGenerate={generate}
        onCancel={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(generate).toHaveBeenCalledWith({
      provider: 'openai-team',
      model: 'gpt-image-2',
      prompt: 'A red panda reading Rust documentation',
      count: 1,
      size: 'auto',
      quality: 'auto',
      output_format: 'png'
    }))
  })

  it('loads a durable artifact through the authenticated desktop bridge callback', async () => {
    const artifact: Artifact = {
      id: '019f7560-b744-7f92-a407-26c26907289b',
      thread_id: '019f7560-b744-7f92-a407-26c26907289c',
      message_id: '019f7560-b744-7f92-a407-26c26907289d',
      kind: 'image',
      mime_type: 'image/png',
      file_name: 'generated.png',
      relative_path: 'artifacts/generated.png',
      byte_size: 68,
      provider: 'openai-team',
      model: 'gpt-image-2',
      prompt: 'A red panda',
      created_at: '2026-07-18T00:00:00Z'
    }
    const source = 'data:image/png;base64,iVBORw0KGgo='
    const load = vi.fn(async () => source)
    render(<ArtifactCard artifact={artifact} onLoad={load} />)

    const image = await screen.findByRole('img', { name: 'A red panda' })
    expect(load).toHaveBeenCalledWith(artifact.id)
    expect(image.getAttribute('src')).toBe(source)
    const download = screen.getByRole('link', { name: 'Download' })
    expect(download.getAttribute('download')).toBe('generated.png')
    expect(download.getAttribute('href')).toBe(source)
  })
})
