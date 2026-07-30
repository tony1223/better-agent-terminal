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
  const timelineCss = await readFile('renderer/src/styles/claude-agent.css', 'utf8')

  // Both panels pin themselves to the tail by scrolling to
  // scrollHeight - clientHeight, and both are display: none while their tab is
  // inactive. Skipping off-screen rows makes a never-seen row report its
  // intrinsic-size estimate instead of its height, so the pin lands short and
  // the transcript reads as frozen mid-turn -- and every row is back to skipped
  // after a tab switch, so it repaints blank. Containment is fine; skipping is
  // not.
  assert.equal(
    /^\s*content-visibility\s*:/m.test(timelineCss),
    false,
    'Timeline rows must not skip off-screen layout while the panel pins to scrollHeight',
  )

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
    /const shouldReplayHistory = \(!!existingState \|\| !!savedSdkSessionId\)\s*&& \(isRemoteConnected \|\| \(!!existingState && !isCodexSession && existingMessages\.length === 0\)\)[\s\S]*const hostMeta = await host\.claude\.getSessionMeta\(sessionId\)[\s\S]*const historySdkSessionId = hostMeta\?\.sdkSessionId \|\| savedSdkSessionId \|\| ''[\s\S]*host\.claude\.clientResume\([\s\S]*historySdkSessionId,[\s\S]*historyCwd,/,
    'Claude attach should recover host-owned metadata and replay empty local snapshots as well as remote history',
  )
  // A remote reattach must not depend on the host still holding an in-memory
  // record. getSessionState returns null whenever the host sidecar rebuilt (or
  // never materialized) the session, and routing that case to resumeSession
  // tears down the host's in-flight turn and skips the exact-id history lookup
  // — the panel then renders blank while the agent keeps streaming.
  assert.equal(
    /const shouldReplayHistory = isRemoteConnected\s*\|\| \(!isCodexSession/.test(claudeSource),
    false,
    'Remote reattach must reach clientResume even when the host has no session record',
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
    // Rows keep growing after React commits them — markdown reflow, expanding
    // tool output, late images and fonts — so one post-render scroll lands
    // short of the real bottom and the growth that follows pushes the tail
    // further away, which reads as the panel freezing mid-turn.
    assert.match(
      panelSource,
      /const scrollToBottomAfterRender = useCallback\([\s\S]*stableFrames = el\.scrollHeight === lastHeight \? stableFrames \+ 1 : 0[\s\S]*requestAnimationFrame\(settle\)/,
      `${name} auto-scroll must re-scroll until scrollHeight stops moving`,
    )
    assert.equal(
      /const scrollToBottomAfterRender = useCallback\(\(\) => \{\s*requestAnimationFrame\(\(\) => \{\s*requestAnimationFrame\(/.test(panelSource),
      false,
      `${name} auto-scroll must not trust a single post-render scrollHeight reading`,
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
    // The host's user echo reuses the client's own message id (emitUserEcho
    // falls back to clientMessageId), so a remote send lands in the id-match
    // branch and never reaches the content-match dedupe below it. Returning
    // early there leaves the message ghosted until the send RPC resolves — and
    // that resolves when the turn ends, not when the prompt is taken, so the
    // message the agent is visibly answering stays greyed out the whole time.
    const idMatchBranch = panelSource.indexOf('const existingMessageIndex = nextPrev.findIndex(m => m.id === finalMsg.id)')
    const clearsGhostOnIdMatch = panelSource.indexOf('const existing = nextPrev[existingMessageIndex]')
    const contentDedupe = panelSource.indexOf('// Dedup user messages:')
    assert.ok(idMatchBranch > 0, `${name} panel should still match an echo by id`)
    assert.ok(
      clearsGhostOnIdMatch > idMatchBranch && clearsGhostOnIdMatch < contentDedupe,
      `${name} panel should clear the optimistic status inside the id-match branch, before the content dedupe it can never reach`,
    )

    // A dropped remote used to append `err-disconnect-${Date.now()}`, so every
    // retry while the link was down stacked another identical row, and nothing
    // ever revised them once the app re-dialled — a recovered connection still
    // read as broken, with the user's text sitting unsent in the input box.
    assert.ok(
      !/id: `err-disconnect-\$\{Date\.now\(\)\}`/.test(panelSource),
      `${name} panel should not mint a fresh id per disconnect, which stacks duplicate notices`,
    )
    assert.match(
      panelSource,
      /const remoteDisconnectNoticeId = `sys-remote-disconnected-\$\{sessionId\}`/,
      `${name} panel should keep one stable disconnect notice per session`,
    )
    assert.match(
      panelSource,
      /if \(!wasConnected && isRemoteConnected\) \{[\s\S]{0,400}?Remote connection restored/,
      `${name} panel should revise the disconnect notice when the connection comes back`,
    )
  }

  // The status poll refuses to re-dial without these params, so recording them
  // only after a successful dial meant a window opened while the tunnel was
  // down could never reconnect on its own — restoring the tunnel did nothing
  // and the app had to be restarted. They have to be set before the dial.
  const appSource = await readFile('renderer/src/App.tsx', 'utf8')
  const recordsParams = appSource.indexOf('remoteConnParamsRef.current = {')
  const dials = appSource.indexOf('const connectResult = await host.remote.connect(')
  assert.ok(recordsParams > 0 && dials > 0, 'App should still dial the remote and record its params')
  assert.ok(
    recordsParams < dials,
    'App should record the dial params before dialing, so a failed dial can still be retried',
  )

  // A generated image reaches the panel as a file on disk, not as bytes: the
  // app-server writes it under $CODEX_HOME and reports `savedPath`, so keeping
  // the path on the wire keeps a megabyte of base64 out of session history.
  // Both spellings matter — live items are camelCase, replayed rollouts are
  // snake_case — and the panel keys its card on the tool name `image_gen`,
  // which is neither of the names the wire uses (`imageGeneration` live,
  // `imagegen` in the rollout). Nothing compiles or runs the Rust in CI, so
  // these source assertions are the only automated guard that the two halves
  // still agree on a shape.
  const appServerSource = await readFile('src-tauri/src/codex_app_server.rs', 'utf8')
  assert.match(
    appServerSource,
    /Some\("imageGeneration"\) =>/,
    'codex app-server should handle the live imageGeneration item',
  )
  assert.match(
    appServerSource,
    /"imagegen" \| "image_gen" \| "image_generation" => "image_gen"/,
    'replayed rollouts should map their image tool name onto the one the panel renders',
  )
  assert.match(
    appServerSource,
    /first_str\(item, &\["savedPath", "saved_path"\]\)/,
    'the image result should accept both the live and replay spellings of the saved path',
  )
  // image_generation_end lands before the function_call_output that closes the
  // same call, and that output is a bare image block with no text in it.
  // Writing its empty text back over the result would blank the card again.
  assert.match(
    appServerSource,
    /if !text\.is_empty\(\) \{\s*updates\["result"\] = json!\(text\);/,
    'an empty tool output should not overwrite a result that is already populated',
  )

  // Codex's ThreadItem union has 18 variants and bat used to render 6 of them,
  // so plans, skill/plugin tool calls, subagent activity and viewed images all
  // vanished from the transcript with no trace. A result only lands if
  // item/started already created the row, so each of these has to appear in
  // both handlers.
  for (const itemType of ['dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'imageView', 'plan', 'sleep']) {
    const started = appServerSource.indexOf('fn handle_item_started')
    const completed = appServerSource.indexOf('fn handle_item_completed')
    const usage = appServerSource.indexOf('fn handle_usage_updated')
    assert.ok(started > 0 && completed > started && usage > completed, 'handler order assumption holds')
    const inStarted = appServerSource.slice(started, completed).includes(`"${itemType}"`)
    const inCompleted = appServerSource.slice(completed, usage).includes(`"${itemType}"`)
    assert.ok(inStarted, `${itemType} should open a tool row in handle_item_started`)
    assert.ok(inCompleted, `${itemType} should close its tool row in handle_item_completed`)
  }

  assert.match(
    source,
    /typeof parsed\.path === 'string' && parsed\.path/,
    'the panel should accept a generated image delivered as a path',
  )
  assert.match(
    source,
    /item\.toolName === 'image_gen' \|\| item\.toolName === 'image_view'/,
    'a viewed image should render in the same card as a generated one',
  )
  assert.match(
    source,
    /host\.image\.readAsDataUrl\(image\.path\)/,
    'the panel should resolve a generated image path into bytes on demand',
  )
  // $CODEX_HOME is the user's to clean out, so a card rebuilt from history can
  // outlive its file. Showing the path beats a broken image frame.
  assert.match(
    source,
    /Image unavailable: \{image\.path\}/,
    'the panel should name the missing file when a generated image cannot be read',
  )

  // An approval request is announced once via claude:permission-request and
  // never repeated, while the turn stays blocked until it is answered. Panels
  // are mounted lazily (active terminal plus a two-entry LRU that starts empty
  // every launch), so a request that arrives before its panel exists used to be
  // unanswerable forever. The payload has to be kept, not just the resolve
  // handle, and session state has to hand it back.
  assert.match(
    appServerSource,
    /request_data: Value,/,
    'a pending Codex approval should keep the payload it was announced with',
  )
  assert.match(
    appServerSource,
    /"pendingPermission": pending_permission,/,
    'Codex session state should report the approval the turn is blocked on',
  )
  for (const panel of ['ClaudeAgentPanel', 'CodexAgentPanel']) {
    const panelSource = await readFile(`renderer/src/components/${panel}.tsx`, 'utf8')
    assert.match(
      panelSource,
      /const adoptHostPendingPrompts = useCallback/,
      `${panel} should adopt a pending prompt the host is still blocked on`,
    )
    assert.match(
      panelSource,
      /adoptHostPendingPrompts\(existingState as unknown as ClaudeSessionState\)/,
      `${panel} should recover a pending prompt when it hydrates`,
    )
    // A dropped tunnel loses every event emitted while it was down, and none of
    // them are replayed — so reconnecting has to ask what is still outstanding.
    assert.match(
      panelSource,
      /host\.claude\.getSessionState\(sessionId\)\s*\n\s*\.then\(state => adoptHostPendingPrompts/,
      `${panel} should re-check pending prompts after a remote reconnect`,
    )
  }

  // The archive is append-only, and the flush effect assumed `messages` only
  // ever grows by new rows. Hydrating breaks that assumption — it replaces the
  // list with the host's last 300, whose head is already archived — and the
  // hydrate effect re-runs on every remote reconnect, so the same window was
  // appended once per reconnect, permanently, and rendered as a repeated reply.
  for (const panel of ['ClaudeAgentPanel', 'CodexAgentPanel']) {
    const panelSource = await readFile(`renderer/src/components/${panel}.tsx`, 'utf8')
    assert.match(
      panelSource,
      /messages\.slice\(0, excess\)\.filter\(m => !archivedIdsRef\.current\.has\(m\.id\)\)/,
      `${panel} must not re-archive rows it has already flushed`,
    )
    assert.match(
      panelSource,
      /archivedCountRef\.current \+= toArchive\.length/,
      `${panel}'s archived count should track what was written, not what was dropped`,
    )
    assert.match(
      panelSource,
      /dedupeMessagesById\(\[\.\.\.loadedArchive, \.\.\.messages\]\)/,
      `${panel} should dedupe the archived+live merge`,
    )
    // The dep is what resyncs streaming state and metadata after a reconnect.
    // Dropping it would leave a panel stuck on whatever it showed when the
    // tunnel died — the fix for the duplicate archiving is the id filter above,
    // not removing this.
    assert.match(
      panelSource,
      /\[sessionId, cwd, isCodexSession, codexSandboxMode, codexApprovalPolicy, isRemoteConnected\]/,
      `${panel} should still re-hydrate when the remote connection returns`,
    )
  }

  // The notification snapshot has no isStreaming/messages/pending-prompt
  // fields, so answering a session-state probe from it reports a mid-turn
  // session as idle (connect to a working host, watch the panel sit silent)
  // and hides the prompt a blocked turn is waiting on. Both probes must reach
  // the sidecar, which owns the live session.
  const remoteServerSource = await readFile('src-tauri/src/remote_server.rs', 'utf8')
  assert.doesNotMatch(
    remoteServerSource,
    /"claude:get-session-state" =>[\s\S]{0,900}?session_state_from_notification_snapshot/,
    'the remote session-state probe must not answer from the notification snapshot',
  )
  const claudeCmdSource = await readFile('src-tauri/src/commands/claude.rs', 'utf8')
  assert.match(
    claudeCmdSource,
    /let from_sidecar = self\s*\n\s*\.sidecar_call\(\s*\n\s*"claude\.getSessionState",/,
    'the local session-state probe must ask the sidecar rather than stop at the snapshot',
  )
  assert.match(
    claudeCmdSource,
    /\(Ok\(Value::Null\), Some\(session\)\) \| \(Err\(_\), Some\(session\)\) =>/,
    'the notification snapshot should remain a fallback for when the sidecar has nothing',
  )
  for (const panel of ['ClaudeAgentPanel', 'CodexAgentPanel']) {
    const panelSource = await readFile(`renderer/src/components/${panel}.tsx`, 'utf8')
    // Remote pairs versions independently, so a new client still meets hosts
    // whose probe omits these. Coercing a missing isStreaming to false is what
    // turns the indicator off on a host that is mid-turn.
    assert.match(
      panelSource,
      /if \(typeof existingState\.isStreaming === 'boolean'\) \{\s*\n\s*setIsStreaming\(existingState\.isStreaming\)/,
      `${panel} must not read a missing isStreaming as "not streaming"`,
    )
    assert.doesNotMatch(
      panelSource,
      /setIsStreaming\(!!existingState\.isStreaming\)/,
      `${panel} should no longer coerce an absent isStreaming to false`,
    )
  }

  console.log('Codex panel regression: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
