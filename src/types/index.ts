export interface Workspace {
  id: string;
  name: string;
  alias?: string;
  folderPath: string;
  createdAt: number;
}

export interface TerminalInstance {
  id: string;
  workspaceId: string;
  type: 'terminal' | 'claude-code';
  title: string;
  alias?: string;
  pid?: number;
  cwd: string;
  scrollbackBuffer: string[];
  lastActivityTime?: number;
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
  type: 'terminal' | 'claude-code';
  shell?: string;
}

export interface PtyOutput {
  id: string;
  data: string;
}

export interface PtyExit {
  id: string;
  exitCode: number;
}

export type ShellType = 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'custom';

export interface AppSettings {
  shell: ShellType;
  customShellPath: string;
  fontSize: number;
  theme: 'dark' | 'light';
}
