import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { burnDestinationFor, burnDestinationHash, createBurnPackage, WalletAccountRgb, WalletManagerRgb } from '../onchain.js'
import { OnchainJournal } from '../src/onchain-journal.js'
import { OnchainWorker } from '../src/onchain-worker.js'
import { WebRgbProvider } from '../src/onchain-webrgb.js'

const routes = [
  { chainId: 'eip155:42161', dstEid: 0 },
  { chainId: 'eip155:1', dstEid: 30101 },
  { chainId: 'eip155:137', dstEid: 30109 },
  { chainId: 'eip155:9745', dstEid: 30383 },
  { chainId: 'tron:728126428', dstEid: 30420 }
]

async function scratch (t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'wdk-onchain-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('matches independent go-ethereum bridge vectors and exports the V1 proof package', async () => {
  const { vectors } = JSON.parse(await readFile(new URL('./fixtures/bridge-burn-destination-vectors.json', import.meta.url)))
  for (const vector of vectors) {
    const { version, destinationChainId, dstEid, recipient } = vector
    assert.equal('0x' + burnDestinationHash({ version, destinationChainId, dstEid, recipient }), vector.hash)
  }
  const address = '0x2222222222222222222222222222222222222222'
  for (const route of routes.slice(0, -1)) {
    const destination = burnDestinationFor({ chainId: route.chainId, address }, routes)
    assert.equal(destination.dstEid, route.dstEid)
    assert.equal(destination.recipient, address)
  }
  assert.throws(() => burnDestinationFor({ chainId: 'eip155:1', address }, [routes[0]]), /route/)
  const tron = burnDestinationFor({
    chainId: 'tron:728126428',
    address: 'TEdvoHEatmDKvTh3o9vBRB9Vdtbhn4QFhy'
  }, routes)
  assert.equal('0x' + burnDestinationHash(tron), vectors.find(vector => vector.name === 'layerzero-21-byte-recipient').hash)
  assert.throws(() => burnDestinationFor({ chainId: 'tron:728126428', address }, routes), /Tron/)
  const destination = burnDestinationFor({ chainId: 'eip155:1', address }, routes)
  const proof = Buffer.from('RGB\0TFRx')
  const payload = JSON.parse(createBurnPackage(proof, destination))
  assert.deepEqual(payload, {
    format: 'utexo-burn',
    version: 1,
    consignment: { encoding: 'base64', byteLength: proof.length, data: proof.toString('base64') },
    burnDestination: destination
  })
  assert.throws(() => createBurnPackage(Buffer.from('wrong'), destination))
})

test('journal preserves unknown submission across reopen and refuses cross-wallet use', async t => {
  const dir = await scratch(t)
  const id = 'burn-20261103-test-01'
  const journal = new OnchainJournal(dir)
  await journal.bind('wallet-a')
  assert.equal(await journal.get(id), undefined)
  await journal.save({ id, stage: 'starting' })
  await journal.save({ id, stage: 'submitting', txid: 'ab'.repeat(32) })

  const reopened = new OnchainJournal(dir)
  await reopened.bind('wallet-a')
  await assert.rejects(reopened.assertAvailable(), { code: 'OPERATION_UNRESOLVED' })
  assert.equal((await reopened.get(id)).stage, 'submitting')
  await assert.rejects(reopened.bind('wallet-b'), { code: 'WALLET_IDENTITY_MISMATCH' })
  await assert.rejects(reopened.get('../../tmp/bad-file'), /stable, unique operation ID/)
})

test('worker rejects unpinned binaries and mismatched response identifiers', async t => {
  const dir = await scratch(t)
  const file = join(dir, 'worker')
  const source = `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'wrong') request.id += 'x'
  process.stdout.write(JSON.stringify({ id: request.id, result: request.params }) + '\\n')
})
`
  await writeFile(file, source, { mode: 0o700 })
  await assert.rejects(OnchainWorker.start(file, '0'.repeat(64)), { code: 'NATIVE_IDENTITY_MISMATCH' })
  const worker = await OnchainWorker.start(file, createHash('sha256').update(source).digest('hex'))
  try {
    assert.deepEqual(await worker.request('echo', { a: 1 }), { a: 1 })
    await assert.rejects(worker.request('wrong'), { code: 'NATIVE_PROTOCOL' })
    await assert.rejects(worker.request('echo'), { code: 'NATIVE_PROTOCOL' })
  } finally {
    await worker.close()
  }
})

test('manager requires a loopback fixture profile and owns a copied seed', async () => {
  const seed = Uint8Array.from({ length: 64 }, (_, i) => i + 1)
  const config = {
    network: 'regtest',
    indexerUrl: 'tcp://127.0.0.1:50001',
    transportEndpoint: 'rpc://127.0.0.1:3003/json-rpc',
    maxFeeSats: '2000',
    authorize: () => false,
    burnDestinationRoutes: routes
  }
  assert.throws(() => new WalletManagerRgb(seed, { ...config, network: 'signet' }), /isolated regtest/)
  assert.throws(() => new WalletManagerRgb(seed, { ...config, indexerUrl: 'ssl://example.com:50002' }), /loopback/)
  assert.throws(() => new WalletManagerRgb(seed, { ...config, burnDestinationRoutes: [{ chainId: 'eip155:1', dstEid: 0 }] }), /route/)
  assert.throws(() => new WalletManagerRgb(seed, { ...config, mode: 'btc-only' }), /does not accept RGB/)
  assert.throws(() => new WalletManagerRgb(seed, { ...config, mode: null }), /Invalid wallet mode/)
  const manager = new WalletManagerRgb(seed, config)
  assert.equal(manager.seed, undefined)
  assert.deepEqual(seed, Uint8Array.from({ length: 64 }, (_, i) => i + 1))
  await manager.dispose()
  await assert.rejects(manager.getAccount(), { code: 'WALLET_CLOSED' })
})

test('journal storage mode is durable and legacy identity stays RGB', async t => {
  const dir = await scratch(t)
  for (const invoices of [false, true]) {
    const journal = new OnchainJournal(dir, { invoices })
    await journal.bind('wallet-a', 'btc-only')
    const reopened = new OnchainJournal(dir, { invoices })
    await reopened.bind('wallet-a', 'btc-only')
    await assert.rejects(reopened.bind('wallet-a'), { code: 'WALLET_MODE_MISMATCH' })
  }
  const legacy = await scratch(t)
  await mkdir(join(legacy, '.wdk-onchain-journal-v1'), { mode: 0o700 })
  await writeFile(join(legacy, '.wdk-onchain-journal-v1', 'identity.json'), '{"identity":"legacy"}\n', { mode: 0o600 })
  const journal = new OnchainJournal(legacy)
  await journal.bind('legacy', 'rgb')
  await assert.rejects(journal.bind('legacy', 'btc-only'), { code: 'WALLET_MODE_MISMATCH' })
})

test('a BTC-only restore can read vanilla BTC but has no RGB or WebRGB mutation authority', async () => {
  const calls = []
  const worker = {
    available: true,
    request (method) {
      calls.push(method)
      if (method === 'goOnline') return {}
      if (method === 'getAddress') return { address: 'fixture-address' }
      if (method === 'getBtcBalance') return { vanilla: { spendable: '15000' }, colored: { settled: '9000', future: '9000', spendable: '9000' } }
      assert.fail('Unexpected native call: ' + method)
    }
  }
  const journal = { records: () => [], get: () => undefined }
  const account = new WalletAccountRgb(worker, {}, { network: 'regtest', mode: 'btc-only' }, journal, journal)
  await account.connect()
  assert.deepEqual(account.getInfo(), { ready: true, network: 'regtest', protocol: 'BTC_L1', methods: [] })
  assert.equal(await account.getAddress(), 'fixture-address')
  assert.equal(await account.getBalance(), 15000n)
  assert.deepEqual((await account.getBalanceDetails()).colored, { settled: '9000', future: '9000', spendable: '0' })
  const operationId = 'btc-only-blocked-rgb'
  const plan = { operationId, count: 2, size: 1000n, feeRate: 2n, psbtSha256: '11'.repeat(32) }
  for (const operation of [
    () => account.checkProxyEndpoint(),
    () => account.refresh(),
    () => account.registerAssetContract({}),
    () => account.blindReceive(),
    () => account.witnessReceive(),
    () => account.createUtxos(plan),
    () => account.prepareCreateUtxos(plan),
    () => account.commitPreparedCreateUtxos(plan),
    () => account.cancelCreateUtxosPlan(plan),
    () => account.recoverCreateUtxos(operationId),
    () => account.sendRgbInvoice({ operationId, invoice: 'rgb:fixture' }),
    () => account.burnAsset({}),
    () => account.recoverBurn(operationId),
    () => account.getConsignment({ assetId: 'rgb:fixture', txid: '22'.repeat(32) }),
    () => account.receiveWebRgbInvoice({ operationId, method: 'witnessReceive', requestKey: '33'.repeat(32),
      assertAuthorized: () => assert.fail('Unexpected authorization check'), approve: () => assert.fail('Unexpected approval') })
  ]) {
    await assert.rejects(async () => operation(), { code: 'RGB_MODE_UNAVAILABLE' })
  }
  const provider = new WebRgbProvider(account, {
    scope: {
      walletId: 'test-wallet', network: 'regtest', methods: ['enable'], assertAuthorized () {},
      identity: { origin: 'https://bridge.example', topic: 'ab'.repeat(32), id: 1, method: 'rgb_enable', fingerprint: 'cd'.repeat(32) }
    },
    confirm: () => assert.fail('Unexpected bridge approval')
  })
  await assert.rejects(provider.enable(), { code: 'NOT_ENABLED' })
  assert.deepEqual(calls, ['goOnline', 'getAddress', 'getBtcBalance', 'getBtcBalance'])
})

test('the WDK policy view has no spend, address allocation or post-close authority', async () => {
  const txid = 'ab'.repeat(32)
  const transaction = { txid, fee: '130', confirmationTime: null }
  let addresses = 0
  const worker = {
    request (method) {
      if (method === 'goOnline') return {}
      if (method === 'getAddress') return { address: 'test-address-' + ++addresses }
      if (method === 'getBtcBalance') return { vanilla: { spendable: '9007199254740993' } }
      if (method === 'listTransactions') return [transaction]
      assert.fail('Unexpected native call: ' + method)
    },
    close () {}
  }
  const account = new WalletAccountRgb(worker, { destroy () {} }, {}, {})
  const view = await account.toReadOnlyAccount()
  assert.ok(Object.isFrozen(view))
  assert.equal(view.sendBtc, undefined)
  assert.equal(view.getNewAddress, undefined)
  assert.equal(view.dispose, undefined)
  await assert.rejects(view.getAddress(), { code: 'ADDRESS_UNALLOCATED' })
  assert.equal(addresses, 0)
  await account.connect()
  assert.equal(await account.getAddress(), await view.getAddress())
  assert.equal(await view.getBalance(), 9007199254740993n)
  assert.equal(await view.getTransactionReceipt(txid), null)
  assert.deepEqual(await view.getTransaction(txid), { hash: txid, finality: 'pending', fee: 130n })
  transaction.confirmationTime = { height: 120, timestamp: '1790000000' }
  assert.deepEqual(await account.waitForTransaction(txid), { hash: txid, finality: 'confirmed', block: 120, success: true, fee: 130n })
  assert.equal(await view.getTransactionReceipt(txid), transaction)
  await assert.rejects(view.getTransaction('ff'.repeat(32)), { name: 'NoSuchElementError' })
  await account.shutdown()
  await assert.rejects(view.getAddress(), { code: 'WALLET_CLOSED' })
  await assert.rejects(view.getBalance(), { code: 'WALLET_CLOSED' })
})
