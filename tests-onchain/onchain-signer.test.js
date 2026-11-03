// Copyright 2026 UTEXO.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import test from 'node:test'
import { base64, hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { p2tr, Transaction } from '@scure/btc-signer'
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js'
import { deriveOnchainSigner } from '../src/onchain-signer.js'

const TEST_VERSIONS = { private: 0x04358394, public: 0x043587cf }
const H = 0x80000000
const seed = Uint8Array.from({ length: 64 }, (_, i) => i)
const master = HDKey.fromMasterSeed(seed, TEST_VERSIONS)
const other = HDKey.fromMasterSeed(new Uint8Array(64).fill(7), TEST_VERSIONS)
const TxOptions = { allowUnknownOutputs: true, proprietary: 'ignore' }

function key (coin, index, root = master) {
  const path = [H + 86, H + coin, H, 0, index]
  const child = root.derive(`m/86'/${coin}'/0'/0/${index}`)
  const pubKey = child.publicKey.subarray(1)
  const script = p2tr(pubKey).script
  return { script, tapInternalKey: pubKey, tapBip32Derivation: [[pubKey, { hashes: [], der: { fingerprint: root.fingerprint, path } }]] }
}

function psbt (kind, configure = () => {}) {
  const tx = new Transaction(TxOptions)
  const colored = kind === 'rgb-send' || kind === 'rgb-burn'
  const inputKey = key(colored ? 827167 : 1, 3)
  const prev = new Transaction(TxOptions)
  prev.addInput({ txid: new Uint8Array(32).fill(12), index: 3 })
  prev.addOutput({ script: inputKey.script, amount: 100000n })
  tx.addInput({
    txid: prev.id,
    index: 0,
    nonWitnessUtxo: prev.unsignedTx,
    witnessUtxo: { script: inputKey.script, amount: 100000n },
    tapBip32Derivation: inputKey.tapBip32Derivation,
    tapInternalKey: inputKey.tapInternalKey
  })
  const recipient = key(1, 5, other)
  const change = key(1, 4)
  const policy = { kind, maxFeeSats: '5000', approvedOutputs: [] }
  if (kind === 'btc-send') {
    tx.addOutput({ script: recipient.script, amount: 10000n })
    tx.addOutput({ ...change, amount: 89500n })
    policy.approvedOutputs.push({ index: 0, scriptHex: hex.encode(recipient.script), amountSats: '10000' })
  } else if (kind === 'rgb-output') {
    tx.addOutput({ ...key(827167, 1), amount: 20000n })
    tx.addOutput({ ...key(827167, 2), amount: 20000n })
    tx.addOutput({ ...change, amount: 59500n })
    policy.expectedColorableOutputs = { count: 2, amountSats: '20000' }
  } else {
    tx.addOutput({
      script: hex.decode('6a20' + 'ab'.repeat(32)),
      amount: 0n,
      proprietary: [[hex.decode('0372676201'), hex.decode('012345')]]
    })
    if (kind === 'rgb-send') {
      tx.addOutput({ script: recipient.script, amount: 500n })
      policy.approvedOutputs.push({ index: 1, scriptHex: hex.encode(recipient.script), amountSats: '500' })
    }
    tx.addOutput({ ...change, amount: kind === 'rgb-send' ? 99000n : 99500n })
  }
  configure(tx, policy)
  return { tx, raw: base64.encode(tx.toPSBT(0)), policy }
}

test('derives watch-only identity, signs reviewed BTC, output setup, RGB send and burn without altering committed maps', () => {
  const signer = deriveOnchainSigner(seed, { network: 'regtest' })
  assert.deepEqual(signer.identity, {
    network: 'regtest',
    accountXpubVanilla: master.derive("m/86'/1'/0'").publicExtendedKey,
    accountXpubColored: master.derive("m/86'/827167'/0'").publicExtendedKey,
    masterFingerprint: master.fingerprint.toString(16).padStart(8, '0')
  })
  try {
    for (const kind of ['btc-send', 'rgb-output', 'rgb-send', 'rgb-burn']) {
      const { tx, raw, policy } = psbt(kind)
      const plan = signer.inspect(raw, policy)
      assert.equal(plan.txid, tx.id)
      assert.equal(plan.feeSats, '500')
      assert.equal(Object.isFrozen(plan.outputs[0]), true)
      if (kind === 'rgb-output') {
        assert.deepEqual(plan.inputs.map(input => input.role), ['vanilla'])
        assert.deepEqual(plan.outputs.map(({ role, amountSats }) => [role, amountSats]), [
          ['colored', '20000'], ['colored', '20000'], ['vanilla', '59500']
        ])
      }
      const signed = signer.sign(raw, policy, plan)
      const bytes = base64.decode(signed)
      const finalized = Transaction.fromPSBT(bytes, TxOptions)
      assert.equal(finalized.isFinal, true)
      assert.equal(finalized.getInput(0).finalScriptWitness[0].length, 64)
      assert.equal(finalized.vsize, plan.vsize)
      assert.equal(finalized.fee, 500n)
      assert.equal(finalized.id, tx.id)
      const unsignedMaps = RawPSBTV0.decode(base64.decode(raw))
      const signedMaps = RawPSBTV0.decode(bytes)
      delete signedMaps.inputs[0].finalScriptWitness
      assert.deepEqual(signedMaps, unsignedMaps)
      assert.throws(() => signer.sign(raw, policy, plan), { code: 'REVIEW_REQUIRED' })
    }
  } finally {
    signer.destroy()
  }
})

test('a review cannot be cloned, reused after close, or changed by replacing PSBT metadata or fee policy', () => {
  const signer = deriveOnchainSigner(seed, { network: 'regtest' })
  const { raw, policy } = psbt('rgb-burn')
  const plan = signer.inspect(raw, policy)
  const modified = RawPSBTV0.decode(base64.decode(raw))
  modified.outputs[0].proprietary[0][1] = hex.decode('ff')
  const changed = base64.encode(RawPSBTV0.encode(modified))
  assert.throws(() => signer.sign(raw, policy, { ...plan }), { code: 'REVIEW_REQUIRED' })
  assert.throws(() => signer.sign(changed, policy, plan), { code: 'REVIEW_MISMATCH' })
  assert.throws(() => signer.sign(raw, { ...policy, maxFeeSats: '9999' }, plan), { code: 'REVIEW_MISMATCH' })
  signer.destroy()
  signer.destroy()
  assert.throws(() => signer.sign(raw, policy, plan), { code: 'SIGNER_CLOSED' })
  assert.throws(() => signer.inspect(raw, policy), { code: 'SIGNER_CLOSED' })
})

test('rejects forged key origins and payment outputs, colored BTC inputs, excess fees, and incorrect setup count', () => {
  const signer = deriveOnchainSigner(seed, { network: 'regtest' })
  try {
    const check = (kind, configure, code) => {
      const { raw, policy } = psbt(kind, configure)
      assert.throws(() => signer.inspect(raw, policy), { code })
    }
    check('btc-send', tx => tx.updateOutput(1, key(1, 12, other)), 'UNVERIFIED_KEY')
    check('btc-send', tx => tx.updateOutput(0, { amount: 9999n }), 'OUTPUT_MISMATCH')
    check('btc-send', tx => tx.updateInput(0, { sighashType: 0x81 }), 'UNSAFE_INPUT')
    check('btc-send', (_, policy) => { policy.maxFeeSats = '499' }, 'FEE_POLICY')
    check('rgb-output', (_, policy) => { policy.expectedColorableOutputs.count = 3 }, 'OUTPUT_MISMATCH')
    check('rgb-output', tx => tx.updateOutput(1, { amount: 19999n }), 'OUTPUT_MISMATCH')
    check('rgb-output', tx => tx.addOutput({ script: key(1, 12, other).script, amount: 1000n }), 'UNVERIFIED_KEY')
    check('rgb-burn', tx => tx.updateOutput(0, { script: hex.decode('6a20' + 'ab'.repeat(32)), amount: 1n }), 'OUTPUT_MISMATCH')
    // Reuse the colored input in an otherwise valid Bitcoin payment.
    const payment = psbt('btc-send')
    const colored = RawPSBTV0.decode(base64.decode(psbt('rgb-burn').raw))
    const raw = RawPSBTV0.decode(base64.decode(payment.raw))
    raw.global.unsignedTx.inputs = colored.global.unsignedTx.inputs
    raw.inputs = colored.inputs
    assert.throws(() => signer.inspect(base64.encode(RawPSBTV0.encode(raw)), payment.policy), { code: 'UNSAFE_INPUT' })
  } finally {
    signer.destroy()
  }
})

test('rejects previous output amount/script or transaction ID inconsistent with full previous transaction', () => {
  const signer = deriveOnchainSigner(seed, { network: 'regtest' })
  try {
    const fixture = psbt('btc-send')
    const malformed = mutate => {
      const raw = RawPSBTV0.decode(base64.decode(fixture.raw))
      mutate(raw)
      return base64.encode(RawPSBTV0.encode(raw))
    }
    assert.throws(() => signer.inspect(malformed(raw => { raw.inputs[0].witnessUtxo.amount += 1n }), fixture.policy),
      { code: 'INVALID_PSBT' })
    assert.throws(() => signer.inspect(malformed(raw => { raw.global.unsignedTx.inputs[0].txid.fill(1) }), fixture.policy),
      { code: 'INVALID_PSBT' })
    assert.throws(() => signer.inspect(malformed(raw => { delete raw.inputs[0].witnessUtxo }), fixture.policy),
      { code: 'UNVERIFIED_PREVOUT' })
    assert.throws(() => signer.inspect(malformed(raw => { raw.inputs[0].witnessUtxo.script = key(1, 12).script }), fixture.policy),
      { code: 'INVALID_PSBT' })
  } finally {
    signer.destroy()
  }
})

test('rejects transport aliases and implicit legacy seed derivation', () => {
  assert.throws(() => deriveOnchainSigner(seed, { network: 'utexo' }), { code: 'INVALID_IDENTITY' })
  assert.throws(() => deriveOnchainSigner(seed.subarray(0, 32), { network: 'signet' }), { code: 'INVALID_IDENTITY' })
})

test('finalizes a mixed vanilla and colored burn with BIP341 witness amounts committed for all inputs', () => {
  const signer = deriveOnchainSigner(seed, { network: 'regtest' })
  try {
    const { raw, policy } = psbt('rgb-burn', tx => {
      const vanilla = key(1, 100)
      tx.addInput({
        txid: new Uint8Array(32).fill(61),
        index: 2,
        witnessUtxo: { script: vanilla.script, amount: 80000n },
        tapBip32Derivation: vanilla.tapBip32Derivation
      })
      tx.updateOutput(1, { amount: 179000n })
    })
    const plan = signer.inspect(raw, policy)
    assert.deepEqual(plan.inputs.map(input => input.role), ['colored', 'vanilla'])
    assert.equal(plan.feeSats, '1000')
    const signed = Transaction.fromPSBT(base64.decode(signer.sign(raw, policy, plan)), TxOptions)
    assert.equal(signed.isFinal, true)
    assert.equal(signed.vsize, plan.vsize)
    assert.equal(signed.getInput(1).finalScriptWitness[0].length, 64)
  } finally {
    signer.destroy()
  }
})
