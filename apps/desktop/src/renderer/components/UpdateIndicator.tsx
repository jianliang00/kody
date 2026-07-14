import {
  ArrowDownToLine,
  Check,
  LoaderCircle,
  RefreshCcw,
  RotateCcw
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { DesktopUpdateStatus } from '@shared/bridge'

interface UpdateIndicatorProps {
  status: DesktopUpdateStatus
  onAction: () => void
}

export function UpdateIndicator({ status, onAction }: UpdateIndicatorProps) {
  const presentation = updatePresentation(status)
  if (!presentation) return null

  return (
    <button
      className={`update-pill update-pill--${status.phase}`}
      type="button"
      disabled={presentation.disabled}
      onClick={onAction}
      aria-label={presentation.label}
      title={status.detail ?? presentation.label}
    >
      {presentation.icon}
      <span>{presentation.text}</span>
    </button>
  )
}

function updatePresentation(status: DesktopUpdateStatus): {
  label: string
  text: string
  icon: ReactNode
  disabled?: boolean
} | undefined {
  if (status.phase === 'disabled' || status.phase === 'idle') return undefined
  if (status.phase === 'checking') {
    return {
      label: 'Checking for Kody updates',
      text: 'Checking',
      icon: <LoaderCircle className="spin" aria-hidden="true" size={13} />,
      disabled: true
    }
  }
  if (status.phase === 'available') {
    return {
      label: `Download Kody ${status.availableVersion ?? 'update'}`,
      text: status.availableVersion ? `Kody ${status.availableVersion}` : 'Update available',
      icon: <ArrowDownToLine aria-hidden="true" size={13} />
    }
  }
  if (status.phase === 'downloading') {
    const percent = Math.round(status.percent ?? 0)
    return {
      label: `Downloading Kody update, ${percent}%`,
      text: `${percent}%`,
      icon: <LoaderCircle className="spin" aria-hidden="true" size={13} />,
      disabled: true
    }
  }
  if (status.phase === 'downloaded') {
    return {
      label: `Restart and install Kody ${status.availableVersion ?? 'update'}`,
      text: 'Restart to update',
      icon: <RotateCcw aria-hidden="true" size={13} />
    }
  }
  if (status.phase === 'up-to-date') {
    return {
      label: 'Kody is up to date. Check again',
      text: 'Up to date',
      icon: <Check aria-hidden="true" size={13} />
    }
  }
  return {
    label: 'Update check failed. Try again',
    text: 'Update failed',
    icon: <RefreshCcw aria-hidden="true" size={13} />
  }
}
