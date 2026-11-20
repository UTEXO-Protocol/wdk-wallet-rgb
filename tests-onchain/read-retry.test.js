import assert from 'node:assert/strict'
import test from 'node:test'
import { p2tr, TEST_NETWORK } from '@scure/btc-signer'
import { WalletAccountRgb } from '../onchain.js'

const assetId = 'rgb:read-retry-fixture'
const txid = 'a1'.repeat(32)
const psbtSha256 = 'b2'.repeat(32)
const address = p2tr(Uint8Array.from(Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')), undefined, { ...TEST_NETWORK, bech32: 'bcrt' }).address
const fault = code => Object.assign(new Error('Injected native failure'), { code })

async function fixture (request, initialRecords = []) {
  const calls = []
  const records = new Map(initialRecords.map(record => [record.id, record]))
  const worker = {
    available: true,
    async request (method, params) {
      calls.push({ method, params })
      if (method === 'goOnline') return {}
      return request(method, params, worker)
    },
    close () { worker.available = false }
  }
  const journal = {
    get: id => records.get(id),
    records: () => [...records.values()],
    assertAvailable () {},
    async save (record) { records.set(record.id, { ...record }) }
  }
  const account = new WalletAccountRgb(worker, {
    inspect: () => ({ txid, psbtSha256 }), sign: () => 'signed-test-plan', destroy () {}
  }, { network: 'regtest', mode: 'rgb', maxFeeSats: '1000', authorize: () => true }, journal, undefined, () => {})
  await account.connect()
  return { account, calls, records }
}

const getters = [
  ['getNetworkInfo', account => account.getNetworkInfo(), { network: 'regtest', height: 1, blockHash: 'cc'.repeat(32) }],
  ['getBtcBalance', account => account.getBtcBalance(), { vanilla: { spendable: '10000' } }],
  ['getAssetBalance', account => account.getAssetBalance(assetId), { spendable: '1' }],
  ['listAssets', account => account.listAssets(), []],
  ['listTransactions', account => account.getTransactions(), []],
  ['listUnspents', account => account.listUnspents(), []],
  ['listTransfers', account => account.listTransfers({ assetId, txid }), []],
  ['getFeeRate', account => account.estimateFeeResult(6), { feeRate: '2' }]
]

for (const [method, read, result] of getters) {
  test(`${method} retries one unavailable chain probe with the same immutable request`, async () => {
    let attempts = 0
    const f = await fixture((actualMethod) => {
      assert.equal(actualMethod, method)
      if (++attempts === 1) throw fault('INDEXER_UNAVAILABLE')
      return result
    })
    try {
      await read(f.account)
      const reads = f.calls.filter(call => call.method === method)
      assert.equal(reads.length, 2)
      assert.equal(reads[0].params, reads[1].params)
      if (reads[0].params !== undefined) assert(Object.isFrozen(reads[0].params))
      assert.equal(f.calls.filter(call => call.method === 'goOnline').length, 1)
    } finally { await f.account.shutdown() }
  })
}

test('an unavailable getter is bounded to two native attempts and returns the second failure', async () => {
  const first = fault('INDEXER_UNAVAILABLE')
  const second = fault('INDEXER_UNAVAILABLE')
  let attempts = 0
  const f = await fixture(() => { throw ++attempts === 1 ? first : second })
  try {
    await assert.rejects(f.account.getTransactions(), error => error === second)
    assert.equal(attempts, 2)
  } finally { await f.account.shutdown() }
})

for (const code of ['INVALID_INDEXER', 'WRONG_NETWORK', 'NATIVE_IDENTITY_MISMATCH', 'NATIVE_PROTOCOL', 'NATIVE_TIMEOUT', 'ETIMEDOUT', 'NATIVE_OPERATION_FAILED', undefined]) {
  test(`a getter does not retry ${code ?? 'an unclassified failure'}`, async () => {
    const error = fault(code)
    let attempts = 0
    const f = await fixture(() => { attempts++; throw error })
    try {
      await assert.rejects(f.account.getTransactions(), actual => actual === error)
      assert.equal(attempts, 1)
    } finally { await f.account.shutdown() }
  })
}

test('a wrong-chain response after the retry cannot pass the network getter', async () => {
  let attempts = 0
  const f = await fixture(() => {
    if (++attempts === 1) throw fault('INDEXER_UNAVAILABLE')
    return { network: 'mainnet', height: 1, blockHash: 'cc'.repeat(32) }
  })
  try {
    await assert.rejects(f.account.getNetworkInfo(), { code: 'NATIVE_PROTOCOL' })
    assert.equal(attempts, 2)
  } finally { await f.account.shutdown() }
})

test('closing the account between attempts prevents another native call', async () => {
  let closing
  let attempts = 0
  const f = await fixture(() => {
    attempts++
    closing = f.account.shutdown()
    throw fault('INDEXER_UNAVAILABLE')
  })
  await assert.rejects(f.account.getTransactions(), { code: 'WALLET_CLOSED' })
  await closing
  assert.equal(attempts, 1)
})

test('the busy owner is retained across both native attempts', async () => {
  const first = Promise.withResolvers()
  const retry = Promise.withResolvers()
  const releaseFirst = Promise.withResolvers()
  const releaseRetry = Promise.withResolvers()
  let attempts = 0
  const f = await fixture(async () => {
    if (++attempts === 1) {
      first.resolve()
      await releaseFirst.promise
      throw fault('INDEXER_UNAVAILABLE')
    }
    retry.resolve()
    await releaseRetry.promise
    return []
  })
  try {
    const pending = f.account.getTransactions()
    await first.promise
    await assert.rejects(f.account.listAssets(), { code: 'WALLET_BUSY' })
    releaseFirst.resolve()
    await retry.promise
    await assert.rejects(f.account.listUnspents(), { code: 'WALLET_BUSY' })
    releaseRetry.resolve()
    assert.deepEqual(await pending, [])
    assert.equal(attempts, 2)
  } finally { releaseFirst.resolve(); releaseRetry.resolve(); await f.account.shutdown() }
})

const excluded = [
  ['refresh', account => account.refresh()],
  ['refreshTransfers', account => account.refreshTransfers({ assetId })],
  ['sync', account => account.sync()],
  ['metadata', account => account.getAssetMetadata(assetId)],
  ['invoice decoding', account => account.decodeRgbInvoice('rgb:fixture')],
  ['blinded receive', account => account.blindReceive()],
  ['witness receive', account => account.witnessReceive()],
  ['invoice cancellation', account => account.cancelReceiveInvoice({ batchTransferIdx: 1, recipientId: 'recipient' })],
  ['NIA issuance', account => account.issueAssetNia({ operationId: 'read-retry-issue-nia', name: 'Test', ticker: 'TEST', precision: 0, amounts: ['1'] })],
  ['CFA issuance', account => account.issueAssetCfa({ operationId: 'read-retry-issue-cfa', name: 'Test', precision: 0, amounts: ['1'] })]
]

for (const [name, invoke] of excluded) {
  test(`${name} is not retried on INDEXER_UNAVAILABLE`, async () => {
    const error = fault('INDEXER_UNAVAILABLE')
    let attempts = 0
    const f = await fixture(() => { attempts++; throw error })
    try {
      await assert.rejects(invoke(f.account), actual => actual === error)
      assert.equal(attempts, 1)
    } finally { await f.account.shutdown() }
  })
}

for (const failedMethod of ['sendBtcBegin', 'sendBtcEnd']) {
  test(`${failedMethod} never replays an unavailable financial command`, async () => {
    const error = fault('INDEXER_UNAVAILABLE')
    const operationId = 'read-retry-' + failedMethod.toLowerCase()
    const f = await fixture((method, params, worker) => {
      if (method === 'snapshotUnsigned') return { reservations: [] }
      if (method === failedMethod) {
        worker.available = false
        throw error
      }
      if (method === 'sendBtcBegin') return { txid, psbt: 'unsigned-test-plan' }
      assert.fail('Unexpected native operation: ' + method)
    })
    try {
      await assert.rejects(f.account.sendBtc({ operationId, address, amount: 10000n, feeRate: 1n }), actual => actual === error)
      assert.equal(f.calls.filter(call => call.method === failedMethod).length, 1)
      assert.equal(f.calls.filter(call => call.method === 'goOnline').length, 1)
      assert.equal(f.records.get(operationId).stage, failedMethod === 'sendBtcEnd' ? 'submitting' : 'starting')
    } finally { await f.account.shutdown() }
  })
}
