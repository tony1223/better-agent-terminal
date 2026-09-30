// ProjectsSidebar — the list inside the sidebar's collapsible Projects section.
// Lists git repos discovered next to the user's workspaces (including repos
// with no Claude sessions yet), their linked worktrees, and a per-repo Claude
// session count. The "+" button on a repo or worktree focuses the workspace
// bound to that directory (creating it if needed) and starts a Claude Code
// session there, or focuses the existing agent terminal if one is already open.

import { useTranslation } from 'react-i18next'

import { projectsStore, useProjects, type Project } from '../stores/projects-store'
import { workspaceStore } from '../stores/workspace-store'

// Reuse the matching workspace (and its agent) if present, otherwise create the
// workspace and add a default Claude agent terminal. The agent spawns when the
// workspace mounts; guarding on an existing agent avoids duplicate sessions
// (the workspace auto-create flow also skips when an agent terminal exists).
function startSession(path: string, name: string): void {
  const existing = workspaceStore.getState().workspaces.find(w => w.folderPath === path)
  const workspaceId = existing ? existing.id : workspaceStore.addWorkspace(name, path).id
  workspaceStore.setActiveWorkspace(workspaceId)
  const agent = workspaceStore.getWorkspaceTerminals(workspaceId).find(t => t.agentPreset && t.agentPreset !== 'none')
  if (agent) {
    workspaceStore.setFocusedTerminal(agent.id)
    return
  }
  workspaceStore.addTerminal(workspaceId, 'claude-code')
}

export function ProjectsSidebar() {
  const { t } = useTranslation()
  const { projects, loading, error } = useProjects(s => s)

  return (
    <div className="projects-sidebar">
      <div className="projects-toolbar">
        <span className="projects-count">{t('projects.repoCount', { count: projects.length })}</span>
        <button
          className="project-action-btn"
          onClick={() => void projectsStore.refresh()}
          disabled={loading}
          title={t('projects.rescan')}
          aria-label={t('projects.rescan')}
        >
          ↻
        </button>
      </div>
      {loading && projects.length === 0 && <div className="projects-status">{t('projects.scanning')}</div>}
      {error && <div className="projects-error">{t('projects.scanFailed', { error })}</div>}
      {!loading && !error && projects.length === 0 && <div className="projects-status">{t('projects.empty')}</div>}
      {projects.map((project: Project) => (
        <div key={project.id} className="project-item">
          <div className="project-row">
            <span className="project-name" title={project.root}>
              {project.name}
              {project.sessionCount > 0 && (
                <span
                  className="project-session-count"
                  title={t('projects.sessionCount', { count: project.sessionCount })}
                >
                  {` · ${project.sessionCount}`}
                </span>
              )}
            </span>
            <button
              className="project-action-btn"
              onClick={() => startSession(project.root, project.name)}
              title={t('projects.startSession')}
              aria-label={t('projects.startSession')}
            >
              +
            </button>
          </div>
          {project.worktrees.filter(w => !w.isMain).map(worktree => (
            <div key={worktree.path} className="project-row project-worktree-row">
              <span className="project-name" title={worktree.path}>
                ⌥ {worktree.branch || t('projects.detached')}
              </span>
              <button
                className="project-action-btn"
                onClick={() => startSession(
                  worktree.path,
                  `${project.name} (${worktree.branch || t('projects.worktreeFallback')})`,
                )}
                title={t('projects.startSessionInWorktree')}
                aria-label={t('projects.startSessionInWorktree')}
              >
                +
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
