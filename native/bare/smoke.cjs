// SPDX-License-Identifier: Apache-2.0
const { Worker, parentPort, workerData } = require('bare-worker')
const fs = require('bare-fs')

// Public derivation fixture, from a fixed test vector. No private input crosses the addon boundary.
const identity = {
  network: 'regtest',
  accountXpubVanilla: 'tpubDCXivb31ZeAsURzdKmZFmQKXAixbGF1SxmiLJNWKEbbDzwHZvKmdVszKcMEZsFpuBZ5xTM732FVkT1JWVqLZMV84zi3cMwRD8kELPJBQy5e',
  accountXpubColored: 'tpubDCnYdtmvqfaj4msxcfMRVdNdnrKNJ8e27QxkJNnG4ZqJXYWxxWvHwnV2gvXjiXt3P4yKQJkwXmvwSK146zF3ZNog46HpKZbzWyxGKfZhD12',
  masterFingerprint: '4a1c8d2c'
}

function assert (condition, message) {
  if (!condition) throw new Error(message)
}

function request (native, handle, method, params = {}) {
  const response = JSON.parse(native.request(handle, JSON.stringify({ id: 'smoke', method, params })))
  assert(response.id === 'smoke', 'Native response lost the request identity')
  return response
}

function expectNativeError (fn, code) {
  try {
    fn()
  } catch (error) {
    assert(error.code === code, 'Unexpected native boundary error')
    return
  }
  throw new Error('Invalid native call succeeded')
}

if (parentPort) {
  const native = require.addon('../..')
  const handle = native.create()
  const opened = request(native, handle, 'open', { ...identity, dataDir: workerData })
  assert(opened.result?.watchOnly, 'Worker could not acquire watch-only wallet')
  const address = request(native, handle, 'getAddress')
  assert(address.result?.address.startsWith('bcrt1p'), 'Worker returned invalid address')
  parentPort.postMessage(address.result.address)
  // Intentionally retain the handle until JS environment destruction. A following
  // worker must reopen the same directory without waiting for process exit.
  globalThis.retainedWalletHandle = handle
  parentPort.close()
} else {
  async function verify () {
    const dataDir = fs.mkdtempSync(__dirname + '/../target/bare-addon/wallet-smoke-')
    try {
      const addresses = new Set()
      for (let i = 0; i < 8; i++) {
        const address = await new Promise((resolve, reject) => {
          const worker = new Worker(__filename, { workerData: dataDir })
          let value
          worker.once('error', reject)
          // Bare unrefs the port when its last message listener is removed.
          // Keep the port alive until exit so teardown is part of the test.
          worker.on('message', address => { value = address })
          worker.once('exit', code => {
            if (code !== 0 || !value) reject(new Error('Bare worker failed before returning an address'))
            else resolve(value)
          })
        })
        assert(!addresses.has(address), 'Wallet derivation state did not advance after reopen')
        addresses.add(address)
      }

      const native = require.addon('../..')
      const first = native.create()
      const second = native.create()
      const openParams = { ...identity, dataDir }
      try {
        const version = request(native, first, 'version').result
        assert(version.runtime === 'bare-in-process' && version.indexer === 'electrum-and-dev-esplora',
          'Unexpected native profile')
        assert(request(native, first, 'open', openParams).result?.watchOnly, 'Wallet did not open')
        assert(request(native, second, 'open', openParams).error?.code === 'WALLET_IN_USE',
          'Another handle acquired the same wallet directory')
        const noBitcoind = request(native, first, 'goOnline', { indexerUrl: 'https://127.0.0.1:1' })
        assert(noBitcoind.error?.code === 'INVALID_PARAMS', 'An HTTP indexer was admitted')
        const malformed = JSON.parse(native.request(first, '{"id":"smoke","method":"open","params":null}'))
        assert(malformed.id === null && malformed.error?.code === 'INVALID_PARAMS',
          'An invalid envelope was accepted')
        expectNativeError(() => native.request({}, '{}'), 'NATIVE_INVALID_HANDLE')
        expectNativeError(() => native.request(Object.create(first), '{}'), 'NATIVE_INVALID_HANDLE')
        expectNativeError(() => native.request(first, 'x'.repeat(6 * 1024 * 1024 + 1)), 'NATIVE_INVALID_REQUEST')
        native.destroy(first)
        expectNativeError(() => native.request(first, '{}'), 'NATIVE_CLOSED')
        assert(request(native, second, 'open', openParams).result?.watchOnly, 'Explicit destroy retained the wallet lock')
      } finally {
        native.destroy(first)
        native.destroy(second)
      }
      console.log('Bare addon handle boundary, exclusive ownership, and eight worker teardown/reopens passed')
    } finally {
      fs.rmSync(dataDir, { recursive: true })
    }
  }

  verify().catch(error => {
    console.error(error)
    Bare.exit(1)
  })
}
