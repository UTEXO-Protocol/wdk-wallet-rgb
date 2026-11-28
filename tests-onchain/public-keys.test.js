import assert from 'node:assert/strict'
import test from 'node:test'
import { WalletAccountRgb } from '../onchain.js'
import { deriveOnchainSigner } from '../src/onchain-signer.js'

for (const network of ['mainnet', 'signet', 'regtest']) {
  test(`public keys expose only an immutable copy of the ${network} account identity while offline`, async () => {
    const signer = deriveOnchainSigner(new Uint8Array(64).fill(9), { network })
    let nativeRequests = 0
    const account = new WalletAccountRgb({
      request () { nativeRequests++; throw new Error('Public keys must not call native') },
      close: async () => {}
    }, signer, { network }, undefined, undefined, () => {})
    try {
      const keys = account.getPublicKeys()
      assert.deepEqual(Object.keys(keys).sort(), [
        'accountXpubColored', 'accountXpubVanilla', 'masterFingerprint', 'network'
      ])
      assert.deepEqual(keys, signer.identity)
      assert.notEqual(keys, signer.identity)
      assert.notEqual(keys, account.getPublicKeys())
      assert(Object.isFrozen(keys))
      assert.throws(() => { keys.accountXpubColored = 'modified' }, TypeError)
      assert.match(keys.accountXpubVanilla, network === 'mainnet' ? /^xpub/ : /^tpub/)
      assert.match(keys.accountXpubColored, network === 'mainnet' ? /^xpub/ : /^tpub/)
      assert.match(keys.masterFingerprint, /^[a-f0-9]{8}$/)
      assert.equal(nativeRequests, 0)
    } finally {
      await account.shutdown()
    }
    assert.throws(() => account.getPublicKeys(), { code: 'WALLET_CLOSED' })
  })
}
