import { memo, useMemo } from 'react'

export const AgentToolInput = memo(function AgentToolInput({ input }: { input: Record<string, unknown> }) {
  const text = useMemo(() => JSON.stringify(input, null, 2), [input])
  return <pre>{text}</pre>
})
