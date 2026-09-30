/**
 * Agent 預設配置
 * 定義支援的 AI Agent CLI 工具及其屬性
 */

import { getDefaultPreset, listPresets, type PanelKind, type ProviderId } from '../../../shared/providers.mjs';

export interface AgentPreset {
  id: string;
  name: string;
  icon: string;
  color: string;
  command?: string;       // 可選的自動啟動命令（PTY 模式用）
  debug?: boolean;        // 僅在 debug 模式下顯示
  suggested?: boolean;    // 標記為推薦選項
  backend?: 'sdk' | 'channel' | 'cli' | 'pty';  // sdk = ClaudeAgentPanel, channel = Claude Channel Agent, cli = bundled CLI PTY, pty = generic PTY
  needsGitRepo?: boolean; // 需要 git repo（worktree 類）
  provider?: ProviderId | null; // shared/providers.json provider id; null = plain terminal
  panel?: PanelKind;      // which panel renders the session
  hidden?: boolean;       // kept for lookups of persisted sessions, never offered in pickers
}

// Preset ids are data (shared/providers.json), not a closed union: a new
// provider must not require a type change. Look presets up via the registry.
export type AgentPresetId = string;

// Presets are declared in shared/providers.json (see docs/providers.md).
export const AGENT_PRESETS: AgentPreset[] = listPresets();

export function getAgentPreset(id: string): AgentPreset | undefined {
  return AGENT_PRESETS.find(p => p.id === id);
}

export function getDefaultAgentPreset(): AgentPreset {
  return getDefaultPreset() || AGENT_PRESETS[0];
}

/** Get presets visible in UI, filtering debug-only presets unless BAT_DEBUG is set */
export function getVisiblePresets(isDebugOverride?: boolean): AgentPreset[] {
  const isDebug = typeof isDebugOverride === 'boolean'
    ? isDebugOverride
    : typeof window !== 'undefined'
      && (window as unknown as { batAppAPI?: { debug?: { isDebugMode?: boolean } } }).batAppAPI?.debug?.isDebugMode === true
  return AGENT_PRESETS.filter(p => !p.hidden && (!p.debug || isDebug))
}
