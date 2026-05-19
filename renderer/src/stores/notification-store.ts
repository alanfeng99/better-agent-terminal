import { host } from '../host-api'
import { workspaceStore } from './workspace-store'

export interface NotificationEntry {
  id: string
  sessionId: string
  windowId: string | null
  profileId: string | null
  workspaceId?: string
  workspaceName: string
  cwd: string
  reason: 'completed' | 'error' | 'aborted'
  result?: string
  error?: string
  timestamp: number
  read: boolean
  agentKind?: 'claude' | 'codex'
}

type Listener = () => void

class NotificationStore {
  private entries: NotificationEntry[] = []
  private listeners: Set<Listener> = new Set()
  private subscribed = false
  private unsubscribePush?: () => void
  private unsubscribeActivate?: () => void

  getEntries(): NotificationEntry[] {
    return this.entries
  }

  unreadCount(): number {
    return this.entries.reduce((n, e) => (e.read ? n : n + 1), 0)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  async init(): Promise<void> {
    if (this.subscribed) return
    this.subscribed = true
    try {
      this.entries = await host.notification.list()
      this.emit()
    } catch { /* ignore */ }
    this.unsubscribePush = host.notification.onUpdate((entries) => {
      this.entries = entries
      this.emit()
    })
    // When a notification is focused, the host targets this window with
    // the agent's workspace id. Switch to that workspace tab — focusing
    // the OS window alone leaves the user on whatever tab was active.
    this.unsubscribeActivate = host.notification.onActivateWorkspace((workspaceId) => {
      if (!workspaceId) return
      if (workspaceStore.getState().workspaces.some((w) => w.id === workspaceId)) {
        workspaceStore.setActiveWorkspace(workspaceId)
      }
    })
  }

  dispose(): void {
    this.unsubscribePush?.()
    this.unsubscribePush = undefined
    this.unsubscribeActivate?.()
    this.unsubscribeActivate = undefined
    this.subscribed = false
  }

  async markRead(id: string): Promise<void> {
    await host.notification.markRead(id)
  }

  async markAllRead(): Promise<void> {
    await host.notification.markAllRead()
  }

  async clear(): Promise<void> {
    await host.notification.clear()
  }

  async focusEntry(id: string): Promise<void> {
    await host.notification.focusEntry(id)
  }

  async focusLatestUnread(): Promise<{ id: string; windowId: string } | null> {
    return host.notification.focusLatestUnread()
  }
}

export const notificationStore = new NotificationStore()

import { createSelectorHook } from './use-store'
export const useNotifications = createSelectorHook<NotificationEntry[]>({
  subscribe: (l) => notificationStore.subscribe(l),
  getState: () => notificationStore.getEntries(),
})
