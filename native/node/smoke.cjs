// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Worker, parentPort, workerData } = require('node:worker_threads')

// Public derivation fixture. No private input crosses the addon boundary.
const identity = {
  network: 'regtest',
  accountXpubVanilla: 'tpubDCXivb31ZeAsURzdKmZFmQKXAixbGF1SxmiLJNWKEbbDzwHZvKmdVszKcMEZsFpuBZ5xTM732FVkT1JWVqLZMV84zi3cMwRD8kELPJBQy5e',
  accountXpubColored: 'tpubDCnYdtmvqfaj4msxcfMRVdNdnrKNJ8e27QxkJNnG4ZqJXYWxxWvHwnV2gvXjiXt3P4yKQJkwXmvwSK146zF3ZNog46HpKZbzWyxGKfZhD12',
  masterFingerprint: '4a1c8d2c'
}

function request (native, handle, method, params = {}) {
  const response = JSON.parse(native.request(handle, JSON.stringify({ id: 'smoke', method, params })))
  assert.equal(response.id, 'smoke', 'Native response lost its request identity')
  return response
}

if (parentPort) {
  const native = require(workerData.addon)
  const first = native.create()
  const openParams = { ...identity, dataDir: workerData.dataDir }
  const version = request(native, first, 'version').result
  assert.equal(version.runtime, 'node-in-process')
  assert.equal(version.indexer, 'electrum-and-dev-esplora')
  assert.equal(request(native, first, 'open', openParams).result?.watchOnly, true)
  const address = request(native, first, 'getAddress').result?.address
  assert.match(address, /^bcrt1p/)

  if (workerData.mode === 'boundary') {
    const second = native.create()
    try {
      const otherModule = require(workerData.otherAddon)
      const otherHandle = otherModule.create()
      try {
        assert.throws(() => otherModule.request(first, '{}'), { code: 'NATIVE_INVALID_HANDLE' })
        assert.throws(() => native.request(otherHandle, '{}'), { code: 'NATIVE_INVALID_HANDLE' })
        assert.throws(() => otherModule.destroy(first), { code: 'NATIVE_INVALID_HANDLE' })
      } finally {
        otherModule.destroy(otherHandle)
      }
      assert.equal(request(native, second, 'open', openParams).error?.code, 'WALLET_IN_USE')
      for (const value of [{}, Object.create(first), null, undefined, 1, 'x']) {
        assert.throws(() => native.request(value, '{}'), { code: 'NATIVE_INVALID_HANDLE' })
        assert.throws(() => native.destroy(value), { code: 'NATIVE_INVALID_HANDLE' })
      }
      assert.throws(() => native.request(), { code: 'NATIVE_INVALID_REQUEST' })
      assert.throws(() => native.destroy(), { code: 'NATIVE_INVALID_HANDLE' })
      for (const value of ['', 'x'.repeat(6 * 1024 * 1024 + 1), 1, null, {}]) {
        assert.throws(() => native.request(first, value), { code: 'NATIVE_INVALID_REQUEST' })
      }
      for (const value of ['{"id":"smoke","method":"open","params":null}', '{}\u0000', '{']) {
        assert.equal(JSON.parse(native.request(first, value)).error?.code, 'INVALID_PARAMS')
      }
      const unicode = JSON.parse(native.request(first, JSON.stringify({ id: 'unicode', method: 'unsupported-é𝄞', params: {} })))
      assert.equal(unicode.id, 'unicode', 'UTF-8 conversion invalidated the request envelope')
      assert.ok(unicode.error)
      native.destroy(first)
      native.destroy(first)
      assert.throws(() => native.request(first, '{}'), { code: 'NATIVE_CLOSED' })
      assert.equal(request(native, second, 'open', openParams).result?.watchOnly, true,
        'Explicit destroy retained the wallet lock')
    } finally {
      native.destroy(first)
      native.destroy(second)
    }
  }
  parentPort.postMessage({ address })
  // Retain the JS object deliberately. Environment cleanup must release the
  // wallet even when no GC finalizer ran before Node destroyed the Worker.
  globalThis.retainedWalletHandle = first
  if (workerData.mode === 'terminate') {
    setInterval(() => {}, 1000)
  } else {
    parentPort.close()
  }
} else {
  async function verify () {
    const originalUmask = process.umask()
    const addon = fs.realpathSync(process.argv[2] || path.join(__dirname, '../target/node-addon/utexo-rgb-native.node'))
    const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wdk-node-addon-'))
    fs.chmodSync(dataDir, 0o700)
    try {
      const otherAddon = path.join(dataDir, 'other-module.node')
      fs.copyFileSync(addon, otherAddon)
      fs.chmodSync(otherAddon, 0o600)
      const addresses = new Set()
      async function run (mode) {
        let worker
        try {
          return await new Promise((resolve, reject) => {
            worker = new Worker(__filename, { workerData: { addon, otherAddon, dataDir, mode } })
            let value
            worker.once('error', reject)
            worker.on('message', response => {
              value = response
              // Only an idle worker is terminated; never interrupt a financial call.
              if (mode === 'terminate') worker.terminate().catch(reject)
            })
            worker.once('exit', code => {
              if (!value || code !== (mode === 'terminate' ? 1 : 0)) reject(new Error('Native smoke worker failed'))
              else resolve(value.address)
            })
          })
        } finally {
          if (worker) await worker.terminate()
        }
      }
      for (let i = 0; i < 8; i++) {
        const address = await run('retained')
        assert.equal(addresses.has(address), false, 'Wallet derivation did not survive worker teardown')
        addresses.add(address)
      }
      await run('terminate')
      await run('retained')
      await run('boundary')
      assert.equal(process.umask(), originalUmask, 'Native work changed the process umask')
      assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700)
      for (const name of ['.utexo-rgb-native.lock', '.utexo-rgb-native.identity']) {
        assert.equal(fs.statSync(path.join(dataDir, name)).mode & 0o777, 0o600)
      }
      console.log('Node addon boundary, exclusive ownership, retained-handle cleanup, idle termination and reopen passed')
    } finally {
      fs.rmSync(dataDir, { recursive: true })
    }
  }
  verify().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
