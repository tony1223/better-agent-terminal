import { useEffect, useState } from 'react'
import { workspaceStore } from '../stores/workspace-store'

interface ActivityIndicatorProps {
  lastActivityTime?: number | null
  workspaceId?: string
  terminalId?: string
  size?: 'small' | 'medium'
}

function getActivityData(
  propActivityTime: number | null | undefined,
  workspaceId: string | undefined,
  terminalId: string | undefined
): { lastActivityTime: number | null; hasPending: boolean } {
  if (terminalId) {
    const terminal = workspaceStore.getState().terminals.find(t => t.id === terminalId)
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
}

export function ActivityIndicator({
  lastActivityTime: propActivityTime,
  workspaceId,
  terminalId,
  size = 'small'
}: ActivityIndicatorProps) {
  const [activityData, setActivityData] = useState(() =>
    getActivityData(propActivityTime, workspaceId, terminalId)
  )
  const [isActive, setIsActive] = useState(false)

  // Subscribe to store changes — no polling needed
  useEffect(() => {
    return workspaceStore.subscribe(() => {
      setActivityData(getActivityData(propActivityTime, workspaceId, terminalId))
    })
  }, [propActivityTime, workspaceId, terminalId])

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

  const className = `activity-indicator ${size} ${isActive ? 'active' : 'inactive'}${activityData.hasPending ? ' pending' : ''}`

  return (
    <div className={className}>
      {activityData.hasPending && <span className="activity-indicator-badge">?</span>}
    </div>
  )
}
