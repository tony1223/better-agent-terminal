import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { host } from '../host-api'

interface SkillItem {
  name: string
  description: string
  argumentHint?: string
}

interface SkillsPanelProps {
  isVisible: boolean
  width?: number
  collapsed?: boolean
  onCollapse?: () => void
  activeCwd: string | null
  activeSessionId: string | null
}

// Known built-in Claude Code commands & skills — anything not in this set is treated as custom/user skill
const BUILTIN_COMMANDS = new Set([
  // Slash commands
  'bug', 'clear', 'compact', 'config', 'cost', 'debug', 'doctor', 'feedback',
  'help', 'init', 'login', 'logout', 'memory', 'model', 'permissions',
  'plan', 'project', 'review', 'search', 'status', 'terminal', 'vim', 'web',
  // System skills
  'batch', 'claude-api', 'context', 'extra-usage', 'heapdump', 'insights',
  'keybindings-help', 'loop', 'pr-comments', 'release-notes', 'schedule',
  'security-review', 'simplify', 'update-config',
])

export function SkillsPanel({ isVisible, activeCwd, activeSessionId }: SkillsPanelProps) {
  const { t } = useTranslation()
  const [sdkCommands, setSdkCommands] = useState<SkillItem[]>([])
  const [fsCommands, setFsCommands] = useState<{ name: string; description: string; scope: 'project' | 'global' | 'plugin' }[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const retryRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch SDK supported commands — retry until available (queryInstance needs first query)
  useEffect(() => {
    if (retryRef.current) { clearInterval(retryRef.current); retryRef.current = null }
    if (!activeSessionId) {
      setSdkCommands([])
      return
    }

    const fetchCommands = () => {
      host.claude.getSupportedCommands(activeSessionId).then(cmds => {
        if (cmds?.length) {
          setSdkCommands(cmds.map(c => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
          })))
          if (retryRef.current) { clearInterval(retryRef.current); retryRef.current = null }
        }
      }).catch(() => {})
    }

    fetchCommands()
    retryRef.current = setInterval(fetchCommands, 3000)

    return () => {
      if (retryRef.current) { clearInterval(retryRef.current); retryRef.current = null }
    }
  }, [activeSessionId])

  // Listen for broadcast from ClaudeAgentPanel
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { commands: { name: string; description: string; argumentHint: string }[] } | undefined
      if (detail?.commands?.length) {
        setSdkCommands(detail.commands.map(c => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
        })))
        if (retryRef.current) { clearInterval(retryRef.current); retryRef.current = null }
      }
    }
    window.addEventListener('claude-skills-updated', handler)
    return () => window.removeEventListener('claude-skills-updated', handler)
  }, [])

  // Scan filesystem .claude/commands/
  useEffect(() => {
    if (!activeCwd) {
      setFsCommands([])
      return
    }
    host.claude.scanSkills(activeCwd).then(results => {
      setFsCommands(results)
    }).catch(() => setFsCommands([]))
  }, [activeCwd])

  // Classify: plugin (top) vs custom (middle) vs built-in (bottom).
  // Plugin items are namespaced "<plugin>:<name>" — both from the fs scan
  // (scope 'plugin') and from SDK commands that carry a ':' namespace.
  const { pluginItems, customItems, builtinItems } = useMemo(() => {
    const fsNames = new Set(fsCommands.map(f => f.name))

    const fsPlugin: SkillItem[] = []
    const fsCustom: SkillItem[] = []
    for (const f of fsCommands) {
      const item = { name: f.name, description: f.description }
      if (f.scope === 'plugin') fsPlugin.push(item)
      else fsCustom.push(item)
    }

    // SDK commands: split into plugin (namespaced), custom (unknown) and
    // built-in (known).
    const sdkPlugin: SkillItem[] = []
    const sdkCustom: SkillItem[] = []
    const sdkBuiltin: SkillItem[] = []
    for (const cmd of sdkCommands) {
      if (fsNames.has(cmd.name)) continue // already covered by the fs scan
      if (cmd.name.includes(':')) {
        sdkPlugin.push(cmd)
      } else if (BUILTIN_COMMANDS.has(cmd.name)) {
        sdkBuiltin.push(cmd)
      } else {
        sdkCustom.push(cmd)
      }
    }

    return {
      pluginItems: [...fsPlugin, ...sdkPlugin],
      customItems: [...fsCustom, ...sdkCustom],
      builtinItems: sdkBuiltin,
    }
  }, [sdkCommands, fsCommands])

  // Filter by search
  const filteredPlugin = useMemo(() => {
    if (!searchQuery) return pluginItems
    const q = searchQuery.toLowerCase()
    return pluginItems.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  }, [pluginItems, searchQuery])

  const filteredCustom = useMemo(() => {
    if (!searchQuery) return customItems
    const q = searchQuery.toLowerCase()
    return customItems.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  }, [customItems, searchQuery])

  const filteredBuiltin = useMemo(() => {
    if (!searchQuery) return builtinItems
    const q = searchQuery.toLowerCase()
    return builtinItems.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  }, [builtinItems, searchQuery])

  const handleClick = useCallback((skill: SkillItem) => {
    window.dispatchEvent(new CustomEvent('claude-insert-command', {
      detail: { name: skill.name }
    }))
  }, [])

  if (!isVisible) return null

  const renderItem = (skill: SkillItem) => (
    <div
      key={skill.name}
      className="skills-item"
      onClick={() => handleClick(skill)}
      title={skill.description || skill.name}
    >
      <span className="skills-item-name">/{skill.name}</span>
      {skill.description && (
        <span className="skills-item-desc">{skill.description}</span>
      )}
    </div>
  )

  const hasAny = pluginItems.length > 0 || customItems.length > 0 || builtinItems.length > 0
  const hasFiltered = filteredPlugin.length > 0 || filteredCustom.length > 0 || filteredBuiltin.length > 0

  return (
    <div className="skills-sidebar">
      <div className="skills-sidebar-search">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder={t('skills.searchSkills')}
        />
      </div>

      <div className="skills-sidebar-body">
        {/* Top section: Plugin-provided commands (scrollable) */}
        {filteredPlugin.length > 0 && (
          <div className="skills-section">
            <div className="skills-group-header">{t('skills.pluginCommands', 'Plugin commands')}</div>
            <div className="skills-section-list">
              {filteredPlugin.map(renderItem)}
            </div>
          </div>
        )}

        {/* Middle section: Custom / user skills (scrollable) */}
        {filteredCustom.length > 0 && (
          <div className="skills-section">
            <div className="skills-group-header">{t('skills.customCommands')}</div>
            <div className="skills-section-list">
              {filteredCustom.map(renderItem)}
            </div>
          </div>
        )}

        {/* Bottom section: Built-in commands (scrollable) */}
        {filteredBuiltin.length > 0 && (
          <div className="skills-section">
            <div className="skills-group-header">{t('skills.bundledCommands')}</div>
            <div className="skills-section-list">
              {filteredBuiltin.map(renderItem)}
            </div>
          </div>
        )}

        {!hasFiltered && (
          <div className="skills-empty">
            {!hasAny
              ? activeSessionId
                ? t('skills.waitingForUpdate')
                : t('skills.noSession')
              : t('skills.noMatchingSkills')}
          </div>
        )}
      </div>
    </div>
  )
}
