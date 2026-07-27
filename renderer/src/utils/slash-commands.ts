// Grouping and filtering for the `/` menu.
//
// Two sources feed that menu. BAT contributes a dozen commands it handles
// itself (/resume, /model, /new …). Claude Code contributes everything else it
// knows about — its own built-ins, commands from installed plugins, and skills
// from ~/.claude/skills, project .claude/skills and plugin bundles — delivered
// as one flat SlashCommand[] over the claude:commands event.
//
// Flat is the problem. A user with a handful of marketplace plugins has fifty
// or more entries, and an undifferentiated list of fifty is only marginally more
// discoverable than the empty list this replaced. So the menu groups, and the
// grouping has to be derived from the only thing the payload actually carries:
// the name.
//
// React-free so it can be tested with plain node:assert.

export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint: string
  /** Alternate names that resolve to the same command (e.g. /cost → /usage). */
  aliases?: string[]
}

export type SlashCommandSource = 'bat' | 'builtin' | 'plugin' | 'skill'

export interface SlashCommandEntry extends SlashCommandInfo {
  source: SlashCommandSource
}

export interface SlashCommandGroup {
  source: SlashCommandSource
  label: string
  items: SlashCommandEntry[]
}

// Claude Code's own commands and system skills. Used only to separate "shipped
// with Claude Code" from "something you installed" in the menu headings — a name
// missing from this set is still listed, just under a different heading, so the
// cost of the set drifting behind a Claude Code release is a mislabelled group
// rather than a hidden command.
export const CLAUDE_BUILTIN_COMMANDS = new Set([
  // Slash commands
  'bug', 'clear', 'compact', 'config', 'cost', 'debug', 'doctor', 'feedback',
  'help', 'init', 'login', 'logout', 'memory', 'model', 'permissions',
  'plan', 'project', 'review', 'search', 'status', 'terminal', 'vim', 'web',
  // System skills
  'batch', 'claude-api', 'context', 'extra-usage', 'heapdump', 'insights',
  'keybindings-help', 'loop', 'pr-comments', 'release-notes', 'schedule',
  'security-review', 'simplify', 'update-config',
])

const GROUP_LABELS: Record<SlashCommandSource, string> = {
  bat: 'BAT',
  builtin: 'Claude Code',
  plugin: 'Plugins',
  // Personal commands under ~/.claude/commands land here too. The payload gives
  // no way to tell a custom command from a skill, so the heading names both
  // rather than picking one and being wrong half the time.
  skill: 'Skills & custom',
}

// Display order. BAT first because those are the commands this app implements
// and the ones a keystroke away from working; plugins and skills last because
// they are the long tail.
const GROUP_ORDER: SlashCommandSource[] = ['bat', 'builtin', 'plugin', 'skill']

/**
 * Which heading a CLI-reported command belongs under.
 *
 * Claude Code namespaces plugin commands as `plugin-name:command-name`, so a
 * colon is a reliable marker. Everything else is either a known built-in or
 * something the user installed.
 */
export function claudeCommandSource(name: string): SlashCommandSource {
  if (name.includes(':')) return 'plugin'
  return CLAUDE_BUILTIN_COMMANDS.has(name) ? 'builtin' : 'skill'
}

/**
 * Merge BAT's commands with the CLI's, dropping CLI entries whose name BAT
 * already owns.
 *
 * The overlap is real and not small — /model, /compact, /clear, /login,
 * /logout, /resume all exist on both sides. BAT intercepts those names before
 * the prompt is ever sent, so the CLI's entry is unreachable; listing it would
 * put two rows with the same name and different descriptions in the menu and
 * let the user pick the one that does nothing.
 */
export function mergeSlashCommands(
  batCommands: readonly SlashCommandInfo[],
  claudeCommands: readonly SlashCommandInfo[],
): SlashCommandEntry[] {
  const seen = new Set(batCommands.map(c => c.name))
  const merged: SlashCommandEntry[] = batCommands.map(c => ({ ...c, source: 'bat' as const }))
  for (const cmd of claudeCommands) {
    if (!cmd || typeof cmd.name !== 'string' || !cmd.name) continue
    if (seen.has(cmd.name)) continue
    seen.add(cmd.name)
    merged.push({
      name: cmd.name,
      description: typeof cmd.description === 'string' ? cmd.description : '',
      argumentHint: typeof cmd.argumentHint === 'string' ? cmd.argumentHint : '',
      ...(Array.isArray(cmd.aliases) && cmd.aliases.length > 0 ? { aliases: cmd.aliases } : {}),
      source: claudeCommandSource(cmd.name),
    })
  }
  return merged
}

/**
 * Substring match on the name, plus any aliases.
 *
 * Deliberately not matching descriptions: someone typing `/re` wants /resume and
 * /review, not the nine commands whose description happens to contain "re".
 * The Skills panel is the place for prose search.
 */
export function filterSlashCommands(
  entries: readonly SlashCommandEntry[],
  query: string,
): SlashCommandEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...entries]
  return entries.filter(entry =>
    entry.name.toLowerCase().includes(q)
    || entry.aliases?.some(alias => alias.toLowerCase().includes(q)),
  )
}

/**
 * Bucket entries into display groups, preserving each group's incoming order and
 * dropping groups with nothing in them.
 */
export function groupSlashCommands(entries: readonly SlashCommandEntry[]): SlashCommandGroup[] {
  const buckets = new Map<SlashCommandSource, SlashCommandEntry[]>()
  for (const entry of entries) {
    const bucket = buckets.get(entry.source)
    if (bucket) bucket.push(entry)
    else buckets.set(entry.source, [entry])
  }
  return GROUP_ORDER
    .filter(source => buckets.has(source))
    .map(source => ({ source, label: GROUP_LABELS[source], items: buckets.get(source)! }))
}

/**
 * Flatten groups back to a single list.
 *
 * Arrow-key navigation indexes into a flat array while the menu renders headed
 * sections; both have to walk the rows in the same order or the highlight lands
 * on a different command than the one that runs. Deriving the flat list from the
 * groups — rather than building the two independently — is what keeps them in
 * step.
 */
export function flattenSlashGroups(groups: readonly SlashCommandGroup[]): SlashCommandEntry[] {
  return groups.flatMap(group => group.items)
}
