// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stageQualificationPackage } from '../native/scripts/node-host.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceManifest = join(root, 'src/onchain-bare-native.json')

async function workspace (t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'wdk-host-qualification-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('pre-admission Node qualification changes only its private manifest hold', async t => {
  const original = await readFile(sourceManifest)
  const manifest = JSON.parse(original)
  const directory = await workspace(t)
  const staged = await stageQualificationPackage(root, directory)
  assert.equal((await lstat(staged)).mode & 0o777, 0o700)
  assert.deepEqual(await readFile(sourceManifest), original)
  assert.deepEqual(JSON.parse(await readFile(join(staged, 'src/onchain-bare-native.json'))), {
    ...manifest, releaseHold: false
  })
  assert.equal(await realpath(join(staged, 'node_modules')), await realpath(join(root, 'node_modules')))
  for (const file of ['onchain.js', 'package.json', 'src/onchain-wallet.js', 'src/onchain-worker.js']) {
    assert.deepEqual(await readFile(join(staged, file)), await readFile(join(root, file)))
  }
  await assert.rejects(stageQualificationPackage(root, directory), { code: 'EEXIST' })
  assert.deepEqual(await readFile(sourceManifest), original)
})

test('pre-admission staging still rejects both an incorrect worker hash and native identity', async t => {
  const original = await readFile(sourceManifest)
  const directory = await workspace(t)
  const staged = await stageQualificationPackage(root, directory)
  const { WalletManagerRgb } = await import(pathToFileURL(join(staged, 'onchain.js')).href)
  const worker = join(directory, 'incompatible-worker')
  const script = `#!${process.execPath}
const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line)
  if (method !== 'version') process.exit(13)
  process.stdout.write(JSON.stringify({ id, result: { protocol: 2, source: 'unreviewed' } }) + '\\n')
})
`
  await writeFile(worker, script, { mode: 0o700 })
  const digest = createHash('sha256').update(script).digest('hex')
  for (const [name, hash] of [['wrong-hash', '0'.repeat(64)], ['wrong-identity', digest]]) {
    const manager = new WalletManagerRgb(new Uint8Array(64).fill(7), {
      network: 'regtest', startupMode: 'offline', dataDir: join(directory, name),
      indexerUrl: 'tcp://127.0.0.1:50001', transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc',
      nativeExecutable: worker, nativeSha256: hash, maxFeeSats: '5000',
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
