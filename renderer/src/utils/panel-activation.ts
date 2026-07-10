import { useEffect, useLayoutEffect, useRef } from 'react'

type ActiveEffectCleanup = void | (() => void)
type ActiveListener = (active: boolean) => void

export interface PanelActivation {
  readonly current: boolean
  subscribe(listener: ActiveListener): () => void
}

export interface MutablePanelActivation extends PanelActivation {
  set(active: boolean): void
}

export function createPanelActivation(initialActive: boolean): MutablePanelActivation {
  let current = initialActive
  const listeners = new Set<ActiveListener>()

  return {
    get current() {
      return current
    },
    set(active: boolean) {
      if (current === active) return
      current = active
      listeners.forEach(listener => listener(active))
    },
    subscribe(listener: ActiveListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// Keep frequently changing visibility/focus state outside heavy panel props.
// The controller notifies small imperative effects without making the full
// message timeline reconcile whenever a workspace is shown or hidden.
export function usePanelActivation(active: boolean): PanelActivation {
  const controllerRef = useRef<MutablePanelActivation | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = createPanelActivation(active)
  }
  const controller = controllerRef.current

  useLayoutEffect(() => {
    controller.set(active)
  }, [active, controller])

  return controller
}

export function usePanelActiveEffect(
  activation: PanelActivation,
  effect: () => ActiveEffectCleanup,
): void {
  useEffect(() => {
    let cleanup: ActiveEffectCleanup
    const apply = (active: boolean) => {
      cleanup?.()
      cleanup = active ? effect() : undefined
    }

    const unsubscribe = activation.subscribe(apply)
    apply(activation.current)
    return () => {
      unsubscribe()
      cleanup?.()
    }
  }, [activation, effect])
}
