import { host } from '../host-api'
import { workspaceStore } from './workspace-store'
import { settingsStore } from './settings-store'
import { summarizeResult } from '../utils/attention'
import { shouldAnnounceNotification } from '../utils/notification-delivery'

export interface NotificationEntry {
  id: string
  sessionId: string
  windowId: string | null
  profileId: string | null
  workspaceId?: string
  workspaceName: string
  cwd: string
  reason: 'completed' | 'error' | 'aborted' | 'connected'
  result?: string
  error?: string
  timestamp: number
  read: boolean
  agentKind?: 'claude' | 'codex'
  // Absent = agent completion (default). 'remote-client' = a new remote
  // client connected to the host; rendered from `title`, not workspace.
  kind?: 'remote-client'
  title?: string
  nativeNotificationHandled?: boolean
}

type Listener = () => void

class NotificationStore {
  private entries: NotificationEntry[] = []
  private listeners: Set<Listener> = new Set()
  private subscribed = false
  private unsubscribePush?: () => void
  private unsubscribeActivate?: () => void
  // Ids already seen by this window. Null until the first list() so entries
  // that existed before this window opened never produce a toast.
  private knownIds: Set<string> | null = null

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
      this.knownIds = new Set(this.entries.map(e => e.id))
      this.emit()
    } catch { /* ignore */ }
    this.unsubscribePush = host.notification.onUpdate((entries) => {
      this.announceNew(entries)
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
    // Remote windows show the host's list; the host cannot focus a window on
    // this machine, so switch tabs locally and mark the entry read here.
    if (workspaceStore.getViewedRemoteProfileId()) {
      const entry = this.entries.find(e => e.id === id)
      const workspaceId = entry?.workspaceId
      if (workspaceId && workspaceStore.getState().workspaces.some(w => w.id === workspaceId)) {
        workspaceStore.setActiveWorkspace(workspaceId)
      }
      await host.notification.markRead(id)
      return
    }
    await host.notification.focusEntry(id)
  }

  // Fallback OS toasts for remote hosts and platforms without native host
  // delivery. Local Windows completions are handled before the update arrives.
  // Settings: notifyOnComplete (default on), notifyOnlyBackground (skip while
  // this window has focus), notifySound (short beep alongside the toast).
  private announceNew(entries: NotificationEntry[]): void {
    const known = this.knownIds
    this.knownIds = new Set(entries.map(e => e.id))
    if (!known) return
    const isRemote = !!workspaceStore.getViewedRemoteProfileId()
    const now = Date.now()
    const fresh = entries.filter(e => !known.has(e.id) && !e.read && e.kind !== 'remote-client' && this.isMine(e)
      && shouldAnnounceNotification(e, isRemote, now))
    if (fresh.length === 0) return
    const settings = settingsStore.getSettings()
    if (settings.notifyOnComplete === false) return
    const focused = typeof document !== 'undefined' && document.hasFocus()
    if (settings.notifyOnlyBackground && focused) return
    for (const entry of fresh) {
      const suffix = entry.reason === 'error' ? ' ✗' : entry.reason === 'aborted' ? ' ⏹' : ' ✓'
      const body = summarizeResult(entry.error || entry.result, 120)
      host.system.notify(`${entry.workspaceName}${suffix}`, body, entry.workspaceId).catch(() => {})
    }
    if (settings.notifySound) playNotifyBeep()
  }

  // Local windows own entries by window label. A remote window renders the
  // host's list, whose labels name host windows, so it keys on the host
  // profile it is viewing instead.
  private isMine(entry: NotificationEntry): boolean {
    const remoteProfileId = workspaceStore.getViewedRemoteProfileId()
    if (remoteProfileId) return !entry.profileId || entry.profileId === remoteProfileId
    const windowId = workspaceStore.getWindowId()
    return !windowId || entry.windowId === windowId
  }

  async focusLatestUnread(): Promise<{ id: string; windowId: string } | null> {
    return host.notification.focusLatestUnread()
  }
}

export const notificationStore = new NotificationStore()

// Two short tones via WebAudio: no asset to ship, works in every webview.
function playNotifyBeep(): void {
  try {
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
    const AudioCtx = Ctor.AudioContext || Ctor.webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const play = (freq: number, at: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16)
      osc.connect(gain).connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.18)
    }
    play(880, ctx.currentTime)
    play(1175, ctx.currentTime + 0.17)
    window.setTimeout(() => { void ctx.close() }, 600)
  } catch { /* audio unavailable */ }
}

import { createSelectorHook } from './use-store'
export const useNotifications = createSelectorHook<NotificationEntry[]>({
  subscribe: (l) => notificationStore.subscribe(l),
  getState: () => notificationStore.getEntries(),
})
