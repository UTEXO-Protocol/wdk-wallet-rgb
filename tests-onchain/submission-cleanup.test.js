import assert from 'node:assert/strict'
import test from 'node:test'
import { p2tr, TEST_NETWORK } from '@scure/btc-signer'
import { WalletAccountRgb } from '../onchain.js'

const txid = 'a1'.repeat(32)
const psbtSha256 = 'b2'.repeat(32)
const operationId = 'output-submission-cleanup-001'
const address = p2tr(Uint8Array.from(Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')), undefined, { ...TEST_NETWORK, bech32: 'bcrt' }).address
const fault = Object.assign(new Error('Injected submission failure'), { code: 'TEST_FAILURE' })

async function fixture (options = {}) {
  const records = new Map()
  const calls = []
  let prepared = false
  let account
  const journal = {
    get: id => records.get(id),
    records: () => [...records.values()],
    assertAvailable () {},
    async save (record) {
      await options.save?.(record, account)
      records.set(record.id, { ...record })
      calls.push('saved:' + record.stage)
    }
  }
  const worker = {
    available: true,
    async request (method, params) {
      calls.push(method)
      if (method === 'goOnline') return {}
      if (method === 'snapshotUnsigned') return { reservations: [] }
      if (method === 'createUtxosBegin' || method === 'sendBtcBegin') {
        prepared = true
        return { txid, psbt: 'unsigned-test-plan' }
      }
      if (method === 'createUtxosEnd' || method === 'sendBtcEnd') {
        await options.beforeEnd?.(account)
        prepared = false
        return options.end ? options.end(account) : { txid }
      }
      if (method === 'discardPrepared') {
        assert.deepEqual(params, { txid })
        if (!prepared) throw Object.assign(new Error('Guard consumed'), { code: 'NO_PREPARED_OPERATION' })
        if (options.discard) return options.discard()
        prepared = false
        return {}
      }
      if (method === 'listTransactions') return [{ txid, type: 'CreateUtxos' }]
      assert.fail('Unexpected native operation: ' + method)
    },
    close () { worker.available = false; calls.push('close') }
  }
  account = new WalletAccountRgb(worker, {
    inspect: () => ({ txid, psbtSha256 }), sign: () => 'signed-test-plan', destroy () {}
  }, { network: 'regtest', maxFeeSats: '1000', authorize: options.authorize ?? (() => true) }, journal, undefined, () => calls.push('release-directory'))
  await account.connect()
  if (!options.btc) await account.prepareCreateUtxos({ operationId, count: 4, size: '20000', feeRate: '1' })
  return { account, records, calls, commit: () => options.btc
    ? account.sendBtc({ operationId, address, amount: 10000n, feeRate: 1n })
    : account.commitPreparedCreateUtxos({ operationId, psbtSha256 }) }
}

test('shutdown during submitting persistence aborts the exact live vanilla plan before closing', async () => {
  let closing
  const f = await fixture({ save (record, account) {
    if (record.stage === 'submitting') closing = account.dispose()
  } })
  await assert.rejects(f.commit(), { code: 'WALLET_CLOSED' })
  await closing
  assert.equal(f.records.get(operationId).stage, 'declined')
  assert.equal(f.calls.includes('createUtxosEnd'), false)
  assert.equal(f.calls.filter(call => call === 'discardPrepared').length, 1)
  assert(f.calls.indexOf('saved:declined') < f.calls.indexOf('close'))
  assert(f.calls.indexOf('close') < f.calls.indexOf('release-directory'))
  assert.throws(() => f.account.getPublicKeys(), { code: 'WALLET_CLOSED' })
})

test('a failed End dispatch is declined only after the live guard and durable journal acknowledge cleanup', async () => {
  const f = await fixture({ beforeEnd () { throw fault } })
  try {
    await assert.rejects(f.commit(), error => error === fault)
    assert.equal(f.records.get(operationId).stage, 'declined')
    assert.deepEqual(await f.account.listUnresolvedOperations(), [])
  } finally { await f.account.shutdown() }
})

for (const discard of [() => null, () => [], () => ({ discarded: true }), () => { throw fault }]) {
  test('missing or ambiguous live abort acknowledgement preserves the unknown operation', async () => {
    const f = await fixture({ beforeEnd () { throw fault }, discard })
    try {
      await assert.rejects(f.commit(), error => error === fault)
      assert.equal(f.records.get(operationId).stage, 'submitting')
      assert.equal((await f.account.listUnresolvedOperations()).length, 1)
    } finally { await f.account.shutdown() }
  })
}

test('a declined journal write failure does not replace the submission error or resolve its ID', async () => {
  const f = await fixture({ beforeEnd () { throw fault }, save (record) {
    if (record.stage === 'declined') throw new Error('Injected durable write failure')
  } })
  try {
    await assert.rejects(f.commit(), error => error === fault)
    assert.equal(f.records.get(operationId).stage, 'submitting')
  } finally { await f.account.shutdown() }
})

test('a consumed guard after a lost End response stays unknown and recovers the same transaction without replay', async () => {
  const f = await fixture({ end () { throw fault } })
  try {
    await assert.rejects(f.commit(), error => error === fault)
    assert.equal(f.records.get(operationId).stage, 'submitting')
    assert.equal((await f.account.recoverCreateUtxos(operationId)).stage, 'submitted')
    assert.equal(f.calls.filter(call => call === 'createUtxosEnd').length, 1)
  } finally { await f.account.shutdown() }
})

test('shutdown does not wait for a dispatched End response', async () => {
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const f = await fixture({ end () { started.resolve(); return finish.promise } })
  const pending = f.commit()
  const rejected = assert.rejects(pending, { code: 'WALLET_CLOSED' })
  await started.promise
  await f.account.dispose()
  assert.equal(f.records.get(operationId).stage, 'submitting')
  assert.equal(f.calls.includes('discardPrepared'), false)
  finish.resolve({ txid })
  await rejected
})

test('a mismatched End result cannot be reclassified as an unsubmitted transaction', async () => {
  const f = await fixture({ end () { return { txid: 'ff'.repeat(32) } } })
  try {
    await assert.rejects(f.commit(), { code: 'TXID_MISMATCH' })
    assert.equal(f.records.get(operationId).stage, 'submitting')
  } finally { await f.account.shutdown() }
})

test('BTC send uses the same exact live-guard cleanup without replaying End', async () => {
  const f = await fixture({ btc: true, beforeEnd () { throw fault } })
  try {
    await assert.rejects(f.commit(), error => error === fault)
    assert.equal(f.records.get(operationId).stage, 'declined')
    assert.equal(f.calls.filter(call => call === 'sendBtcEnd').length, 1)
    assert.equal(f.calls.filter(call => call === 'discardPrepared').length, 1)
  } finally { await f.account.shutdown() }
})
