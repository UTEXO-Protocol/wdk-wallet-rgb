import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { base64, hex } from '@scure/base'
import { WalletAccountRgb } from '../src/onchain-wallet.js'
import { OnchainJournal } from '../src/onchain-journal.js'
import { WalletRuntimeError } from '../src/onchain-runtime-error.js'
import { WebRgbProvider, burnDestinationFor, burnDestinationHash } from '../src/onchain-webrgb.js'

const ASSET = 'rgb:test-asset'
const OTHER_ASSET = 'rgb:private-asset'
const TXID = '21'.repeat(32)
const ROUTE = { chainId: 'eip155:42161', dstEid: 0 }
const OTHER_ROUTE = { chainId: 'eip155:1', dstEid: 30101 }
const RECIPIENT = { chainId: ROUTE.chainId, address: '0x' + '11'.repeat(20) }
const DESTINATION = burnDestinationFor(RECIPIENT, [ROUTE])
const REQUEST = { network: 'regtest', assetId: ASSET, amount: '123', burnRecipient: RECIPIENT, burnDestination: DESTINATION }
const METHODS = ['enable', 'getInfo', 'getAddress', 'blindReceive', 'witnessReceive', 'listAssets', 'getAssetBalance',
  'listTransfers', 'getTransferStatus', 'decodeRgbInvoice', 'burnAsset', 'getConsignment']
const INFO = { ready: true, protocol: 'RGB_L1', network: 'regtest', methods: ['burnAsset', 'getConsignment'],
  burnDestinationVersion: 1, burnDestinationRoutes: [ROUTE] }
const POLICY = { approvedAssetIds: [ASSET], approvedBurnAssetIds: [ASSET], burnDestinationRoutes: [ROUTE, OTHER_ROUTE] }

function provider (wallet, method, { identity, assertAuthorized = () => {}, confirm = () => true, policy = POLICY, methods = METHODS } = {}) {
  return new WebRgbProvider(wallet, {
    scope: {
      walletId: 'test-wallet', network: 'regtest', methods, assertAuthorized,
      identity: { topic: 'a'.repeat(64), id: 42, method: 'rgb_' + method, origin: 'https://bridge.example',
        fingerprint: 'c'.repeat(64), ...identity }
    },
    policy, confirm
  })
}

function proof () {
  const bytes = Uint8Array.of(82, 71, 66, 0, 84, 70, 82, 16)
  return { assetId: ASSET, txid: TXID, encoding: 'base64', data: base64.encode(bytes), byteLength: bytes.length,
    digest: { algorithm: 'keccak256', value: '0x' + hex.encode(keccak_256(bytes)) } }
}

function mockWallet () {
  const records = new Map()
  let submitted = 0
  let recovered = 0
  const wallet = {
    get submitted () { return submitted },
    get recovered () { return recovered },
    getInfo: () => INFO,
    getOperation: id => records.get(id),
    burnAsset (args) {
      args.assertAuthorized()
      assert.equal(records.has(args.operationId), false)
      submitted++
      records.set(args.operationId, {
        id: args.operationId, kind: 'rgb-burn', stage: 'submitting', txid: TXID,
        args: { assetId: args.assetId, amount: args.amount, feeRate: args.feeRate, minConfirmations: args.minConfirmations,
          commitment: burnDestinationHash(args.burnDestination) },
        burnRecipient: args.burnRecipient, webRgbBinding: args.webRgbBinding
      })
      return { ...args, txid: TXID }
    },
    recoverBurn (id) {
      assert.ok(records.has(id))
      recovered++
      return { txid: TXID, assetId: ASSET, burnDestination: DESTINATION, proof: proof() }
    },
    getConsignment ({ webRgbScopeKey }) {
      if (![...records.values()].some(row => row.webRgbBinding.scopeKey === webRgbScopeKey)) {
        throw new WalletRuntimeError('PROOF_UNAVAILABLE', 'internal location')
      }
      return proof()
    }
  }
  return wallet
}

test('advertises only the intersection of session grants, policy, and exact native V1 routes', async () => {
  const wallet = mockWallet()
  const info = await provider(wallet, 'getInfo').getInfo()
  assert.equal(info.protocol, 'RGB_L1')
  assert.deepEqual(info.methods, ['enable', 'getInfo', 'burnAsset', 'getConsignment'])
  assert.deepEqual(info.burnDestinationRoutes, [ROUTE])
  assert.deepEqual(info.burnRecipientNamespaces, ['eip155'])

  const { methods, burnDestinationVersion } = await provider(wallet, 'getInfo', { methods: ['getInfo', 'burnAsset'] }).getInfo()
  assert.deepEqual(methods, ['getInfo'])
  assert.equal(burnDestinationVersion, undefined)

  assert.throws(() => provider(wallet, 'getInfo', { identity: { origin: 'https://bridge.example/path' } }), { code: 'INVALID_PARAMS' })
  await assert.rejects(provider(wallet, 'getInfo', { assertAuthorized: async () => {} }).getInfo(), { code: 'NOT_ENABLED' })
  await assert.rejects(provider(wallet, 'getInfo').burnAsset(REQUEST), { code: 'INVALID_PARAMS' })
})

test('blocks request ID reuse with changed amount or fingerprint and recovers the original without resubmitting', async () => {
  const wallet = mockWallet()
  let approvals = 0
  const instance = provider(wallet, 'burnAsset', { confirm: approval => {
    approvals++
    assert.equal(approval.origin, 'https://bridge.example')
    assert.deepEqual(approval.params.burnDestination, DESTINATION)
    assert.equal(approval.params.minConfirmations, 6)
    assert.ok(Object.isFrozen(approval.params))
    return true
  } })
  await assert.rejects(instance.burnAsset({ ...REQUEST, burnDestination: { ...DESTINATION, dstEid: 1 } }), { code: 'INVALID_PARAMS' })
  assert.equal(approvals, 0)
  const burned = await instance.burnAsset({ ...REQUEST, minConfirmations: 3 })
  assert.equal(burned.txid, TXID)
  await assert.rejects(instance.burnAsset(REQUEST), { code: 'INTERNAL_ERROR' })
  await assert.rejects(instance.burnAsset({ ...REQUEST, amount: '124' }), { code: 'INVALID_PARAMS' })
  const changedFingerprint = provider(wallet, 'burnAsset', { identity: { fingerprint: 'd'.repeat(64) } })
  await assert.rejects(changedFingerprint.burnAsset(REQUEST), { code: 'INVALID_PARAMS' })
  await assert.rejects(changedFingerprint.recoverBurn(REQUEST), { code: 'INVALID_PARAMS' })
  const otherScope = provider(wallet, 'burnAsset', { identity: { topic: 'e'.repeat(64) } })
  await assert.rejects(otherScope.recoverBurn(REQUEST), { code: 'INTERNAL_ERROR' })
  assert.deepEqual(await provider(wallet, 'burnAsset').recoverBurn(REQUEST), burned)
  assert.equal(wallet.submitted, 1)
  assert.equal(wallet.recovered, 1)
  assert.equal(approvals, 1)
})

test('proof disclosure requires confirmation and a matching burn origin and topic', async () => {
  const wallet = mockWallet()
  await provider(wallet, 'burnAsset').burnAsset(REQUEST)
  const args = { assetId: ASSET, txid: TXID }
  await assert.rejects(provider(wallet, 'getConsignment', { confirm: () => false }).getConsignment(args), { code: 'USER_REJECTED' })
  await assert.rejects(provider(wallet, 'getConsignment', { identity: { origin: 'https://other.example' } }).getConsignment(args), {
    code: 'INTERNAL_ERROR', message: 'The wallet could not complete this request'
  })
  assert.deepEqual(await provider(wallet, 'getConsignment').getConsignment(args), proof())
  wallet.getConsignment = () => ({ ...proof(), byteLength: proof().byteLength + 1 })
  await assert.rejects(provider(wallet, 'getConsignment').getConsignment(args), { code: 'INTERNAL_ERROR' })
})

test('rejects revoked approvals and projects only explicitly allowed public asset and transfer fields', async () => {
  const wallet = mockWallet()
  let active = true
  const assertAuthorized = () => { if (!active) throw new Error('private grant detail') }
  await assert.rejects(provider(wallet, 'burnAsset', {
    assertAuthorized, confirm: async () => { active = false; return true }
  }).burnAsset(REQUEST), { code: 'NOT_ENABLED', message: 'Wallet session is no longer authorized' })
  assert.equal(wallet.submitted, 0)

  wallet.listAssets = () => [
    { assetId: ASSET, name: 'Token', schema: 'Bfa', ticker: 'TOK', precision: 6, path: '/private' },
    { assetId: OTHER_ASSET, name: 'Other', schema: 'Nia', precision: 6 }
  ]
  wallet.listTransfers = ({ assetId }) => {
    assert.equal(assetId, ASSET)
    return [{ idx: 1, status: 'WaitingConfirmations', kind: 'Burn', txid: TXID, recipientId: 'private-recipient',
      invoice: 'private-invoice', assignments: [{ fungible: '999' }], requestedAssignment: { fungible: '123' } }]
  }
  wallet.getAssetBalance = () => ({ spendable: '9007199254740992' })
  assert.deepEqual(await provider(wallet, 'listAssets').listAssets(), [{ id: ASSET, name: 'Token', schema: 'bfa', ticker: 'TOK', precision: 6 }])
  const transfers = await provider(wallet, 'listTransfers').listTransfers()
  assert.deepEqual(transfers, [{ assetId: ASSET, transferId: 1, status: 'WaitingConfirmations', kind: 'Burn',
    txid: TXID, amount: 123, amountBaseUnits: '123' }])
  await assert.rejects(provider(wallet, 'listTransfers').listTransfers(OTHER_ASSET), { code: 'ASSET_NOT_FOUND' })
  await assert.rejects(provider(wallet, 'getAssetBalance').getAssetBalance(ASSET), { code: 'INTERNAL_ERROR' })
})

for (const revokedStage of ['starting', 'submitting']) {
  test('durable session fence rejects a burn revoked while journaling ' + revokedStage, async () => {
    let active = true
    const records = new Map()
    const methods = []
    const journal = {
      get: id => records.get(id),
      assertAvailable () {},
      save (record) {
        records.set(record.id, { ...record })
        if (record.stage === revokedStage) active = false
      }
    }
    const worker = {
      available: true,
      request (method) {
        methods.push(method)
        if (method === 'goOnline') return {}
        if (method === 'snapshotUnsigned') return { reservations: [] }
        if (method === 'burnBegin') return { txid: TXID, psbt: 'irrelevant' }
        if (method === 'discardPrepared') return {}
        assert.fail('Unexpected native method: ' + method)
      }
    }
    const signer = {
      inspect: () => ({ txid: TXID, psbtSha256: '3'.repeat(64) }),
      sign: () => 'signed'
    }
    const account = new WalletAccountRgb(worker, signer, {
      network: 'regtest', routes: [ROUTE], maxFeeSats: '1234', authorize: () => true
    }, journal)
    await account.connect()
    methods.length = 0
    const web = provider(account, 'burnAsset', { assertAuthorized: () => { if (!active) throw new Error('revoked') } })
    await assert.rejects(web.burnAsset(REQUEST), { code: 'NOT_ENABLED' })
    assert.deepEqual(methods, revokedStage === 'starting' ? ['snapshotUnsigned'] : ['snapshotUnsigned', 'burnBegin', 'discardPrepared'])
    const [record] = [...records.values()]
    assert.equal(record.stage, 'declined')
    assert.match(record.webRgbBinding.scopeKey, /^[a-f0-9]{64}$/)
    assert.match(record.webRgbBinding.requestKey, /^[a-f0-9]{64}$/)
  })
}

test('WebRGB invoice retries disclose only the exact still-authorized allocation after restart', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'wdk-webrgb-invoice-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let allocations = 0
  let approvals = 0
  let authorized = true
  let loseReply = false
  const worker = {
    available: true,
    request (method, params) {
      if (method === 'goOnline') return {}
      assert.ok(['blindReceive', 'witnessReceive'].includes(method))
      allocations++
      if (loseReply) throw new WalletRuntimeError('NATIVE_TIMEOUT', 'Response lost')
      authorized = false
      return { invoice: 'rgb:invoice-' + allocations, recipientId: 'recipient-' + allocations,
        expirationTimestamp: params.expirationTimestamp }
    },
    close () {}
  }
  const newWallet = async () => {
    const journal = new OnchainJournal(dir)
    const invoices = new OnchainJournal(dir, { invoices: true })
    await journal.bind('wallet')
    await invoices.bind('wallet')
    const wallet = new WalletAccountRgb(worker, { destroy () {} }, {
      network: 'regtest', routes: [], transportEndpoint: 'rpc://127.0.0.1:49090/json-rpc'
    }, journal, invoices)
    await wallet.connect()
    return { journal, wallet }
  }
  const first = await newWallet()
  const args = { assetId: ASSET, amount: 12 }
  const options = {
    assertAuthorized () { if (!authorized) throw new Error('Wallet locked') },
    confirm () { approvals++; return true }
  }
  await assert.rejects(provider(first.wallet, 'blindReceive', options).blindReceive(args), { code: 'NOT_ENABLED' })
  await first.wallet.shutdown()
  authorized = true
  const second = await newWallet()
  t.after(() => second.wallet.shutdown())
  const receive = provider(second.wallet, 'blindReceive', options)
  const original = await receive.blindReceive(args)
  assert.equal(original.invoice, 'rgb:invoice-1')
  assert.deepEqual(await receive.blindReceive(args), original)
  await assert.rejects(receive.blindReceive({ ...args, amount: 13 }), { code: 'INVALID_PARAMS' })
  await assert.rejects(provider(second.wallet, 'witnessReceive', options).witnessReceive(args), { code: 'INVALID_PARAMS' })
  assert.equal(allocations, 1)
  assert.equal(approvals, 1)

  loseReply = true
  const uncertain = provider(second.wallet, 'blindReceive', { ...options, identity: { id: 43 } })
  await assert.rejects(uncertain.blindReceive(args), { code: 'INTERNAL_ERROR' })
  loseReply = false
  await assert.rejects(uncertain.blindReceive(args), { code: 'INTERNAL_ERROR' })
  assert.equal(allocations, 2)
  assert.equal(approvals, 2)
  await second.journal.assertAvailable()
})
