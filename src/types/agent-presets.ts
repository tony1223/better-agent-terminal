/**
 * Agent 預設配置
 * 定義支援的 AI Agent CLI 工具及其屬性
 */

export interface AgentPreset {
  id: string;
  name: string;
  icon: string;
  color: string;
  command?: string;  // 可選的自動啟動命令
}

export type AgentPresetId = 'claude-code' | 'gemini-cli' | 'codex-cli' | 'copilot-cli' | 'none';

export const AGENT_PRESETS: AgentPreset[] = [
  { 
    id: 'claude-code', 
    name: 'Claude Code', 
    icon: '✦', 
    color: '#d97706', 
    command: 'claude' 
  },
  { 
    id: 'gemini-cli', 
    name: 'Gemini CLI', 
    icon: '◇', 
    color: '#4285f4', 
    command: 'gemini' 
  },
  { 
    id: 'codex-cli', 
    name: 'Codex', 
    icon: '⬡', 
    color: '#10a37f', 
    command: 'codex' 
  },
  { 
    id: 'copilot-cli', 
    name: 'GitHub Copilot', 
    icon: '⬢', 
    color: '#6e40c9', 
    command: 'gh copilot' 
  },
  { 
    id: 'none', 
    name: 'Terminal', 
    icon: '⌘', 
    color: '#888888' 
  },
];

export function getAgentPreset(id: string): AgentPreset | undefined {
  return AGENT_PRESETS.find(p => p.id === id);
}

export function getDefaultAgentPreset(): AgentPreset {
  return AGENT_PRESETS.find(p => p.id === 'claude-code') || AGENT_PRESETS[0];
}
