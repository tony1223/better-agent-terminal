# CLAUDE.md - Project Guidelines

## No Regressions Policy

- **NEVER** break existing features when implementing new ones.
- Before committing, verify ALL existing features still work — not just the new changes.
- Run the build (`pnpm run compile`) to confirm compilation succeeds.
- When modifying shared code (stores, IPC handlers, types), trace all consumers to ensure nothing breaks.

## Package Management

- This repository uses **pnpm**. Do not use `npm install`, `npm ci`, or `npx` for project workflows.
- The pinned package manager is declared in `package.json` (`packageManager`: `pnpm@10.33.2`).
- Use `pnpm install --frozen-lockfile` for reproducible installs.
- Use `pnpm exec <tool>` instead of `npx <tool>`.
- Keep `pnpm-lock.yaml` committed and do not reintroduce `package-lock.json`.
- pnpm v10 blocks dependency lifecycle scripts unless explicitly allowed; required build-script packages are listed under `pnpm.onlyBuiltDependencies` in `package.json`.
- Standard verification commands:
  - `pnpm exec tsc --noEmit --pretty false`
  - `pnpm run compile`
  - `pnpm run test:sidecar`
  - `pnpm run check:tauri-rust`
  - `pnpm run test:tauri-rust`
  - For local packaging verification without macOS signing/notarization: `pnpm run tauri:build:debug`

## Logging

- **Frontend (renderer)**: Use `window.batAppAPI.debug.log(...)` instead of `console.log()`. This sends logs to the Tauri host logger, which writes to disk.
- **Backend (Tauri/Rust)**: Use the project Rust logging/debug helpers so logs are persisted.
- Do NOT use `console.log()` for debugging — use the logger so logs are persisted and visible in the log file.
- **Log file location**:
  - Tauri writes renderer/Rust logs to `<app-data>/logs/debug.log` and sidecar logs to `<app-data>/logs/sidecar.log`.
  - macOS fresh Tauri install: `~/Library/Application Support/com.tonyq.better-agent-terminal/logs/debug.log`
  - macOS existing Electron migration: `~/Library/Application Support/BetterAgentTerminal/logs/debug.log`
  - Windows fresh Tauri install: `%APPDATA%\com.tonyq.better-agent-terminal\logs\debug.log`
  - Linux fresh Tauri install: `~/.local/share/com.tonyq.better-agent-terminal/logs/debug.log` or the platform-resolved Tauri app data dir.
  - `BAT_TAURI_DATA_DIR` overrides the app data directory in dev/tests.
  - In the app, Settings → Open Logs Folder opens the active logs directory.

## Sub-agent / Active Tasks Tracking

- The Claude Agent SDK does **NOT** reliably emit `task_started` / `task_progress` / `task_notification` system messages.
- We track Agent/Task tools from `tool_use` blocks directly in `session.activeTasks` (in `claude-agent-manager.ts`).
- `stopTask()` falls back to using `toolUseId` as `task_id` when no mapping exists.
- Tool results for Agent/Task must clean up `activeTasks` entries.

## React Rendering

- Use `flushSync` from `react-dom` for Agent/Task tool state changes (`setMessages` in `onToolUse` and `onToolResult`) to prevent rendering delays from React 18 batching during streaming.
- Do NOT use `flushSync` for regular tool calls — only for state changes that affect the active tasks bar visibility.

## Status Line

- Our status line implementation is superior to external alternatives (e.g., ccstatusline). Do not replace it.
- 15 configurable items (see `STATUSLINE_ITEMS` in `renderer/src/types/index.ts`) with custom colors, zone alignment, and template-based config.
- Usage polling: Chrome session key (primary, lenient rate limits) → OAuth fallback (strict rate limits).

## Remote State Ownership

- Remote mode is host-owned by default. Except for purely local presentation state, clients do not own remote state.
- Message filters are client-only presentation state and may stay local because they do not change host data.
- All other remote actions must be sent to the host, and the client should render the host response or host broadcast reflection.
- When a remote client requests a mutation, the host applies or rejects it first, then returns the result and broadcasts canonical shared-state changes to every connected client.
- Avoid client-side optimistic final state for remote workflows. Loading/pending UI is fine while waiting for host confirmation.

## Git Workflow

- Do **NOT** auto-create a branch before committing. Commit directly to the current branch (including `main`) unless the user explicitly asks for a branch or PR. This overrides the default "branch first on the default branch" behavior.
- Still only commit/push when the user asks.

## Release

- `package.json` 與 `src-tauri/tauri.conf.json` 的 committed version 固定維持 `0.0.1-dev`。
- 發版時只建立 / push tag；不要 commit release version bump。GitHub Actions 會從 tag 注入實際 build 版本。
- **正式版**: `release new tag version` → 基於最新 tag 遞增 patch 版號，建立 tag 並 push
  - 例：目前 `v2.2.27` → 建立 `v2.2.28` tag
- **預覽版**: `release new pre tag version` → 基於最新 tag 遞增 patch 版號，加 `-pre.1` 後綴
  - 例：目前 `v2.2.27` → 建立 `v2.2.28-pre.1`
  - 若已有 `v2.2.28-pre.1` → 建立 `v2.2.28-pre.2`
- Tag 含 `-pre` 時 GitHub Release 自動標為 Pre-release，不更新 Homebrew tap
- Tag 不含 `-pre` 時為正式版，更新 Homebrew tap
