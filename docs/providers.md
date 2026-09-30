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
  "defaultPreset": "claude-code",           // app-wide default for new agent terminals
  "runtimeDefaultPresets": {                 // preset used when a session is opened on a runtime,
    "claude": "claude-code",                 // e.g. by a Claude ↔ Codex handoff
    "codex": "codex-agent"
  },
  "menuOrder": [ /* preset ids; new-session menu order, unlisted presets sort after, by name */ ],
  "providers": [ /* ordered; this order is the display order */ ],
  "presets":   [ /* ordered; the order of AGENT_PRESETS and agent:list-presets */ ]
}
```

### Provider

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable id. It is used in settings, IPC payloads (`agentKind`, `agent:usage` `provider`, `claude:account-changed` `agent`) and persisted data, so **never rename it**. |
| `label` | string | Display name |
| `runtime` | `claude` \| `codex` | Agent CLI runtime its sessions run on; the account chip shows that runtime's version |
| `auth` | `claude-oauth` \| `codex-oauth` \| `api-key` | Which account adapter handles it (`renderer/src/providers/accounts.ts`) |
| `apiKeyStore` | `codex-env`? | Required for `api-key` providers: where the key lives (`codex-env` = `$CODEX_HOME/.env`) |
| `usage` | `anthropic-oauth` \| `codex-rate-limits` \| `none` | Which usage/rate-limit adapter polls it. Each kind other than `none` reads one host-wide credential, so at most one provider may use it. |
| `defaultEnabled` | boolean | Initial state of the provider toggle |
| `debugOnly` | boolean? | Only surfaced when `BAT_DEBUG` is set |
| `defaultModel` | string? | Model new sessions start with, instead of the runtime's configured default (Fugu: `fugu`) |

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
| `aliases` | string[]? | Retired ids that persisted data may still carry; resolved on load (`openai-agent` → `codex-agent`) |
| `apiVersion` | `v1` \| `v2`? | SDK API version the preset runs (default `v1`) |
| `apiVersionSwitch` | preset id? | The same agent on the other API version (the V1/V2 toggle) |
| `ptyCommand` | `{ default, bypassPermissions? }`? | Auto-start command for PTY presets; `bypassPermissions` is used when the bypass-permissions setting is on. Takes precedence over `command`. |
| `ptyImagePaste` | boolean? | The CLI in the PTY accepts pasted images |

Only the presentation fields (`id`, `name`, `icon`, `color`, `command`, `debug`, `suggested`,
`backend`, `needsGitRepo`) are served on `agent:list-presets`, whose shape predates the registry.
Every other key is registry-only.

### Account adapters

The workspace account chip follows the focused session's provider (`accountChipProviderOf` in
`renderer/src/providers/account-routing.ts`: app-managed agent sessions get a chip, raw CLIs in a PTY
and plain terminals don't). Everything provider-specific goes through the adapter for the provider's
`auth` kind:

| `auth` | Accounts | Local sign-in | Remote sign-in ceremony |
|---|---|---|---|
| `claude-oauth` | Claude account list, switch | `LoginDialog` (paste-back code) | `paste-code-v1` |
| `codex-oauth` | Codex account list, switch | inline browser OAuth, cancellable | `device-code-v1` |
| `api-key` | none; the chip shows whether a key is configured | none; configured in Settings | none |

After a switch or sign-in the renderer fires `<provider id>-account-switched` on `window`, which is
the same name the existing `claude-account-switched` / `codex-account-switched` events already use.

Kinds (`auth`, `usage`, `panel`, `runtime`, `apiKeyStore`) are code. The allowed values are listed in `shared/providers.mjs`
(`AUTH_KINDS`, `USAGE_KINDS`, `PANEL_KINDS`, `RUNTIME_KINDS`, `API_KEY_STORES`) and mirrored in `providers.d.mts`. Providers and
presets are data.

## Enabling and disabling providers

Settings → Providers stores per-provider toggles in the `providers` setting (`settings.json`):
`{ "providers": { "codex": { "enabled": false } } }`. A missing or malformed entry means the
provider's `defaultEnabled`. The helpers in `shared/providers.mjs` (`enabledProviderIds`,
`isPresetEnabled`, `requiredRuntimes`, `canDisableProvider`, `resolveDefaultAgentPreset`) and
their Rust mirror in `providers.rs` (`provider_toggles`, `enabled_provider_ids`) apply these
rules:

- `debugOnly` providers only count as enabled when `BAT_DEBUG` is set.
- The last enabled provider cannot be switched off. A settings file that disables every
  provider falls back to the defaults.
- A disabled provider's presets are not offered: the host drops them from
  `agent:get-supported-session-types` / `agent:list-presets`, and the renderer applies the local
  setting immediately.
- The usage poller skips disabled providers, so they generate no network traffic.
- First-run runtime auto-install only installs agent runtimes that an enabled provider runs on.
  Node is always installed.
- The account chip is hidden for a disabled provider. Its open sessions are kept but show a
  "Provider disabled" placeholder with an **Enable** button. The default agent falls back to
  an enabled provider's agent.
- Remote windows follow the remote host's own toggles (host-owned state).

## Adding a provider

1. **Manifest:** add the provider entry and its presets to `shared/providers.json`. If it reuses
   existing `auth` / `usage` / `panel` kinds, this is the only code change.
2. **New kind (only if needed):** add the value to the kind list in `shared/providers.mjs` and
   `providers.d.mts`, and implement the adapter in each process that dispatches on that kind.
3. **Locales:** add any new strings to all four locale files (`en`, `ja`, `zh-CN`, `zh-TW`).
4. **Tests:** run `pnpm run test:provider-registry`, `pnpm run test:sidecar` and
   `pnpm run test:tauri-rust`. The manifest is validated by `validateProviderManifest` (JS) and
   by `providers.rs` (Rust).
5. **Settings:** if the provider needs its own settings (accounts, API key), return a section for
   its `auth` kind / key store from `sectionFor` in `SettingsPanel` (Settings → Providers).
6. **Docs:** add the provider to the README's provider list.

Never rename or remove an existing provider or preset id. Persisted workspaces, session markers
and remote clients refer to them. To retire a preset, mark it `hidden`.
