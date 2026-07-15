import {
  ArrowDownToLine,
  Check,
  ChevronRight,
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
      <span className="sidebar-utility__icon" aria-hidden="true">{presentation.icon}</span>
      <span className="sidebar-utility__copy">
        <strong>Updates</strong>
        <span>{presentation.text}</span>
      </span>
      {!presentation.disabled ? <ChevronRight className="sidebar-utility__chevron" aria-hidden="true" size={14} /> : null}
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
      text: `${currentVersion} · Unavailable in this build`,
      icon: <RefreshCcw aria-hidden="true" size={13} />,
      disabled: true
    }
  }
  if (status.phase === 'idle') {
    const upToDate = Boolean(status.checkedAt)
    return {
      label: upToDate ? `${currentVersion} is up to date. Check again` : 'Check for Kody updates',
      text: `${currentVersion} · ${upToDate ? 'Up to date' : 'Check for updates'}`,
      icon: upToDate
        ? <Check aria-hidden="true" size={13} />
        : <RefreshCcw aria-hidden="true" size={13} />
    }
  }
  if (status.phase === 'checking') {
    return {
      label: 'Checking for Kody updates',
      text: `${currentVersion} · Checking…`,
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
      text: `Downloading · ${percent}%`,
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
      text: `${currentVersion} · Up to date`,
      icon: <Check aria-hidden="true" size={13} />
    }
  }
  return {
    label: 'Update check failed. Try again',
    text: 'Check failed · Try again',
    icon: <RefreshCcw aria-hidden="true" size={13} />
  }
}
