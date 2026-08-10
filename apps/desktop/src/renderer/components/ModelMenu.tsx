import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, ChevronRight, Zap } from 'lucide-react'
import { useMemo, useRef } from 'react'
import type { ModelDescriptor } from '@shared/protocol'

import './model-menu.css'

export interface ModelMenuProps {
  models: ModelDescriptor[]
  model: string
  effort: string
  speedy: boolean
  supportsSpeedy: boolean
  onModelChange: (model: string) => void
  onEffortChange: (effort: string) => void
  onSpeedyChange: (speedy: boolean) => void
  disabled?: boolean
  loading?: boolean
  id?: string
}

export function ModelMenu({
  models,
  model,
  effort,
  speedy,
  supportsSpeedy,
  onModelChange,
  onEffortChange,
  onSpeedyChange,
  disabled = false,
  loading = false,
  id
}: ModelMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selectedModel = models.find((candidate) => candidate.id === model)
  const effortOptions = useMemo(() => {
    const values = [
      selectedModel?.default_reasoning_effort,
      ...(selectedModel?.reasoning_efforts ?? [])
    ].filter((value): value is string => Boolean(value))
    return [...new Set(values)]
  }, [selectedModel?.default_reasoning_effort, selectedModel?.reasoning_efforts])
  const selectedEffort = effort || selectedModel?.default_reasoning_effort || effortOptions[0] || ''
  const modelLabel = selectedModel?.display_name || model || 'Choose model'
  const triggerDisabled = disabled || loading || models.length === 0
  const triggerLabel = loading
    ? 'Loading models…'
    : models.length === 0
      ? 'No models'
      : modelLabel
  const fastModeEnabled = supportsSpeedy && speedy
  const fastModeState = supportsSpeedy ? (fastModeEnabled ? 'on' : 'off') : 'unavailable'

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild disabled={triggerDisabled}>
        <button
          ref={triggerRef}
          id={id}
          className="model-menu__trigger"
          type="button"
          aria-label={`Model options: ${triggerLabel}`}
          aria-description={`Fast mode ${fastModeState}`}
          title={`Fast mode ${fastModeState}`}
          data-model={model}
          data-effort={selectedEffort}
          data-speedy={fastModeEnabled ? 'true' : 'false'}
          data-speedy-supported={supportsSpeedy ? 'true' : 'false'}
        >
          {fastModeEnabled ? (
            <Zap
              className="model-menu__trigger-leading model-menu__trigger-fast-icon"
              aria-hidden="true"
              size={13}
            />
          ) : null}
          <span className="model-menu__trigger-label">{triggerLabel}</span>
          <span className="model-menu__trigger-indicator" aria-hidden="true">
            <ChevronDown size={11} />
          </span>
        </button>
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          className="model-menu__content"
          aria-label="Model settings"
          align="start"
          sideOffset={5}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.focus()
          }}
        >
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger
              className="model-menu__item model-menu__sub-trigger"
              aria-label={`Model: ${modelLabel}`}
            >
              <span className="model-menu__indicator" aria-hidden="true" />
              <span>Model</span>
              <span className="model-menu__value">{modelLabel}</span>
              <ChevronRight aria-hidden="true" size={13} />
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.SubContent
                className="model-menu__content model-menu__sub-content"
                aria-label="Models"
                sideOffset={4}
                alignOffset={-5}
                collisionPadding={8}
              >
                <DropdownMenuPrimitive.RadioGroup value={model} onValueChange={onModelChange}>
                  {models.map((candidate) => (
                    <DropdownMenuPrimitive.RadioItem
                      className="model-menu__item model-menu__radio-item"
                      key={candidate.id}
                      value={candidate.id}
                      textValue={candidate.display_name}
                    >
                      <DropdownMenuPrimitive.ItemIndicator className="model-menu__indicator" forceMount>
                        {candidate.id === model ? <Check aria-hidden="true" size={13} /> : null}
                      </DropdownMenuPrimitive.ItemIndicator>
                      <span>{candidate.display_name}</span>
                    </DropdownMenuPrimitive.RadioItem>
                  ))}
                </DropdownMenuPrimitive.RadioGroup>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>

          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger
              className="model-menu__item model-menu__sub-trigger"
              disabled={effortOptions.length === 0}
              aria-label={`Effort: ${selectedEffort ? effortLabel(selectedEffort) : 'Unavailable'}`}
            >
              <span className="model-menu__indicator" aria-hidden="true" />
              <span>Effort</span>
              <span className="model-menu__value">
                {selectedEffort ? effortLabel(selectedEffort) : 'Unavailable'}
              </span>
              <ChevronRight aria-hidden="true" size={13} />
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.SubContent
                className="model-menu__content model-menu__sub-content"
                aria-label="Reasoning effort"
                sideOffset={4}
                alignOffset={-5}
                collisionPadding={8}
              >
                <DropdownMenuPrimitive.RadioGroup
                  value={selectedEffort}
                  onValueChange={onEffortChange}
                >
                  {effortOptions.map((candidate) => (
                    <DropdownMenuPrimitive.RadioItem
                      className="model-menu__item model-menu__radio-item"
                      key={candidate}
                      value={candidate}
                      textValue={effortLabel(candidate)}
                    >
                      <DropdownMenuPrimitive.ItemIndicator className="model-menu__indicator" forceMount>
                        {candidate === selectedEffort ? <Check aria-hidden="true" size={13} /> : null}
                      </DropdownMenuPrimitive.ItemIndicator>
                      <span>{effortLabel(candidate)}</span>
                    </DropdownMenuPrimitive.RadioItem>
                  ))}
                </DropdownMenuPrimitive.RadioGroup>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>

          {supportsSpeedy ? (
            <>
              <DropdownMenuPrimitive.Separator className="model-menu__separator" />
              <DropdownMenuPrimitive.CheckboxItem
                className="model-menu__item model-menu__checkbox-item"
                checked={fastModeEnabled}
                textValue="Speedy"
                aria-label={`Speedy: ${fastModeEnabled ? 'On' : 'Off'}`}
                onCheckedChange={(checked) => onSpeedyChange(checked === true)}
              >
                <DropdownMenuPrimitive.ItemIndicator className="model-menu__indicator" forceMount>
                  {fastModeEnabled ? <Check aria-hidden="true" size={13} /> : null}
                </DropdownMenuPrimitive.ItemIndicator>
                <span>Speedy</span>
                <span className="model-menu__value">{fastModeEnabled ? 'On' : 'Off'}</span>
                <span aria-hidden="true" />
              </DropdownMenuPrimitive.CheckboxItem>
            </>
          ) : null}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

function effortLabel(effort: string): string {
  switch (effort.toLowerCase()) {
    case 'xhigh': return 'Extra high'
    case 'x-low':
    case 'xlow': return 'Extra low'
    default: return effort.charAt(0).toUpperCase() + effort.slice(1)
  }
}
