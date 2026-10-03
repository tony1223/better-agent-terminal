import { useEffect, useRef, useState } from 'react'
import { BatchedSubagentStreams, type SubagentStreamSnapshot } from './batched-subagent-streams'
import type { PanelActivation } from './panel-activation'

export function useBatchedSubagentStreams(activation: PanelActivation) {
  const [snapshot, setSnapshot] = useState<SubagentStreamSnapshot>(() => ({ text: new Map(), thinking: new Map() }))
  const controllerRef = useRef<BatchedSubagentStreams | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = new BatchedSubagentStreams(setSnapshot, {
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: handle => window.clearTimeout(handle as number),
    })
  }
  const controller = controllerRef.current
  useEffect(() => {
    controller.setActive(activation.current)
    return activation.subscribe(active => controller.setActive(active))
  }, [activation, controller])
  useEffect(() => () => controller.dispose(), [controller])
  return { ...snapshot, controller }
}
