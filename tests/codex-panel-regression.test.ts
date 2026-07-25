import * as assert from 'assert'
import { readFile } from 'fs/promises'
import { rateLimitsFromHostUsage, type HostUsageSnapshot } from '../renderer/src/utils/claude-usage-cache'
import { normalizeReasoningSummary } from '../renderer/src/utils/reasoning-summary'
import { agentSendResultError, isMissingSessionCwdError } from '../renderer/src/utils/agent-send-recovery'
import {
  autoCompactWindowForClaudeSelection,
  contextWindowForClaudeSelection,
  displayNameForClaudeSelection,
  normalizeClaudeModelSelection,
  sdkModelForClaudeSelection,
} from '../renderer/src/utils/claude-model-presets'

async function main() {
  const source = await readFile('renderer/src/components/CodexAgentPanel.tsx', 'utf8')
  const claudeSource = await readFile('renderer/src/components/ClaudeAgentPanel.tsx', 'utf8')
  const messageSkipSource = await readFile('renderer/src/components/messageSkip.tsx', 'utf8')

  assert.equal(normalizeClaudeModelSelection('claude-opus-5'), 'claude-opus-5:1m')
  assert.equal(normalizeClaudeModelSelection('claude-opus-5[1m]'), 'claude-opus-5:1m')
  // The `[1m]` has to survive the round trip. The SDK emits `claude-opus-5[1m]`,
  // we canonicalize it to the `:1m` preset for the picker, and handing it back
  // without the suffix would drop the session to a 200K window.
  assert.equal(sdkModelForClaudeSelection('claude-opus-5:auto-compact-200k'), 'claude-opus-5[1m]')
  assert.equal(sdkModelForClaudeSelection(normalizeClaudeModelSelection('claude-opus-5[1m]')), 'claude-opus-5[1m]')
  assert.equal(autoCompactWindowForClaudeSelection('claude-opus-5:auto-compact-200k'), 200000)
  assert.equal(autoCompactWindowForClaudeSelection('claude-opus-5:1m'), null)
  assert.equal(contextWindowForClaudeSelection('claude-opus-5:1m'), 1000000)
  assert.equal(displayNameForClaudeSelection('claude-opus-5:1m'), 'Opus 5 · 1M')
  for (const panelSource of [source, claudeSource]) {
    assert.match(panelSource, /'opus-5':\s+P\(5, 25\)/, 'Opus 5 pricing should be $5/$25 per MTok')
  }

  assert.equal(
    source.includes('!isCodexSession && showResumeList'),
    false,
    'Codex resume list must not be gated behind !isCodexSession',
  )
  assert.equal(
    source.includes('{showResumeList && ('),
    true,
    'Codex resume list should render when /resume opens showResumeList',
  )
  assert.match(
    source,
    /if \(typeof m\.isStreaming === 'boolean'\) \{\s*setIsStreaming\(m\.isStreaming\)/,
    'Codex live status must synchronize the authoritative backend running state',
  )
  assert.equal(
    source.includes("if (isCodexSession && message.role === 'user') setIsStreaming(true)"),
    true,
    'Codex user echoes should recover running state against older remote hosts',
  )
  assert.equal(
    source.includes("trimmed === '/sac'"),
    true,
    'Codex should intercept the /sac cybersecurity retry command',
  )
  assert.equal(
    source.includes('shouldAutoContinueForTrigger(ac.trigger, payload)'),
    true,
    'Codex /sac should gate retries through the configured trigger',
  )
  assert.equal(
    source.includes("window.addEventListener('codex-account-switched'"),
    false,
    'Codex account changes are backend-owned and must not make panels clear their timelines',
  )
  assert.equal(
    source.includes('reset after Codex account switch failed'),
    false,
    'Codex account changes must not trigger a second destructive renderer reset',
  )
  assert.match(
    source,
    /result\.errorEmitted === true[\s\S]*err instanceof CodexSendError && err\.alreadyReported/,
    'Codex send failures already emitted by the backend must not render a duplicate error',
  )
  assert.equal(
    agentSendResultError({ ok: false, error: 'session has no cwd' }),
    'session has no cwd',
    'resolved send failures must expose their error to session recovery',
  )
  assert.equal(agentSendResultError({ ok: true, error: 'ignored' }), null)
  assert.equal(isMissingSessionCwdError('Session has no CWD; restart required'), true)
  const weeklyOnlySnapshot: HostUsageSnapshot = {
    provider: 'codex',
    fiveHour: null,
    sevenDay: { utilization: 0.1, resetsAt: 3_000 },
    extraUsage: null,
    planType: 'pro',
    accountEmail: null,
    fetchedAt: 2,
  }
  const mappedRateLimits = rateLimitsFromHostUsage(weeklyOnlySnapshot, {
    five_hour: { utilization: 0.25, resetsAt: 1_000, isUsingOverage: false },
    seven_day: { utilization: 0.3, resetsAt: 2_000, isUsingOverage: true },
  })
  assert.deepEqual(
    Object.keys(mappedRateLimits),
    ['seven_day'],
    'An authoritative weekly-only snapshot must clear a stale 5h window',
  )
  assert.equal(mappedRateLimits.seven_day.utilization, 0.1)
  assert.equal(mappedRateLimits.seven_day.isUsingOverage, true)
  for (const [name, panelSource] of [['Codex', source], ['Claude', claudeSource]] as const) {
    assert.equal(
      panelSource.includes('setRateLimits(prev => rateLimitsFromHostUsage(snap, prev))'),
      true,
      `${name} panels must replace stale window membership from host snapshots`,
    )
  }
  assert.match(
    source,
    /const resumeResult = await host\.claude\.resumeSession\([\s\S]*effectiveModel \|\| savedModel[\s\S]*permissionMode,\s*effectiveEffort[\s\S]*\) as \{ stale\?: boolean \} \| null/,
    'Codex auto-resume should preserve effective model, permission mode, and effort',
  )
  assert.match(
    source,
    /const resumeModel = currentModel[\s\S]*resumeModel[\s\S]*codexSandboxMode[\s\S]*codexApprovalPolicy[\s\S]*permissionMode[\s\S]*resumeEffort/,
    'Codex manual resume should preserve current model, sandbox, approval, permission mode, and effort',
  )
  assert.match(
    claudeSource,
    /const shouldReplayHistory = isRemoteConnected\s*\|\| \(!isCodexSession && existingMessages\.length === 0\)[\s\S]*const hostMeta = await host\.claude\.getSessionMeta\(sessionId\)[\s\S]*const historySdkSessionId = hostMeta\?\.sdkSessionId \|\| savedSdkSessionId \|\| ''[\s\S]*host\.claude\.clientResume\([\s\S]*historySdkSessionId,[\s\S]*historyCwd,/,
    'Claude attach should recover host-owned metadata and replay empty local snapshots as well as remote history',
  )
  assert.match(
    claudeSource,
    /const historyAttached = isRemoteConnected\s*\? remoteHistoryAttachedRef\.current\s*:\s*localHistoryAttachedRef\.current\s*if \(historyAttached\) return/,
    'Claude remounts should inspect history once even when session startup is already cached',
  )
  assert.equal(
    claudeSource.includes('existingMessages.length > 0 || (messageCountRef.current === 0 && !isRemoteConnected)'),
    false,
    'Claude mount hydration must not let an empty local snapshot erase replayed history',
  )
  assert.equal(
    normalizeReasoningSummary('**Step A**\n\n<!-- -->\n\n**Step B**'),
    '**Step A**\n\n**Step B**',
    'Codex reasoning summaries should hide the upstream empty-comment separator',
  )
  assert.equal(
    normalizeReasoningSummary('**Step A**<!-- -->**Step B**'),
    '**Step A**\n\n**Step B**',
    'Inline Codex separators should remain a Markdown paragraph boundary',
  )
  assert.equal(
    normalizeReasoningSummary('before <!-- keep this --> after'),
    'before <!-- keep this --> after',
    'Reasoning normalization must preserve non-empty HTML comments',
  )
  assert.equal(
    source.includes('<pre className="claude-thinking-content">{msg.thinking}</pre>'),
    false,
    'Completed Codex reasoning should not render as raw preformatted Markdown',
  )
  assert.equal(
    (source.match(/<ReasoningSummary/g) || []).length >= 3,
    true,
    'Completed, streaming, and subagent Codex reasoning should share ReasoningSummary rendering',
  )
  assert.equal(
    (source.match(/t\('claude\.reasoningSummary'\)/g) || []).length >= 2,
    true,
    'Completed and streaming Codex reasoning should be labelled as a summary, not raw thinking',
  )
  assert.equal(
    source.includes("content: [lastMsg.content.trimEnd(), finalMsg.content.trimStart()].filter(Boolean).join('\\n\\n')"),
    true,
    'A reasoning-only timeline message should merge with an immediately following answer without leading blank lines',
  )
  assert.equal(
    messageSkipSource.includes("tool: 'claude.hiddenTools'"),
    true,
    'Filtered tool rows should say hidden because their calls still executed',
  )
  const localeExpectations = {
    en: '{{count}} tools hidden',
    'zh-TW': '已隱藏 {{count}} 個工具',
    'zh-CN': '已隐藏 {{count}} 个工具',
    ja: '{{count}}件のツールを非表示',
  } as const
  for (const [locale, expected] of Object.entries(localeExpectations)) {
    const translations = JSON.parse(await readFile(`renderer/src/locales/${locale}.json`, 'utf8')) as {
      claude: { hiddenTools?: string; reasoningSummary?: string }
    }
    assert.equal(translations.claude.hiddenTools, expected, `${locale} should clarify that filtered tools are hidden`)
    assert.ok(translations.claude.reasoningSummary, `${locale} should label Codex reasoning summaries explicitly`)
  }
  for (const [name, panelSource] of [['Codex', source], ['Claude', claudeSource]] as const) {
    assert.match(
      panelSource,
      /const bottom = Math\.max\(0, el\.scrollHeight - el\.clientHeight\)[\s\S]*el\.scrollTop = bottom[\s\S]*el\.scrollTo\(\{ top: bottom, behavior: 'auto' \}\)/,
      `${name} scroll-to-bottom should drive the messages container to its max scrollTop`,
    )
    assert.equal(
      panelSource.includes('onPointerDown={handleScrollToBottomPointerDown}'),
      true,
      `${name} scroll-to-bottom button should run on pointer down, not only click`,
    )
    assert.equal(
      panelSource.includes('const sendClaudeMessage = useCallback(async ('),
      true,
      `${name} panel should funnel sends through a startup-aware helper`,
    )
    assert.match(
      panelSource,
      /await ensureSessionStarted\(\)[\s\S]*host\.claude\.sendMessage\(sessionId, prompt, images, autoCompactWindow, clientMessage\)/,
      `${name} panel should await session startup before sending the first message`,
    )
    assert.match(
      panelSource,
      /const recoverMissingSession[\s\S]*stopSession\(sessionId\)[\s\S]*clearStartedSessionTracking\(sessionId\)[\s\S]*await ensureSessionStarted\(\)/,
      `${name} panel should discard the phantom session before restarting`,
    )
    assert.match(
      panelSource,
      /agentSendResultError\(result\)[\s\S]*isMissingSessionCwdError\(resultError\)[\s\S]*recoverMissingSession\(resultError\)/,
      `${name} panel should recover resolved no-cwd failures as well as rejected RPCs`,
    )
    assert.match(
      panelSource,
      /wasConnected && !isRemoteConnected[\s\S]*clearStartedSessionTracking\(sessionId\)/,
      `${name} panel should invalidate cached startup state when a remote connection drops`,
    )
  }

  console.log('Codex panel regression: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
