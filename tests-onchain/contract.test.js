// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { WalletAccountRgb } from '../onchain.js'

// These are protocol-envelope fixtures, not valid native RGB contracts.
const ASSET = 'rgb:contract-fixture'
const CONTRACT = Uint8Array.from([82, 71, 66, 0, 67, 79, 78, 1, 2, 3])
const MAX_BYTES = 1024 * 1024
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const request = () => ({ contract: Uint8Array.from(CONTRACT), assetId: ASSET, sha256: digest(CONTRACT) })
const exported = (bytes = CONTRACT) => ({ assetId: ASSET, data: Buffer.from(bytes).toString('base64'), sha256: digest(bytes) })

function fixture (t, nativeRequest, mode = 'rgb') {
  const calls = []
  const worker = {
    available: true,
    request (method, params) {
      calls.push({ method, params })
      return nativeRequest(method, params)
    },
    close () { worker.available = false }
  }
  const account = new WalletAccountRgb(worker, { destroy () {} }, {
    network: 'regtest', mode,
    authorize: () => assert.fail('Public contracts must not request spend authorization')
  }, undefined, undefined, () => {})
  t.after(() => account.shutdown())
  return { account, calls }
}

test('contract registration snapshots its checked bytes and returns only the matching asset', async t => {
  const deferred = Promise.withResolvers()
  const f = fixture(t, (method, params) => {
    assert.equal(method, 'importContract')
    assert.deepEqual(params, {
      contractBase64: Buffer.from(CONTRACT).toString('base64'), expectedAssetId: ASSET, sha256: digest(CONTRACT)
    })
    assert(Object.isFrozen(params))
    return deferred.promise
  })
  const options = request()
  const pending = f.account.registerAssetContract(options)
  options.contract.fill(0)
  options.assetId = 'rgb:changed'
  options.sha256 = '00'.repeat(32)
  deferred.resolve({ assetId: ASSET })
  assert.deepEqual(await pending, { assetId: ASSET })
  assert.equal(f.calls.length, 1)
  assert.equal(f.account.getConnectionStatus(), 'offline')
})

test('importRgbContract retains the registration contract', async t => {
  const f = fixture(t, method => {
    assert.equal(method, 'importContract')
    return { assetId: ASSET }
  })
  assert.deepEqual(await f.account.importRgbContract(request()), { assetId: ASSET })
})

test('invalid contract envelopes are rejected before calling native code', t => {
  const f = fixture(t, () => assert.fail('Invalid input reached the native worker'))
  for (const changes of [
    { contract: [] }, { contract: new Uint8Array() }, { contract: new Uint8Array(MAX_BYTES + 1) },
    { sha256: '00'.repeat(32) }, { sha256: digest(CONTRACT).toUpperCase() }, { sha256: undefined },
    { assetId: '' }, { assetId: 'rgb:bad/identity' }
  ]) assert.throws(() => f.account.registerAssetContract({ ...request(), ...changes }), TypeError)
  assert.equal(f.calls.length, 0)
})

test('native registration responses must identify exactly the requested asset', async t => {
  for (const response of [null, undefined, [], {}, { assetId: 'rgb:another' }, { assetId: ASSET, extra: true }]) {
    const f = fixture(t, () => response)
    await assert.rejects(f.account.registerAssetContract(request()), { code: 'NATIVE_PROTOCOL' })
    assert.equal(f.calls.length, 1)
  }
})

test('contract exports return verified bytes without returning native paths or envelopes', async t => {
  const response = exported()
  const f = fixture(t, (method, params) => {
    assert.equal(method, 'exportContract')
    assert.deepEqual(params, { assetId: ASSET })
    assert(Object.isFrozen(params))
    return response
  })
  const bytes = await f.account.exportAssetContract(ASSET)
  assert(bytes instanceof Uint8Array)
  assert.deepEqual(bytes, CONTRACT)
  bytes.fill(0)
  assert.deepEqual(await f.account.exportAssetContract(ASSET), CONTRACT)
  assert.equal(f.account.getConnectionStatus(), 'offline')
})

test('contract export admits the exact size limit and rejects malformed native envelopes', async t => {
  const atLimit = new Uint8Array(MAX_BYTES)
  atLimit.set(CONTRACT)
  const bounded = fixture(t, () => exported(atLimit))
  assert.deepEqual(await bounded.account.exportAssetContract(ASSET), atLimit)

  const transfer = Uint8Array.from([82, 71, 66, 0, 84, 70, 82, 1])
  const valid = exported()
  const invalid = [
    null, undefined, [], {},
    { ...valid, assetId: 'rgb:another' }, { ...valid, data: null },
    { ...valid, data: valid.data + '\n' }, { ...valid, data: valid.data.replace(/=+$/, '') },
    { ...valid, data: 'A'.repeat(Math.ceil(MAX_BYTES / 3) * 4 + 4) },
    { ...valid, sha256: '00'.repeat(32) }, { ...valid, sha256: valid.sha256.toUpperCase() },
    { ...valid, sha256: undefined }, { ...valid, nativePath: '/private/contract.rgb' },
    exported(new Uint8Array()), exported(CONTRACT.subarray(0, 7)), exported(transfer),
    exported(new Uint8Array(MAX_BYTES + 1))
  ]
  for (const response of invalid) {
    const f = fixture(t, () => response)
    await assert.rejects(f.account.exportAssetContract(ASSET), { code: 'NATIVE_PROTOCOL' })
    assert.equal(f.calls.length, 1)
  }
})

test('Bitcoin-only wallets neither advertise nor invoke contract APIs', async t => {
  const f = fixture(t, () => assert.fail('A Bitcoin-only wallet invoked an RGB contract API'), 'btc-only')
  assert.equal(f.account.getCapabilities().contractRegistration.status, 'unavailable')
  assert.equal(f.account.getCapabilities().contractExport.status, 'unavailable')
  assert.throws(() => f.account.registerAssetContract(request()), { code: 'RGB_MODE_UNAVAILABLE' })
  assert.throws(() => f.account.exportAssetContract(ASSET), { code: 'RGB_MODE_UNAVAILABLE' })
  assert.equal(f.calls.length, 0)
})

for (const method of ['importContract', 'exportContract']) {
  const invoke = account => method === 'importContract' ? account.registerAssetContract(request()) : account.exportAssetContract(ASSET)
  const response = () => method === 'importContract' ? { assetId: ASSET } : exported()

  test(`${method} keeps exclusive account ownership until the native response arrives`, async t => {
    const pending = Promise.withResolvers()
    const f = fixture(t, actual => {
      assert.equal(actual, method)
      return pending.promise
    })
    const active = invoke(f.account)
    await assert.rejects(f.account.registerAssetContract(request()), { code: 'WALLET_BUSY' })
    await assert.rejects(f.account.exportAssetContract(ASSET), { code: 'WALLET_BUSY' })
    await assert.rejects(f.account.getBtcBalance(), { code: 'WALLET_BUSY' })
    assert.equal(f.calls.length, 1)
    pending.resolve(response())
    await active
    await invoke(f.account)
    assert.equal(f.calls.length, 2)
  })

  test(`${method} discards a late success after account shutdown`, async t => {
    const pending = Promise.withResolvers()
    const f = fixture(t, () => pending.promise)
    const active = invoke(f.account)
    const rejected = assert.rejects(active, { code: 'WALLET_CLOSED' })
    await f.account.shutdown()
    pending.resolve(response())
    await rejected
    assert.throws(() => invoke(f.account), { code: 'WALLET_CLOSED' })
    assert.equal(f.calls.length, 1)
  })

  for (const code of ['INDEXER_UNAVAILABLE', 'NATIVE_TIMEOUT', 'NATIVE_CLOSED', 'ASSET_ALREADY_KNOWN']) {
    test(`${method} propagates ${code} without retrying or treating it as success`, async t => {
      const failure = Object.assign(new Error('Injected native failure'), { code })
      const f = fixture(t, () => { throw failure })
      await assert.rejects(invoke(f.account), error => error === failure)
      assert.equal(f.calls.length, 1)
    })
  }
}
