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
  const visualPhase = status.phase === 'idle' && status.checkedAt ? 'up-to-date' : status.phase

  return (
    <button
      className={`update-status update-status--${visualPhase}`}
      type="button"
      disabled={presentation.disabled}
      onClick={onAction}
      aria-label={presentation.label}
      title={status.detail ?? presentation.label}
    >
      <span className="update-status__icon" aria-hidden="true">{presentation.icon}</span>
      <span className="update-status__copy">
        <strong>Updates</strong>
        <span>{presentation.text}</span>
      </span>
    </button>
  )
}

function updatePresentation(status: DesktopUpdateStatus): {
  label: string
  text: string
  icon: ReactNode
  disabled?: boolean
} | undefined {
  const currentVersion = status.currentVersion ? `v${status.currentVersion}` : 'Current version'
  if (status.phase === 'disabled') {
    return {
      label: 'Kody updates unavailable',
      text: `${currentVersion} · Unavailable`,
      icon: <RefreshCcw aria-hidden="true" size={13} />,
      disabled: true
    }
  }
  if (status.phase === 'idle') {
    const upToDate = Boolean(status.checkedAt)
    return {
      label: upToDate ? `${currentVersion} is up to date. Check again` : 'Check for Kody updates',
      text: `${currentVersion} · ${upToDate ? 'Current' : 'Check'}`,
      icon: upToDate
        ? <Check aria-hidden="true" size={13} />
        : <RefreshCcw aria-hidden="true" size={13} />
    }
  }
  if (status.phase === 'checking') {
    return {
      label: 'Checking for Kody updates',
      text: 'Checking…',
      icon: <LoaderCircle className="spin" aria-hidden="true" size={13} />,
      disabled: true
    }
  }
  if (status.phase === 'available') {
    return {
      label: `Download Kody ${status.availableVersion ?? 'update'}`,
      text: status.availableVersion ? `v${status.availableVersion} available` : 'Update available',
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
      text: 'Ready to install',
      icon: <RotateCcw aria-hidden="true" size={13} />
    }
  }
  if (status.phase === 'up-to-date') {
    return {
      label: 'Kody is up to date. Check again',
      text: `${currentVersion} · Current`,
      icon: <Check aria-hidden="true" size={13} />
    }
  }
  return {
    label: 'Update check failed. Try again',
    text: 'Try again',
    icon: <RefreshCcw aria-hidden="true" size={13} />
  }
}
