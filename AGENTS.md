# AGENTS.md - Project Guidelines

Follow the project guidance in `CLAUDE.md`. The most important operational notes are repeated here for agents that load `AGENTS.md` first.

## Package Management

- This repository uses **pnpm**. Do not use `npm install`, `npm ci`, or `npx` for project workflows.
- The pinned package manager is declared in `package.json` (`packageManager`: `pnpm@10.33.2`).
- Use `pnpm install --frozen-lockfile` for reproducible installs.
- Use `pnpm exec <tool>` instead of `npx <tool>`.
- Keep `pnpm-lock.yaml` committed and do not reintroduce `package-lock.json`.
- pnpm v10 blocks dependency lifecycle scripts unless explicitly allowed; required build-script packages are listed under `pnpm.onlyBuiltDependencies` in `package.json`.

## Verification

- Run `pnpm exec tsc --noEmit --pretty false` for type checking.
- Run `pnpm run compile` for the standard build check.
- Run `pnpm run test:sidecar` when touching Node sidecar resolution or runtime startup.
- Run `pnpm run check:tauri-rust` when touching Rust/Tauri runtime code. Run `pnpm run test:tauri-rust` when touching Rust behavior covered by unit tests; the Windows test harness includes the required Common Controls v6 activation manifest.
- For local packaging verification without macOS signing/notarization, run:
  - `pnpm run tauri:build:debug`

## Project Rules

- Do not replace the built-in status line implementation.
- Renderer logs should use `window.batAppAPI.debug.log(...)`; Tauri/backend logs should use the project logger/debug helpers.
- Tauri logs live under `<app-data>/logs/`: renderer/Rust logs in `debug.log`, sidecar logs in `sidecar.log`. On macOS fresh Tauri installs this is usually `~/Library/Application Support/com.tonyq.better-agent-terminal/logs/debug.log`; existing Electron migrations may use `~/Library/Application Support/BetterAgentTerminal/logs/debug.log`. `BAT_TAURI_DATA_DIR` overrides this in dev/tests.
- When modifying shared code such as stores, IPC handlers, or shared types, trace consumers before committing.

## IPC Compatibility

- Treat renderer-facing IPC as a compatibility contract. Existing `host.*`, `window.batAppAPI.*`, and event names/signatures should be additive-only unless a task explicitly includes a coordinated migration.
- Do not rename or reshape existing agent events such as `claude:message`, `claude:stream`, `claude:status`, `claude:history`, `claude:resume-loading`, `claude:result`, or `claude:turn-end`; new runtimes must adapt to those event shapes.
- Tauri/Rust runtime work should route behind the existing host API when possible. For example, a Rust Codex runtime may handle `claude_start_session` / `claude_send_message` internally for Codex sessions, but the renderer should keep calling the existing `host.claude.*` methods.
- New IPC commands or events may be added for capabilities, diagnostics, metrics, or explicitly new UI features, but they must not be required to keep existing UI workflows functioning.
- Keep runtime ownership per session explicit. A session should be owned by either Rust or the Node sidecar for its lifecycle; avoid mixing Rust and Node responses for the same running session except through deliberate fallback at session start.
- Fallback should happen below the renderer contract. If Rust cannot handle a Codex capability yet, route or degrade inside Tauri/sidecar code without forcing renderer callsite changes.
