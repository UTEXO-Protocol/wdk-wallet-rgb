// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WalletManagerRgb } from '../onchain.js'
import devServices from '../src/onchain-dev-services.json' with { type: 'json' }

const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1)
const INDEXER = 'tcp://127.0.0.1:50001'
const SIGNET_INDEXER = 'ssl://electrum.iriswallet.com:50033'
const PROXY = 'rpc://127.0.0.1:3003/json-rpc'
const STAGING_PROXY = 'rpcs://staging.rgb-proxy.utexo.com/json-rpc'
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc'
const STAGING = {
  network: 'signet', mode: 'rgb', profile: 'staging', indexerUrl: SIGNET_INDEXER,
  transportEndpoint: STAGING_PROXY, evmRpcUrls: { 42161: ARBITRUM_RPC }
}
const DEV = {
  network: 'signet', mode: 'rgb', profile: 'dev', indexerUrl: devServices.indexerUrl,
  transportEndpoint: devServices.proxyEndpoint, evmRpcUrls: { 42161: devServices.arbitrumRpc }
}
const DIRECT_ARBITRUM = { chainId: 'eip155:42161', dstEid: 0 }
const BLOCK_HASH = 'ab'.repeat(32)
const DEFAULTS = {
  network: 'regtest',
  indexerUrl: INDEXER + '/',
  transportEndpoint: PROXY,
  maxFeeSats: '2000',
  authorize: () => assert.fail('Offline operations must not request transaction authorization')
}

async function managerFor (t, {
  nativeVersion = 4, workerIndexerProtocol, Manager = WalletManagerRgb, receivedMint = null, ...options
} = {}) {
  const network = options.network ?? DEFAULTS.network
  const mode = options.mode ?? 'rgb'
  const indexer = (options.indexerUrl ?? INDEXER).replace(/\/$/, '')
  const expectedOnline = { indexerUrl: indexer, ...(options.evmRpcUrls && { evmRpcUrls: options.evmRpcUrls }) }
  const proxy = options.transportEndpoint ?? PROXY
  const protocol = workerIndexerProtocol ?? (options.profile === 'dev' ? 'Esplora' : 'Electrum')
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
    indexer: 'electrum-and-dev-esplora', runtime: 'node-host-process',
    source: '5010eefa355beb9c42a4c1b69883f7651241a111',
    overlayTree: '2b9bf63482d8a472492d065d3edd260e0fa418ac',
    integrationTree: '168fd88d5f1d3e99a34c03e781689d9b2acceb14'
  })
  if (method === 'open') {
    assert.equal(params.network, '${network}')
    assert.equal(params.mode, '${mode}')
    assert.equal(params.profile, ${JSON.stringify(options.profile)})
    return reply({ network: params.network, profile: params.profile, watchOnly: true })
  }
  if (method === 'bindJournal') return reply({ written: true })
  if (method === 'goOnline') {
    assert.deepEqual(params, ${JSON.stringify(expectedOnline)})
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
  if (method === 'getReceivedMint') return reply(${JSON.stringify(receivedMint)})
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
    return reply({ ok: true, indexerProtocol: ${JSON.stringify(protocol)}, private: 'omitted' })
  }
  if (method === 'checkProxyEndpoint') {
    assert.deepEqual(params, { url: '${proxy}' })
    return reply({ ok: true, private: 'omitted' })
  }
  assert.fail('Unexpected worker method: ' + method)
})
`
  await writeFile(worker, source, { mode: 0o700 })
  const manager = new Manager(SEED, {
    ...DEFAULTS, ...options, dataDir: dir, nativeExecutable: worker,
    nativeSha256: createHash('sha256').update(source).digest('hex')
  })
  t.after(async () => {
    try { await manager.shutdown() } finally { await rm(dir, { recursive: true, force: true }) }
  })
  return manager
}

async function enabledDevFixtureManager () {
  const fixtureModule = new URL('../src/onchain-wallet.js?dev-enabled-fixture', import.meta.url).href
  const servicesModule = new URL('../src/onchain-dev-services.json', import.meta.url).href
  const servicesFixture = 'data:application/json,' + encodeURIComponent(JSON.stringify({ ...devServices, enabled: true }))
  const hooks = registerHooks({
    resolve (specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      if (context.parentURL === fixtureModule && resolved.url === servicesModule) {
        return { ...resolved, url: servicesFixture, shortCircuit: true }
      }
      return resolved
    }
  })
  try { return (await import(fixtureModule)).WalletManagerRgb } finally { hooks.deregister() }
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

test('received mints carry a distinct EVM lock identifier and reject a missing lock', async t => {
  const mint = {
    opid: '12'.repeat(32), lockId: '34'.repeat(32), amount: '1000', beforeBlock: '180',
    evmChainId: '31337', bridgeContract: '0x' + '56'.repeat(20)
  }
  const valid = await managerFor(t, { startupMode: 'offline', receivedMint: mint })
  assert.deepEqual(await (await valid.getAccount()).getReceivedMint('fixture-recipient'), mint)
  const invalid = await managerFor(t, { startupMode: 'offline', receivedMint: { ...mint, lockId: undefined } })
  await assert.rejects((await invalid.getAccount()).getReceivedMint('fixture-recipient'), { code: 'NATIVE_PROTOCOL' })
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

test('explicit staging opens a public Signet RGB account with the exact staged services', async t => {
  const manager = await managerFor(t, { ...STAGING, startupMode: 'offline' })
  const account = await manager.getAccount()
  const info = account.getInfo()
  assert.equal(info.network, 'signet')
  assert.equal(info.protocol, 'RGB_L1')
  assert.equal(info.ready, false)
  assert.ok(info.methods.includes('witnessReceive'))
  assert.ok(!info.methods.includes('burnAsset'))
  assert.equal(info.burnDestinationRoutes, undefined)
  assert.throws(() => account.checkProxyEndpoint(PROXY), /configured/)
  assert.deepEqual(await account.checkProxyEndpoint(), { ok: true })
  await assert.rejects(account.connect(), { code: 'INVALID_INDEXER' })
  await account.connect()
  assert.equal(account.getInfo().ready, true)
})

test('staging advertises a V1 burn route only when the exact direct Arbitrum route is configured', async t => {
  const routes = [{ chainId: 'eip155:42161', dstEid: 0 }]
  const manager = await managerFor(t, { ...STAGING, startupMode: 'offline', burnDestinationRoutes: routes })
  const info = (await manager.getAccount()).getInfo()
  assert.ok(info.methods.includes('burnAsset'))
  assert.ok(info.methods.includes('getConsignment'))
  assert.equal(info.burnDestinationVersion, 1)
  assert.deepEqual(info.burnDestinationRoutes, routes)
  assert.deepEqual(info.burnRecipientNamespaces, ['eip155'])
})

test('staging rejects unqualified service, profile and payout combinations', () => {
  for (const options of [
    { profile: undefined }, { profile: 'dev' }, { network: 'regtest' }, { network: 'utexo' }, { mode: 'btc-only' },
    { indexerUrl: INDEXER }, { transportEndpoint: PROXY }, { transportEndpoint: STAGING_PROXY + '?' },
    { transportEndpoint: 'rpcs://rgb-proxy.utexo.com/json-rpc' },
    { transportEndpoint: 'rpcs://x@staging.rgb-proxy.utexo.com/json-rpc' },
    { proxyAuthKeys: {} }, { evmRpcUrls: undefined }, { evmRpcUrls: { 42161: ARBITRUM_RPC + '/' } },
    { evmRpcUrls: { 42161: 'http://arb1.arbitrum.io/rpc' } }, { evmRpcUrls: { 42161: 'https://x@arb1.arbitrum.io/rpc' } },
    { evmRpcUrls: { 42161: ARBITRUM_RPC, 1: ARBITRUM_RPC } }, { evmRpcUrls: { 1: ARBITRUM_RPC } },
    { burnDestinationRoutes: [{ chainId: 'eip155:1', dstEid: 30101 }] },
    { burnDestinationRoutes: [{ chainId: 'eip155:42161', dstEid: 30110 }] }
  ]) {
    assert.throws(() => new WalletManagerRgb(SEED, { ...DEFAULTS, ...STAGING, ...options }), TypeError, JSON.stringify(options))
  }
})

test('the packaged Dev profile stays disabled with its exact pinned endpoints', () => {
  assert.deepEqual(devServices, {
    enabled: false,
    indexerUrl: 'https://dev.esplora-01.mint.utexo.com',
    proxyEndpoint: 'rpcs://dev.rgb-proxy.utexo.com/json-rpc',
    arbitrumRpc: ARBITRUM_RPC
  })
  assert.throws(() => new WalletManagerRgb(SEED, { ...DEFAULTS, ...DEV }), /Dev Signet hosted access is disabled/)
})

test('the Dev candidate uses only Esplora and advertises only direct Arbitrum', async t => {
  const manager = await managerFor(t, {
    ...DEV, Manager: await enabledDevFixtureManager(), indexerUrl: DEV.indexerUrl + '/',
    startupMode: 'offline', burnDestinationRoutes: [DIRECT_ARBITRUM]
  })
  const account = await manager.getAccount()
  assert.equal(account.getInfo().ready, false)
  assert.equal(account.getInfo().network, 'signet')
  assert.deepEqual(account.getInfo().burnDestinationRoutes, [DIRECT_ARBITRUM])
  assert.deepEqual(await account.checkIndexerUrl(DEV.indexerUrl), { ok: true, indexerProtocol: 'Esplora' })
  assert.deepEqual(await account.checkIndexerUrl(DEV.indexerUrl + '/'), { ok: true, indexerProtocol: 'Esplora' })
  assert.throws(() => account.checkIndexerUrl(SIGNET_INDEXER), /approved HTTPS Esplora/)
  assert.deepEqual(await account.checkProxyEndpoint(), { ok: true })
  assert.throws(() => account.checkProxyEndpoint(STAGING_PROXY), /configured/)
  await assert.rejects(account.connect(), { code: 'INVALID_INDEXER' })
  await account.connect()
  assert.equal(account.getInfo().ready, true)
  assert.deepEqual(await account.getNetworkInfo(), { network: 'signet', height: 123, blockHash: BLOCK_HASH })
})

test('the Dev candidate rejects alternate services, credentials, routes and native protocol', async t => {
  const Manager = await enabledDevFixtureManager()
  for (const override of [
    { profile: undefined }, { profile: 'staging' }, { network: 'regtest' }, { network: 'utexo' }, { mode: 'btc-only' },
    { indexerUrl: SIGNET_INDEXER }, { indexerUrl: DEV.indexerUrl.replace('https:', 'http:') },
    { indexerUrl: DEV.indexerUrl + '?' }, { indexerUrl: DEV.indexerUrl + '//' },
    { transportEndpoint: STAGING_PROXY }, { transportEndpoint: DEV.transportEndpoint + '?' },
    { proxyAuthKeys: {} }, { bitcoindAuth: { username: 'x', password: 'y' } },
    { evmRpcUrls: {} }, { evmRpcUrls: { 42161: DEV.evmRpcUrls[42161] + '/' } },
    { evmRpcUrls: { ...DEV.evmRpcUrls, 1: ARBITRUM_RPC } },
    { burnDestinationRoutes: [DIRECT_ARBITRUM, DIRECT_ARBITRUM] },
    { burnDestinationRoutes: [{ chainId: 'eip155:42161', dstEid: 30101 }] },
    { burnDestinationRoutes: [{ chainId: 'eip155:1', dstEid: 30101 }] }
  ]) {
    assert.throws(() => new Manager(SEED, { ...DEFAULTS, ...DEV, ...override }), TypeError, JSON.stringify(override))
  }
  const manager = await managerFor(t, {
    ...DEV, Manager, startupMode: 'offline', workerIndexerProtocol: 'Electrum'
  })
  const account = await manager.getAccount()
  assert.equal(account.getInfo().burnDestinationRoutes, undefined)
  await assert.rejects(account.checkIndexerUrl(), { code: 'NATIVE_PROTOCOL' })
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
