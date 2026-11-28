// Copyright 2026 UTEXO.
// SPDX-License-Identifier: Apache-2.0

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { base64 } from '@scure/base'
import { Address, NETWORK, OutScript, RawTx, RawWitness, Script, SigHash, TEST_NETWORK, Transaction, p2pkh } from '@scure/btc-signer'
import { equalBytes, hash160, sha256x2, tagSchnorr, taprootTweakPrivKey } from '@scure/btc-signer/utils.js'

const MAX_MESSAGE_BYTES = 4096
// One P2WPKH witness count, two lengths, a 73-byte signature with sighash,
// and a 33-byte public key. Taproot key-path witnesses are smaller.
const MAX_SIGNATURE_CHARS = 3 + 4 * Math.ceil((1 + 2 + 73 + 33) / 3)
const REGTEST = Object.freeze({ ...TEST_NETWORK, bech32: 'bcrt' })
const ADDRESS_NETWORKS = new Map([
  ['mainnet', NETWORK],
  ['regtest', REGTEST],
  ['testnet', TEST_NETWORK],
  ['testnet4', TEST_NETWORK],
  ['signet', TEST_NETWORK]
])

export const BIP322_CAPABILITIES = Object.freeze({
  signing: true,
  verification: true,
  protocol: 'bip322-simple',
  // Match the established Iris capability contract. This key-path subset also
  // rejects the upgrade mechanisms described in BIP-322 2.1.0.
  specVersion: '2.0.0',
  addressTypes: Object.freeze(['p2tr']),
  verificationAddressTypes: Object.freeze(['p2tr', 'p2wpkh'])
})

export function bip322Network (network) {
  const selected = ADDRESS_NETWORKS.get(network)
  if (!selected) throw new TypeError('BIP-322 requires a supported Bitcoin network')
  return selected
}

export function bip322MessageBytes (message) {
  if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES || !message.isWellFormed()) {
    throw new TypeError('BIP-322 requires well-formed text of at most 4,096 UTF-8 bytes')
  }
  const bytes = utf8ToBytes(message)
  if (bytes.length > MAX_MESSAGE_BYTES) throw new RangeError('BIP-322 message exceeds 4,096 UTF-8 bytes')
  return bytes
}

function transactionToSign (messageBytes, script) {
  const tagged = tagSchnorr('BIP0322-signed-message', messageBytes)
  const spend = RawTx.encode({
    version: 0,
    lockTime: 0,
    segwitFlag: false,
    inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, sequence: 0, finalScriptSig: Script.encode([0, tagged]) }],
    outputs: [{ amount: 0n, script }]
  })
  // Transaction expects the display-order txid, while hash256 returns wire bytes.
  const tx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true })
  tx.addInput({ txid: sha256x2(spend).reverse(), index: 0, sequence: 0 })
  tx.addOutput({ amount: 0n, script: Script.encode(['RETURN']) })
  return tx
}

// Internal signer helper. The key owner supplies the exact key-path script and
// destroys the untweaked private child immediately after this call.
export function signTaprootBip322 (messageBytes, script, secret) {
  const tx = transactionToSign(messageBytes, script)
  const sighash = tx.preimageWitnessV1(0, [script], SigHash.DEFAULT, [0n])
  const auxiliary = randomBytes(32)
  let tweaked
  try {
    tweaked = taprootTweakPrivKey(secret)
    if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 32 ||
        !equalBytes(schnorr.getPublicKey(tweaked), script.subarray(2))) {
      throw new Error('BIP-322 challenge does not match the signing key')
    }
    const signed = schnorr.sign(sighash, tweaked, auxiliary)
    return 'smp' + base64.encode(RawWitness.encode([signed]))
  } finally {
    tweaked?.fill(0)
    auxiliary.fill(0)
  }
}

function verifyTaproot (messageBytes, script, key, witness) {
  // Bounded key-path subset. Multiple items could introduce an annex or a
  // script path, neither of which this API can verify.
  if (witness[0] !== 1 || witness[1] !== witness.length - 2) return false
  const length = witness[1]
  const hashType = length === 64 ? SigHash.DEFAULT : length === 65 && witness[66] === SigHash.ALL ? SigHash.ALL : undefined
  if (hashType === undefined) return false
  const tx = transactionToSign(messageBytes, script)
  return schnorr.verify(witness.subarray(2, 66), tx.preimageWitnessV1(0, [script], hashType, [0n]), key)
}

function verifyWitnessPubkeyHash (messageBytes, script, keyHash, witness) {
  const length = witness[1]
  const keyOffset = length + 3
  if (witness[0] !== 2 || length < 9 || length > 73 || witness[keyOffset - 1] !== 33 ||
      witness.length !== keyOffset + 33 || witness[keyOffset - 2] !== SigHash.ALL) return false
  const key = witness.subarray(keyOffset)
  if ((key[0] !== 2 && key[0] !== 3) || !equalBytes(hash160(key), keyHash)) return false
  const signature = witness.subarray(2, keyOffset - 2)
  const tx = transactionToSign(messageBytes, script)
  const sighash = tx.preimageWitnessV0(0, p2pkh(key).script, SigHash.ALL, 0n)
  return secp256k1.verify(signature, sighash, key, { format: 'der', lowS: true, prehash: false })
}

// Returns true only for a valid proof in the supported P2TR key-path or
// P2WPKH subset. Bad inputs and unsupported witnesses fail closed.
export function verifyMessageBip322 (message, address, signature, network) {
  try {
    const messageBytes = bip322MessageBytes(message)
    if (typeof address !== 'string' || address.length > 90 ||
        typeof signature !== 'string' || signature.length > MAX_SIGNATURE_CHARS ||
        signature.startsWith('ful') || signature.startsWith('pof')) return false
    const coder = Address(bip322Network(network))
    const decoded = coder.decode(address)
    if ((decoded.type !== 'tr' && decoded.type !== 'wpkh') || coder.encode(decoded) !== address) return false

    const encoded = signature.startsWith('smp') ? signature.slice(3) : signature
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false
    const witness = base64.decode(encoded)
    if (base64.encode(witness) !== encoded) return false

    const script = OutScript.encode(decoded)
    if (decoded.type === 'tr') return verifyTaproot(messageBytes, script, decoded.pubkey, witness)
    return verifyWitnessPubkeyHash(messageBytes, script, decoded.hash, witness)
  } catch {
    return false
  }
}
