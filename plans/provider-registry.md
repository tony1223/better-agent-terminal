# Provider registry

Status: Phase 0 implemented (2026-09-30); Phases 1–2 pending.

## Goal

Declare every agent provider (Claude, Codex, Fugu, and future ones) in **one place**, so
that adding a provider is a manifest entry plus, at most, one small adapter, instead of
another branch at every site that currently knows about exactly two providers.

Also add a **Settings → Providers** tab where each provider can be enabled or disabled,
so the app only shows, polls and installs what the user actually uses.

Non-goals for this plan: new providers themselves. They land on top of the registry as
separate follow-ups (see [Follow-ups](#follow-ups)).

## Problem

Provider identity is spread across all three processes and duplicated:

- `'claude' | 'codex'` unions in 13 places (`WorkspaceView.tsx` ×5, `LoginDialog.tsx`,
  `MainPanel.tsx`, `ClaudeAgentPanel.tsx`, `CodexAgentPanel.types.ts`, `host-api.ts` ×2,
  `notification-store.ts`, `workspace-store.ts`, `remote-auth.ts`, `claude-usage-cache.ts`).
- Binary fallbacks where "not codex" silently means "claude": `App.tsx`
  (`onAccountChanged`), `claude-usage-cache.ts` (`ingest`), `WorkspaceView.tsx`
  (usage provider for the chip, CLI version label).
- Preset id lists re-typed by hand: ~30 checks against `'codex-agent' | 'codex-agent-worktree'
  | 'codex-fugu'` and ~45 against the Claude ids, across `WorkspaceView.tsx` (the worst,
  ~25), `MainPanel.tsx`, both agent panels, `workspace-store.ts`, `settings-store.ts`,
  `agent-preset-menu.ts`, `agent-profiles.ts`, `TerminalPanel.tsx`, `ClaudeCliPanel.tsx`,
  `node-sidecar/src/handlers/codex.mjs`.
- Preset metadata is defined **twice**: `renderer/src/types/agent-presets.ts` and
  `src-tauri/src/commands/agent.rs` (`AGENT_PRESET_IDS`, `DEBUG_ONLY_AGENT_PRESET_IDS`,
  `agent_preset_metadata`). They must be kept in sync by hand.
- The Rust side has its own two-way mappings: `notification.rs` `agent_kind_from_options`
  (which does not know `codex-fugu`), `runtime.rs`, and the usage poller's hard-wired
  `claude_due` / `codex_due` timers in `claude_usage.rs`.
- Fugu (Sakana) is already a third provider, but it is special-cased: it has its own
  settings surface (`commands/fugu.rs`), it is missing from the account chip, and some
  preset checks miss it.

## Design

### Two layers: a shared manifest and one registry per process

The app runs three processes in three languages (Rust host, TS renderer, Node sidecar),
so "one place" means:

1. **`shared/providers.json`** is the single source of truth for *data*. It is read by all three
   processes:
   - The renderer and the sidecar share one JS module, `shared/providers.mjs` (types in
     `providers.d.mts`), the same way both already use `shared/transfer-redaction.mjs`.
   - The Rust host embeds it at compile time with `include_str!` (`src-tauri/src/providers.rs`),
     the same way `runtime_catalog.rs` embeds `runtime-catalog.json`.
2. **A registry module in each runtime** owns *behaviour*. It exposes lookups (`getProvider`,
   `providerOfPreset`, `presetsOf`, `enabledProviders`, …) and dispatches to adapters. No
   code outside the registries compares against provider or preset id literals.

### Manifest shape

```jsonc
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "claude",
      "label": "Claude",
      "auth": "claude-oauth",           // adapter kind for accounts/login
      "usage": "anthropic-oauth",       // adapter kind for the usage poller
      "defaultEnabled": true
    },
    {
      "id": "codex",
      "label": "Codex",
      "auth": "codex-oauth",
      "usage": "codex-rate-limits",
      "defaultEnabled": true
    },
    {
      "id": "fugu",
      "label": "Fugu (Sakana)",
      "auth": "api-key",
      "usage": "none",
      "debugOnly": true,
      "defaultEnabled": true
    }
  ],
  "presets": [
    { "id": "claude-code", "provider": "claude", "backend": "sdk", "panel": "claude-agent",
      "name": "Claude Agent", "icon": "✦", "color": "#d97706",
      "command": "claude --continue", "suggested": true },
    { "id": "codex-agent", "provider": "codex", "backend": "sdk", "panel": "codex-agent",
      "name": "Codex Agent", "icon": "⬡", "color": "#10a37f" },
    { "id": "codex-fugu", "provider": "fugu", "backend": "sdk", "panel": "codex-agent",
      "name": "Codex Fugu Agent", "icon": "🐡", "color": "#06b6d4", "debug": true },
    { "id": "none", "provider": null, "panel": "terminal", "name": "Terminal", "icon": "⌘", "color": "#888888" }
    // …every existing preset, ids unchanged
  ]
}
```

Key decisions:

- **Preset ids are unchanged.** Workspaces, session markers, remote clients and
  `bat-server` all persist preset ids. The manifest lists every existing preset explicitly
  under its current id, so no data migration is needed.
- **Adapters are keyed by kind, not by provider id.** A provider picks an `auth` kind, a
  `usage` kind and a `backend`. A new provider that reuses existing kinds is a
  **manifest-only change**. Only a genuinely new login flow or usage API needs code.
- **`provider` versus `backend`/`panel`.** The provider is the account, usage and endpoint
  identity. The backend and panel decide how a session runs. Fugu shows why they have to be
  separate: its provider is `fugu`, but it runs on the Codex backend and uses `CodexAgentPanel`.
- **Providers are an ordered array**, not an object: `serde_json` in the host does not
  preserve key order, and the order is the display order.
- **Ids are data, kinds are code.** `ProviderId` / preset ids are plain strings checked by the
  registry; only `auth`, `usage` and `panel` are closed unions. A hard-coded id union would
  make every new provider a code change again. (`AgentPresetId` stays a literal union until
  Phase 1 removes the literal comparisons, then widens to `string`.)
- `validateProviderManifest` (`shared/providers.mjs`) checks the manifest when the module
  loads, and throws if it is invalid. For example, every preset must point to a declared
  provider, and ids must be unique. On the Rust side, deserialization and the unit tests in
  `providers.rs` do the same job.
- Fugu-specific fields (API key env, Codex model provider) are added in Phase 1, when a call
  site reads them.

### Registries

| Process | Module | Responsibilities |
|---|---|---|
| Renderer | `shared/providers.mjs` (lookups), plus `renderer/src/providers/adapters/{claude-oauth,codex-oauth,api-key}.ts` from Phase 1 | `ProviderId` type derived from the manifest. Preset → provider/panel. Account chip data: list, switch, login, cancel. Usage normalisation. Enabled filter. |
| Rust | `src-tauri/src/providers.rs` (split into a module directory once adapters land) | Parses the embedded manifest. `agent_preset_metadata` / `AGENT_PRESET_IDS` are generated from it. `agent_kind_from_options` becomes a lookup. The usage poller loops over enabled providers and dispatches by `usage` kind. |
| Sidecar | `shared/providers.mjs` | Preset → provider. `isCodexAgentPreset` becomes `panelOf(preset) === 'codex'`. This is where the spawn-env hook for future providers will live. |

`ProviderId` replaces every `'claude' | 'codex'` union. The IPC and event payloads that
already carry a provider string (`claude:account-changed` `{agent}`, `agent:usage`
`{provider}`, `agentKind`) keep their names and shapes and only gain new values. This is
**additive**, as `AGENTS.md` § IPC Compatibility requires.

### Enabling and disabling providers

- **Setting:** `providers: { [id]: { enabled: boolean } }` in the existing settings file,
  which both the renderer store and Rust (`read_unified_settings`) already read. If an entry
  is missing, `defaultEnabled` applies, so existing installs behave exactly as they do today.
- **What a disabled provider loses:**
  - Its presets disappear from the new-session quick-pick and the thumbnail menu. This
    applies to the renderer and to `agent_supported_session_presets`, which the remote API
    serves as `agent:list-presets`.
  - No account chip, and its account section is hidden.
  - The usage poller skips it, so it makes no network requests.
  - Its runtime is not auto-installed: the `runtime-auto-install` / `runtime_install` gate.
    Disabling Codex means the Codex runtime is never downloaded.
- **Existing sessions of a disabled provider are kept.** Their panel shows a "Provider
  disabled" placeholder with an **Enable** button. Nothing is deleted.
- At least one provider must stay enabled. The toggle for the last enabled provider is
  disabled.
- **Settings → Providers tab:** one row per provider with a toggle, status (logged in / key
  configured / needs login), account count and a link to its account management. The
  existing Claude-only accounts tab becomes the Claude row's section. The Fugu settings
  (`codex_fugu_status` / key form) become the Fugu row's section.
- `debugOnly` providers (Fugu) appear only when `BAT_DEBUG` is set, as today.

## Phases

Each phase is its own commit series and ships behaviour-neutral unless stated. Each phase
must pass the full gate (see [Verification](#verification)) and includes its doc updates.

### Phase 0: manifest and registries (no behaviour change) — done

- `shared/providers.json` holds all current presets verbatim, with their provider and panel.
- `shared/providers.mjs` + `providers.d.mts` (renderer and sidecar) and
  `src-tauri/src/providers.rs` (host).
- `agent-presets.ts` builds `AGENT_PRESETS` from the manifest; the `claude-code-v2` special
  case in `getVisiblePresets` became the `hidden` flag.
- `agent.rs` no longer hard-codes `AGENT_PRESET_IDS`, `DEBUG_ONLY_AGENT_PRESET_IDS` or
  `agent_preset_metadata`; it serves the manifest.
- Golden fixture `tests/fixtures/legacy-agent-presets.json` was captured from the
  pre-registry renderer list. Both the renderer (`test:provider-registry`) and the host
  (`commands::agent` tests) assert that they reproduce it exactly.
- New tests: `test:provider-registry`, `node-sidecar/tests/providers.test.mjs` (part of
  `test:sidecar`; it checks that the module loads in plain Node), and the `providers::` Rust
  unit tests.

### Phase 1: move the call sites onto the registry (no behaviour change)

Split into reviewable commits by area:

1. **Presets and panel routing:** `MainPanel`, `workspace-store` (`sdkSessionRuntimeFamily`),
   `agent-preset-menu`, `agent-profiles`, `settings-store`, `TerminalPanel`,
   `ClaudeCliPanel`, both agent panels, sidecar `codex.mjs`.
2. **Accounts and login:** `WorkspaceView` `refreshAccountChip` / `handleAccountSwitch` /
   `handleLogin` / `handleLoginCancel` become one adapter map. `LoginDialog`, `remote-auth`,
   `App.tsx` `onAccountChanged`, `notification-store`, `notification.rs`
   `agent_kind_from_options`.
3. **Usage:** `claude-usage-cache` (`UsageProvider` becomes `ProviderId`, and `ingest` no
   longer falls back to Claude), the `claude_usage.rs` poller loop, and the statusline
   usage source in both panels.
4. **Fugu fixes that fall out of this:**
   - It gets an account chip (key configured / not configured).
   - `notification.rs` routes it as `fugu`/codex.
   - Every preset check that previously missed it now covers it.

   This is the only intended behaviour change in Phase 1, and it only affects the debug
   build.

### Phase 2: enabling and disabling providers

- Settings field and defaults, Rust reader, renderer store.
- Filtering in the quick-pick, thumbnail menu, account chip, usage poller, runtime
  auto-install and `agent_supported_session_presets`.
- Disabled-provider placeholder panel.
- Settings → Providers tab. Absorbs the Claude accounts tab and the Fugu settings.
- i18n strings in all four locales (`en`, `ja`, `zh-CN`, `zh-TW`).

## Documentation (updated in the same phase as the code)

| Doc | Change | Phase |
|---|---|---|
| `plans/provider-registry.md` (this file) | status per phase | every phase |
| `docs/providers.md` (new, done) | Manifest reference, kinds (`auth`, `usage`, `panel`), and **"Adding a provider" checklist**: manifest entry, adapter only if a new kind is needed, locales, tests, README row | 0, extended in 2 |
| `CLAUDE.md` and `AGENTS.md` (done) | New § **Providers**: never compare against provider or preset id literals outside the registries; `shared/providers.json` is the source of truth; link to `docs/providers.md` | 0 |
| `README.md` | Agent presets line and Features: "providers are declared in one manifest". § Account & Usage: per-provider accounts and usage. New § **Providers**: supported providers, enabling/disabling them in Settings → Providers, and that disabled providers are not polled or installed | 1 (accounts/usage wording), 2 (Providers section) |

## Verification

The gate for every phase (from `CLAUDE.md` / runbook):

```bash
pnpm exec tsc --noEmit --pretty false
pnpm run compile
pnpm run test:sidecar
pnpm run check:tauri-rust && pnpm run test:tauri-rust
```

Also run the existing suites that touch the moved code: `test:codex`,
`test:agent-context-transfer`, `test:workspace-sdk-session-owner`,
`test:remote-auth-capabilities`, `test:remote-profile-events`, `test:notification-delivery`,
`test:attention-list`, `test:host-api`, and the new `test:provider-registry`.

Manual checks (the No Regressions policy):
- Create a session of each preset. Resume an old workspace, and check that its persisted
  preset ids still map to the right panel.
- Switch Claude and Codex accounts. Check the usage rows in the chip and the statusline.
- Log in remotely to Claude and Codex.
- Use Fugu in debug mode.
- Disable Codex: its presets are gone, it is not polled, and an open Codex session shows the
  placeholder. Re-enable it and the session comes back.

## Upstream

Phases 0–2 are proposed to `tony1223/better-agent-terminal` as **three PRs** (one per phase)
so each one stays reviewable. The design is proposed in
[tony1223/better-agent-terminal#145](https://github.com/tony1223/better-agent-terminal/issues/145),
so the direction is agreed on before a large refactor lands.

## Follow-ups

- **Generic `api-key` providers on the Claude backend (Anthropic-compatible endpoints):**
  - Accounts: a keyring-backed store, one entry per account.
  - At spawn, the sidecar sets `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / model env and
    strips the Anthropic credentials.
  - Per-provider capability flags hide unsupported UI such as 1M context, `WebSearch` and the
    Anthropic usage widget.
  - Sessions record their provider, so they cannot be resumed on a different provider.
- **First providers on top of that:**
  - GLM (Z.ai): usage from `GET /api/monitor/usage/quota/limit`.
  - MiniMax: usage from `GET /v1/token_plan/remains`, which needs a subscription key.
