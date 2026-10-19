import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redactConnectionCredentials } from '../node-sidecar/src/lib/connection-redaction.mjs'
import { installScript } from '../scripts/build-bat-server-bundle.mjs'

const [rustCli, readme] = await Promise.all([
  readFile('src-tauri/src/lib.rs', 'utf8'),
  readFile('README.md', 'utf8'),
])
const installer = installScript('linux-aarch64')

assert.match(rustCli, /--token-file=PATH/)
assert.match(rustCli, /BAT_TOKEN_FILE/)
assert.match(rustCli, /CREDENTIALS_DIRECTORY/)
assert.match(rustCli, /SYSTEMD_TOKEN_CREDENTIAL:\s*&str\s*=\s*"bat-server-token"/)
assert.match(rustCli, /--token is supported for compatibility/)
assert.match(rustCli, /BAT_TOKEN is supported for compatibility/)
assert.match(rustCli, /token file .* is accessible beyond its owner; prefer chmod 600/)

assert.match(installer, /TOKEN_FILE="\$\{BAT_TOKEN_FILE:-\/etc\/bat-server\/credentials\/token\}"/)
assert.match(installer, /chmod 0600 "\$TOKEN_TMP"/)
assert.match(installer, /LoadCredential=bat-server-token:\$TOKEN_FILE/)
assert.match(installer, /Environment=BAT_TOKEN_FILE=\$TOKEN_FILE/)
assert.match(installer, /migrating the legacy inline token/)
assert.ok(installer.includes('--token(=|[[:space:]]+)([^[:space:]]+)'))

const execStartLines = installer.match(/^ExecStart=.*$/gm) ?? []
assert.equal(execStartLines.length, 1)
assert.doesNotMatch(execStartLines[0], /--token(?:=|\s)/)

if (process.platform !== 'win32') {
  const bashSyntax = spawnSync('bash', ['-n'], { input: installer, encoding: 'utf8' })
  assert.equal(bashSyntax.status, 0, bashSyntax.stderr)
}

assert.match(readme, /--token-file=PATH/)
assert.match(readme, /\/etc\/bat-server\/credentials\/token/)
assert.match(readme, /LoadCredential=/)
assert.match(readme, /backward compatibility/i)

assert.match(rustCli, /--print-connect-link/)
assert.match(rustCli, /args\.print_connect_link && !std::io::stdout\(\)\.is_terminal\(\)/)
// Both runtime variants call the same credential-safe banner.
assert.equal((rustCli.match(/print_headless_server_banner\(&data_dir, &result, args\.print_connect_link\)/g) ?? []).length, 2)
assert.doesNotMatch(rustCli, /println!\([^\n]*\{token\}/)

const diagnosticCases = [
  ['failure wss://example.invalid?token=fixture-secret&fp=AA', 'failure wss://example.invalid?token=[REDACTED]&fp=AA'],
  ['--TOKEN=fixture-secret', '--TOKEN=[REDACTED]'],
  ['{"token":"fixture-secret","remoteToken":"second-secret"}', '{"token":"[REDACTED]","remoteToken":"[REDACTED]"}'],
  ['{"token":"fixture\\\"secret"}', '{"token":"[REDACTED]"}'],
]
for (const [input, expected] of diagnosticCases) {
  assert.equal(redactConnectionCredentials(input), expected)
  assert.equal(redactConnectionCredentials(expected), expected)
}

const scratch = await mkdtemp(join(tmpdir(), 'bat-connection-log-test-'))
try {
  const logPath = join(scratch, 'sidecar.log')
  const loggerUrl = new URL('../node-sidecar/src/lib/logger.mjs', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import * as logger from ${JSON.stringify(loggerUrl)};
    logger.__setLogPathOverrideForTests(${JSON.stringify(logPath)});
    logger.initLogger();
    logger.error(new Error('upgrade failed wss://example.invalid?token=fixture-secret&fp=AA'));
    logger.info({token: 'fixture-secret', remoteToken: 'second-secret'});
  `], { encoding: 'utf8' })
  assert.equal(child.status, 0, 'logger subprocess must succeed')
  const diskLog = await readFile(logPath, 'utf8')
  for (const text of [child.stdout, child.stderr, diskLog]) {
    assert.ok(!text.includes('fixture-secret') && !text.includes('second-secret'))
  }
  assert.match(diskLog, /\?token=\[REDACTED\]&fp=AA/)
  assert.match(child.stderr, /\?token=\[REDACTED\]&fp=AA/)
} finally {
  await rm(scratch, { recursive: true, force: true })
}

console.log('bat-server token security contract: passed')
