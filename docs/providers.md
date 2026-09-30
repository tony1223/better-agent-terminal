# Providers

Agent providers (Claude, Codex, Fugu, …) and the agent presets they offer are declared once, in
[`shared/providers.json`](../shared/providers.json). All three processes read that file:

| Process | Reads it through | Notes |
|---|---|---|
| Renderer | [`shared/providers.mjs`](../shared/providers.mjs) (types in `providers.d.mts`) | `renderer/src/types/agent-presets.ts` builds `AGENT_PRESETS` from it |
| Node sidecar | [`shared/providers.mjs`](../shared/providers.mjs) | Loads unbundled in dev (JSON import attribute) and bundled by esbuild in release. Sidecar handlers move onto it in Phase 1 of the plan; until then only its tests import it. |
| Rust host | [`src-tauri/src/providers.rs`](../src-tauri/src/providers.rs) | Embeds the JSON with `include_str!`; serves `agent:list-presets` / `agent:get-supported-session-types` from it |

**Rule:** code outside these registries looks providers and presets up by *kind*. It does not
compare against provider or preset id literals such as `'codex-agent'` or `'claude'`. Call sites
that still do are being moved over; see [`plans/provider-registry.md`](../plans/provider-registry.md).

## Manifest reference

```jsonc
{
  "schemaVersion": 1,
  "providers": [ /* ordered; this order is the display order */ ],
  "presets":   [ /* ordered; this order is the picker order */ ]
}
```

### Provider

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable id. It is used in settings, IPC payloads (`agentKind`, `agent:usage` `provider`, `claude:account-changed` `agent`) and persisted data, so **never rename it**. |
| `label` | string | Display name |
| `auth` | `claude-oauth` \| `codex-oauth` \| `api-key` | Which account/login adapter handles it |
| `usage` | `anthropic-oauth` \| `codex-rate-limits` \| `none` | Which usage/rate-limit adapter polls it |
| `defaultEnabled` | boolean | Initial state of the provider toggle |
| `debugOnly` | boolean? | Only surfaced when `BAT_DEBUG` is set |

### Preset

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable id. It is persisted in workspaces and session markers and sent to remote clients, so **never rename it**. |
| `provider` | provider id \| `null` | Owning provider; `null` for the plain terminal |
| `panel` | `claude-agent` \| `codex-agent` \| `claude-channel` \| `claude-cli-agent` \| `claude-cli` \| `terminal` | Which panel renders the session. `claude-agent` sessions run on the node sidecar, `codex-agent` sessions on the Rust Codex app-server. |
| `hidden` | boolean? | Kept so persisted sessions still resolve, but never offered in pickers |
| `name`, `icon`, `color` | string | Picker presentation |
| `command` | string? | Auto-start command (PTY mode) |
| `debug` | boolean? | Only offered when `BAT_DEBUG` is set |
| `suggested` | boolean? | Marked as recommended in pickers |
| `backend` | `sdk` \| `channel` \| `cli` \| `pty`? | Legacy backend hint consumed by the preset menus |
| `needsGitRepo` | boolean? | Worktree presets; only offered inside a git repository |

`provider`, `panel` and `hidden` are registry-only keys. The host strips them from the metadata it
serves on `agent:list-presets`, whose shape predates the registry.

Kinds (`auth`, `usage`, `panel`) are code. The allowed values are listed in `shared/providers.mjs`
(`AUTH_KINDS`, `USAGE_KINDS`, `PANEL_KINDS`) and mirrored in `providers.d.mts`. Providers and
presets are data.

## Adding a provider

1. **Manifest:** add the provider entry and its presets to `shared/providers.json`. If it reuses
   existing `auth` / `usage` / `panel` kinds, this is the only code change.
2. **New kind (only if needed):** add the value to the kind list in `shared/providers.mjs` and
   `providers.d.mts`, and implement the adapter in each process that dispatches on that kind.
3. **Locales:** add any new strings to all four locale files (`en`, `ja`, `zh-CN`, `zh-TW`).
4. **Tests:** run `pnpm run test:provider-registry`, `pnpm run test:sidecar` and
   `pnpm run test:tauri-rust`. The manifest is validated by `validateProviderManifest` (JS) and
   by `providers.rs` (Rust).
5. **Docs:** add the provider to the README's provider list.

Never rename or remove an existing provider or preset id. Persisted workspaces, session markers
and remote clients refer to them. To retire a preset, mark it `hidden`.
