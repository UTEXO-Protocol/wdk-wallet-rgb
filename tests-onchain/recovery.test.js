import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { p2tr, TEST_NETWORK } from '@scure/btc-signer'
import { OnchainJournal } from '../src/onchain-journal.js'
import { importWalletFixture } from './fixtures/native-manifest.js'

const { WalletAccountRgb, WalletManagerRgb } = await importWalletFixture('recovery')

const operationId = 'btc-recovery-test-01'
const checkpoint = [{ txid: '11'.repeat(32) }]
const txid = '22'.repeat(32)
const regtest = { ...TEST_NETWORK, bech32: 'bcrt' }
const address = p2tr(new Uint8Array(Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')), undefined, regtest).address

async function testJournal (t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'wdk-recovery-')))
  t.after(() => rm(path, { recursive: true, force: true }))
  const journal = new OnchainJournal(path)
  await journal.bind('recovery-test')
  return journal
}

function accountFor (worker, journal) {
  return new WalletAccountRgb(worker, {
    inspect: () => assert.fail('No PSBT may reach review after the Begin reply was lost'),
    sign: () => assert.fail('Recovery must never sign')
  }, {
    network: 'regtest', maxFeeSats: '1000', authorize: () => assert.fail('Recovery must never request approval')
  }, journal)
}

test('lost Begin response leaves the durable checkpoint and recovery consumes the ID without replay', async t => {
  const journal = await testJournal(t)
  const account = accountFor({
    available: true,
    async request (method) {
      if (method === 'goOnline') return {}
      if (method === 'snapshotUnsigned') {
        assert.equal(await journal.get(operationId), undefined)
        return { reservations: checkpoint }
      }
      assert.equal(method, 'sendBtcBegin')
      const record = await journal.get(operationId)
      assert.equal(record.stage, 'starting')
      assert.deepEqual(record.unsignedCheckpoint, checkpoint)
      this.available = false
      throw Object.assign(new Error('Lost native Begin reply'), { code: 'NATIVE_CLOSED' })
    }
  }, journal)
  await account.connect()
  const send = { operationId, address, amount: 10_000n, feeRate: 2n }
  await assert.rejects(account.sendBtc(send), { code: 'NATIVE_CLOSED' })

  let nativeDiscards = 0
  const reopened = accountFor({
    available: true,
    request (method, args) {
      if (method === 'goOnline') return {}
      assert.equal(method, 'discardUnsubmitted')
      assert.deepEqual(args, { kind: 'btc-send', checkpoint })
      nativeDiscards++
      return { discarded: true }
    }
  }, journal)
  assert.equal((await reopened.listUnresolvedOperations())[0].stage, 'starting')
  assert.equal((await reopened.recoverUnsubmittedOperation(operationId)).stage, 'declined')
  assert.equal((await reopened.recoverUnsubmittedOperation(operationId)).stage, 'declined')
  assert.equal(nativeDiscards, 1)
  assert.deepEqual(await reopened.listUnresolvedOperations(), [])
  await reopened.connect()
  await assert.rejects(reopened.sendBtc(send), { code: 'OPERATION_EXISTS' })
})

test('unsigned recovery requires an unambiguous acknowledgement and excludes submitting and legacy records', async t => {
  const journal = await testJournal(t)
  const record = { id: operationId, kind: 'btc-send', stage: 'prepared', txid, unsignedCheckpoint: checkpoint }
  await journal.save(record)
  let result
  let calls = 0
  const account = accountFor({
    available: true,
    request (method, args) {
      assert.equal(method, 'discardUnsubmitted')
      assert.equal(args.kind, record.kind)
      assert.equal(args.expected.txid, txid)
      assert.equal(args.expected.batchTransferIdx, undefined)
      assert.deepEqual(args.checkpoint, checkpoint)
      calls++
      if (result === undefined) throw Object.assign(new Error('Ambiguous reservations'), { code: 'DISCARD_UNCERTAIN' })
      return result
    }
  }, journal)
  await assert.rejects(account.recoverUnsubmittedOperation(operationId), { code: 'DISCARD_UNCERTAIN' })
  result = {}
  await assert.rejects(account.recoverUnsubmittedOperation(operationId), { code: 'NATIVE_PROTOCOL' })
  assert.deepEqual(await journal.get(operationId), record)
  await journal.save({ ...record, stage: 'submitting' })
  await assert.rejects(account.recoverUnsubmittedOperation(operationId), { code: 'OPERATION_UNRESOLVED' })
  await journal.save({ ...record, stage: 'starting', unsignedCheckpoint: undefined })
  await assert.rejects(account.recoverUnsubmittedOperation(operationId), { code: 'OPERATION_UNRESOLVED' })
  assert.equal(calls, 2)
})

for (const kind of ['btc-send', 'rgb-receive']) {
  test('shutdown keeps the wallet lock through an admitted ' + kind + ' journal write', async () => {
    const writeStarted = Promise.withResolvers()
    const finishWrite = Promise.withResolvers()
    let closeCount = 0
    let destroyCount = 0
    const stages = []
    const journal = {
      get () {},
      assertAvailable () {},
      async save (record) {
        writeStarted.resolve()
        await finishWrite.promise
        assert.equal(closeCount, 0)
        stages.push(record.stage)
      }
    }
    const worker = {
      available: true,
      request (method) {
        if (method === 'goOnline') return {}
        if (method === 'snapshotUnsigned') return { reservations: [] }
        assert.fail('A native mutation was invoked while closing: ' + method)
      },
      close () { closeCount++ }
    }
    const account = new WalletAccountRgb(worker, { destroy () { destroyCount++ } }, {
      network: 'regtest', transportEndpoint: 'rpc://127.0.0.1:3003/json-rpc', maxFeeSats: '1000'
    }, journal, journal)
    await account.connect()
    const active = kind === 'btc-send'
      ? account.sendBtc({ operationId, address, amount: 10_000n, feeRate: 2n })
      : account.receiveWebRgbInvoice({ method: 'blindReceive', operationId, requestKey: '33'.repeat(32),
        assertAuthorized () {}, approve () {} })
    const rejected = assert.rejects(active, { code: 'WALLET_CLOSED' })
    await writeStarted.promise
    const closing = account.shutdown()
    assert.equal(account.shutdown(), closing)
    assert.equal(destroyCount, 1)
    await Promise.resolve()
    assert.equal(closeCount, 0)
    finishWrite.resolve()
    await Promise.all([closing, rejected])
    assert.deepEqual(stages, ['starting'])
    assert.equal(closeCount, 1)
  })
}

test('shutdown does not wait for a pending human approval or sign after closure', async () => {
  const approvalStarted = Promise.withResolvers()
  const decision = Promise.withResolvers()
  const stages = []
  let closeCount = 0
  const journal = {
    get () {},
    assertAvailable () {},
    save (record) { stages.push(record.stage) }
  }
  const worker = {
    available: true,
    request (method) {
      if (method === 'goOnline') return {}
      if (method === 'snapshotUnsigned') return { reservations: [] }
      if (method === 'sendBtcBegin') return { txid, psbt: 'test-plan' }
      assert.fail('A native mutation was invoked while closing: ' + method)
    },
    close () { closeCount++ }
  }
  const account = new WalletAccountRgb(worker, {
    destroy () {},
    inspect: () => ({ txid, psbtSha256: '33'.repeat(32) }),
    sign: () => assert.fail('A closed account must not sign')
  }, {
    network: 'regtest', maxFeeSats: '1000',
    authorize () { approvalStarted.resolve(); return decision.promise }
  }, journal)
  await account.connect()
  const active = account.sendBtc({ operationId, address, amount: 10_000n, feeRate: 2n })
  const rejected = assert.rejects(active, { code: 'WALLET_CLOSED' })
  await approvalStarted.promise
  await account.shutdown()
  assert.equal(closeCount, 1)
  decision.resolve(true)
  await rejected
  assert.deepEqual(stages, ['starting', 'prepared'])
})

async function workerFixture (t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'wdk-worker-claim-')))
  const executable = join(dir, 'worker')
  const source = String.raw`#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  const reply = result => process.stdout.write(JSON.stringify({ id, result }) + '\n')
  if (method === 'version') return reply({
    protocol: 2, unsignedRecovery: 1, journalWrites: 1, assetIssuance: 2, networkChecks: 5, runtime: 'node-host-process',
    indexer: 'electrum-and-dev-esplora', source: '2f7b21d8637baad548504ea870deb2c0d4d0a37d',
    overlayTree: '5492824f3cf47b4c821dfca8b7a63fed27858486',
    integrationTree: '5492824f3cf47b4c821dfca8b7a63fed27858486'
  })
  if (method === 'open') return reply({ network: params.network, watchOnly: true })
  if (method === 'bindJournal') return reply({ written: true })
  if (method === 'getBtcBalance') process.kill(process.pid, 'SIGKILL')
})
`
  await writeFile(executable, source, { mode: 0o700 })
  const managers = []
  t.after(async () => {
    await Promise.all(managers.map(manager => manager.shutdown()))
    await rm(dir, { recursive: true, force: true })
  })
  const pin = createHash('sha256').update(source).digest('hex')
  const seed = Uint8Array.from({ length: 64 }, (_, i) => i + 1)
  return (nativeSha256 = pin) => {
    const manager = new WalletManagerRgb(seed, {
      network: 'regtest', startupMode: 'offline', dataDir: join(dir, 'wallet'), nativeExecutable: executable, nativeSha256,
      indexerUrl: 'tcp://127.0.0.1:50001', transportEndpoint: 'rpc://127.0.0.1:3003/json-rpc',
      maxFeeSats: '1000', authorize: () => false
    })
    managers.push(manager)
    return manager
  }
}

test('an independently dead child cannot release the wallet path to another manager in the same runtime', async t => {
  const createManager = await workerFixture(t)
  const first = createManager()
  const second = createManager()
  const account = await first.getAccount()
  await assert.rejects(account.getBtcBalance(), { code: 'NATIVE_CLOSED' })
  await assert.rejects(second.getAccount(), { code: 'WALLET_IN_USE' })
  await first.shutdown()
  assert.equal((await second.getAccount()).getConnectionStatus(), 'offline')
})

test('an unsuccessful worker launch releases the wallet path for retry', async t => {
  const createManager = await workerFixture(t)
  await assert.rejects(createManager('00'.repeat(32)).getAccount(), { code: 'NATIVE_IDENTITY_MISMATCH' })
  assert.equal((await createManager().getAccount()).getConnectionStatus(), 'offline')
})
