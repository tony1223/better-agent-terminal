// ProjectsSidebar — the list inside the sidebar's collapsible Projects section.
// Lists git repos discovered next to the user's workspaces (including repos
// with no Claude sessions yet), their linked worktrees, and a per-repo Claude
// session count. The "+" button on a repo or worktree focuses the workspace
// bound to that directory (creating it if needed) and starts a Claude Code
// session there, or focuses the existing agent terminal if one is already open.

import { useTranslation } from 'react-i18next'
import { useRef, useState } from 'react'

import { projectsStore, useProjects, type Project } from '../stores/projects-store'
import { workspaceStore } from '../stores/workspace-store'

// Reuse the matching workspace (and its agent) if present, otherwise create the
// workspace and add a default Claude agent terminal. The agent spawns when the
// workspace mounts; guarding on an existing agent avoids duplicate sessions
// (the workspace auto-create flow also skips when an agent terminal exists).
export function ProjectsSidebar() {
  const { t } = useTranslation()
  const { projects, loading, error } = useProjects(s => s)
  const openingRef = useRef(false)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const startSession = async (path: string, name: string): Promise<void> => {
    if (openingRef.current) return
    openingRef.current = true
    setOpening(true)
    setOpenError(null)
    try {
      await workspaceStore.openProject(path, name)
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err))
    } finally {
      openingRef.current = false
      setOpening(false)
    }
  }

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
      {openError && <div className="projects-error" role="alert">{t('projects.openFailed', { error: openError })}</div>}
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
              onClick={() => void startSession(project.root, project.name)}
              disabled={opening}
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
                disabled={opening}
                onClick={() => void startSession(
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
