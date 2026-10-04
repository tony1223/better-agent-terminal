import { host } from '../host-api'

export const BAT_RELOAD_SLASH_COMMAND = {
  name: 'bat-reload',
  description: 'Stop the current agent and restart with fresh MCP settings, preserving the conversation',
  argumentHint: '',
}

export interface SessionReloadResult {
  ok: true
  sessionId: string
  sdkSessionId: string | null
  deferred: boolean
}

export async function requestSessionReload(sessionId: string): Promise<SessionReloadResult> {
  const result = await host.claude.reloadSession(sessionId) as SessionReloadResult | null
  if (!result || result.ok !== true || result.sessionId !== sessionId || typeof result.deferred !== 'boolean') {
    throw new Error('Host did not confirm session reload. Update the BAT host if this operation is unavailable.')
  }
  return result
}
