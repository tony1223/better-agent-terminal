import { useEffect, useState } from 'react'
import { useWorkspace, workspaceStore } from '../stores/workspace-store'
import { useNotifications } from '../stores/notification-store'
import { shallowEqual } from '../stores/use-store'
import { workspaceHasUnreadCompletion } from '../utils/attention'

interface ActivityIndicatorProps {
  lastActivityTime?: number | null
  workspaceId?: string
  terminalId?: string
  size?: 'small' | 'medium'
}

export function ActivityIndicator({
  lastActivityTime: propActivityTime,
  workspaceId,
  terminalId,
  size = 'small'
}: ActivityIndicatorProps) {
  // Re-renders only when this component's specific slice changes (terminal-scoped
  // or workspace-scoped). Avoids the previous full-store subscription that
  // re-rendered every indicator on any unrelated terminal mutation.
  const activityData = useWorkspace(
    (state): { lastActivityTime: number | null; hasPending: boolean } => {
      if (terminalId) {
        const terminal = state.terminals.find(t => t.id === terminalId)
        return {
          lastActivityTime: terminal?.lastActivityTime ?? null,
          hasPending: terminal?.hasPendingAction ?? false,
        }
      }
      if (workspaceId) {
        const terminals = workspaceStore.getWorkspaceTerminals(workspaceId)
        return {
          lastActivityTime: workspaceStore.getWorkspaceLastActivity(workspaceId),
          hasPending: terminals.some(t => t.hasPendingAction),
        }
      }
      return { lastActivityTime: propActivityTime ?? null, hasPending: false }
    },
    shallowEqual,
  )
  // "Finished, not yet looked at": an unread completion notification for this
  // workspace. Read state flips when the workspace is viewed (NotificationBell
  // owns that), so the dot drops back to the dim inactive green by itself.
  const hasUnread = useNotifications(
    entries => (workspaceId ? workspaceHasUnreadCompletion(entries, workspaceId) : false),
  )
  const [isActive, setIsActive] = useState(false)

  // Single timeout for active→inactive transition (replaces 1s interval)
  useEffect(() => {
    const { lastActivityTime } = activityData

    if (!lastActivityTime) {
      setIsActive(false)
      return
    }

    const timeSinceActivity = Date.now() - lastActivityTime
    if (timeSinceActivity >= 10000) {
      setIsActive(false)
      return
    }

    setIsActive(true)
    const timeout = setTimeout(() => setIsActive(false), 10000 - timeSinceActivity)
    return () => clearTimeout(timeout)
  }, [activityData.lastActivityTime])

  // Precedence: pending (red) > active (yellow) > unread (bright green) > inactive.
  const stateClass = isActive ? 'active' : hasUnread ? 'unread' : 'inactive'
  const className = `activity-indicator ${size} ${stateClass}${activityData.hasPending ? ' pending' : ''}`

  return (
    <div className={className}>
      {activityData.hasPending && <span className="activity-indicator-badge">?</span>}
    </div>
  )
}
