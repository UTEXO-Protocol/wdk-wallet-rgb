// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { Address, NETWORK, OutScript, TEST_NETWORK } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { checkOperationId } from './onchain-journal.js'
import { WalletRuntimeError } from './onchain-runtime-error.js'
import { publicPaymentScript } from './onchain-signer.js'

const MAX_MONEY = 2_100_000_000_000_000n
const MAX_U64 = 0xffff_ffff_ffff_ffffn
const MAX_FEE_RATE = 1_000n
const KEY_HEX = /^[0-9a-f]{64}$/
const ASSET_ID = /^rgb:[A-Za-z0-9~_-]{1,156}$/
const INVOICE_EXPIRY_MARGIN = 600
const OPERATION_LIFETIME = 1800
const MIN_OPERATION_LIFETIME = 330

const BITCOIN_NETWORKS = new Map([
  ['mainnet', NETWORK],
  ['testnet', TEST_NETWORK],
  ['testnet4', TEST_NETWORK],
  ['signet', TEST_NETWORK],
  ['regtest', { ...TEST_NETWORK, bech32: 'bcrt' }]
])

function positiveDecimal (value, maximum, label) {
  if (typeof value === 'bigint') value = value.toString()
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > maximum) {
    throw new TypeError(label + ' must be a positive integer in base units')
  }
  return value
}

export function admitFeeEstimate (result) {
  const feeRate = result?.feeRate
  if (typeof feeRate !== 'string' || !/^[1-9][0-9]{0,19}$/.test(feeRate)) {
    throw new WalletRuntimeError('NATIVE_PROTOCOL', 'Invalid Bitcoin fee estimate')
  }
  if (BigInt(feeRate) > MAX_FEE_RATE) {
    throw new WalletRuntimeError('FEE_UNAVAILABLE', 'The Bitcoin fee estimate exceeds the wallet fee rate limit')
  }
  return { feeRate }
}

function paymentScript (address, network) {
  const params = BITCOIN_NETWORKS.get(network)
  if (!params || typeof address !== 'string' || address.length > 90) {
    throw new TypeError('A valid Bitcoin address for this wallet network is required')
  }
  let script
  try {
    script = hex.encode(OutScript.encode(Address(params).decode(address)))
  } catch {
    throw new TypeError('A valid Bitcoin address for this wallet network is required')
  }
  if (!publicPaymentScript(script)) throw new TypeError('Unsupported Bitcoin destination script')
  return script
}

export function checkRgbInvoice (invoice) {
  if (typeof invoice !== 'string' || !invoice.startsWith('rgb:') || invoice.length > 8192 ||
      new TextEncoder().encode(invoice).length > 8192 || invoice.trim() !== invoice) {
    throw new TypeError('A valid RGB invoice is required')
  }
  return invoice
}

export function checkFeeBlocks (blocks) {
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > 1008) {
    throw new TypeError('Fee estimate target must be between 1 and 1008 blocks')
  }
  return blocks
}

export function prepareBtcSend (request, network) {
  const { operationId, address, amount, feeRate } = request
  checkOperationId(operationId)
  const amountSats = positiveDecimal(amount, MAX_MONEY, 'Bitcoin amount')
  const scriptHex = paymentScript(address, network)
  return {
    args: { address, amount: amountSats, feeRate: positiveDecimal(feeRate, MAX_FEE_RATE, 'Fee rate') },
    expectations: { approvedOutputs: [{ scriptHex, amountSats }] }
  }
}

export function prepareRgbSend (request, decoded, { network, transportEndpoint }, now = Math.floor(Date.now() / 1000)) {
  const { operationId, invoice, assetId, feeRate, minConfirmations = 3, witnessAmountSats } = request
  checkOperationId(operationId)
  checkRgbInvoice(invoice)
  if (typeof assetId !== 'string' || !ASSET_ID.test(assetId)) throw new TypeError('A valid RGB asset ID is required')
  const amount = positiveDecimal(request.amount, MAX_U64, 'RGB amount')
  if (!decoded || decoded.network !== network || (decoded.assetId !== null && decoded.assetId !== assetId) ||
      typeof decoded.recipientId !== 'string' || !decoded.recipientId ||
      !Array.isArray(decoded.transportEndpoints) || decoded.transportEndpoints.length !== 1 ||
      decoded.transportEndpoints[0] !== transportEndpoint || !KEY_HEX.test(decoded.publicKey)) {
    throw new TypeError('Invoice network, asset, proxy or recipient key is outside this wallet profile')
  }
  if (decoded.assignment?.any !== true && decoded.assignment?.fungible !== '0' && decoded.assignment?.fungible !== amount) {
    throw new TypeError('Invoice does not permit the exact fungible amount')
  }
  if (!Number.isInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 255) {
    throw new TypeError('Invalid minimum confirmations')
  }
  if (typeof decoded.expirationTimestamp !== 'string' || !/^[1-9][0-9]{0,15}$/.test(decoded.expirationTimestamp)) {
    throw new TypeError('RGB invoice needs a valid expiry')
  }
  const expiry = Number(decoded.expirationTimestamp)
  const expirationTimestamp = Math.min(expiry - INVOICE_EXPIRY_MARGIN, now + OPERATION_LIFETIME)
  if (!Number.isSafeInteger(expiry) || expirationTimestamp < now + MIN_OPERATION_LIFETIME) {
    throw new TypeError('RGB invoice expires too soon to send safely')
  }
  const approvedOutputs = []
  const args = {
    invoice,
    assetId,
    recipientId: decoded.recipientId,
    amount,
    feeRate: positiveDecimal(feeRate, MAX_FEE_RATE, 'Fee rate'),
    minConfirmations,
    expirationTimestamp: String(expirationTimestamp),
    senderTransportEndpoint: transportEndpoint
  }
  if (decoded.recipientType === 'Witness' && typeof decoded.witnessScriptHex === 'string' &&
      publicPaymentScript(decoded.witnessScriptHex)) {
    args.witnessAmountSat = positiveDecimal(witnessAmountSats, MAX_MONEY, 'Witness output amount')
    approvedOutputs.push({ scriptHex: decoded.witnessScriptHex, amountSats: args.witnessAmountSat })
  } else if (decoded.recipientType !== 'Blind' || decoded.witnessScriptHex !== null || witnessAmountSats !== undefined) {
    throw new TypeError('Explicit witness value is required only for a supported witness invoice')
  }
  return { args, expectations: { approvedOutputs } }
}

export function sendRecoveryParams (record) {
  if (!record || !['btc-send', 'rgb-send'].includes(record.kind) || !['submitting', 'submitted', 'failed'].includes(record.stage)) {
    throw new WalletRuntimeError('SEND_UNAVAILABLE', 'No matching submitted wallet send is recorded')
  }
  if (typeof record.txid !== 'string' || !KEY_HEX.test(record.txid)) {
    throw new WalletRuntimeError('JOURNAL_CORRUPT', 'Saved send has an invalid transaction ID')
  }
  const result = { kind: record.kind, txid: record.txid }
  if (record.kind === 'rgb-send') {
    if (!record.args || typeof record.args.assetId !== 'string' || !ASSET_ID.test(record.args.assetId) ||
        typeof record.args.recipientId !== 'string' || !record.args.recipientId ||
        !Number.isInteger(record.batchTransferIdx) || record.batchTransferIdx < 1 || record.batchTransferIdx > 0x7fff_ffff) {
      throw new WalletRuntimeError('JOURNAL_CORRUPT', 'Saved RGB send has an invalid transfer identity')
    }
    const amount = positiveDecimal(record.args.amount, MAX_U64, 'Saved RGB amount')
    Object.assign(result, { assetId: record.args.assetId, recipientId: record.args.recipientId, amount, batchTransferIdx: record.batchTransferIdx })
  }
  return result
}

export function admitSendStatus (result, expected) {
  if (!result || result.kind !== expected.kind || result.txid !== expected.txid ||
      (result.batchTransferIdx ?? undefined) !== expected.batchTransferIdx ||
      !['submitted', 'failed', 'unresolved'].includes(result.state) ||
      (result.state === 'failed' && expected.kind !== 'rgb-send')) {
    throw new WalletRuntimeError('SEND_STATUS_MISMATCH', 'Native send status did not match the recorded operation')
  }
  return { state: result.state, txid: result.txid, ...(expected.batchTransferIdx && { batchTransferIdx: expected.batchTransferIdx }) }
}
