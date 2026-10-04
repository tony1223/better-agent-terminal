import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
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

async function build() {
  const { stdout } = await execFileAsync('cargo', [
    'build', '--manifest-path', manifest, '--target-dir', target, '--message-format=json',
  ], { cwd: root })
  return stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(message => message.reason === 'compiler-artifact' && message.target.kind.includes('lib'))
    .map(message => ({ name: message.target.name, fresh: message.fresh }))
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
${name === 'bat-runtime' ? '[dependencies]\nbat-host-support = { path = "../bat-host-support" }\n' : ''}`)
    const source = name === 'bat-runtime'
      ? 'pub fn value() -> u32 { bat_host_support::value() + include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../runtime-catalog.json")).trim().parse::<u32>().unwrap() }\n'
      : `pub fn value() -> u32 { ${name === 'bat-host-support' ? 100 : 10} }\n`
    await writeFile(join(directory, 'src/lib.rs'), source)
  }

  const initialKey = await prepareStableCratesCache(root)
  assert.equal((await restoreStableCratesCache(root)).matched, false)
  assert.equal((await build()).filter(crate => !crate.fresh).length, STABLE_CRATES.length)
  assert.equal(await result(), '111')
  await recordStableCratesCache(root)

  // A clean checkout touches every source. A shell-only edit must leave all
  // independent libraries Fresh, including the runtime's catalog input.
  for (const file of (await stableCratesKey(root)).files) await utimes(file, new Date(), new Date())
  await writeFile(join(cargoRoot, 'src/main.rs'), 'fn main() { println!("{}", bat_runtime::value() + bat_remote_protocol::value()); } // shell-only edit\n')
  assert.equal(await prepareStableCratesCache(root), initialKey)
  assert.equal((await restoreStableCratesCache(root)).matched, true)
  assert.equal((await build()).filter(crate => crate.fresh).length, STABLE_CRATES.length)
  assert.equal(await result(), '111')

  // Even backdated edits must invalidate the cache. Cargo's timestamp check
  // alone would incorrectly accept the old rlib after source normalization.
  const hostSource = join(cargoRoot, 'crates', 'bat-host-support', 'src/lib.rs')
  await writeFile(hostSource, 'pub fn value() -> u32 { 200 }\n')
  await utimes(hostSource, new Date(0), new Date(0))
  assert.notEqual(await prepareStableCratesCache(root), initialKey)
  assert.equal((await restoreStableCratesCache(root)).matched, false)
  assert.equal((await build()).filter(crate => !crate.fresh).length, STABLE_CRATES.length)
  assert.equal(await result(), '211')
  // No record after an interrupted/failed release: the old cache key remains
  // untrusted on retry, even if partial compilation artifacts survived.
  assert.equal((await restoreStableCratesCache(root)).matched, false)
  await build()
  await recordStableCratesCache(root)
  assert.equal((await restoreStableCratesCache(root)).matched, true)
  assert.equal((await build()).filter(crate => crate.fresh).length, STABLE_CRATES.length)

  // include_str! inputs are part of the key, not just .rs files and manifests.
  await writeFile(join(root, 'runtime-catalog.json'), '2')
  await prepareStableCratesCache(root)
  assert.equal((await restoreStableCratesCache(root)).matched, false)
  await build()
  assert.equal(await result(), '212')
  await recordStableCratesCache(root)

  // A rollback to an older source must never reuse the newer artifact.
  await writeFile(hostSource, 'pub fn value() -> u32 { 100 }\n')
  await prepareStableCratesCache(root)
  assert.equal((await restoreStableCratesCache(root)).matched, false)
  await build()
  assert.equal(await result(), '112')

  await prepareStableCratesCache(root)
  assert.equal((await readFile(manifest, 'utf8')).match(/\[package\.metadata\.bat-stable-crates-cache\]/g).length, 1)
  assert.equal((await stat(hostSource)).mtime.toISOString(), '2000-01-01T00:00:00.000Z')
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('stable-rust-crates-cache: real Cargo reuse, source changes, retry and rollback passed')
