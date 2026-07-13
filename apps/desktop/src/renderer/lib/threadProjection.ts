import type { Thread } from '@shared/protocol'

const DEFAULT_THREAD_TITLE = 'New thread'

function isPlaceholderTitle(title: string): boolean {
  const normalized = title.trim()
  return normalized.length === 0 || normalized.toLocaleLowerCase() === DEFAULT_THREAD_TITLE.toLocaleLowerCase()
}

/**
 * Preserves server-pushed Thread metadata while an older durable snapshot is
 * still in flight. Thread titles transition once from the placeholder to a
 * generated title, so an older placeholder must never overwrite that event.
 */
export class ThreadProjectionLedger {
  private readonly titles = new Map<string, string>()

  observeTitle(threadId: string, title: string): void {
    if (!isPlaceholderTitle(title)) this.titles.set(threadId, title)
  }

  reconcile(thread: Thread): Thread {
    const projectedTitle = this.titles.get(thread.id)
    if (projectedTitle && isPlaceholderTitle(thread.title)) {
      return { ...thread, title: projectedTitle }
    }
    if (!isPlaceholderTitle(thread.title)) this.titles.set(thread.id, thread.title)
    return thread
  }

  reconcileAll(threads: Thread[]): Thread[] {
    return threads.map((thread) => this.reconcile(thread))
  }

  clear(): void {
    this.titles.clear()
  }
}
