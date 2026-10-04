import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  prepareStableCratesCache,
  recordStableCratesCache,
  restoreStableCratesCache,
  stableCratesKey,
  STABLE_CRATES,
} from '../scripts/stable-rust-crates-cache.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'bat-stable-rust-cache-'))
const cargoRoot = join(root, 'src-tauri')
const manifest = join(cargoRoot, 'Cargo.toml')
const target = join(cargoRoot, 'target')
const binary = join(target, 'debug', `cache-probe${process.platform === 'win32' ? '.exe' : ''}`)
const cacheState = join(root, '.bat-rust-cache', 'stable-crates.json')
const dependencies = {
  'bat-accounts': ['bat-app-storage'],
  'bat-agent-bridge': ['bat-host-support'],
  'bat-app-storage': ['bat-host-support'],
  'bat-filesystem': ['bat-host-support'],
  'bat-git': ['bat-host-support'],
  'bat-pty': ['bat-app-storage', 'bat-host-support'],
  'bat-runtime': ['bat-host-support'],
}
const hostDependents = STABLE_CRATES.filter(name => name !== 'bat-remote-protocol')

function restore(clean) {
  // The fixture deliberately builds with an explicit target directory. Never
  // let an inherited CARGO_TARGET_DIR clean another workspace's artifacts.
  return restoreStableCratesCache(root, clean, { targetDir: target })
}

async function build(targetDir = target) {
  const { stdout } = await execFileAsync('cargo', [
    'build', '--manifest-path', manifest, '--target-dir', targetDir, '--message-format=json',
  ], { cwd: root })
  return stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(message => message.reason === 'compiler-artifact' && message.target.kind.includes('lib'))
    .map(message => ({ name: message.target.name, fresh: message.fresh }))
}

async function assertRebuilt(names) {
  const artifacts = await build()
  assert.equal(artifacts.length, STABLE_CRATES.length)
  assert.deepEqual(artifacts.filter(crate => !crate.fresh).map(crate => crate.name).sort(),
    names.map(name => name.replaceAll('-', '_')).sort())
}

async function result() {
  return (await execFileAsync(binary, [], { cwd: root })).stdout.trim()
}

try {
  await mkdir(join(cargoRoot, 'src'), { recursive: true })
  await writeFile(manifest, `[package]
name = "cache-probe"
version = "0.1.0"
edition = "2021"
[workspace]
members = [".", "crates/*"]
resolver = "2"
[dependencies]
${STABLE_CRATES.map(name => `${name} = { path = "crates/${name}" }`).join('\n')}
`)
  await writeFile(join(cargoRoot, 'src/main.rs'), 'fn main() { println!("{}", bat_runtime::value() + bat_remote_protocol::value()); }\n')
  await writeFile(join(root, 'runtime-catalog.json'), '1')
  for (const name of STABLE_CRATES) {
    const directory = join(cargoRoot, 'crates', name)
    await mkdir(join(directory, 'src'), { recursive: true })
    await writeFile(join(directory, 'Cargo.toml'), `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"
${dependencies[name]?.length ? '[dependencies]\n' + dependencies[name].map(dep => `${dep} = { path = "../${dep}" }`).join('\n') + '\n' : ''}`)
    const source = name === 'bat-runtime'
      ? 'pub fn value() -> u32 { bat_host_support::value() + include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../runtime-catalog.json")).trim().parse::<u32>().unwrap() }\n'
      : `pub fn value() -> u32 { ${name === 'bat-host-support' ? 100 : 10} }\n`
    await writeFile(join(directory, 'src/lib.rs'), source)
  }

  // Resource preparation creates target/ before Cargo runs. Restored CI caches
  // also omit CACHEDIR.TAG, which recent Cargo requires for --target-dir clean.
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'bundle-mode.txt'), 'all-in-one\n')
  const initialKey = await prepareStableCratesCache(root)
  assert.deepEqual((await restore()).invalidated, STABLE_CRATES)
  const cargoTag = await readFile(join(target, 'CACHEDIR.TAG'), 'utf8')
  assert.ok(cargoTag.startsWith('Signature: 8a477f597d28d172789f06886806bc55'))
  assert.equal(await readFile(join(target, 'bundle-mode.txt'), 'utf8'), 'all-in-one\n')
  await assertRebuilt(STABLE_CRATES)
  assert.equal(await result(), '111')
  await recordStableCratesCache(root)

  // A clean checkout touches every source. A shell-only edit must leave all
  // independent libraries Fresh, including the runtime's catalog input.
  for (const file of (await stableCratesKey(root)).files) await utimes(file, new Date(), new Date())
  await writeFile(join(cargoRoot, 'src/main.rs'), 'fn main() { println!("{}", bat_runtime::value() + bat_remote_protocol::value()); } // shell-only edit\n')
  assert.equal(await prepareStableCratesCache(root), initialKey)
  assert.equal((await restore()).matched, true)
  await assertRebuilt([])
  assert.equal(await result(), '111')

  // Even backdated edits must invalidate the cache. Cargo's timestamp check
  // alone would incorrectly accept the old rlib after source normalization.
  const hostSource = join(cargoRoot, 'crates', 'bat-host-support', 'src/lib.rs')
  await writeFile(hostSource, 'pub fn value() -> u32 { 200 }\n')
  await utimes(hostSource, new Date(0), new Date(0))
  await rm(join(target, 'CACHEDIR.TAG'))
  assert.notEqual(await prepareStableCratesCache(root), initialKey)
  assert.deepEqual((await restore()).invalidated, hostDependents)
  assert.equal(await readFile(join(target, 'CACHEDIR.TAG'), 'utf8'), cargoTag)
  await assertRebuilt(hostDependents)
  assert.equal(await result(), '211')
  // No record after an interrupted/failed release: the old cache key remains
  // untrusted on retry, even if partial compilation artifacts survived.
  assert.deepEqual((await restore()).invalidated, hostDependents)
  await assertRebuilt(hostDependents)
  await recordStableCratesCache(root)
  assert.equal((await restore()).matched, true)
  await assertRebuilt([])

  // A leaf edit only rebuilds that leaf. An intermediate edit also rebuilds
  // its transitive consumer, while the host and other libraries remain Fresh.
  for (const [name, invalidated] of [
    ['bat-filesystem', ['bat-filesystem']],
    ['bat-app-storage', ['bat-accounts', 'bat-app-storage', 'bat-pty']],
  ]) {
    const source = join(cargoRoot, 'crates', name, 'src/lib.rs')
    await writeFile(source, 'pub fn value() -> u32 { 20 }\n')
    await utimes(source, new Date(0), new Date(0))
    await prepareStableCratesCache(root)
    assert.deepEqual((await restore()).invalidated, invalidated)
    await assertRebuilt(invalidated)
    await recordStableCratesCache(root)
  }

  // include_str! inputs are part of the key, not just .rs files and manifests.
  await writeFile(join(root, 'runtime-catalog.json'), '2')
  await prepareStableCratesCache(root)
  assert.deepEqual((await restore()).invalidated, ['bat-runtime'])
  await assertRebuilt(['bat-runtime'])
  assert.equal(await result(), '212')
  await recordStableCratesCache(root)

  // A rollback to an older source must never reuse the newer artifact.
  await writeFile(hostSource, 'pub fn value() -> u32 { 100 }\n')
  await prepareStableCratesCache(root)
  assert.deepEqual((await restore()).invalidated, hostDependents)
  await assertRebuilt(hostDependents)
  assert.equal(await result(), '112')
  await recordStableCratesCache(root)

  // Dependency changes are discovered from Cargo metadata rather than a
  // hardcoded graph. Removing this edge makes accounts independent of storage.
  const accountManifest = join(cargoRoot, 'crates', 'bat-accounts', 'Cargo.toml')
  await writeFile(accountManifest, '[package]\nname = "bat-accounts"\nversion = "0.1.0"\nedition = "2021"\n')
  assert.deepEqual((await restore()).invalidated, ['bat-accounts'])
  await assertRebuilt(['bat-accounts'])
  await recordStableCratesCache(root)
  await writeFile(join(cargoRoot, 'crates', 'bat-app-storage', 'src/lib.rs'), 'pub fn value() -> u32 { 30 }\n')
  assert.deepEqual((await restore()).invalidated, ['bat-app-storage', 'bat-pty'])
  await assertRebuilt(['bat-app-storage', 'bat-pty'])
  await recordStableCratesCache(root)

  // A cleanup failure must not normalize sources or bless partial artifacts.
  await writeFile(hostSource, 'pub fn value() -> u32 { 300 }\n')
  await utimes(hostSource, new Date(0), new Date(0))
  const stateBeforeFailure = await readFile(cacheState, 'utf8')
  await assert.rejects(restore(async () => { throw new Error('clean failed') }), /clean failed/)
  assert.equal((await stat(hostSource)).mtime.getTime(), 0)
  assert.equal(await readFile(cacheState, 'utf8'), stateBeforeFailure)

  // An explicit build target takes precedence over an inherited environment.
  const outsideTarget = join(root, 'other-target')
  await build(outsideTarget)
  const outsideLib = (await readdir(join(outsideTarget, 'debug', 'deps')))
    .find(name => /^libbat_host_support.*\.rlib$/.test(name))
  assert.ok(outsideLib)
  const outsideArtifact = join(outsideTarget, 'debug', 'deps', outsideLib)
  const outsideModified = (await stat(outsideArtifact)).mtimeMs
  const outsideTagPath = join(outsideTarget, 'CACHEDIR.TAG')
  const outsideTag = await readFile(outsideTagPath, 'utf8')
  await rm(outsideTagPath)
  await assert.rejects(restoreStableCratesCache(root, undefined, { targetDir: outsideTarget }), /unmarked external Cargo target/)
  await assert.rejects(readFile(outsideTagPath), { code: 'ENOENT' })
  assert.equal((await stat(outsideArtifact)).mtimeMs, outsideModified)
  assert.equal((await stat(hostSource)).mtime.getTime(), 0)
  assert.equal(await readFile(cacheState, 'utf8'), stateBeforeFailure)
  await writeFile(outsideTagPath, outsideTag)
  const linkedTarget = join(root, 'linked-target')
  await symlink(outsideTarget, linkedTarget, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(restoreStableCratesCache(root, undefined, { targetDir: linkedTarget }), /linked Cargo target/)
  assert.equal((await stat(outsideArtifact)).mtimeMs, outsideModified)
  await rm(linkedTarget)
  await writeFile(join(target, 'CACHEDIR.TAG'), 'invalid tag\n')
  await assert.rejects(restore(), /invalid CACHEDIR.TAG/)
  assert.equal((await stat(hostSource)).mtime.getTime(), 0)
  assert.equal(await readFile(cacheState, 'utf8'), stateBeforeFailure)
  await writeFile(join(target, 'CACHEDIR.TAG'), cargoTag)
  const inheritedTarget = process.env.CARGO_TARGET_DIR
  try {
    process.env.CARGO_TARGET_DIR = outsideTarget
    const changed = hostDependents.filter(name => name !== 'bat-accounts')
    assert.deepEqual((await restore()).invalidated, changed)
    assert.equal((await stat(outsideArtifact)).mtimeMs, outsideModified)
    await assertRebuilt(changed)
    assert.equal(await result(), '312')
  } finally {
    if (inheritedTarget === undefined) delete process.env.CARGO_TARGET_DIR
    else process.env.CARGO_TARGET_DIR = inheritedTarget
  }
  await recordStableCratesCache(root)

  // Old, malformed, and incomplete cache state all require a safe rebuild.
  for (const state of [
    '{invalid json',
    JSON.stringify({ key: (await stableCratesKey(root)).key, sourceTime: '2000-01-01T00:00:00.000Z' }),
    JSON.stringify({ version: 2, crates: {}, sourceTime: '2000-01-01T00:00:00.000Z' }),
  ]) {
    await writeFile(cacheState, state)
    assert.deepEqual((await restore()).invalidated, STABLE_CRATES)
    await assertRebuilt(STABLE_CRATES)
    await recordStableCratesCache(root)
  }

  await prepareStableCratesCache(root)
  assert.equal((await readFile(manifest, 'utf8')).match(/\[package\.metadata\.bat-stable-crates-cache\]/g).length, 1)
  assert.equal((await stat(hostSource)).mtime.toISOString(), '2000-01-01T00:00:00.000Z')
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('stable-rust-crates-cache: selective Cargo reuse, dependency changes, retry, rollback, target isolation and state migration passed')
