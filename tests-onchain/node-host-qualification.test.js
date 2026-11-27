// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildFixtureAddon } from './fixtures/node-addon-fixture.js'
import { stageQualificationPackage } from '../native/scripts/node-host.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceManifest = join(root, 'src/onchain-node-native.json')
const target = `${process.platform}-${process.arch}${process.platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? '-gnu' : '-musl') : ''}`

async function workspace (t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'wdk-host-qualification-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('pre-admission Node qualification changes only its private manifest and exact target pin', async t => {
  const original = await readFile(sourceManifest)
  const manifest = JSON.parse(original)
  const directory = await workspace(t)
  const pin = { sha256: 'ab'.repeat(32), byteLength: 123 }
  const staged = await stageQualificationPackage(root, directory, { target, pin })
  assert.equal((await lstat(staged)).mode & 0o777, 0o700)
  assert.deepEqual(await readFile(sourceManifest), original)
  assert.deepEqual(JSON.parse(await readFile(join(staged, 'src/onchain-node-native.json'))), {
    ...manifest, releaseHold: false, targets: { [target]: pin }
  })
  assert.equal(await realpath(join(staged, 'node_modules')), await realpath(join(root, 'node_modules')))
  for (const file of ['onchain.js', 'package.json', 'src/onchain-wallet.js', 'src/onchain-worker.js']) {
    assert.deepEqual(await readFile(join(staged, file)), await readFile(join(root, file)))
  }
  await assert.rejects(stageQualificationPackage(root, directory), { code: 'EEXIST' })
  assert.deepEqual(await readFile(sourceManifest), original)
})

test('pre-admission staging still rejects both an incorrect addon hash and native identity', async t => {
  const original = await readFile(sourceManifest)
  const directory = await workspace(t)
  const addon = await buildFixtureAddon(t, `module.exports = line => {
    const { id, method } = JSON.parse(line)
    if (method !== 'version') throw new Error('Unexpected native method')
    return JSON.stringify({ id, result: { protocol: 2, source: 'unreviewed' } })
  }`)
  const pin = { sha256: addon.sha256, byteLength: addon.byteLength }
  const staged = await stageQualificationPackage(root, directory, { target, pin })
  const { WalletManagerRgb } = await import(pathToFileURL(join(staged, 'onchain.js')).href)
  const digest = addon.sha256
  for (const [name, hash] of [['wrong-hash', '0'.repeat(64)], ['wrong-identity', digest]]) {
    const manager = new WalletManagerRgb(new Uint8Array(64).fill(7), {
      network: 'regtest', startupMode: 'offline', dataDir: join(directory, name),
      indexerUrl: 'tcp://127.0.0.1:50001', transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc',
      nativeAddon: addon.path, nativeSha256: hash, maxFeeSats: '5000',
      authorize: () => assert.fail('Qualification must not request a transaction signature')
    })
    try {
      await assert.rejects(manager.getAccount(), { code: 'NATIVE_IDENTITY_MISMATCH' })
    } finally {
      await manager.shutdown()
    }
  }
  assert.deepEqual(await readFile(sourceManifest), original)
})
