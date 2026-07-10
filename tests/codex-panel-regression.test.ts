import * as assert from 'assert'
import { readFile } from 'fs/promises'

async function main() {
  const source = await readFile('renderer/src/components/CodexAgentPanel.tsx', 'utf8')
  const claudeSource = await readFile('renderer/src/components/ClaudeAgentPanel.tsx', 'utf8')

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
    /const hostMeta = await host\.claude\.getSessionMeta\(sessionId\)[\s\S]*const remoteSdkSessionId = hostMeta\?\.sdkSessionId \|\| savedSdkSessionId \|\| ''[\s\S]*host\.claude\.clientResume\([\s\S]*remoteSdkSessionId,[\s\S]*remoteCwd,/,
    'Claude remote attach should recover host-owned metadata before requesting history',
  )
  assert.match(
    claudeSource,
    /if \(!isRemoteConnected \|\| remoteHistoryAttachedRef\.current\) return/,
    'Claude reconnect should replay remote history once even when session startup is already cached',
  )
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
  }

  console.log('Codex panel regression: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
