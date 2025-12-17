import { useEffect, useState } from 'react'
import { workspaceStore } from '../stores/workspace-store'

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
  const [isActive, setIsActive] = useState(false)

  useEffect(() => {
    const checkActivity = () => {
      let lastActivityTime: number | null = propActivityTime ?? null

      if (terminalId) {
        const terminal = workspaceStore.getState().terminals.find(t => t.id === terminalId)
        lastActivityTime = terminal?.lastActivityTime ?? null
      } else if (workspaceId) {
        lastActivityTime = workspaceStore.getWorkspaceLastActivity(workspaceId)
      }

      if (!lastActivityTime) {
        setIsActive(false)
        return
      }

      const timeSinceActivity = Date.now() - lastActivityTime
      // Active (yellow) if activity within last 10 seconds
      setIsActive(timeSinceActivity <= 10000)
    }

    checkActivity()

    // Check every 1 second
    const interval = setInterval(checkActivity, 1000)

    return () => clearInterval(interval)
  }, [propActivityTime, workspaceId, terminalId])

  const className = `activity-indicator ${size} ${isActive ? 'active' : 'inactive'}`

  return <div className={className} />
}