// Copyright 2026 UTEXO.
// SPDX-License-Identifier: Apache-2.0

import { base64, hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { p2tr, Transaction } from '@scure/btc-signer'
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js'
import { sha256 } from '@noble/hashes/sha2.js'

const HARDENED = 0x80000000
const MAX_INDEX = HARDENED - 1
const MAX_MONEY = BigInt('2100000000000000')
const MAX_PSBT_BYTES = 1024 * 1024
const MAX_PSBT_BASE64 = 4 * Math.ceil(MAX_PSBT_BYTES / 3)
const MAX_ITEMS = 256
const NETWORKS = ['mainnet', 'testnet', 'testnet4', 'signet', 'regtest']
const KINDS = ['btc-send', 'rgb-output', 'rgb-send', 'rgb-burn']
// All inputs use SIGHASH_DEFAULT. Its BIP341 digest commits to every previous
// amount/script as well as the outputs, even when the PSBT lacks full prevtxs.
const SIGHASH_DEFAULT = 0
const TX_OPTIONS = Object.freeze({ allowUnknownOutputs: true, unknown: 'strict', proprietary: 'ignore' })

export class OnchainSigningError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'OnchainSigningError'
    this.code = code
  }
}

function refuse (code, message) {
  throw new OnchainSigningError(code, message)
}

function equal (a, b) {
  return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length &&
    a.every((byte, index) => byte === b[index])
}

function amount (value, code, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) {
    refuse(code, 'Amounts must be canonical decimal satoshi strings.')
  }
  const sats = BigInt(value)
  if (sats > MAX_MONEY || (positive && sats === BigInt(0))) refuse(code, 'Amount is outside the permitted range.')
  return sats
}

function ownedChild (key, index) {
  const derived = key.deriveChild(index)
  // BIP32 permits a derivation to skip an invalid child. A reviewed PSBT must
  // describe the exact child whose public key and script will be used.
  if (derived.index !== index) {
    derived.wipePrivateData()
    refuse('UNSUPPORTED_KEY', 'Key derivation did not produce the requested child.')
  }
  return derived
}

function branchKey (root, coin) {
  const intermediates = []
  try {
    let key = root
    for (const index of [HARDENED + 86, HARDENED + coin, HARDENED, 0]) {
      key = ownedChild(key, index)
      intermediates.push(key)
    }
    const xpub = intermediates[2].publicExtendedKey
    const publicKey = HDKey.fromExtendedKey(key.publicExtendedKey, root.versions)
    intermediates.pop()
    return { xpub, publicKey, privateKey: key }
  } finally {
    for (const key of intermediates) key.wipePrivateData()
  }
}

function publicPaymentScript (script) {
  return /^(?:0014[0-9a-f]{40}|0020[0-9a-f]{64}|5120[0-9a-f]{64}|76a914[0-9a-f]{40}88ac|a914[0-9a-f]{40}87)$/.test(script)
}

/**
 * @typedef {{index: number, scriptHex: string, amountSats: string}} ApprovedOutput
 * @typedef {{
 *   kind: 'btc-send'|'rgb-output'|'rgb-send'|'rgb-burn',
 *   maxFeeSats: string,
 *   approvedOutputs: readonly ApprovedOutput[],
 *   expectedColorableOutputs?: {count: number, amountSats: string}
 * }} OnchainSigningExpectation
 */

/** @param {OnchainSigningExpectation} expectation */
function normalizeExpectation (expectation) {
  if (!expectation || !KINDS.includes(expectation.kind) ||
      !Array.isArray(expectation.approvedOutputs) || expectation.approvedOutputs.length > 1) {
    refuse('INVALID_EXPECTATION', 'The reviewed transaction policy is invalid.')
  }
  const { kind } = expectation
  const maxFee = amount(expectation.maxFeeSats, 'INVALID_EXPECTATION', true)
  const approved = Array.from(expectation.approvedOutputs, output => {
    if (!output || !Number.isInteger(output.index) || output.index < 0 || output.index >= MAX_ITEMS ||
        typeof output.scriptHex !== 'string' || !publicPaymentScript(output.scriptHex)) {
      refuse('INVALID_EXPECTATION', 'The reviewed payment output is invalid.')
    }
    return { index: output.index, scriptHex: output.scriptHex, amountSats: amount(output.amountSats, 'INVALID_EXPECTATION', true).toString() }
  })
  if ((kind === 'btc-send' && approved.length !== 1) ||
      ((kind === 'rgb-output' || kind === 'rgb-burn') && approved.length !== 0)) {
    refuse('INVALID_EXPECTATION', 'The reviewed payment outputs do not match this operation.')
  }
  const setup = expectation.expectedColorableOutputs
  let colorable = null
  if (kind === 'rgb-output') {
    if (!setup || !Number.isInteger(setup.count) || setup.count < 1 || setup.count >= MAX_ITEMS) {
      refuse('INVALID_EXPECTATION', 'Review the number and value of the colorable outputs.')
    }
    colorable = { count: setup.count, amountSats: amount(setup.amountSats, 'INVALID_EXPECTATION', true).toString() }
  } else if (setup !== undefined) {
    refuse('INVALID_EXPECTATION', 'Colorable output creation requires a separate review.')
  }
  return { kind, maxFeeSats: maxFee.toString(), approved, colorable }
}

function readPsbt (psbt) {
  if (typeof psbt !== 'string' || psbt.length === 0 || psbt.length > MAX_PSBT_BASE64 || psbt.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(psbt)) {
    refuse('INVALID_PSBT', 'The wallet returned an invalid or oversized PSBT.')
  }
  try {
    const bytes = base64.decode(psbt)
    if (bytes.length > MAX_PSBT_BYTES || base64.encode(bytes) !== psbt) throw new Error()
    const raw = RawPSBTV0.decode(bytes)
    const tx = Transaction.fromPSBT(bytes, TX_OPTIONS)
    if ((raw.global.version !== undefined && raw.global.version !== 0) ||
        tx.inputsLength === 0 || tx.inputsLength > MAX_ITEMS || tx.outputsLength === 0 || tx.outputsLength > MAX_ITEMS ||
        raw.inputs.length !== tx.inputsLength || raw.outputs.length !== tx.outputsLength) throw new Error()
    return { raw, tx, digest: hex.encode(sha256(bytes)) }
  } catch {
    refuse('INVALID_PSBT', 'The wallet returned an invalid or unsupported PSBT.')
  }
}

function checkAmountSum (sum) {
  if (sum > MAX_MONEY) refuse('INVALID_PSBT', 'The transaction amount is outside the Bitcoin range.')
}

/**
 * Derive an in-process, revocable BIP86 signer for the on-chain wallet.
 *
 * Accept only normalized 64-byte BIP39 seed material. The caller owns that
 * input buffer and its lifetime. Native receives only identity (public xpubs
 * and fingerprint); it never receives an xpriv, seed or mnemonic. No general
 * PSBT signing surface should be exposed to a dApp. Only a trusted wallet
 * integration may hold this signer and must authorize the reviewed plan.
 *
 * @param {Uint8Array} seedBytes
 * @param {{network: string}} options
 */
export function deriveOnchainSigner (seedBytes, { network } = {}) {
  if (!(seedBytes instanceof Uint8Array) || seedBytes.length !== 64 || !NETWORKS.includes(network)) {
    refuse('INVALID_IDENTITY', 'A supported network and normalized 64-byte wallet seed are required.')
  }
  const coins = network === 'mainnet' ? { vanilla: 0, colored: 827166 } : { vanilla: 1, colored: 827167 }
  const versions = network === 'mainnet' ? { private: 0x0488ade4, public: 0x0488b21e } : { private: 0x04358394, public: 0x043587cf }
  const seed = Uint8Array.from(seedBytes)
  let root
  let vanilla
  let colored
  let fingerprint
  try {
    root = HDKey.fromMasterSeed(seed, versions)
    fingerprint = root.fingerprint
    vanilla = branchKey(root, coins.vanilla)
    colored = branchKey(root, coins.colored)
  } catch {
    vanilla?.privateKey?.wipePrivateData()
    colored?.privateKey?.wipePrivateData()
    refuse('INVALID_IDENTITY', 'The wallet signing identity could not be derived.')
  } finally {
    seed.fill(0)
    root?.wipePrivateData()
  }

  const identity = Object.freeze({
    network,
    accountXpubVanilla: vanilla.xpub,
    accountXpubColored: colored.xpub,
    masterFingerprint: fingerprint.toString(16).padStart(8, '0')
  })
  let active = true
  let reviews = new WeakMap()
  const branches = { vanilla, colored }
  const assertActive = () => {
    if (!active) refuse('SIGNER_CLOSED', 'The wallet signer is closed.')
  }

  function owner (metadata, script) {
    // No key path with a script tree, legacy signing, or ambiguous key origin.
    if (metadata.tapTree !== undefined || metadata.tapMerkleRoot !== undefined ||
        metadata.redeemScript !== undefined || metadata.witnessScript !== undefined ||
        metadata.bip32Derivation !== undefined) {
      refuse('UNSUPPORTED_KEY', 'Only single key-path Taproot wallet scripts are supported.')
    }
    const entries = metadata.tapBip32Derivation
    if (!Array.isArray(entries) || entries.length !== 1) refuse('UNVERIFIED_KEY', 'A wallet derivation is missing or ambiguous.')
    const [reported, origin] = entries[0]
    const { fingerprint: rootFingerprint, path } = origin.der
    if (origin.hashes.length !== 0 || rootFingerprint !== fingerprint || path.length !== 5 ||
        path[0] !== HARDENED + 86 || path[2] !== HARDENED || path[3] !== 0 || path[4] > MAX_INDEX) {
      refuse('UNVERIFIED_KEY', 'The transaction does not identify a supported wallet key.')
    }
    const rail = path[1] === HARDENED + coins.vanilla ? 'vanilla' : path[1] === HARDENED + coins.colored ? 'colored' : null
    if (!rail) refuse('UNVERIFIED_KEY', 'The transaction does not identify a wallet account.')
    const publicKey = ownedChild(branches[rail].publicKey, path[4]).publicKey.subarray(1)
    if (!equal(reported, publicKey) ||
        (metadata.tapInternalKey !== undefined && !equal(metadata.tapInternalKey, publicKey)) ||
        !equal(p2tr(publicKey).script, script)) {
      refuse('UNVERIFIED_KEY', 'A transaction script does not match its wallet derivation.')
    }
    return { rail, index: path[4], publicKey }
  }

  function evaluate (psbt, expectation) {
    assertActive()
    const policy = normalizeExpectation(expectation)
    const packet = readPsbt(psbt)
    const { raw, tx } = packet
    const inputs = []
    const outputs = []
    const outpoints = new Set()
    const rgb = policy.kind === 'rgb-burn' || policy.kind === 'rgb-send'
    let markerCount = 0
    let colorableCount = 0
    let totalInput = BigInt(0)
    let totalOutput = BigInt(0)
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i)
      const map = raw.inputs[i]
      if (map.partialSig !== undefined || map.tapKeySig !== undefined || map.tapScriptSig !== undefined ||
          map.tapLeafScript !== undefined || map.finalScriptWitness !== undefined || map.finalScriptSig !== undefined ||
          map.p2cKeyTweak !== undefined || map.musig2ParticipantPubkeys !== undefined ||
          map.musig2PubNonce !== undefined || map.musig2PartialSig !== undefined ||
          (input.sighashType !== undefined && input.sighashType !== SIGHASH_DEFAULT)) {
        refuse('UNSAFE_INPUT', 'A wallet input has an unsupported signature, script path or sighash.')
      }
      const prev = input.witnessUtxo
      if (!prev || prev.amount <= BigInt(0) || prev.amount > MAX_MONEY || !input.txid ||
          !Number.isInteger(input.index) || input.index < 0 || input.index === 0xffffffff ||
          !input.txid.some(byte => byte !== 0)) {
        refuse('UNVERIFIED_PREVOUT', 'The transaction has an invalid previous output.')
      }
      // Transaction.fromPSBT also validates the full previous transaction's
      // txid, selected output amount and selected script whenever supplied.
      const outpoint = `${hex.encode(input.txid)}:${input.index}`
      if (outpoints.has(outpoint)) refuse('UNSAFE_INPUT', 'The transaction spends the same input more than once.')
      outpoints.add(outpoint)
      const key = owner(input, prev.script)
      if (!rgb && key.rail !== 'vanilla') refuse('UNSAFE_INPUT', 'This operation cannot spend colorable Bitcoin inputs.')
      totalInput += prev.amount
      checkAmountSum(totalInput)
      inputs.push({ key, outpoint, amountSats: prev.amount.toString() })
    }
    if (rgb && !inputs.some(input => input.key.rail === 'colored')) {
      refuse('UNSAFE_INPUT', 'An RGB spend must include a colorable wallet input.')
    }

    for (let i = 0; i < tx.outputsLength; i++) {
      const output = tx.getOutput(i)
      if (output.amount < BigInt(0) || output.amount > MAX_MONEY || !output.script) {
        refuse('INVALID_PSBT', 'The transaction contains an invalid output.')
      }
      totalOutput += output.amount
      checkAmountSum(totalOutput)
      const scriptHex = hex.encode(output.script)
      const amountSats = output.amount.toString()
      const approved = policy.approved.find(entry => entry.index === i)
      let role
      if (approved) {
        if (approved.scriptHex !== scriptHex || approved.amountSats !== amountSats) {
          refuse('OUTPUT_MISMATCH', 'A payment output differs from the reviewed destination or amount.')
        }
        role = 'approved'
      } else if (scriptHex.startsWith('6a')) {
        if (!rgb || i !== 0 || !/^6a20[0-9a-f]{64}$/.test(scriptHex) || output.amount !== BigInt(0)) {
          refuse('OUTPUT_MISMATCH', 'The transaction contains an unexpected commitment output.')
        }
        markerCount++
        role = 'rgb-commitment'
      } else {
        if (output.amount <= BigInt(0)) refuse('OUTPUT_MISMATCH', 'A wallet output must have positive value.')
        const key = owner(output, output.script)
        if (key.rail === 'colored') {
          if (policy.kind === 'btc-send') refuse('OUTPUT_MISMATCH', 'This payment cannot create a colorable wallet output.')
          if (policy.colorable && policy.colorable.amountSats !== amountSats) {
            refuse('OUTPUT_MISMATCH', 'A colorable output differs from the reviewed value.')
          }
          colorableCount++
        }
        role = key.rail
      }
      outputs.push(Object.freeze({ index: i, scriptHex, amountSats, role }))
    }
    if (policy.approved.some(entry => entry.index >= tx.outputsLength) ||
        markerCount !== (rgb ? 1 : 0) ||
        (policy.colorable && policy.colorable.count !== colorableCount)) {
      refuse('OUTPUT_MISMATCH', 'The transaction is missing an output required by the review.')
    }
    const fee = totalInput - totalOutput
    if (fee <= BigInt(0) || fee > BigInt(policy.maxFeeSats) || tx.fee !== fee) {
      refuse('FEE_POLICY', 'The transaction fee is outside the reviewed limit.')
    }
    // Exact final vsize for one SIGHASH_DEFAULT 64-byte signature per input:
    // marker+flag (2), then each witness count + item length + signature (66).
    const vsize = Math.ceil((tx.unsignedTx.length * 4 + 2 + 66 * inputs.length) / 4)
    const plan = Object.freeze({
      kind: policy.kind,
      psbtSha256: packet.digest,
      txid: tx.id,
      feeSats: fee.toString(),
      vsize,
      inputs: Object.freeze(inputs.map(({ key, outpoint, amountSats }) => Object.freeze({ outpoint, amountSats, role: key.rail }))),
      outputs: Object.freeze(outputs)
    })
    return { ...packet, inputs, plan, policy: JSON.stringify(policy) }
  }

  return Object.freeze({
    identity,
    /** @param {string} psbt @param {OnchainSigningExpectation} expectation */
    inspect (psbt, expectation) {
      const admitted = evaluate(psbt, expectation)
      reviews.set(admitted.plan, admitted.policy)
      return admitted.plan
    },
    /**
     * Requires the exact in-process plan produced by inspect, after the caller
     * has authorized it. Only final Taproot witnesses are added to original maps.
     * Never sends a transaction or serializes private material.
     *
     * @param {string} psbt
     * @param {OnchainSigningExpectation} expectation
     * @param {{psbtSha256: string}} reviewedPlan
     */
    sign (psbt, expectation, reviewedPlan) {
      assertActive()
      const reviewedPolicy = reviews.get(reviewedPlan)
      if (reviewedPolicy === undefined) refuse('REVIEW_REQUIRED', 'An unused wallet transaction review is required.')
      const { raw, tx, inputs, plan, policy } = evaluate(psbt, expectation)
      if (reviewedPlan.psbtSha256 !== plan.psbtSha256 || reviewedPolicy !== policy) {
        refuse('REVIEW_MISMATCH', 'The PSBT or signing policy changed after review.')
      }
      reviews.delete(reviewedPlan)
      try {
        const unsigned = tx.unsignedTx
        for (const [i, { key }] of inputs.entries()) {
          const child = ownedChild(branches[key.rail].privateKey, key.index)
          const secret = child.privateKey
          try {
            // Some builders only supply the key origin. Add the independently
            // verified internal key to the local signing object in that case.
            if (tx.getInput(i).tapInternalKey === undefined) tx.updateInput(i, { tapInternalKey: key.publicKey })
            if (!tx.signIdx(secret, i, [SIGHASH_DEFAULT])) throw new Error()
            const tapKeySig = tx.getInput(i).tapKeySig
            if (tapKeySig?.length !== 64) throw new Error()
          } finally {
            secret?.fill(0)
            child.wipePrivateData()
          }
        }
        tx.finalize()
        if (!equal(tx.unsignedTx, unsigned) || tx.vsize !== plan.vsize) throw new Error()
        // End APIs extract the final Bitcoin tx from this PSBT. Preserve RGB
        // proprietary keys and every original map and insert finalized witness.
        const signedInputs = raw.inputs.map((input, i) => {
          const finalScriptWitness = tx.getInput(i).finalScriptWitness
          if (finalScriptWitness?.length !== 1 || finalScriptWitness[0].length !== 64) throw new Error()
          return { ...input, finalScriptWitness }
        })
        const signed = RawPSBTV0.encode({ ...raw, inputs: signedInputs })
        const checked = Transaction.fromPSBT(signed, TX_OPTIONS)
        if (!equal(checked.unsignedTx, unsigned) || checked.id !== plan.txid ||
            checked.fee.toString() !== plan.feeSats || checked.vsize !== plan.vsize ||
            !equal(checked.extract(), tx.extract())) throw new Error()
        return base64.encode(signed)
      } catch {
        refuse('SIGNING_FAILED', 'The reviewed transaction could not be signed safely.')
      }
    },
    destroy () {
      active = false
      reviews = new WeakMap()
      vanilla.privateKey?.wipePrivateData()
      colored.privateKey?.wipePrivateData()
      vanilla.privateKey = null
      colored.privateKey = null
    }
  })
}
