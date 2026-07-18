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
    <>
      <button
        className={`update-status update-status--${visualPhase}`}
        type="button"
        disabled={presentation.disabled}
        onClick={onAction}
        aria-label={presentation.label}
        title={status.detail ?? presentation.statusText}
      >
        <span className="update-status__icon" aria-hidden="true">{presentation.icon}</span>
        <span className="update-status__copy">{presentation.actionText}</span>
      </button>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {presentation.statusText}
      </span>
    </>
  )
}

function updatePresentation(status: DesktopUpdateStatus): {
  label: string
  actionText: string
  statusText: string
  icon: ReactNode
  disabled?: boolean
} | undefined {
  const currentVersion = status.currentVersion ? `v${status.currentVersion}` : 'Current version'
  if (status.phase === 'disabled') {
    return {
      label: 'Kody updates unavailable',
      actionText: 'Unavailable',
      statusText: `${currentVersion}. Updates unavailable.`,
      icon: <RefreshCcw aria-hidden="true" size={13} />,
      disabled: true
    }
  }
  if (status.phase === 'idle') {
    const upToDate = Boolean(status.checkedAt)
    return {
      label: upToDate ? `${currentVersion} is up to date. Check again` : 'Check for Kody updates',
      actionText: upToDate ? 'Check again' : 'Check updates',
      statusText: upToDate ? `${currentVersion} is up to date.` : `${currentVersion}. Updates have not been checked.`,
      icon: upToDate
        ? <Check aria-hidden="true" size={13} />
        : <RefreshCcw aria-hidden="true" size={13} />
    }
  }
  if (status.phase === 'checking') {
    return {
      label: 'Checking for Kody updates',
      actionText: 'Checking…',
      statusText: 'Checking for Kody updates.',
      icon: <LoaderCircle className="spin" aria-hidden="true" size={13} />,
      disabled: true
    }
  }
  if (status.phase === 'available') {
    return {
      label: `Download Kody ${status.availableVersion ?? 'update'}`,
      actionText: 'Download',
      statusText: status.availableVersion
        ? `Kody ${status.availableVersion} is available to download.`
        : 'A Kody update is available to download.',
      icon: <ArrowDownToLine aria-hidden="true" size={13} />
    }
  }
  if (status.phase === 'downloading') {
    const percent = Math.round(status.percent ?? 0)
    return {
      label: `Downloading Kody update, ${percent}%`,
      actionText: `Downloading ${percent}%`,
      statusText: `Downloading Kody update, ${percent}%.`,
      icon: <LoaderCircle className="spin" aria-hidden="true" size={13} />,
      disabled: true
    }
  }
  if (status.phase === 'downloaded') {
    return {
      label: `Restart and install Kody ${status.availableVersion ?? 'update'}`,
      actionText: 'Restart',
      statusText: status.availableVersion
        ? `Kody ${status.availableVersion} is ready to install.`
        : 'The Kody update is ready to install.',
      icon: <RotateCcw aria-hidden="true" size={13} />
    }
  }
  if (status.phase === 'up-to-date') {
    return {
      label: 'Kody is up to date. Check again',
      actionText: 'Check again',
      statusText: `${currentVersion} is up to date.`,
      icon: <Check aria-hidden="true" size={13} />
    }
  }
  return {
    label: 'Update check failed. Try again',
    actionText: 'Try again',
    statusText: status.detail ?? 'Kody could not check for updates.',
    icon: <RefreshCcw aria-hidden="true" size={13} />
  }
}
