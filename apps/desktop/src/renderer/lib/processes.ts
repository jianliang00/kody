import type { ManagedProcess, ProcessEvent, ProcessStatus } from '@shared/protocol'

const ACTIVE_PROCESS_STATUSES = new Set<ProcessStatus>(['starting', 'running', 'stopping'])

export function isProcessActive(process: Pick<ManagedProcess, 'status'>): boolean {
  return ACTIVE_PROCESS_STATUSES.has(process.status)
}

export function processStatusLabel(status: ProcessStatus): string {
  switch (status) {
    case 'starting': return 'Starting'
    case 'running': return 'Running'
    case 'stopping': return 'Stopping'
    case 'exited': return 'Exited'
    case 'stopped': return 'Stopped'
    case 'failed': return 'Failed'
    case 'lost': return 'Lost'
  }
}

/** Output is reconciled through byte cursors; only lifecycle changes require a new snapshot. */
export function shouldRefreshProcessSnapshot(event: ProcessEvent): boolean {
  return event.type !== 'output'
}

/** Active processes first, then the most recently created terminal records. */
export function sortManagedProcesses(processes: ManagedProcess[]): ManagedProcess[] {
  return [...processes].sort((left, right) => {
    const activityOrder = Number(isProcessActive(right)) - Number(isProcessActive(left))
    return activityOrder || right.created_at.localeCompare(left.created_at)
  })
}
