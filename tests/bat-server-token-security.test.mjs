import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
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

console.log('bat-server token security contract: passed')
