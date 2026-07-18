import { Image as ImageIcon, LoaderCircle, Send, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { ImageModelDescriptor, ImageProviderDescriptor } from '@shared/protocol'
import { KodySelect } from './KodySelect'

export interface ImageGenerationOptions {
  provider: string
  model: string
  prompt: string
  count: number
  size?: string
  quality?: string
  output_format?: string
}

interface ImageComposerProps {
  providers: ImageProviderDescriptor[]
  modelsByProvider: Record<string, ImageModelDescriptor[]>
  message: string
  unavailable?: boolean
  generating: boolean
  onMessageChange: (message: string) => void
  onGenerate: (options: ImageGenerationOptions) => Promise<void>
  onCancel: () => void
}

export function ImageComposer({
  providers,
  modelsByProvider,
  message,
  unavailable = false,
  generating,
  onMessageChange,
  onGenerate,
  onCancel
}: ImageComposerProps) {
  const availableProviders = providers.filter((provider) => provider.auth !== 'missing')
  const [providerId, setProviderId] = useState(availableProviders[0]?.id ?? '')
  const provider = availableProviders.find((candidate) => candidate.id === providerId)
    ?? availableProviders[0]
  const models = provider ? modelsByProvider[provider.id] ?? [] : []
  const [modelId, setModelId] = useState('')
  const model = models.find((candidate) => candidate.id === modelId)
    ?? models.find((candidate) => candidate.is_default)
    ?? models[0]
  const capabilities = model?.capabilities
  const [size, setSize] = useState('auto')
  const [quality, setQuality] = useState('auto')
  const [format, setFormat] = useState('png')
  const [count, setCount] = useState('1')
  const [error, setError] = useState('')

  useEffect(() => {
    if (provider && provider.id !== providerId) setProviderId(provider.id)
  }, [provider, providerId])

  useEffect(() => {
    if (model) setModelId(model.id)
  }, [model?.id])

  useEffect(() => {
    if (capabilities?.sizes.length && !capabilities.sizes.includes(size)) {
      setSize(capabilities.sizes[0] ?? 'auto')
    }
    if (capabilities?.qualities.length && !capabilities.qualities.includes(quality)) {
      setQuality(capabilities.qualities[0] ?? 'auto')
    }
    if (capabilities?.output_formats.length && !capabilities.output_formats.includes(format)) {
      setFormat(capabilities.output_formats[0] ?? 'png')
    }
  }, [capabilities, format, quality, size])

  const providerOptions = useMemo(
    () => availableProviders.map((item) => ({ value: item.id, label: item.display_name })),
    [availableProviders]
  )

  const submit = async (): Promise<void> => {
    const prompt = message.trim()
    if (!prompt) {
      setError('Describe the image you want to generate.')
      return
    }
    if (!provider || !model) {
      setError('Configure an image provider and model first.')
      return
    }
    setError('')
    await onGenerate({
      provider: provider.id,
      model: model.id,
      prompt,
      count: Number(count),
      ...(size ? { size } : {}),
      ...(quality ? { quality } : {}),
      ...(format ? { output_format: format } : {})
    })
  }

  const disabled = unavailable || generating || !provider || !model

  return (
    <form
      className="composer image-composer"
      aria-label="Image generator"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="composer__topline">
        <span className="image-composer__title"><ImageIcon aria-hidden="true" size={16} /> Generate image</span>
        <div className="composer__provider">
          <label htmlFor="image-provider">Provider</label>
          <KodySelect
            id="image-provider"
            value={provider?.id ?? ''}
            variant="toolbar"
            placeholder="Unavailable"
            options={providerOptions}
            disabled={unavailable || generating || providerOptions.length === 0}
            onValueChange={(value) => {
              setProviderId(value)
              setModelId('')
            }}
          />
          <label htmlFor="image-model">Model</label>
          <KodySelect
            id="image-model"
            value={model?.id ?? ''}
            variant="toolbar"
            placeholder="Unavailable"
            options={models.map((item) => ({ value: item.id, label: item.display_name }))}
            disabled={unavailable || generating || models.length === 0}
            onValueChange={setModelId}
          />
        </div>
      </div>

      <textarea
        id="image-prompt"
        value={message}
        rows={3}
        disabled={unavailable || generating}
        placeholder="Describe the image, composition, style, lighting, and text…"
        aria-invalid={Boolean(error)}
        onChange={(event) => {
          setError('')
          onMessageChange(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      {error ? <p className="composer__error" role="alert">{error}</p> : null}

      <footer className="composer__footer">
        <div className="image-composer__options">
          <KodySelect
            value={size}
            variant="compact"
            ariaLabel="Image size"
            options={(capabilities?.sizes ?? ['auto']).map((value) => ({ value, label: value }))}
            disabled={disabled}
            onValueChange={setSize}
          />
          <KodySelect
            value={quality}
            variant="compact"
            ariaLabel="Image quality"
            options={(capabilities?.qualities ?? ['auto']).map((value) => ({ value, label: value }))}
            disabled={disabled}
            onValueChange={setQuality}
          />
          <KodySelect
            value={format}
            variant="compact"
            ariaLabel="Image format"
            options={(capabilities?.output_formats ?? ['png']).map((value) => ({ value, label: value.toUpperCase() }))}
            disabled={disabled}
            onValueChange={setFormat}
          />
          <KodySelect
            value={count}
            variant="compact"
            ariaLabel="Image count"
            options={Array.from({ length: Math.min(4, Math.max(1, capabilities?.max_images ?? 1)) }, (_, index) => ({
              value: String(index + 1),
              label: `${index + 1} image${index === 0 ? '' : 's'}`
            }))}
            disabled={disabled}
            onValueChange={setCount}
          />
        </div>
        <div className="composer__actions">
          <button className="secondary-button" type="button" disabled={generating} onClick={onCancel}>
            <X aria-hidden="true" size={15} /> Cancel
          </button>
          <button className="send-button" type="submit" disabled={disabled || !message.trim()}>
            {generating
              ? <><LoaderCircle className="spin" aria-hidden="true" size={15} /> Generating…</>
              : <><Send aria-hidden="true" size={15} /> Generate</>}
          </button>
        </div>
      </footer>
    </form>
  )
}
