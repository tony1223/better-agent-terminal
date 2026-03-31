import { AgentPresetId } from './agent-presets';

// 環境變數定義
export interface EnvVariable {
  key: string;
  value: string;
  enabled: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  alias?: string;
  folderPath: string;
  createdAt: number;
  defaultAgent?: AgentPresetId;  // Workspace 預設 Agent
  envVars?: EnvVariable[];       // Workspace 專屬環境變數
  group?: string;                // Workspace 分組
  color?: string;                // Workspace 顏色標籤
  lastSdkSessionId?: string;     // 上次使用的 SDK session ID，下次自動 resume
}

export const WORKSPACE_COLORS = [
  { id: 'red', value: '#e74c3c', label: 'Red' },
  { id: 'orange', value: '#e67e22', label: 'Orange' },
  { id: 'yellow', value: '#f1c40f', label: 'Yellow' },
  { id: 'green', value: '#2ecc71', label: 'Green' },
  { id: 'blue', value: '#3498db', label: 'Blue' },
  { id: 'purple', value: '#9b59b6', label: 'Purple' },
  { id: 'pink', value: '#e91e8a', label: 'Pink' },
  { id: 'gray', value: '#95a5a6', label: 'Gray' },
] as const

export interface TerminalInstance {
  id: string;
  workspaceId: string;
  type: 'terminal';              // 統一為 terminal
  agentPreset?: AgentPresetId;   // 可選的 Agent 預設
  title: string;
  alias?: string;
  pid?: number;
  cwd: string;
  scrollbackBuffer: string[];
  lastActivityTime?: number;
  hasPendingAction?: boolean;
  sdkSessionId?: string;         // Claude SDK session ID for auto-resume
  model?: string;                // Selected Claude model for this session
  pendingPrompt?: string;        // Prompt to auto-send after fork/resume
  pendingImages?: string[];      // Data URLs of images to send with pendingPrompt
  sessionMeta?: {                // Persisted session metadata for status line
    totalCost: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    numTurns: number;
    contextWindow: number;
  };
}

export interface AppState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  terminals: TerminalInstance[];
  activeTerminalId: string | null;
  focusedTerminalId: string | null;
}

export interface CreatePtyOptions {
  id: string;
  cwd: string;
  type: 'terminal';              // 統一為 terminal
  agentPreset?: AgentPresetId;   // 可選的 Agent 預設
  shell?: string;
  customEnv?: Record<string, string>;  // 自定義環境變數
}

export interface PtyOutput {
  id: string;
  data: string;
}

export interface PtyExit {
  id: string;
  exitCode: number;
}

// Shell types: platform-specific options
// Windows: pwsh, powershell, cmd
// macOS/Linux: zsh, bash, sh
export type ShellType = 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'zsh' | 'bash' | 'sh' | 'custom';

// Shell options grouped by platform
export const SHELL_OPTIONS: { id: ShellType; name: string; platforms: ('win32' | 'darwin' | 'linux')[] }[] = [
  { id: 'auto', name: 'Auto Detect', platforms: ['win32', 'darwin', 'linux'] },
  // Windows shells
  { id: 'pwsh', name: 'PowerShell 7 (pwsh)', platforms: ['win32'] },
  { id: 'powershell', name: 'Windows PowerShell', platforms: ['win32'] },
  { id: 'cmd', name: 'Command Prompt (cmd)', platforms: ['win32'] },
  // macOS/Linux shells
  { id: 'zsh', name: 'Zsh', platforms: ['darwin', 'linux'] },
  { id: 'bash', name: 'Bash', platforms: ['darwin', 'linux'] },
  { id: 'sh', name: 'sh', platforms: ['darwin', 'linux'] },
  // Custom (all platforms)
  { id: 'custom', name: 'Custom', platforms: ['win32', 'darwin', 'linux'] },
];

export type FontType = 'system' | 'sf-mono' | 'menlo' | 'consolas' | 'monaco' | 'fira-code' | 'jetbrains-mono' | 'cascadia-code' | 'custom';

const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

// Cross-platform fallback chains for reliable xterm.js rendering
export const FONT_OPTIONS: { id: FontType; name: string; fontFamily: string }[] = [
  { id: 'system', name: 'System Default', fontFamily: isWindows
    ? 'Consolas, "Courier New", monospace'
    : '"SF Mono", Menlo, Monaco, monospace' },
  { id: 'cascadia-code', name: 'Cascadia Code', fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { id: 'consolas', name: 'Consolas', fontFamily: 'Consolas, "Courier New", monospace' },
  { id: 'sf-mono', name: 'SF Mono', fontFamily: '"SF Mono", Menlo, Consolas, monospace' },
  { id: 'menlo', name: 'Menlo', fontFamily: 'Menlo, Consolas, monospace' },
  { id: 'monaco', name: 'Monaco', fontFamily: 'Monaco, Consolas, monospace' },
  { id: 'fira-code', name: 'Fira Code', fontFamily: '"Fira Code", Consolas, monospace' },
  { id: 'jetbrains-mono', name: 'JetBrains Mono', fontFamily: '"JetBrains Mono", Consolas, monospace' },
  { id: 'custom', name: 'Custom', fontFamily: 'monospace' },
];

// Preset terminal color themes
export const COLOR_PRESETS = [
  {
    id: 'novel',
    name: 'Novel (Default)',
    background: '#1f1d1a',
    foreground: '#dfdbc3',
    cursor: '#dfdbc3'
  },
  {
    id: 'dracula',
    name: 'Dracula',
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2'
  },
  {
    id: 'monokai',
    name: 'Monokai',
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2'
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    background: '#002b36',
    foreground: '#839496',
    cursor: '#839496'
  },
  {
    id: 'nord',
    name: 'Nord',
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9'
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#abb2bf'
  },
  {
    id: 'custom',
    name: 'Custom',
    background: '#1f1d1a',
    foreground: '#dfdbc3',
    cursor: '#dfdbc3'
  },
] as const;

export type ColorPresetId = typeof COLOR_PRESETS[number]['id'];

// Agent command type for auto-start
export type AgentCommandType = 'claude' | 'gemini' | 'codex' | 'custom';

export const AGENT_COMMAND_OPTIONS: { id: AgentCommandType; name: string; command: string }[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini' },
  { id: 'codex', name: 'Codex CLI', command: 'codex' },
  { id: 'custom', name: 'Custom', command: '' },
];

export type LanguageCode = 'en' | 'zh-TW' | 'zh-CN';

export interface AppSettings {
  language: LanguageCode;
  shell: ShellType;
  customShellPath: string;
  fontSize: number;
  fontFamily: FontType;
  customFontFamily: string;
  theme: 'dark' | 'light';
  colorPreset: ColorPresetId;
  customBackgroundColor: string;
  customForegroundColor: string;
  customCursorColor: string;
  globalEnvVars?: EnvVariable[];  // 全域環境變數
  defaultAgent?: AgentPresetId;   // 全域預設 Agent
  agentAutoCommand: boolean;      // 是否自動啟動 Agent
  agentCommandType: AgentCommandType;  // Agent 命令類型
  agentCustomCommand: string;     // 自定義 Agent 命令
  defaultTerminalCount: number;   // 每個 workspace 預設的 terminal 數量
  createDefaultAgentTerminal: boolean;  // 是否預設建立 Agent Terminal
  allowBypassPermissions: boolean;  // 允許切換 bypassPermissions 模式時不再確認
  defaultModel?: string;     // 預設模型（空 = 使用 SDK 預設）
  defaultEffort?: 'low' | 'medium' | 'high' | 'max';  // 預設 effort level
  showDockBadge?: boolean;               // Dock 圖示顯示待處理數量
  notifyOnComplete?: boolean;           // Agent 完成時發送系統通知
  notifySound?: boolean;               // 通知時播放聲音
  notifyOnlyBackground?: boolean;      // 僅在視窗不在前景時通知
  statuslineItems?: StatuslineItemConfig[];  // 自訂 statusline 項目排序和顯示
  collapseToolOutputs?: boolean;  // 預設折疊所有工具輸出（預設 false = 展開）
}

// ============================================
//   Skill Commands
// ============================================

export interface SkillCommand {
  name: string
  description: string
  argumentHint?: string
  scope: 'project' | 'global'
  source: 'filesystem' | 'sdk'
}

// ============================================
//   Statusline Configuration
// ============================================

export type StatuslineItemId =
  | 'sessionId' | 'tokens' | 'turns' | 'duration'
  | 'contextPct' | 'cost' | 'workspace' | 'gitBranch'
  | 'usage5h' | 'usage5hReset' | 'usage7d' | 'usage7dReset'
  | 'maxOut' | 'prompts'

export interface StatuslineItemConfig {
  id: StatuslineItemId
  visible: boolean
  separatorAfter?: boolean
  align?: 'left' | 'center' | 'right'
  color?: string  // Custom color (hex or CSS color)
}

export interface StatuslineItemDef {
  id: StatuslineItemId
  label: string
  description: string
  defaultVisible: boolean
  group: 'session' | 'context' | 'limits' | 'actions'
}

export const STATUSLINE_ITEMS: StatuslineItemDef[] = [
  { id: 'sessionId',    label: 'Session ID',   description: 'First 8 chars of SDK session ID (click to resume)',  defaultVisible: true,  group: 'session' },
  { id: 'gitBranch',    label: 'Git Branch',   description: 'Current git branch name',                            defaultVisible: true,  group: 'session' },
  { id: 'tokens',       label: 'Tokens',       description: 'Total input + output token count',                   defaultVisible: true,  group: 'session' },
  { id: 'turns',        label: 'Turns',        description: 'Number of conversation turns',                       defaultVisible: true,  group: 'session' },
  { id: 'duration',     label: 'Duration',     description: 'Session duration in seconds',                        defaultVisible: true,  group: 'session' },
  { id: 'contextPct',   label: 'Context %',    description: 'Percentage of context window used',                  defaultVisible: true,  group: 'context' },
  { id: 'cost',         label: 'Cost',         description: 'Total session cost in USD',                          defaultVisible: true,  group: 'context' },
  { id: 'workspace',    label: 'Workspace',    description: 'Current workspace name',                             defaultVisible: false, group: 'context' },
  { id: 'usage5h',      label: '5h Usage',     description: '5-hour usage percentage',                            defaultVisible: true,  group: 'limits' },
  { id: 'usage5hReset', label: '5h Reset',     description: '5-hour usage reset countdown',                       defaultVisible: true,  group: 'limits' },
  { id: 'usage7d',      label: '7d Usage',     description: '7-day usage percentage',                             defaultVisible: true,  group: 'limits' },
  { id: 'usage7dReset', label: '7d Reset',     description: '7-day usage reset countdown',                        defaultVisible: true,  group: 'limits' },
  { id: 'maxOut',        label: 'Max Output',   description: 'Maximum output tokens for current model',            defaultVisible: false, group: 'context' },
  { id: 'prompts',      label: 'Prompts',      description: 'Link to view prompt history',                        defaultVisible: true,  group: 'actions' },
]
