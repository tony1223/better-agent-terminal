import { host } from '../host-api'
import { v4 as uuidv4 } from 'uuid'
import type { Workspace, TerminalInstance, AppState } from '../types'
import { AgentPresetId, getAgentPreset } from '../types/agent-presets'
import { normalizeAgentParams } from '../types/agent-profiles'
import { clearPreviewCache } from '../components/TerminalThumbnail'
import { settingsStore } from './settings-store'

type Listener = () => void

export const TERMINAL_ACTIVITY_MIN_INTERVAL_MS = 500

// PTY events are application-wide under Tauri. Return null for a terminal
// owned by another window and for bursts that are too recent to affect the
// activity UI. This keeps the hottest output path allocation-free.
export function updateTerminalActivityState(
  state: AppState,
  id: string,
  now: number,
): AppState | null {
  const index = state.terminals.findIndex(terminal => terminal.id === id)
  if (index < 0) return null
  const terminal = state.terminals[index]
  if (
    terminal.lastActivityTime !== undefined
    && now - terminal.lastActivityTime < TERMINAL_ACTIVITY_MIN_INTERVAL_MS
  ) {
    return null
  }
  const terminals = [...state.terminals]
  terminals[index] = { ...terminal, lastActivityTime: now }
  return { ...state, terminals }
}

function debugLog(...args: unknown[]): void {
  if (host.debug.isDebugMode !== true) return
  void host.debug.log(...args).catch(() => {})
}

function setHostDockBadge(count: number): void {
  void host.app.setDockBadge(count).catch(() => {})
}

function normalizePersistedAgentPreset(value: unknown): AgentPresetId | undefined {
  if (value === 'openai-agent') return 'codex-agent'
  if (typeof value === 'string') {
    const preset = getAgentPreset(value)
    if (preset && (!preset.debug || host.debug.isDebugMode === true)) return value as AgentPresetId
  }
  return undefined
}

export function sdkSessionRuntimeFamily(agentPreset?: AgentPresetId): 'claude' | 'codex' | null {
  if (agentPreset === 'codex-agent' || agentPreset === 'codex-agent-worktree' || agentPreset === 'codex-fugu') return 'codex'
  if (agentPreset === 'claude-code' || agentPreset === 'claude-code-v2' || agentPreset === 'claude-code-worktree') return 'claude'
  return null
}

function defaultModelForNewAgent(agentPreset?: AgentPresetId): string | undefined {
  if (agentPreset !== 'codex-agent' && agentPreset !== 'codex-agent-worktree') return undefined
  return settingsStore.getSettings().defaultCodexModel || undefined
}

class WorkspaceStore {
  private state: AppState = {
    workspaces: [],
    activeWorkspaceId: null,
    terminals: [],
    activeTerminalId: null,
    focusedTerminalId: null
  }

  private activeGroup: string | null = null
  private windowId: string | null = null
  // For a remote client window, the HOST profile id this window is viewing
  // (the local alias's remote_profile_id). Null for local windows. Host and
  // client both label their main window "main", so windowId can't tell them
  // apart on the wire — remote reloads are scoped by this profile id instead.
  private viewedRemoteProfileId: string | null = null
  // For a remote client window, the "host:port" of the connection this window
  // is bound to. The Rust remote client stamps every host-originated
  // workspace:reload with a matching `remoteOrigin`, so reloads can be scoped
  // to the right host even when two connections use the same profile id.
  private viewedRemoteOrigin: string | null = null
  private listeners: Set<Listener> = new Set()

  // Usage polling removed — OAuth API calls to Anthropic have been removed.
  // Stubs kept so consumers don't break.
  get claudeUsage() { return null }
  get usageAccount() { return null }
  getUsagePacing() { return null }
  startUsagePolling() { /* no-op */ }
  refreshUsageNow() { /* no-op */ }

  getState(): AppState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(listener => listener())
  }

  private restoredFocusForWorkspace(
    workspaceId: string | null,
    workspaces = this.state.workspaces,
    terminals = this.state.terminals,
  ): string | null {
    if (!workspaceId) return null
    const workspace = workspaces.find(w => w.id === workspaceId)
    const savedFocus = workspace?.focusedTerminalId
    if (savedFocus && terminals.some(t => t.id === savedFocus && t.workspaceId === workspaceId)) {
      return savedFocus
    }
    return terminals.find(t => t.workspaceId === workspaceId)?.id ?? null
  }

  // Workspace actions
  addWorkspace(name: string, folderPath: string): Workspace {
    const workspace: Workspace = {
      id: uuidv4(),
      name,
      folderPath,
      createdAt: Date.now()
    }

    this.state = {
      ...this.state,
      workspaces: [...this.state.workspaces, workspace],
      activeWorkspaceId: workspace.id
    }

    this.notify()
    return workspace
  }

  removeWorkspace(id: string): void {
    const terminals = this.state.terminals.filter(t => t.workspaceId !== id)
    const workspaces = this.state.workspaces.filter(w => w.id !== id)
    const activeWorkspaceId = this.state.activeWorkspaceId === id
      ? (workspaces[0]?.id ?? null)
      : this.state.activeWorkspaceId
    const restoredFocus = this.restoredFocusForWorkspace(activeWorkspaceId, workspaces, terminals)

    this.state = {
      ...this.state,
      workspaces,
      terminals,
      activeWorkspaceId,
      activeTerminalId: restoredFocus,
      focusedTerminalId: restoredFocus,
    }

    this.notify()
  }

  setActiveWorkspace(id: string): void {
    if (this.state.activeWorkspaceId === id) return

    // Persist current focus into the current workspace before switching
    const currentWsId = this.state.activeWorkspaceId
    const currentFocus = this.state.focusedTerminalId
    const updatedWorkspaces = this.state.workspaces.map(w =>
      w.id === currentWsId && w.focusedTerminalId !== (currentFocus ?? undefined)
        ? { ...w, focusedTerminalId: currentFocus ?? undefined }
        : w
    )

    const restoredFocus = this.restoredFocusForWorkspace(id, updatedWorkspaces)

    this.state = {
      ...this.state,
      workspaces: updatedWorkspaces,
      activeWorkspaceId: id,
      activeTerminalId: restoredFocus,
      focusedTerminalId: restoredFocus
    }

    this.notify()
    this.save()
  }

  renameWorkspace(id: string, alias: string): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, alias: alias.trim() || undefined } : w
      )
    }

    this.notify()
  }

  reorderWorkspaces(workspaceIds: string[]): void {
    const workspaceMap = new Map(this.state.workspaces.map(w => [w.id, w]))
    const orderedIdSet = new Set(workspaceIds)
    const reordered = workspaceIds
      .map(id => workspaceMap.get(id))
      .filter((w): w is Workspace => w !== undefined)
    const remaining = this.state.workspaces.filter(w => !orderedIdSet.has(w.id))

    this.state = {
      ...this.state,
      workspaces: [...reordered, ...remaining]
    }

    this.notify()
    this.save()
  }

  // Workspace environment variables
  setWorkspaceEnvVars(id: string, envVars: import('../types').EnvVariable[]): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, envVars } : w
      )
    }
    this.notify()
    this.save()
  }

  addWorkspaceEnvVar(id: string, envVar: import('../types').EnvVariable): void {
    const workspace = this.state.workspaces.find(w => w.id === id)
    if (!workspace) return
    const envVars = [...(workspace.envVars || []), envVar]
    this.setWorkspaceEnvVars(id, envVars)
  }

  removeWorkspaceEnvVar(id: string, key: string): void {
    const workspace = this.state.workspaces.find(w => w.id === id)
    if (!workspace) return
    const envVars = (workspace.envVars || []).filter(e => e.key !== key)
    this.setWorkspaceEnvVars(id, envVars)
  }

  updateWorkspaceEnvVar(id: string, key: string, updates: Partial<import('../types').EnvVariable>): void {
    const workspace = this.state.workspaces.find(w => w.id === id)
    if (!workspace) return
    const envVars = (workspace.envVars || []).map(e =>
      e.key === key ? { ...e, ...updates } : e
    )
    this.setWorkspaceEnvVars(id, envVars)
  }

  // SDK session persistence — per terminal
  findSdkSessionOwner(
    sdkSessionId: string | undefined,
    agentPreset: AgentPresetId | undefined,
    excludeTerminalId?: string,
  ): TerminalInstance | undefined {
    if (!sdkSessionId) return undefined
    const family = sdkSessionRuntimeFamily(agentPreset)
    if (!family) return undefined
    return this.state.terminals.find(t =>
      t.id !== excludeTerminalId
      && t.sdkSessionId === sdkSessionId
      && sdkSessionRuntimeFamily(t.agentPreset) === family
    )
  }

  // Legacy profile snapshots (and profile copies created before the host
  // started re-keying them) can contain the same terminal id in two profile
  // windows. The process-wide agent runtime uses that id as its session key,
  // so repair the later claimant in-place and let React remount it under a
  // fresh identity. Conversation/runtime handles are deliberately cleared:
  // inheriting them would reconnect the replacement terminal to the same
  // Claude/Codex transcript even after its panel id changed.
  repairTerminalIdentityCollision(terminalId: string): string | undefined {
    const terminal = this.state.terminals.find(t => t.id === terminalId)
    if (!terminal) return undefined

    const replacementId = uuidv4()
    const workspace = this.state.workspaces.find(w => w.id === terminal.workspaceId)
    const isWorktree = !!terminal.worktreePath || terminal.agentPreset?.endsWith('-worktree') === true
    const previousSdkSessionId = terminal.sdkSessionId
    const repairedTerminal: TerminalInstance = {
      ...terminal,
      id: replacementId,
      cwd: isWorktree ? (workspace?.folderPath || terminal.cwd) : terminal.cwd,
      sdkSessionId: undefined,
      claudeCliSessionId: undefined,
      claudeCliRestartToken: undefined,
      sessionMeta: undefined,
      worktreePath: isWorktree ? undefined : terminal.worktreePath,
      worktreeBranch: isWorktree ? undefined : terminal.worktreeBranch,
      worktreeMergedKind: isWorktree ? undefined : terminal.worktreeMergedKind,
      historyKey: uuidv4().replace(/-/g, '').slice(0, 12),
      pendingPrompt: undefined,
      pendingImages: undefined,
      hasPendingAction: false,
      isAgentRunning: false,
      scrollbackBuffer: [],
      pid: undefined,
    }

    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w => ({
        ...w,
        focusedTerminalId: w.focusedTerminalId === terminalId ? replacementId : w.focusedTerminalId,
        lastSdkSessionId: previousSdkSessionId && w.lastSdkSessionId === previousSdkSessionId
          ? undefined
          : w.lastSdkSessionId,
      })),
      terminals: this.state.terminals.map(t => t.id === terminalId ? repairedTerminal : t),
      activeTerminalId: this.state.activeTerminalId === terminalId
        ? replacementId
        : this.state.activeTerminalId,
      focusedTerminalId: this.state.focusedTerminalId === terminalId
        ? replacementId
        : this.state.focusedTerminalId,
    }
    debugLog('[workspace-store] repaired duplicate agent session identity', {
      windowId: this.windowId,
      previousSessionId: terminalId,
      replacementSessionId: replacementId,
      workspaceId: terminal.workspaceId,
    })
    this.notify()
    void this.save()
    return replacementId
  }

  setTerminalSdkSessionId(terminalId: string, sdkSessionId: string | undefined): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, sdkSessionId } : t
      )
    }
    this.notify()
    this.save()
  }

  setTerminalClaudeCliSessionId(terminalId: string, claudeCliSessionId: string | undefined): void {
    const current = this.state.terminals.find(t => t.id === terminalId)
    if (!current || current.claudeCliSessionId === claudeCliSessionId) return
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, claudeCliSessionId } : t
      )
    }
    this.notify()
    this.save()
  }

  bumpTerminalClaudeCliRestart(terminalId: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, claudeCliRestartToken: Date.now() } : t
      )
    }
    this.notify()
    this.save()
  }

  setTerminalWorktreeInfo(terminalId: string, worktreePath: string | undefined, worktreeBranch: string | undefined): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, worktreePath, worktreeBranch } : t
      )
    }
    this.notify()
    this.save()
  }

  setTerminalWorktreeMergedKind(terminalId: string, mergedKind: TerminalInstance['worktreeMergedKind']): void {
    const current = this.state.terminals.find(t => t.id === terminalId)
    if (!current || current.worktreeMergedKind === mergedKind) return
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, worktreeMergedKind: mergedKind } : t
      )
    }
    this.notify()
  }

  setTerminalSessionMeta(terminalId: string, meta: { totalCost: number; inputTokens: number; outputTokens: number; durationMs: number; numTurns: number; contextWindow: number; cacheReadTokens?: number; cacheCreationTokens?: number }): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, sessionMeta: meta } : t
      )
    }
    // Don't notify — this is a background persistence update, no UI re-render needed
    this.save()
  }

  setTerminalProcfile(terminalId: string, procfilePath: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, procfilePath, title: `Worker: ${procfilePath.split('/').pop()}` } : t
      )
    }
    this.notify()
  }

  setTerminalPendingPrompt(terminalId: string, prompt: string, images?: string[]): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, pendingPrompt: prompt, pendingImages: images } : t
      )
    }
    this.notify()
  }

  // Legacy: also store on workspace for backwards compatibility
  setLastSdkSessionId(workspaceId: string, sdkSessionId: string): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === workspaceId ? { ...w, lastSdkSessionId: sdkSessionId } : w
      )
    }
    this.notify()
    this.save()
  }

  // Terminal actions
  // `init` lets a caller pre-seed identity/location before the panel mounts.
  // Worktree agents use it so the terminal is born with cwd = worktree folder
  // (created in Rust first), and the SDK session then starts through the normal
  // path — no post-hoc cwd rewrite or worktree special-casing at start time.
  addTerminal(
    workspaceId: string,
    agentPreset?: AgentPresetId,
    init?: { id?: string; cwd?: string; worktreePath?: string; worktreeBranch?: string },
  ): TerminalInstance {
    const workspace = this.state.workspaces.find(w => w.id === workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const existingTerminals = this.state.terminals.filter(
      t => t.workspaceId === workspaceId && !t.agentPreset
    )

    // Get agent preset info for title
    const preset = agentPreset ? getAgentPreset(agentPreset) : null
    const title = preset && preset.id !== 'none'
      ? preset.name
      : 'New Terminal'
    const defaultModel = defaultModelForNewAgent(agentPreset)

    const terminal: TerminalInstance = {
      id: init?.id ?? uuidv4(),
      workspaceId,
      type: 'terminal',
      agentPreset,
      title,
      cwd: init?.cwd ?? workspace.folderPath,
      ...(init?.worktreePath ? { worktreePath: init.worktreePath } : {}),
      ...(init?.worktreeBranch ? { worktreeBranch: init.worktreeBranch } : {}),
      ...(defaultModel ? { model: defaultModel } : {}),
      scrollbackBuffer: [],
      lastActivityTime: Date.now(),
      historyKey: uuidv4().replace(/-/g, '').slice(0, 12),
      agentParams: normalizeAgentParams(agentPreset),
    }

    // Auto-focus if it's an agent terminal or no current focus
    const shouldFocus = (agentPreset && agentPreset !== 'none') || !this.state.focusedTerminalId

    this.state = {
      ...this.state,
      terminals: [...this.state.terminals, terminal],
      activeWorkspaceId: shouldFocus ? workspaceId : this.state.activeWorkspaceId,
      activeTerminalId: shouldFocus ? terminal.id : this.state.activeTerminalId,
      focusedTerminalId: shouldFocus ? terminal.id : this.state.focusedTerminalId
    }

    this.notify()
    debugLog('[workspace-store] addTerminal', {
      windowId: this.windowId,
      workspaceId,
      workspaceName: workspace.name,
      folderPath: workspace.folderPath,
      terminalId: terminal.id,
      agentPreset: terminal.agentPreset || 'none',
      title,
      terminalCount: this.state.terminals.length,
      workspaceTerminalCount: this.state.terminals.filter(t => t.workspaceId === workspaceId).length,
      activeWorkspaceId: this.state.activeWorkspaceId,
      activeTerminalId: this.state.activeTerminalId,
      focusedTerminalId: this.state.focusedTerminalId,
    })
    return terminal
  }

  removeTerminal(id: string): void {
    clearPreviewCache(id)
    const removedTerminal = this.state.terminals.find(t => t.id === id)
    const terminals = this.state.terminals.filter(t => t.id !== id)
    const fallbackFocus = this.restoredFocusForWorkspace(removedTerminal?.workspaceId ?? this.state.activeWorkspaceId, this.state.workspaces, terminals)
    const focusedTerminalId = this.state.focusedTerminalId === id
      ? fallbackFocus
      : this.state.focusedTerminalId
    const activeTerminalId = this.state.activeTerminalId === id
      ? fallbackFocus
      : this.state.activeTerminalId

    this.state = {
      ...this.state,
      terminals,
      activeTerminalId,
      focusedTerminalId
    }

    this.notify()
  }

  switchTerminalApiVersion(id: string): 'claude-code' | 'claude-code-v2' | null {
    const terminal = this.state.terminals.find(t => t.id === id)
    if (!terminal) return null
    const newPreset = terminal.agentPreset === 'claude-code' ? 'claude-code-v2' as const : 'claude-code' as const
    const newTitle = newPreset === 'claude-code-v2' ? 'Claude Agent (V2)' : 'Claude Agent (V1)'
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, agentPreset: newPreset, title: newTitle } : t
      )
    }
    this.notify()
    return newPreset
  }

  renameTerminal(id: string, title: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, alias: title } : t
      )
    }

    this.notify()
    this.save()
  }

  setTerminalGeneratedTitle(id: string, title: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, title } : t
      )
    }

    this.notify()
  }

  setTerminalRuntimeError(id: string, runtimeError?: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, runtimeError } : t
      )
    }

    this.notify()
  }

  setFocusedTerminal(id: string | null): void {
    const terminal = id ? this.state.terminals.find(t => t.id === id) : null
    const activeWorkspaceId = terminal?.workspaceId ?? this.state.activeWorkspaceId
    if (
      this.state.focusedTerminalId === id
      && this.state.activeTerminalId === id
      && this.state.activeWorkspaceId === activeWorkspaceId
    ) return

    this.state = {
      ...this.state,
      activeWorkspaceId,
      activeTerminalId: id,
      focusedTerminalId: id
    }

    this.notify()
  }

  updateTerminalCwd(id: string, cwd: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, cwd } : t
      )
    }

    this.notify()
  }

  updateTerminalModel(id: string, model: string): void {
    const terminal = this.state.terminals.find(t => t.id === id)
    if (!terminal || terminal.model === model) return

    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, model } : t
      )
    }

    this.notify()
    this.save()
  }

  updateTerminalPermissionMode(id: string, permissionMode: string): void {
    const terminal = this.state.terminals.find(t => t.id === id)
    if (!terminal || terminal.permissionMode === permissionMode) return

    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, permissionMode } : t
      )
    }

    this.notify()
    this.save()
  }

  updateTerminalAgentParams(id: string, params: Record<string, string | number | boolean>): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? {
          ...t,
          agentParams: normalizeAgentParams(t.agentPreset, { ...(t.agentParams || {}), ...params }),
        } : t
      )
    }

    this.notify()
    this.save()
  }

  markAgentCommandSent(id: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, agentCommandSent: true } : t
      )
    }
    this.notify()
    this.save()
  }

  markHasUserInput(id: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, hasUserInput: true } : t
      )
    }
    this.notify()
    this.save()
  }

  appendScrollback(id: string, data: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, scrollbackBuffer: [...t.scrollbackBuffer, data] } : t
      )
    }
    // Don't notify for scrollback updates to avoid re-renders
  }

  clearScrollback(id: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, scrollbackBuffer: [] } : t
      )
    }

    this.notify()
  }

  reorderTerminals(terminalIds: string[]): void {
    const terminalMap = new Map(this.state.terminals.map(t => [t.id, t]))
    const reorderedSubset = terminalIds
      .map(id => terminalMap.get(id))
      .filter((t): t is TerminalInstance => t !== undefined)
    const reorderedIds = new Set(reorderedSubset.map(t => t.id))
    let nextReorderedIndex = 0

    const terminals = this.state.terminals.map(t => {
      if (!reorderedIds.has(t.id)) return t
      return reorderedSubset[nextReorderedIndex++] ?? t
    })

    this.state = {
      ...this.state,
      terminals
    }

    this.notify()
    this.save()
  }

  // Get terminals for current workspace
  getWorkspaceTerminals(workspaceId: string): TerminalInstance[] {
    return this.state.terminals.filter(t => t.workspaceId === workspaceId)
  }

  // Get agent terminal for workspace (first agent terminal, regardless of type)
  getAgentTerminal(workspaceId: string): TerminalInstance | undefined {
    return this.state.terminals.find(
      t => t.workspaceId === workspaceId && t.agentPreset && t.agentPreset !== 'none'
    )
  }

  // Legacy compatibility - alias for getAgentTerminal
  getClaudeCodeTerminal(workspaceId: string): TerminalInstance | undefined {
    return this.getAgentTerminal(workspaceId)
  }

  getRegularTerminals(workspaceId: string): TerminalInstance[] {
    return this.state.terminals.filter(
      t => t.workspaceId === workspaceId && (!t.agentPreset || t.agentPreset === 'none')
    )
  }

  // Group management
  getActiveGroup(): string | null {
    return this.activeGroup
  }

  setActiveGroup(group: string | null): void {
    this.activeGroup = group

    // Auto-select first workspace in the group if current is not visible
    if (group) {
      const visibleWorkspaces = this.state.workspaces.filter(w => w.group === group)
      const currentVisible = visibleWorkspaces.some(w => w.id === this.state.activeWorkspaceId)
      if (!currentVisible && visibleWorkspaces.length > 0) {
        const activeWorkspaceId = visibleWorkspaces[0].id
        const restoredFocus = this.restoredFocusForWorkspace(activeWorkspaceId)
        this.state = {
          ...this.state,
          activeWorkspaceId,
          activeTerminalId: restoredFocus,
          focusedTerminalId: restoredFocus
        }
      } else {
        // Force new reference so React re-renders the sidebar filter
        this.state = { ...this.state }
      }
    } else {
      this.state = { ...this.state }
    }

    this.notify()
    this.save()
  }

  setWorkspaceGroup(id: string, group: string | undefined): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, group } : w
      )
    }
    this.notify()
    this.save()
  }

  setWorkspaceColor(id: string, color: string | undefined): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, color } : w
      )
    }
    this.notify()
    this.save()
  }

  getGroups(): string[] {
    const groups = new Set<string>()
    for (const w of this.state.workspaces) {
      if (w.group) groups.add(w.group)
    }
    return Array.from(groups).sort()
  }

  // Activity tracking
  private lastActivityNotify: number = 0
  private _savePromise: Promise<void> = Promise.resolve()
  private _savePending = false
  private _lastSavedData: string | null = null

  updateTerminalActivity(id: string): void {
    const now = Date.now()
    const next = updateTerminalActivityState(this.state, id, now)
    if (!next) return
    this.state = next
    // Throttle notifications to avoid excessive re-renders (max once per 500ms)
    if (now - this.lastActivityNotify >= TERMINAL_ACTIVITY_MIN_INTERVAL_MS) {
      this.lastActivityNotify = now
      this.notify()
    }
  }

  setTerminalPendingAction(id: string, pending: boolean): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, hasPendingAction: pending } : t
      )
    }
    this.notify()
    this.updateDockBadge()
  }

  setTerminalAgentRunning(id: string, running: boolean): void {
    const terminal = this.state.terminals.find(t => t.id === id)
    if (!terminal || terminal.isAgentRunning === running) return
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, isAgentRunning: running } : t
      )
    }
    this.notify()
  }

  private updateDockBadge(): void {
    const settings = settingsStore.getSettings()
    if (settings.showDockBadge === false) return
    const count = this.state.terminals.filter(t => t.hasPendingAction).length
    setHostDockBadge(count)
  }

  getWorkspaceLastActivity(workspaceId: string): number | null {
    const terminals = this.getWorkspaceTerminals(workspaceId)
    const lastActivities = terminals
      .map(t => t.lastActivityTime)
      .filter((time): time is number => time !== undefined)

    return lastActivities.length > 0 ? Math.max(...lastActivities) : null
  }

  // Window identity for cross-window drag
  setWindowId(id: string): void { this.windowId = id }
  getWindowId(): string | null { return this.windowId }

  // Set by App.tsx whenever the active profile changes. Non-null marks this
  // window as a remote client viewing the given HOST profile id; it gates which
  // host workspace:reload broadcasts this window is allowed to apply.
  setViewedRemoteProfileId(id: string | null): void { this.viewedRemoteProfileId = id }
  getViewedRemoteProfileId(): string | null { return this.viewedRemoteProfileId }
  setViewedRemoteOrigin(origin: string | null): void { this.viewedRemoteOrigin = origin }
  getViewedRemoteOrigin(): string | null { return this.viewedRemoteOrigin }

  listenForReload(): () => void {
    return host.workspace.onReload((payload?: unknown) => {
      if (typeof payload === 'string' && payload) {
        // Bare-string reloads carry no origin/window/profile attribution, so
        // adopting the attached data is unsafe (a host broadcast leaking here
        // would overwrite this window's list — and the next save would persist
        // it). Current builds never emit strings locally and the Rust remote
        // client wraps legacy host strings into tagged objects, so just
        // re-fetch through this window's own routing.
        debugLog('[workspace-store] string reload payload; refetching own workspace instead of adopting')
        this.reloadFromHost({ preserveActiveSelection: true })
        return
      }
      if (payload && typeof payload === 'object') {
        const reload = payload as { windowId?: unknown; data?: unknown; profileId?: unknown; remoteOrigin?: unknown }
        const remoteOrigin = typeof reload.remoteOrigin === 'string' ? reload.remoteOrigin : null
        if (this.viewedRemoteProfileId !== null) {
          // Remote client window: only host-originated reloads (stamped with
          // remoteOrigin by the Rust remote client) may be applied, and only
          // from the host this window is connected to. An untagged reload is
          // local-origin — adopting it here would push LOCAL data into the
          // remote view and the next save would write it to the host.
          if (remoteOrigin === null) {
            debugLog('[workspace-store] reload ignored: local-origin payload on remote client window')
            return
          }
          if (this.viewedRemoteOrigin !== null && remoteOrigin !== this.viewedRemoteOrigin) {
            debugLog('[workspace-store] reload ignored: remote origin mismatch', {
              viewedRemoteOrigin: this.viewedRemoteOrigin,
              remoteOrigin,
            })
            return
          }
          // The host and this client both label their main window "main", so
          // windowId can't distinguish them. The reload's profileId names the
          // HOST profile that changed — apply it only when it matches the host
          // profile this window is viewing, otherwise the host editing an
          // unrelated profile (e.g. its own default) would clobber us.
          const reloadProfileId = typeof reload.profileId === 'string' ? reload.profileId : null
          if (reloadProfileId === null) {
            // Legacy host that doesn't tag reloads with a profileId — we can't
            // safely apply foreign data, so re-fetch our own bound profile.
            debugLog('[workspace-store] reload without profileId on remote client; reloading bound profile', {
              viewedRemoteProfileId: this.viewedRemoteProfileId,
            })
            this.reloadFromHost({ preserveActiveSelection: true })
            return
          }
          if (reloadProfileId !== this.viewedRemoteProfileId) {
            debugLog('[workspace-store] reload ignored: remote profile mismatch', {
              viewedRemoteProfileId: this.viewedRemoteProfileId,
              reloadProfileId,
            })
            return
          }
        } else {
          // Local window: NEVER apply a host-originated reload. The host's
          // main window and ours are both labelled "main", so without this
          // check a host broadcast would pass the windowId gate below, this
          // window would adopt the HOST's workspace list, and the next local
          // save would persist it over this machine's own data.
          if (remoteOrigin !== null) {
            debugLog('[workspace-store] reload ignored: remote-origin payload on local window', {
              remoteOrigin,
            })
            return
          }
          if (typeof reload.windowId === 'string' && reload.windowId !== this.windowId) {
            // windowId selects the target window.
            debugLog('[workspace-store] reload ignored: target window mismatch', {
              windowId: this.windowId,
              targetWindowId: reload.windowId,
            })
            return
          }
        }
        if (typeof reload.data === 'string' && reload.data) {
          this.applySerializedData(reload.data, { preserveActiveSelection: true })
          return
        }
      }
      this.reloadFromHost()
    })
  }

  // Fire-and-forget reload used by the reload-event listener. load() awaits a
  // host round-trip that REJECTS with "not connected to remote server" when a
  // remote window's socket is down; calling it bare from the event callback let
  // that rejection escape as an unhandledrejection (see App init blank-window
  // reports). Swallow it here with an explanatory log — a failed reload is
  // non-fatal; the window keeps its current list and re-syncs on reconnect.
  private reloadFromHost(options?: { preserveActiveSelection?: boolean }): void {
    void this.load(options).catch(err => {
      debugLog('[workspace-store] reload failed', {
        message: err instanceof Error ? err.message : String(err),
        viewedRemoteProfileId: this.viewedRemoteProfileId,
      })
    })
  }

  // Persistence — serialized to prevent concurrent writes from corrupting the file
  async save(): Promise<void> {
    // If a save is already queued, skip — the queued save will capture the latest state
    if (this._savePending) {
      return
    }
    this._savePending = true

    // Wait for any in-flight save to finish, then perform ours
    this._savePromise = this._savePromise.then(async () => {
      this._savePending = false
      const saveStartedAt = Date.now()
      const savedTerminals = this.state.terminals.map(t => ({
        id: t.id,
        workspaceId: t.workspaceId,
        type: t.type,
        agentPreset: t.agentPreset,
        title: t.title,
        alias: t.alias,
        cwd: t.cwd,
        sdkSessionId: t.sdkSessionId,
        claudeCliSessionId: t.claudeCliSessionId,
        claudeCliRestartToken: t.claudeCliRestartToken,
        model: t.model,
        permissionMode: t.permissionMode,
        agentParams: t.agentParams,
        sessionMeta: t.sessionMeta,
        worktreePath: t.worktreePath,
        worktreeBranch: t.worktreeBranch,
        worktreeMergedKind: t.worktreeMergedKind,
        historyKey: t.historyKey,
        procfilePath: t.procfilePath,
      }))
      // Persist current focus into the active workspace at save time
      const wsWithFocus = this.state.workspaces.map(w =>
        w.id === this.state.activeWorkspaceId && this.state.focusedTerminalId
          ? { ...w, focusedTerminalId: this.state.focusedTerminalId }
          : w
      )
      const data = JSON.stringify({
        workspaces: wsWithFocus,
        activeWorkspaceId: this.state.activeWorkspaceId,
        activeGroup: this.activeGroup,
        terminals: savedTerminals,
        activeTerminalId: this.state.activeTerminalId,
      })
      if (data === this._lastSavedData) {
        return
      }
      debugLog('[workspace-store] save start', {
        windowId: this.windowId,
        workspaceCount: wsWithFocus.length,
        terminalCount: savedTerminals.length,
        activeWorkspaceId: this.state.activeWorkspaceId,
        activeTerminalId: this.state.activeTerminalId,
        focusedTerminalId: this.state.focusedTerminalId,
        dataLength: data.length,
      })
      const ok = await host.workspace.save(data)
      if (ok) this._lastSavedData = data
      const elapsedMs = Date.now() - saveStartedAt
      if (elapsedMs >= 250 || ok !== true) {
        debugLog('[workspace-store] save done', {
          windowId: this.windowId,
          ok,
          elapsedMs,
          workspaceCount: wsWithFocus.length,
          terminalCount: savedTerminals.length,
        })
      }
    }).catch(e => {
      debugLog('[workspace-store] save failed', {
        windowId: this.windowId,
        error: e instanceof Error ? e.message : String(e),
      })
    })

    return this._savePromise
  }

  // `preserveActiveSelection` keeps the window's current active workspace /
  // focused terminal instead of jumping to the host's stored active. Used by
  // the remote auto-reconnect path so re-attaching after an idle drop doesn't
  // yank the user off the workspace they were on. Initial loads omit it so they
  // honor the host's canonical active selection.
  async load(options?: { preserveActiveSelection?: boolean }): Promise<void> {
    const data = await host.workspace.load()
    if (data) {
      this.applySerializedData(data, options)
    }
  }

  private applySerializedData(data: string, options?: { preserveActiveSelection?: boolean }): void {
    try {
      const parsed = JSON.parse(data)
      // Restore terminals with empty runtime fields
      const workspaces: Workspace[] = (parsed.workspaces || []).map((w: Workspace) => ({
        ...w,
        defaultAgent: normalizePersistedAgentPreset(w.defaultAgent),
      }))
      const workspaceMap = new Map(workspaces.map((w: Workspace) => [w.id, w]))
      const terminals = (parsed.terminals || []).map((t: Partial<TerminalInstance>): TerminalInstance | null => {
        const ws = t.workspaceId ? workspaceMap.get(t.workspaceId) : undefined
        if (!ws?.folderPath) {
          host.debug.log?.(`[workspace-store] Warning: terminal ${t.id} has no valid workspace, skipping`)
          return null
        }
        const cwd = t.cwd || ws.folderPath
        // For agent terminals, always derive title from preset to fix any persisted corruption
        const originalAgentPreset = typeof t.agentPreset === 'string' ? t.agentPreset : undefined
        const agentPreset = normalizePersistedAgentPreset(originalAgentPreset)
        const hiddenDebugPreset = !!originalAgentPreset
          && !agentPreset
          && getAgentPreset(originalAgentPreset)?.debug === true
        const presetTitle = agentPreset && agentPreset !== 'none'
          ? (getAgentPreset(agentPreset)?.name || t.title || 'Terminal')
          : hiddenDebugPreset
            ? 'Terminal'
          : (t.title || 'Terminal')
        return {
          id: t.id || '',
          workspaceId: t.workspaceId || '',
          type: 'terminal' as const,
          agentPreset,
          title: presetTitle,
          alias: t.alias,
          cwd,
          sdkSessionId: t.sdkSessionId,
          claudeCliSessionId: t.claudeCliSessionId,
          claudeCliRestartToken: t.claudeCliRestartToken,
          model: t.model,
          permissionMode: typeof t.permissionMode === 'string' ? t.permissionMode : undefined,
          agentParams: normalizeAgentParams(agentPreset, t.agentParams),
          sessionMeta: t.sessionMeta,
          worktreePath: t.worktreePath,
          worktreeBranch: t.worktreeBranch,
          worktreeMergedKind: t.worktreeMergedKind,
          historyKey: t.historyKey || uuidv4().replace(/-/g, '').slice(0, 12),
          procfilePath: t.procfilePath,
          scrollbackBuffer: [],
          pid: undefined,
        }
      }).filter((t: TerminalInstance | null): t is TerminalInstance => t !== null)
      const currentActiveWorkspaceId = this.state.activeWorkspaceId
      const currentFocusedTerminalId = this.state.focusedTerminalId
      const shouldPreserveActive = !!options?.preserveActiveSelection
        && !!currentActiveWorkspaceId
        && workspaces.some((w: Workspace) => w.id === currentActiveWorkspaceId)
      const requestedActiveWorkspaceId = shouldPreserveActive
        ? currentActiveWorkspaceId
        : parsed.activeWorkspaceId || null
      const activeWorkspaceId = requestedActiveWorkspaceId && workspaces.some((w: Workspace) => w.id === requestedActiveWorkspaceId)
        ? requestedActiveWorkspaceId
        : (workspaces.find((w: Workspace) => terminals.some((t: TerminalInstance) => t.workspaceId === w.id))?.id ?? workspaces[0]?.id ?? null)

      // Restore last focused terminal for the active workspace
      const activeWs = workspaces.find((w: Workspace) => w.id === activeWorkspaceId)
      const savedFocusId = activeWs?.focusedTerminalId
      const focusCandidate = shouldPreserveActive
        ? this.state.focusedTerminalId || savedFocusId || parsed.activeTerminalId
        : savedFocusId || parsed.activeTerminalId
      const restoredFocus = focusCandidate && terminals.find(
        (t: TerminalInstance) => t.id === focusCandidate && t.workspaceId === activeWorkspaceId
      ) ? focusCandidate : this.restoredFocusForWorkspace(activeWorkspaceId, workspaces, terminals)

      if (options?.preserveActiveSelection && currentActiveWorkspaceId && currentActiveWorkspaceId !== activeWorkspaceId) {
        host.debug.log?.(`[workspace-store] active workspace ${currentActiveWorkspaceId} removed by host; switched to ${activeWorkspaceId || 'none'}`)
      }
      if (options?.preserveActiveSelection && currentFocusedTerminalId && currentFocusedTerminalId !== restoredFocus) {
        const stillExists = terminals.some(t => t.id === currentFocusedTerminalId)
        if (!stillExists) {
          host.debug.log?.(`[workspace-store] focused terminal/session ${currentFocusedTerminalId} removed by host; switched to ${restoredFocus || 'none'}`)
        }
      }

      this.state = {
        ...this.state,
        workspaces,
        activeWorkspaceId,
        terminals,
        activeTerminalId: restoredFocus,
        focusedTerminalId: restoredFocus,
      }
      this.activeGroup = parsed.activeGroup || null
      this._lastSavedData = data
      debugLog('[workspace-store] load applied', {
        windowId: this.windowId,
        workspaceCount: workspaces.length,
        terminalCount: terminals.length,
        activeWorkspaceId,
        activeTerminalId: restoredFocus,
        focusedTerminalId: restoredFocus,
        activeWorkspaceTerminals: terminals
          .filter(t => t.workspaceId === activeWorkspaceId)
          .map(t => ({
            id: t.id,
            title: t.title,
            agentPreset: t.agentPreset || 'none',
            cwd: t.cwd,
          })),
      })
      this.notify()
    } catch (e) {
      host.debug.log?.(`Failed to parse workspace data: ${e}`)
      console.error('Failed to parse workspace data:', e)
    }
  }
}

export const workspaceStore = new WorkspaceStore()

import { createSelectorHook } from './use-store'
export const useWorkspace = createSelectorHook<AppState>({
  subscribe: (l) => workspaceStore.subscribe(l),
  getState: () => workspaceStore.getState(),
})
