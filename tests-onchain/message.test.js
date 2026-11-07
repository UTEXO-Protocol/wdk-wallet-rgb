import assert from 'node:assert/strict'
import test from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { base64 } from '@scure/base'
import { p2tr, RawWitness } from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { BIP322_CAPABILITIES, bip322Network, verifyMessageBip322 } from '../src/onchain-message.js'
import { deriveOnchainSigner } from '../src/onchain-signer.js'

// Official BIP-322 generated simple witnesses (bitcoin/bips, CC0).
// https://github.com/bitcoin/bips/blob/master/bip-0322/generated-test-vectors.json
const vectors = [
  {
    message: 'PURVOQ544B6HUATVBJZN5EZJUU',
    address: 'bc1pcquvhrqv0q68t4m0hfq6tpn006qrskyc7yrqnp2uyrf2emg3wynsdjyk38',
    signature: 'smpAUB6B2Rbupzua8LTQIF06516wzl+cwKy1be8RgoiW0riyXdKwe6GTz/5Hnb37m67pJwIKCh+D5jDueG6KpvYpmu8'
  },
  {
    message: '2V6TUTMSH4VQ3Z7WZWKYD7DFNH',
    address: 'bc1qqthe0hz8klx90e7stf6shclhsvqd5ly96pn53v',
    signature: 'smpAkgwRQIhALC6hdfxNy1n45d7UXSskRBdfZW0Al259E1kDMpipdYkAiAJPfZqb+WurZuf1apU5xeE6Igui9dvt5tihQLDvxlY1AEhAqbnruyo677ktQjio7XOchO3w51Dh9AbRVngha5jtNfT'
  }
]

test('verifies official Taproot and P2WPKH simple witnesses, including legacy unprefixed form', () => {
  assert.equal(BIP322_CAPABILITIES.specVersion, '2.0.0')
  for (const { message, address, signature } of vectors) {
    assert.equal(verifyMessageBip322(message, address, signature, 'mainnet'), true)
    assert.equal(verifyMessageBip322(message, address, signature.slice(3), 'mainnet'), true)
    assert.equal(verifyMessageBip322(message + '\n', address, signature, 'mainnet'), false)
    assert.equal(verifyMessageBip322(message, address, signature, 'signet'), false)
    assert.equal(verifyMessageBip322(message, address.toUpperCase(), signature, 'mainnet'), false)
    assert.equal(verifyMessageBip322(message, address, 'ful' + signature.slice(3), 'mainnet'), false)
  }
})

test('rejects taproot annexes, noncanonical CompactSize and unsupported sighashes', () => {
  const { message, address, signature } = vectors[0]
  const raw = base64.decode(signature.slice(3))
  const [item] = RawWitness.decode(raw)
  const bad = [
    RawWitness.encode([item, Uint8Array.of(0x50)]),
    RawWitness.encode([Uint8Array.of(...item, 0)]),
    RawWitness.encode([Uint8Array.of(...item, 2)]),
    Uint8Array.of(0xfd, 1, 0, ...raw.subarray(1)),
    Uint8Array.of(...raw, 0)
  ]
  for (const witness of bad) {
    assert.equal(verifyMessageBip322(message, address, 'smp' + base64.encode(witness), 'mainnet'), false)
  }
})

test('rejects high-S and noncanonical DER P2WPKH signatures', () => {
  const { message, address, signature } = vectors[1]
  const [signed, pubkey] = RawWitness.decode(base64.decode(signature.slice(3)))
  const { r, s } = secp256k1.Signature.fromBytes(signed.subarray(0, -1), 'der')
  const high = new secp256k1.Signature(r, secp256k1.Point.Fn.ORDER - s).toBytes('der')
  const malformed = Uint8Array.of(...signed.subarray(0, -1), 0)
  for (const der of [high, malformed]) {
    const witness = RawWitness.encode([Uint8Array.of(...der, 1), pubkey])
    assert.equal(verifyMessageBip322(message, address, 'smp' + base64.encode(witness), 'mainnet'), false)
  }
})

test('signs exact UTF-8 only for the fixed owned first receive key and refuses after close', () => {
  const signer = deriveOnchainSigner(new Uint8Array(64).fill(5), { network: 'regtest' })
  try {
    const address = signer.getMessageSigningAddress()
    const account = HDKey.fromExtendedKey(signer.identity.accountXpubVanilla, {
      private: 0x04358394, public: 0x043587cf
    })
    const deriveAddress = index => p2tr(account.deriveChild(0).deriveChild(index).publicKey.subarray(1), undefined, bip322Network('regtest')).address
    assert.equal(address, deriveAddress(0))
    assert.throws(() => signer.signMessageBip322('test', deriveAddress(1)), { code: 'MESSAGE_ADDRESS_MISMATCH' })
    assert.throws(() => signer.signMessageBip322('\ud800', address), TypeError)
    assert.throws(() => signer.signMessageBip322('😀'.repeat(1025), address), RangeError)
    for (const message of ['', ' café\u0000\n  ', '😀'.repeat(1024)]) {
      const signature = signer.signMessageBip322(message, address)
      assert.match(signature, /^smp/)
      assert.equal(verifyMessageBip322(message, address, signature, 'regtest'), true)
      assert.equal(verifyMessageBip322(message.trimEnd() + '!', address, signature, 'regtest'), false)
    }
    signer.destroy()
    assert.throws(() => signer.getMessageSigningAddress(), { code: 'SIGNER_CLOSED' })
    assert.throws(() => signer.signMessageBip322('test', address), { code: 'SIGNER_CLOSED' })
  } finally {
    signer.destroy()
  }
})
