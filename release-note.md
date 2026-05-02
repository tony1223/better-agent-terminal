# Release Notes — v2.1.x

## v2.1.6

### New Features

#### Keyboard Shortcuts (#68)
- `` Ctrl+ ` `` / `` Cmd+` ``: Toggle between Agent terminal and first regular terminal (press again to switch back)
- `Ctrl+←/→` / `Cmd+←/→`: Cycle workspace tabs (Terminal → Files → Git)
- `Ctrl+↑/↓` / `Cmd+↑/↓`: Switch to previous / next workspace (wraps around)

---

## v2.1.5

### Bug Fixes
- **Model selector**: No longer shows "No models available" — models are now fetched on-demand when the selector opens, without requiring an active session
- **Model switching**: Switching models no longer clears the message input box (#65)

---

## v2.1.4

### New Features

#### Cross-Window Workspace Drag-and-Drop
- Drag workspaces between different windows in the sidebar
- Drop position is respected — inserts at the exact target slot
- No session rebuild needed — pure registry re-index

#### Firefox Session Key Support
- Usage polling now supports Firefox cookies as a session key source (Chrome → Firefox → OAuth fallback chain)
- Cross-platform: macOS, Windows (`%APPDATA%`), Linux (standard + Snap + Flatpak)
- Reads `profiles.ini` to resolve the correct default profile
- EBUSY handling: if Firefox is running and DB is locked, returns stale cache for 10 min

#### Usage Polling Improvements
- Cumulative backoff: `60s × 2^streak` (streak capped at 3 → max 480s) for consecutive rate limits
- `refreshUsageNow()` is blocked during rate-limit backoff to prevent hammering
- localStorage cache: usage data persists across app restarts; expired windows are cleared on load
- Stale indicator: 10 min without fresh data marks the 5h usage as stale (dimmed)

#### 5h Pacing Indicator
- `usage5h` statusline item now shows ▼ (on pace) or ▲ (over pace) based on utilization vs time elapsed
- Tooltip shows time elapsed % and estimated minutes to limit

#### Context % Dynamic Color
- `ctx X%` statusline item now colors dynamically: green (≤50%) / yellow (≥50%) / red (≥80%)
- User-configured statusline color for `contextPct` is ignored — dynamic color always wins

#### PDF Preview
- Click `.pdf` file paths in Agent chat to open preview in right sidebar using Chromium's built-in viewer (#60, @handpower)

#### Simplified Chinese Locale
- Added 简体中文 (Simplified Chinese) language support

#### Multi-Window Enhancements
- Window index shown in profile badge (e.g. `Default:1`, `Default:2`)
- Closing an empty-workspace window skips confirmation dialog — removed silently
- Single instance lock with workspace save-to-snapshot on second launch attempt

### Bug Fixes
- Fixed stale/wrong-account Chrome session key returning 0% usage after account switch
- Fixed `getSupportedModels` failing when no active session exists
- Fixed image resize error (`sharp` module not found in packaged app) — native binaries now unpacked from asar
- Fixed `sharp` platform-specific deps causing `EBADPLATFORM` on ARM64 CI runners
- Fixed markdown loose list item extra spacing
- Fixed cross-window workspace drop inserting at wrong position

---

## v2.1.3

### New Features

#### Profile Workspace Isolation
- New profile opened in a new window now starts with empty workspace list (previously showed old profile's workspaces)

#### Drag-and-Drop Workspace
- Drag folders from Finder/Explorer directly onto the sidebar workspace list to add them
- Supports multiple folders at once
- Visual feedback with dashed blue outline during drag

#### Native Create Folder in Add Workspace
- Folder picker now natively supports creating new folders (macOS "New Folder" button / Windows native support)
- Simplified from split button back to single "Add Workspace" button

### Bug Fixes
- Fixed extra line breaks in markdown preview (`breaks: false` for GFM standard behavior)
- Fixed `fs.readFile` error handling in MarkdownPreviewPanel (#51, @Owen0857)

---

## v2.1.2

### New Features

#### Skills Panel
- Right sidebar new "Skills" tab (alongside Snippets) showing available slash commands
- Split into **Custom** (user-defined `.claude/commands/`) and **Built-in** (system) sections with separator
- Click any skill to insert `/command` into Agent chat input
- Auto-loads from SDK `supportedCommands()` with 3s retry for fresh sessions
- Only visible for Claude Code terminals
- Filesystem scan reads project-level and global `.claude/commands/*.md`

#### Markdown Preview Panel
- Click `.md` file paths in Agent chat to open live preview in right sidebar
- Auto-updates on file changes via `fs.watch`
- Header with filename, copy path, open file, and close buttons
- Reuses existing markdown pipeline (marked + DOMPurify + highlight.js + mermaid)

#### Workspace Context Menu
- Added "Copy Path" option to right-click workspace menu

### Community Contributions
- **@Owen0857**: Collapse output for read-only tools (Read, Glob, Grep, LS) (#42)
- **@Owen0857**: Usage polling rate-limit backoff fix (#44)
- **@Owen0857**: SDK plugin loading support (#40)
- **@handpower**: File URL parsing fix (#41)
- **@handpower**: Markdown rendering in Agent chat panel (#39)

---

## v2.1.1

### New Features

#### Default Model & Effort Settings
- New settings: Default Model (text input) and Default Effort Level (dropdown)
- Applied to new Agent sessions automatically
- Default effort changed from `high` to `medium`
- Removed `max` effort from UI (SDK still accepts it for Opus 4.6)

#### Enable 1M Context Toggle
- New checkbox in Settings to enable/disable 1M token context window
- Default: enabled (1M is GA for Opus 4.6 / Sonnet 4.6)

### Improvements

#### Statusline
- **ctx%** now uses per-turn `usage.input_tokens` (actual context size) instead of cumulative total
  - Previously showed misleading values like "ctx 184%" after many turns
  - Tooltip shows both current context and total consumption
- **maxOut** statusline item shows max output tokens (e.g. `maxOut:64k`)
  - Default hidden, enable in statusline settings
- **last_tool_name** shown in active tasks bar (e.g. `Searching codebase [Grep]`)

#### Input
- Agent input textarea auto-grows up to ~8 lines as you type
- Shrinks back to 1 line on clear/send

#### SDK & Token Counting
- Updated claude-agent-sdk to 0.2.81 and claude-code to 2.1.81
- Fixed token counting to include cache tokens (cacheRead + cacheCreate)
- Removed blink animation from task elapsed time display

### Bug Fixes
- Fixed usage polling rate-limit backoff (use retryAfterSec directly)
- Support `file://` URLs in LinkedText
- Restored original 2min usage polling (SDK rate_limits lacks 7d data)
