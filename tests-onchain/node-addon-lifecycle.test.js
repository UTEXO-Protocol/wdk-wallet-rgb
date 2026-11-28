// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import assert from 'node:assert/strict'
import { appendFile, chmod, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import nativeManifest from '../src/onchain-bare-native.json' with { type: 'json' }
import { buildFixtureAddon, importWorkerFixture } from './fixtures/node-addon-fixture.js'
import { importWalletFixture } from './fixtures/native-manifest.js'

const version = {
  protocol: 2, unsignedRecovery: 1, journalWrites: 1, assetIssuance: 2,
  networkChecks: 7, contractRegistration: 1, contractExport: 1,
  receivedMintVerification: 1, exposedInputs: 1, runtime: 'node-in-process',
  indexer: 'electrum-and-dev-esplora', source: nativeManifest.source,
  overlayTree: nativeManifest.overlayTree, integrationTree: nativeManifest.integrationTree
}

function handler (body, { destroyPath } = {}) {
  return `const fs = require('node:fs')
module.exports = (frame, blockNative) => {
  const { id, method, params } = JSON.parse(frame)
  const reply = result => JSON.stringify({ id, result })
  if (method === 'version') return reply(${JSON.stringify(version)})
  ${body}
}
module.exports.destroyPath = ${JSON.stringify(destroyPath)}
`
}

async function fixture (t, body = 'return reply(params)', options = {}) {
  const addon = await buildFixtureAddon(t, handler(body, options))
  const worker = await importWorkerFixture(t, { addon, timeoutMs: options.timeoutMs })
  return { addon, ...worker }
}

async function waitForFile (path) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await stat(path); return } catch (error) { if (error.code !== 'ENOENT') throw error }
    await delay(10)
  }
  assert.fail('The native fixture did not reach its checkpoint')
}

test('Node addon is admitted by path, permissions, bytes and source identity before work', async t => {
  const f = await fixture(t)
  await assert.rejects(f.OnchainWorker.start('relative.node', f.addon.sha256), TypeError)
  await assert.rejects(f.OnchainWorker.start(f.addon.path, '00'.repeat(32)), { code: 'NATIVE_IDENTITY_MISMATCH' })
  const link = join(f.addon.directory, 'symlink.node')
  await symlink(f.addon.path, link)
  await assert.rejects(f.OnchainWorker.start(link, f.addon.sha256))
  await chmod(f.addon.path, 0o666)
  await assert.rejects(f.OnchainWorker.start(f.addon.path, f.addon.sha256))
  await chmod(f.addon.path, 0o600)
  await appendFile(f.addon.path, 'tampered')
  await assert.rejects(f.OnchainWorker.start(f.addon.path, f.addon.sha256), { code: 'NATIVE_IDENTITY_MISMATCH' })
})

test('native addon executes away from the caller and rejects concurrent requests', async t => {
  const f = await fixture(t, `blockNative(200); return reply(params)`)
  const worker = await f.OnchainWorker.start(f.addon.path, f.addon.sha256)
  t.after(() => worker.close())
  const pending = worker.request('echo', { value: 'kept' })
  await assert.rejects(worker.request('echo'), { code: 'WALLET_BUSY' })
  let completed = false
  pending.then(() => { completed = true })
  await delay(30)
  assert.equal(completed, false)
  assert.deepEqual(await pending, { value: 'kept' })
  await worker.close()
  assert.equal(worker.available, false)
  await assert.rejects(worker.request('echo'), { code: 'NATIVE_CLOSED' })
})

test('oversized requests are rejected before entering the native addon', async t => {
  const f = await fixture(t)
  const worker = await f.OnchainWorker.start(f.addon.path, f.addon.sha256)
  t.after(() => worker.close())
  assert.throws(() => worker.request('echo', { value: 'x'.repeat(6 * 1024 * 1024) }), RangeError)
  assert.deepEqual(await worker.request('echo', { value: 'valid' }), { value: 'valid' })
})

for (const [name, body] of [
  ['wrong request ID', `return JSON.stringify({ id: 'wrong', result: {} })`],
  ['ambiguous response', `return JSON.stringify({ id, result: {}, error: { code: 'X', message: 'X' } })`],
  ['malformed error', `return JSON.stringify({ id, error: null })`],
  ['invalid JSON', `return '{'`],
  ['oversized response', `return 'x'.repeat(14 * 1024 * 1024 + 1)`]
]) {
  test(`${name} permanently closes the native session without another dispatch`, async t => {
    const f = await fixture(t, body)
    const worker = await f.OnchainWorker.start(f.addon.path, f.addon.sha256)
    t.after(() => worker.close())
    await assert.rejects(worker.request('invalid'), { code: 'NATIVE_PROTOCOL' })
    assert.equal(worker.available, false)
    await assert.rejects(worker.request('invalid'), { code: 'NATIVE_PROTOCOL' })
    await worker.close()
  })
}

for (const interruption of ['close', 'timeout']) {
  test(`${interruption} rejects the wait but drains a dispatched native mutation before releasing ownership`, async t => {
    const addon = await buildFixtureAddon(t, '')
    const events = join(addon.directory, 'events')
    const started = join(addon.directory, 'started')
    const proof = join(addon.directory, 'proof')
    const destroyed = join(addon.directory, 'destroyed')
    await writeFile(addon.path + '.fixture.cjs', handler(`
      if (method === 'mutate') {
        fs.appendFileSync(${JSON.stringify(events)}, 'invoked\\n')
        fs.writeFileSync(${JSON.stringify(started)}, 'started')
        blockNative(600)
        fs.writeFileSync(${JSON.stringify(proof)}, 'original-proof')
        fs.appendFileSync(${JSON.stringify(events)}, 'committed\\n')
        return reply({ txid: 'original-txid' })
      }
      if (method === 'recover') return reply({ proof: fs.readFileSync(${JSON.stringify(proof)}, 'utf8') })
      throw new Error('Unexpected mutation replay')
    `, { destroyPath: destroyed }))
    const { OnchainWorker } = await importWorkerFixture(t, { addon, timeoutMs: interruption === 'timeout' ? 200 : undefined })
    const worker = await OnchainWorker.start(addon.path, addon.sha256)
    t.after(() => worker.close())
    const mutation = worker.request('mutate', { operationId: 'same-operation-id' })
    const rejected = assert.rejects(mutation, { code: interruption === 'timeout' ? 'NATIVE_TIMEOUT' : 'NATIVE_CLOSED' })
    await waitForFile(started)
    let closed = false
    let close
    if (interruption === 'close') close = worker.close().then(() => { closed = true })
    await rejected
    close ??= worker.close().then(() => { closed = true })
    await delay(20)
    assert.equal(closed, false, 'close must wait for the native call and its destructor')
    await assert.rejects(stat(destroyed), { code: 'ENOENT' })
    await assert.rejects(worker.request('mutate'), { code: interruption === 'timeout' ? 'NATIVE_TIMEOUT' : 'NATIVE_CLOSED' })
    await close
    assert.equal(await readFile(events, 'utf8'), 'invoked\ncommitted\n')
    assert.equal(await readFile(destroyed, 'utf8'), 'destroy\n')
    const reopened = await OnchainWorker.start(addon.path, addon.sha256)
    try {
      assert.deepEqual(await reopened.request('recover'), { proof: 'original-proof' })
      assert.equal(await readFile(events, 'utf8'), 'invoked\ncommitted\n')
    } finally { await reopened.close() }
    assert.equal(await readFile(destroyed, 'utf8'), 'destroy\ndestroy\n')
  })
}

test('native application errors reject only their request and preserve the live session', async t => {
  const f = await fixture(t, `
    if (method === 'fail') return JSON.stringify({ id, error: { code: 'INSUFFICIENT_FUNDS', message: 'Not enough funds' } })
    return reply(params)
  `)
  const worker = await f.OnchainWorker.start(f.addon.path, f.addon.sha256)
  t.after(() => worker.close())
  await assert.rejects(worker.request('fail'), { code: 'INSUFFICIENT_FUNDS' })
  assert.equal(worker.available, true)
  assert.deepEqual(await worker.request('echo', { still: 'live' }), { still: 'live' })
})

test('unexpected native exceptions close the worker without disclosing diagnostics or replaying', async t => {
  const addon = await buildFixtureAddon(t, '')
  const destroyed = join(addon.directory, 'destroyed')
  const events = join(addon.directory, 'events')
  await writeFile(addon.path + '.fixture.cjs', handler(`
    fs.appendFileSync(${JSON.stringify(events)}, 'invoked\\n')
    throw new Error('PRIVATE_NATIVE_DIAGNOSTIC_123')
  `, { destroyPath: destroyed }))
  const { OnchainWorker } = await importWorkerFixture(t, { addon })
  const worker = await OnchainWorker.start(addon.path, addon.sha256)
  t.after(() => worker.close())
  await assert.rejects(worker.request('fail'), error => {
    assert.equal(error.code, 'NATIVE_IO_FAILED')
    assert.equal(String(error).includes('PRIVATE_NATIVE_DIAGNOSTIC'), false)
    return true
  })
  await worker.close()
  assert.equal(await readFile(events, 'utf8'), 'invoked\n')
  assert.equal(await readFile(destroyed, 'utf8'), 'destroy\n')
  await assert.rejects(worker.request('fail'), { code: 'NATIVE_IO_FAILED' })
})

test('the dedicated worker does not inherit JavaScript environment values or preload arguments', async t => {
  const key = 'WDK_PRIVATE_TEST_ENV'
  const original = process.env[key]
  process.env[key] = 'private-test-context'
  t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original })
  const f = await fixture(t, `return reply({ argv: process.execArgv, keys: Object.keys(process.env).sort() })`)
  const worker = await f.OnchainWorker.start(f.addon.path, f.addon.sha256)
  try {
    assert.deepEqual(await worker.request('environment'), { argv: [], keys: ['LANG', 'PATH'] })
  } finally { await worker.close() }
})

test('wallet directory admission remains owned until the real native thread has drained', async t => {
  const addon = await buildFixtureAddon(t, '')
  const started = join(addon.directory, 'started')
  await writeFile(addon.path + '.fixture.cjs', handler(`
    if (method === 'open') return reply({ network: params.network, watchOnly: true })
    if (method === 'bindJournal') return reply({ written: true })
    if (method === 'getBtcBalance') {
      fs.writeFileSync(${JSON.stringify(started)}, 'started')
      blockNative(600)
      return reply({ vanilla: { settled: '0', future: '0', spendable: '0' }, colored: { settled: '0', future: '0', spendable: '0' } })
    }
    throw new Error('Unexpected operation: ' + method)
  `))
  const { workerModuleUrl } = await importWorkerFixture(t, { addon })
  const { WalletManagerRgb } = await importWalletFixture('addon-ownership', false, workerModuleUrl)
  const config = {
    network: 'regtest', startupMode: 'offline', dataDir: join(addon.directory, 'wallet'),
    nativeAddon: addon.path, nativeSha256: addon.sha256, indexerUrl: 'tcp://127.0.0.1:50001',
    transportEndpoint: 'rpc://127.0.0.1:3003/json-rpc', maxFeeSats: '1000', authorize: () => false
  }
  const seed = Uint8Array.from({ length: 64 }, (_, i) => i + 1)
  const first = new WalletManagerRgb(seed, config)
  const second = new WalletManagerRgb(seed, config)
  t.after(async () => { await first.shutdown(); await second.shutdown() })
  const account = await first.getAccount()
  const pending = account.getBtcBalance()
  const rejected = assert.rejects(pending, { code: 'NATIVE_CLOSED' })
  await waitForFile(started)
  const closing = first.shutdown()
  await rejected
  await assert.rejects(second.getAccount(), { code: 'WALLET_IN_USE' })
  await closing
  assert.equal((await second.getAccount()).getConnectionStatus(), 'offline')
})
