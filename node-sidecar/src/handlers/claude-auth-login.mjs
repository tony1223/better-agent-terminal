// claude.authLogin* — interactive, URL-based ("paste code") login driver.
//
// The desktop `claude.authLogin` (claude-auth.mjs) just spawns `claude auth
// login` and waits for the browser+OAuth callback to fire — fine when a
// browser is present. On a headless/remote host there is no browser, so we
// drive the CLI directly and surface its sign-in URL to the client:
//
//   1. authLoginStart → spawn `claude auth login`, capture the OAuth URL and
//      return it with an opaque loginId.
//   2. authLoginSubmitCode({code, loginId}) → write the callback code to the
//      matching CLI process and report success/failure.
//   3. authLoginCancel({loginId}) → kill only the matching in-flight login.
//
// The CLI uses a hosted redirect (platform.claude.com) and emits the URL even
// over piped stdio (no TTY/PTY required), so this works on a headless host.
// Request/response only (no events) so the remote plumbing stays minimal.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { registerHandler } from '../lib/protocol.mjs'
import { info, warn } from '../lib/logger.mjs'
import { resolveClaudeCliBinaryWithInstall } from './claude-auth.mjs'

const URL_RE = /(https?:\/\/[^\s'"]*(?:oauth|authorize)[^\s'"]*)/i
const OUTPUT_TAIL_MAX = 8192
const LOGIN_URL_TIMEOUT_MS = 60_000
const LOGIN_COMPLETE_TIMEOUT_MS = 120_000
// Output phrases that indicate the login did not actually succeed even when
// the process exits cleanly.
const FAILURE_RE = /\b(error|invalid|disabled|does not have access|denied|failed|not authorized|unauthorized)\b/i

let activeLogin = null

function stripAnsi(value) {
  return String(value || '')
    // CSI / SGR sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // OSC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // remaining control chars except \n and \t
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

function cleanupLogin(session) {
  if (session && session.killTimer) {
    clearTimeout(session.killTimer)
    session.killTimer = null
  }
  if (activeLogin === session) activeLogin = null
}

function killSession(session) {
  if (!session || !session.child) return
  try { session.child.kill('SIGTERM') } catch { /* ignore */ }
}

function failureReason(session) {
  const out = stripAnsi(session.output || '')
  if (FAILURE_RE.test(out)) return 'Claude rejected the authorization request'
  const code = session.exitCode
  // CLI output may echo provider details we do not control. Keep it host-local
  // and return only a stable, non-sensitive failure category to remote clients.
  return `Claude login did not complete (exit code ${code == null ? 'unknown' : code})`
}

export function sanitizeLoginError(value) {
  return stripAnsi(value)
    .replace(/\b[A-Za-z0-9]{3,12}-[A-Za-z0-9]{3,12}\b/g, '<redacted-code>')
    .replace(/https?:\/\/\S+/gi, '<redacted-url>')
    .slice(-600)
}

export function loginIdMatches(session, requestedLoginId) {
  // Backward compatibility: old clients omit loginId while the sidecar still
  // has exactly one active session. New clients must echo the opaque id.
  return !requestedLoginId || requestedLoginId === session?.loginId
}

export function isTrustedClaudeLoginUrl(value) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:') return false
    return ['claude.ai', 'claude.com', 'anthropic.com'].some(
      domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
    )
  } catch {
    return false
  }
}

// authLoginStart: spawn `claude auth login` and resolve with the captured
// OAuth URL. The CLI is left running at its paste-code prompt.
registerHandler('claude.authLoginStart', async () => {
  // Credentials are host-global. Never let a second remote client silently
  // supersede the first client's login ceremony.
  if (activeLogin) {
    return { ok: false, error: 'auth_in_progress', terminal: false }
  }

  const cliPath = await resolveClaudeCliBinaryWithInstall()
  if (!cliPath) {
    return {
      ok: false,
      error: 'Claude CLI binary not available on the host',
      terminal: true,
    }
  }

  const session = {
    loginId: randomUUID(),
    child: null,
    output: '',
    url: null,
    finished: false,
    exitCode: null,
    urlResolve: null,
    exitResolve: null,
    killTimer: null,
  }
  const urlPromise = new Promise((resolve) => { session.urlResolve = resolve })

  let child
  try {
    child = spawn(cliPath, ['auth', 'login'], {
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    return {
      ok: false,
      error: sanitizeLoginError(`failed to spawn claude auth login: ${err instanceof Error ? err.message : String(err)}`),
      terminal: true,
    }
  }
  session.child = child
  activeLogin = session

  const onChunk = (chunk) => {
    session.output = (session.output + stripAnsi(chunk)).slice(-OUTPUT_TAIL_MAX)
    if (!session.url) {
      const m = session.output.match(URL_RE)
      if (m && isTrustedClaudeLoginUrl(m[1])) {
        session.url = m[1]
        info('[claude-auth-login] captured login URL')
        if (session.urlResolve) { session.urlResolve(session.url); session.urlResolve = null }
      }
    }
  }
  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)
  child.on('error', (err) => {
    warn('[claude-auth-login] spawn error', err instanceof Error ? err.message : String(err))
    session.finished = true
    if (session.urlResolve) { session.urlResolve(null); session.urlResolve = null }
    if (session.exitResolve) { session.exitResolve(); session.exitResolve = null }
  })
  child.on('exit', (codeNum) => {
    session.finished = true
    session.exitCode = typeof codeNum === 'number' ? codeNum : null
    if (session.urlResolve) { session.urlResolve(session.url); session.urlResolve = null }
    if (session.exitResolve) { session.exitResolve(); session.exitResolve = null }
  })

  // Safety net: never leave a stuck login process alive forever.
  session.killTimer = setTimeout(() => { killSession(session); cleanupLogin(session) }, LOGIN_URL_TIMEOUT_MS + LOGIN_COMPLETE_TIMEOUT_MS)

  const url = await Promise.race([
    urlPromise,
    new Promise((resolve) => setTimeout(() => resolve(session.url), LOGIN_URL_TIMEOUT_MS)),
  ])

  if (!url) {
    const reason = session.finished ? failureReason(session) : 'login did not produce a sign-in URL'
    killSession(session)
    cleanupLogin(session)
    return { ok: false, error: reason, loginId: session.loginId, terminal: true }
  }
  return {
    ok: true,
    url,
    loginId: session.loginId,
    expiresInSeconds: Math.floor((LOGIN_URL_TIMEOUT_MS + LOGIN_COMPLETE_TIMEOUT_MS) / 1000),
  }
})

// authLoginSubmitCode: deliver the pasted code to the waiting CLI and report
// whether the login completed successfully.
registerHandler('claude.authLoginSubmitCode', async (params) => {
  const code = typeof params?.code === 'string' ? params.code.trim() : ''
  const loginId = typeof params?.loginId === 'string' ? params.loginId.trim() : ''
  const deferRelease = params?.deferRelease === true
  const session = activeLogin
  if (!session) return { success: false, error: 'no active login session', terminal: true }
  if (session.finished) {
    const result = {
      success: false,
      error: failureReason(session),
      loginId: session.loginId,
      terminal: true,
    }
    if (!deferRelease) cleanupLogin(session)
    return result
  }
  if (!loginIdMatches(session, loginId)) {
    return { success: false, error: 'invalid login session', terminal: false }
  }
  if (!code) return { success: false, error: 'missing authorization code', terminal: false }

  const exitPromise = new Promise((resolve) => { session.exitResolve = resolve })
  try {
    session.child.stdin?.write(`${code}\n`)
  } catch (err) {
    killSession(session)
    if (!deferRelease) cleanupLogin(session)
    return {
      success: false,
      error: sanitizeLoginError(`failed to submit code: ${err instanceof Error ? err.message : String(err)}`),
      loginId: session.loginId,
      terminal: true,
    }
  }

  await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(resolve, LOGIN_COMPLETE_TIMEOUT_MS)),
  ])

  const exitCode = session.exitCode
  const out = stripAnsi(session.output || '')
  const succeeded = session.finished && exitCode === 0 && !FAILURE_RE.test(out)
  const result = succeeded
    ? { success: true, loginId: session.loginId, terminal: true }
    : { success: false, error: failureReason(session), loginId: session.loginId, terminal: true }
  if (!session.finished) killSession(session)
  if (!deferRelease) cleanupLogin(session)
  return result
})

registerHandler('claude.authLoginCancel', async (params) => {
  const loginId = typeof params?.loginId === 'string' ? params.loginId.trim() : ''
  const deferRelease = params?.deferRelease === true
  if (!activeLogin) return { ok: true, cancelled: false }
  if (!loginIdMatches(activeLogin, loginId)) {
    return { ok: false, cancelled: false, error: 'invalid login session', terminal: false }
  }
  const activeLoginId = activeLogin.loginId
  killSession(activeLogin)
  if (!deferRelease) cleanupLogin(activeLogin)
  return { ok: true, cancelled: true, loginId: activeLoginId, terminal: true }
})

// The Rust host calls release only after it has captured/restored the account.
// Keeping the terminal session reserved until then closes the small race where
// another remote client could start while host-side account finalization runs.
registerHandler('claude.authLoginRelease', async (params) => {
  const loginId = typeof params?.loginId === 'string' ? params.loginId.trim() : ''
  if (!activeLogin) return { ok: true, released: false }
  if (!loginIdMatches(activeLogin, loginId)) {
    return { ok: false, released: false, error: 'invalid login session' }
  }
  killSession(activeLogin)
  cleanupLogin(activeLogin)
  return { ok: true, released: true }
})
