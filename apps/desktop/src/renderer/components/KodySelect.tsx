import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import clsx from 'clsx'
import type { ReactNode } from 'react'

import './kody-select.css'

export interface KodySelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface KodySelectProps {
  value: string
  options: KodySelectOption[]
  onValueChange: (value: string) => void
  id?: string
  name?: string
  disabled?: boolean
  required?: boolean
  placeholder?: string
  ariaLabel?: string
  ariaDescribedBy?: string
  ariaInvalid?: boolean
  className?: string
  contentClassName?: string
  leadingIcon?: ReactNode
  title?: string
  variant?: 'field' | 'toolbar' | 'compact' | 'chip'
}

export function KodySelect({
  value,
  options,
  onValueChange,
  id,
  name,
  disabled = false,
  required = false,
  placeholder = 'Select an option',
  ariaLabel,
  ariaDescribedBy,
  ariaInvalid,
  className,
  contentClassName,
  leadingIcon,
  title,
  variant = 'field'
}: KodySelectProps) {
  return (
    <SelectPrimitive.Root
      value={value}
      name={name}
      disabled={disabled}
      required={required}
      onValueChange={onValueChange}
    >
      <SelectPrimitive.Trigger
        id={id}
        className={clsx('kody-select__trigger', `kody-select__trigger--${variant}`, className)}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid || undefined}
        data-value={value}
        title={title}
      >
        {leadingIcon ? (
          <span className="kody-select__leading-icon" aria-hidden="true">
            {leadingIcon}
          </span>
        ) : null}
        <SelectPrimitive.Value className="kody-select__value" placeholder={placeholder} />
        <SelectPrimitive.Icon className="kody-select__trigger-icon">
          <ChevronDown aria-hidden="true" size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className={clsx('kody-select__content', contentClassName)}
          data-variant={variant}
          position="popper"
          sideOffset={5}
          collisionPadding={8}
        >
          <SelectPrimitive.ScrollUpButton className="kody-select__scroll-button">
            <ChevronUp aria-hidden="true" size={14} />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="kody-select__viewport">
            {options.map((option) => (
              <SelectPrimitive.Item
                className="kody-select__item"
                disabled={option.disabled}
                key={option.value}
                value={option.value}
                textValue={option.label}
              >
                <SelectPrimitive.ItemIndicator className="kody-select__item-indicator">
                  <Check aria-hidden="true" size={14} />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="kody-select__scroll-button">
            <ChevronDown aria-hidden="true" size={14} />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
