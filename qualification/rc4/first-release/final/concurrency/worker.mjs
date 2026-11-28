// SPDX-License-Identifier: Apache-2.0
// Disposable acceptance harness; never used by the SDK runtime.
import assert from 'node:assert/strict'
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
const { WalletManagerRgb } = await import(pathToFileURL(workerData.entry).href)
let approvals = 0
const seed = new Uint8Array(workerData.seed)
let manager, account
try {
  manager = new WalletManagerRgb(seed, {
    ...workerData.config,
    authorize: () => { throw new Error('Offline acceptance must not authorize transfers') },
    authorizeMessage: review => {
      assert.equal(review.kind, 'bip322')
      assert.match(review.messageSha256, /^[0-9a-f]{64}$/)
      approvals++
      return true
    }
  })
  account = await manager.getAccount()
  const address = await account.getMessageSigningAddress()
  parentPort.postMessage({ ready: true, address })
} catch (error) {
  try { await manager?.shutdown() } finally { seed.fill(0) }
  parentPort.postMessage({ ready: false, code: error.code ?? error.name })
  parentPort.close()
}
if (account) {
  parentPort.on('message', async ({ id, action, message, address, signature }) => {
    try {
      let result
      if (action === 'readsign') {
        assert.equal(account.getConnectionStatus(), 'offline')
        assert.equal(await account.getBalance(), 0n)
        assert.deepEqual(await account.listAssets(), [])
        assert.deepEqual(await account.getTransactions(), [])
        const ownAddress = await account.getMessageSigningAddress()
        const signed = await account.signMessageBip322(message, ownAddress)
        assert.equal(await account.verifyMessageBip322(message, ownAddress, signed), true)
        assert.equal(await account.verifyMessageBip322(message + '-changed', ownAddress, signed), false)
        result = { address: ownAddress, signature: signed, approvals }
      } else if (action === 'verify') {
        result = await account.verifyMessageBip322(message, address, signature)
      } else if (action === 'close') {
        await manager.shutdown()
        seed.fill(0)
        result = { closed: true }
      } else throw new Error('Unknown acceptance command')
      parentPort.postMessage({ id, result })
      if (action === 'close') parentPort.close()
    } catch (error) {
      parentPort.postMessage({ id, error: { code: error.code ?? error.name, message: error.message } })
    }
  })
}
