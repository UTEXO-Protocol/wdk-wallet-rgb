// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WalletManagerRgb } from '../onchain.js'

const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1)
const INDEXER = 'tcp://127.0.0.1:50001'
const PROXY = 'rpc://127.0.0.1:3003/json-rpc'
const BLOCK_HASH = 'ab'.repeat(32)
const DEFAULTS = {
  network: 'regtest',
  indexerUrl: INDEXER + '/',
  transportEndpoint: PROXY,
  maxFeeSats: '2000',
  authorize: () => assert.fail('Offline operations must not request transaction authorization')
}

async function managerFor (t, { nativeVersion = 1, ...options } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'wdk-network-')))
  const worker = join(dir, 'fixture-worker')
  const source = `#!${process.execPath}
const assert = require('node:assert/strict')
const readline = require('node:readline')
let connectionAttempts = 0
let tipReads = 0
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  const reply = result => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
  if (method === 'version') return reply({
    protocol: 2, networkChecks: ${nativeVersion}, unsignedRecovery: 1, journalWrites: 1,
    indexer: 'electrum-only', runtime: 'node-host-process',
    source: '0a9d352f2690902df2b6fae9bca1a6c13c3354d4',
    overlayTree: '5b7660a66d53da6a5935407bbaf21f7e73636f35',
    integrationTree: '8dd209a8bb849696e45f301b0ea1b3d4eb0fba06'
  })
  if (method === 'open') return reply({ network: params.network, watchOnly: true })
  if (method === 'bindJournal') return reply({ written: true })
  if (method === 'goOnline') {
    assert.equal(params.indexerUrl, '${INDEXER}')
    if (++connectionAttempts === 1) return process.stdout.write(JSON.stringify({
      id, error: { code: 'INVALID_INDEXER', message: 'Indexer offline' }
    }) + '\\n')
    return reply({})
  }
  if (method === 'getAddress') {
    assert.equal(connectionAttempts, 2)
    return reply({ address: 'fixture-connected-address' })
  }
  if (method === 'getBtcBalance') {
    assert.equal(connectionAttempts, 0)
    return reply({ vanilla: { spendable: '42' } })
  }
  if (method === 'getNetworkInfo') {
    assert.equal(connectionAttempts, 2)
    return reply({
      network: 'regtest', height: ++tipReads === 1 ? 0 : -1, blockHash: '${BLOCK_HASH}',
      ignored: true
    })
  }
  if (method === 'checkIndexerUrl') {
    assert.deepEqual(params, { url: '${INDEXER}' })
    return reply({ ok: true, indexerProtocol: 'Electrum', private: 'omitted' })
  }
  if (method === 'checkProxyEndpoint') {
    assert.deepEqual(params, { url: '${PROXY}' })
    return reply({ ok: true, private: 'omitted' })
  }
  assert.fail('Unexpected worker method: ' + method)
})
`
  await writeFile(worker, source, { mode: 0o700 })
  const manager = new WalletManagerRgb(SEED, {
    ...DEFAULTS, ...options, dataDir: dir, nativeExecutable: worker,
    nativeSha256: createHash('sha256').update(source).digest('hex')
  })
  t.after(async () => {
    try { await manager.shutdown() } finally { await rm(dir, { recursive: true, force: true }) }
  })
  return manager
}

test('offline open supports cached reads and gates address allocation on retryable indexer admission', async t => {
  const manager = await managerFor(t, { startupMode: 'offline' })
  const account = await manager.getAccount()
  assert.equal(account.getConnectionStatus(), 'offline')
  assert.equal(account.getInfo().ready, false)
  assert.equal(await account.getBalance(), 42n)
  await assert.rejects(account.getAddress(), { code: 'WALLET_OFFLINE' })
  await assert.rejects(account.getNewAddress(), { code: 'WALLET_OFFLINE' })
  await assert.rejects(account.blindReceive(), { code: 'WALLET_OFFLINE' })
  await assert.rejects(account.witnessReceive(), { code: 'WALLET_OFFLINE' })
  await assert.rejects(account.getNetworkInfo(), { code: 'WALLET_OFFLINE' })
  const id = 'offline-output-request'
  await assert.rejects(account.createUtxos({ operationId: id, count: 1, size: '1000', feeRate: '2' }), { code: 'WALLET_OFFLINE' })
  assert.equal(await account.getOperation(id), undefined)
  assert.throws(() => account.checkIndexerUrl('tcp://127.0.0.1:50002'), /configured/)
  assert.throws(() => account.checkProxyEndpoint('rpc://127.0.0.1:3004/json-rpc'), /configured/)
  assert.deepEqual(await account.checkIndexerUrl(), { ok: true, indexerProtocol: 'Electrum' })
  assert.deepEqual(await account.checkIndexerUrl(INDEXER + '/'), { ok: true, indexerProtocol: 'Electrum' })
  assert.deepEqual(await account.checkProxyEndpoint(PROXY), { ok: true })
  await assert.rejects(account.connect(), { code: 'INVALID_INDEXER' })
  assert.equal(account.getConnectionStatus(), 'offline')
  await account.connect()
  await account.connect()
  assert.equal(account.getConnectionStatus(), 'connected')
  assert.equal(account.getInfo().ready, true)
  assert.equal(await account.getAddress(), 'fixture-connected-address')
  assert.deepEqual(await account.getNetworkInfo(), { network: 'regtest', height: 0, blockHash: BLOCK_HASH })
  await assert.rejects(account.getNetworkInfo(), { code: 'NATIVE_PROTOCOL' })
  await manager.shutdown()
  assert.throws(() => account.getConnectionStatus(), { code: 'WALLET_CLOSED' })
})

test('offline open fails closed if the worker does not attest the network API', async t => {
  const manager = await managerFor(t, { startupMode: 'offline', nativeVersion: 0 })
  await assert.rejects(manager.getAccount(), { code: 'NATIVE_IDENTITY_MISMATCH' })
})

test('only isolated regtest fixture endpoints and matching authentication schemes are admitted', () => {
  for (const value of [
    'tcp://example.test:50001',
    'tcp://127.0.0.1:0',
    'tcp://@127.0.0.1:50001',
    'tcp://127.0.0.1:50001?',
    'tcp://127.0.0.1:50001#',
    'tcp://127.0.0.1:50001/path',
    'tcp://127.0.0.1:50001 ',
    'tcp://127.0.0.1:50001\\',
    'tcp://127.0.0.1'
  ]) {
    assert.throws(() => new WalletManagerRgb(SEED, { ...DEFAULTS, indexerUrl: value }), TypeError, value)
  }
  assert.throws(() => new WalletManagerRgb(SEED, { ...DEFAULTS, startupMode: 'retry' }), TypeError)
  assert.throws(() => new WalletManagerRgb(SEED, { ...DEFAULTS, proxyAuthKeys: { 'http://localhost': 'ab'.repeat(32) } }), TypeError)
})
