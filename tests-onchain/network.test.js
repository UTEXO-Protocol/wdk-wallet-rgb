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
const SIGNET_INDEXER = 'ssl://electrum.iriswallet.com:50033'
const PROXY = 'rpc://127.0.0.1:3003/json-rpc'
const BLOCK_HASH = 'ab'.repeat(32)
const DEFAULTS = {
  network: 'regtest',
  indexerUrl: INDEXER + '/',
  transportEndpoint: PROXY,
  maxFeeSats: '2000',
  authorize: () => assert.fail('Offline operations must not request transaction authorization')
}

async function managerFor (t, { nativeVersion = 2, ...options } = {}) {
  const network = options.network ?? DEFAULTS.network
  const mode = options.mode ?? 'rgb'
  const indexer = (options.indexerUrl ?? INDEXER).replace(/\/$/, '')
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
    overlayTree: '8d04178a740de8ed05cb597251ee162c6e9c8a79',
    integrationTree: '9c562a793e484c433a6a10ae58a6cd76c8a70b11'
  })
  if (method === 'open') {
    assert.equal(params.network, '${network}')
    assert.equal(params.mode, '${mode}')
    return reply({ network: params.network, watchOnly: true })
  }
  if (method === 'bindJournal') return reply({ written: true })
  if (method === 'goOnline') {
    assert.deepEqual(params, { indexerUrl: '${indexer}' })
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
    assert.notEqual(connectionAttempts, 1)
    return reply({ vanilla: { spendable: '42' } })
  }
  if (method === 'getFeeRate') {
    assert.equal(connectionAttempts, 2)
    return reply({ feeRate: { 2: '3900', 6: '1000', 12: '1.5' }[params.blocks] })
  }
  if (method === 'getNetworkInfo') {
    assert.equal(connectionAttempts, 2)
    return reply({
      network: '${network}', height: ++tipReads === 1 ? 123 : -1, blockHash: '${BLOCK_HASH}',
      ignored: true
    })
  }
  if (method === 'checkIndexerUrl') {
    assert.deepEqual(params, { url: '${indexer}' })
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
  assert.deepEqual(await account.getNetworkInfo(), { network: 'regtest', height: 123, blockHash: BLOCK_HASH })
  await assert.rejects(account.getNetworkInfo(), { code: 'NATIVE_PROTOCOL' })
  await manager.shutdown()
  assert.throws(() => account.getConnectionStatus(), { code: 'WALLET_CLOSED' })
})

test('offline open fails closed if the worker does not attest the network API', async t => {
  const manager = await managerFor(t, { startupMode: 'offline', nativeVersion: 1 })
  await assert.rejects(manager.getAccount(), { code: 'NATIVE_IDENTITY_MISMATCH' })
})

test('public Signet uses the pinned TLS endpoint and enables only Bitcoin operations', async t => {
  const manager = await managerFor(t, {
    network: 'signet', mode: 'btc-only', startupMode: 'offline', transportEndpoint: undefined,
    indexerUrl: SIGNET_INDEXER + '/', authorizeMessage: async () => true
  })
  const account = await manager.getAccount()
  assert.deepEqual(account.getInfo(), { ready: false, network: 'signet', protocol: 'BTC_L1', methods: [] })
  await assert.rejects(account.sync(), { code: 'WALLET_OFFLINE' })
  assert.throws(() => account.checkIndexerUrl('ssl://electrum.iriswallet.com:50034'), /approved TLS/)
  assert.deepEqual(await account.checkIndexerUrl(SIGNET_INDEXER), { ok: true, indexerProtocol: 'Electrum' })
  await assert.rejects(account.connect(), { code: 'INVALID_INDEXER' })
  await account.connect()
  assert.deepEqual(await account.sync(), { transfers: [] })
  await assert.rejects(account.estimateFeeResult(2), { code: 'FEE_UNAVAILABLE' })
  assert.deepEqual(await account.estimateFeeResult(6), { feeRate: '1000' })
  await assert.rejects(account.estimateFeeResult(12), { code: 'NATIVE_PROTOCOL' })
  assert.deepEqual(await account.getNetworkInfo(), { network: 'signet', height: 123, blockHash: BLOCK_HASH })
  assert.throws(() => account.refresh(), { code: 'RGB_MODE_UNAVAILABLE' })
  const address = await account.getMessageSigningAddress()
  assert.match(address, /^tb1p/)
  const signature = await account.signMessageBip322('public signet', address)
  assert.equal(await account.verifyMessageBip322('public signet', address, signature), true)
})

test('public Signet rejects RGB configuration, chain aliases and unapproved Electrum URLs', () => {
  const config = { ...DEFAULTS, network: 'signet', mode: 'btc-only', indexerUrl: SIGNET_INDEXER, transportEndpoint: undefined }
  for (const network of ['utexo', 'mainnet', 'testnet', 'testnet4']) {
    assert.throws(() => new WalletManagerRgb(SEED, { ...config, network }), /Unsupported Bitcoin network/)
  }
  for (const options of [
    { mode: 'rgb' }, { transportEndpoint: PROXY }, { evmRpcUrls: {} }, { proxyAuthKeys: {} }, { burnDestinationRoutes: [] }
  ]) {
    assert.throws(() => new WalletManagerRgb(SEED, { ...config, ...options }), /Bitcoin-only/)
  }
  for (const value of [
    'tcp://electrum.iriswallet.com:50033', 'ssl://127.0.0.1:50033', 'ssl://example.test:50033',
    'ssl://electrum.iriswallet.com:50034', SIGNET_INDEXER + '//', SIGNET_INDEXER + '?', SIGNET_INDEXER + '/rpc'
  ]) {
    assert.throws(() => new WalletManagerRgb(SEED, { ...config, indexerUrl: value }), /approved TLS/, value)
  }
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
