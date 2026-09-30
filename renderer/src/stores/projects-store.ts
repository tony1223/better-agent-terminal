// projects-store — renderer cache of discovered projects for the sidebar's
// Projects section.
//
// Fetches from the sidecar (via the projects_list Tauri command) using code
// roots derived from the parent dirs of the user's existing workspaces, so
// sibling repos under e.g. ~/code surface even when they have no open session.
// The store only watches workspaces (and rescans) while something is
// subscribed, i.e. while the Projects section is expanded.

import { createSelectorHook } from './use-store'
import { host } from '../host-api'
import { workspaceStore } from './workspace-store'

export interface ProjectWorktree {
  path: string
  branch: string | null
  isMain: boolean
}

export interface Project {
  id: string
  name: string
  root: string
  repo?: { host: string; owner: string; name: string }
  worktrees: ProjectWorktree[]
  sessionCount: number
  hasSessions: boolean
  lastSessionAt?: number
}

interface ProjectsState {
  projects: Project[]
  loading: boolean
  error: string | null
}

function parentDir(path: string): string {
  return path.replace(/[/\\]+$/, '').replace(/[/\\][^/\\]+$/, '')
}

// Code roots = unique parent dirs of every workspace folder. Scanning these
// finds the user's repos (and their siblings) without a dedicated setting.
function deriveCodeRoots(): string[] {
  const { workspaces } = workspaceStore.getState()
  const roots = new Set<string>()
  for (const workspace of workspaces) {
    const folder = workspace.folderPath
    if (!folder) continue
    const parent = parentDir(folder)
    if (parent) roots.add(parent)
  }
  return [...roots].sort()
}

function rootsKey(roots: string[]): string {
  return roots.join('|')
}

class ProjectsStore {
  private state: ProjectsState = { projects: [], loading: false, error: null }
  private listeners = new Set<() => void>()
  private unsubscribeWorkspaces: (() => void) | null = null
  // Roots key of the last scan that was started; null until the first scan.
  private lastRootsKey: string | null = null
  // Incremented per scan so a slow, superseded scan can't overwrite newer results.
  private requestSeq = 0

  getState(): ProjectsState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.startWatching()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stopWatching()
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private set(patch: Partial<ProjectsState>): void {
    this.state = { ...this.state, ...patch }
    this.notify()
  }

  // Re-scan when the set of code roots changes (workspace added/removed), so
  // newly opened projects' siblings surface without a manual rescan.
  private startWatching(): void {
    if (this.unsubscribeWorkspaces) return
    this.unsubscribeWorkspaces = workspaceStore.subscribe(() => this.refreshIfRootsChanged())
    this.refreshIfRootsChanged()
  }

  private stopWatching(): void {
    this.unsubscribeWorkspaces?.()
    this.unsubscribeWorkspaces = null
  }

  private refreshIfRootsChanged(): void {
    if (rootsKey(deriveCodeRoots()) !== this.lastRootsKey) void this.refresh()
  }

  async refresh(): Promise<void> {
    const roots = deriveCodeRoots()
    this.lastRootsKey = rootsKey(roots)
    const seq = ++this.requestSeq
    if (roots.length === 0) {
      // Nothing to scan (e.g. workspaces not loaded yet) — skip the host call.
      this.set({ projects: [], loading: false, error: null })
      return
    }
    this.set({ loading: true, error: null })
    try {
      const result = (await host.projects.list(roots)) as { projects?: Project[] } | null
      if (seq !== this.requestSeq) return
      this.set({ projects: Array.isArray(result?.projects) ? result.projects : [], loading: false })
    } catch (err) {
      if (seq !== this.requestSeq) return
      this.set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

export const projectsStore = new ProjectsStore()

export const useProjects = createSelectorHook<ProjectsState>({
  subscribe: (listener) => projectsStore.subscribe(listener),
  getState: () => projectsStore.getState(),
})
