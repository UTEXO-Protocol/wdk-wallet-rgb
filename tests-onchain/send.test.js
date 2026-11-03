// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { Address, TEST_NETWORK } from '@scure/btc-signer'
import { admitSendStatus, checkFeeBlocks, prepareBtcSend, prepareRgbSend, sendRecoveryParams } from '../src/onchain-send.js'

const operationId = 'fixture-payment-001'
const transportEndpoint = 'rpc://127.0.0.1:49090/json-rpc'
const assetId = 'rgb:LlN6od33-ezLHwEH-qsxtyTo-jh2AQDh-~9nIJZo-9Arhk24'
const target = { network: 'regtest', transportEndpoint }
const program = new Uint8Array(20).fill(0x42)
const scriptHex = '0014' + '42'.repeat(20)
const address = Address({ ...TEST_NETWORK, bech32: 'bcrt' }).encode({ type: 'wpkh', hash: program })

const request = { operationId, assetId, invoice: 'rgb:invoice', amount: 10n, feeRate: 2n }
const invoice = {
  network: 'regtest',
  assetId,
  recipientId: 'bcrt:utxob:fixture',
  transportEndpoints: [transportEndpoint],
  publicKey: 'ab'.repeat(32),
  assignment: { fungible: '10' },
  recipientType: 'Blind',
  witnessScriptHex: null,
  expirationTimestamp: '4000'
}

test('Bitcoin send binds the exact requested destination and bigint amount', () => {
  const args = { operationId, address, amount: 546n, feeRate: '2' }
  assert.deepEqual(prepareBtcSend(args, 'regtest'), {
    args: { address, amount: '546', feeRate: '2' },
    expectations: { approvedOutputs: [{ scriptHex, amountSats: '546' }] }
  })
  assert.throws(() => prepareBtcSend(args, 'mainnet'), /valid Bitcoin address/)
  assert.throws(() => prepareBtcSend({ ...args, amount: 546 }, 'regtest'), /integer in base units/)
  assert.throws(() => prepareBtcSend({ ...args, feeRate: '01' }, 'regtest'), /integer in base units/)
  assert.throws(() => prepareBtcSend({ ...args, operationId: 'replay' }, 'regtest'), /stable/)
  assert.equal(checkFeeBlocks(6), 6)
  assert.throws(() => checkFeeBlocks(1009), /between/)
})

test('RGB send binds a proxy invoice with exact recipient type, amount and expiry', () => {
  const blind = prepareRgbSend(request, invoice, target, 1000)
  assert.deepEqual(blind, {
    args: {
      invoice: request.invoice,
      assetId,
      recipientId: invoice.recipientId,
      amount: '10',
      feeRate: '2',
      minConfirmations: 3,
      expirationTimestamp: '2800',
      senderTransportEndpoint: transportEndpoint
    },
    expectations: { approvedOutputs: [] }
  })
  const witness = { ...invoice, recipientType: 'Witness', witnessScriptHex: scriptHex }
  assert.deepEqual(
    prepareRgbSend({ ...request, witnessAmountSats: 546n }, witness, target, 1000).expectations,
    { approvedOutputs: [{ scriptHex, amountSats: '546' }] }
  )
  assert.throws(() => prepareRgbSend(request, witness, target, 1000), /Witness output amount/)
  assert.throws(() => prepareRgbSend({ ...request, witnessAmountSats: '546' }, invoice, target, 1000), /witness value/)
  assert.throws(() => prepareRgbSend({ ...request, amount: '11' }, invoice, target, 1000), /exact fungible amount/)
  assert.throws(() => prepareRgbSend(request, { ...invoice, network: 'signet' }, target, 1000), /outside this wallet profile/)
  assert.throws(() => prepareRgbSend(request, { ...invoice, transportEndpoints: ['rpcs://example.test/json-rpc'] }, target, 1000), /outside this wallet profile/)
  assert.throws(() => prepareRgbSend(request, { ...invoice, expirationTimestamp: '1900' }, target, 1000), /expires too soon/)
  assert.doesNotThrow(() => prepareRgbSend(request, { ...invoice, assignment: { any: true }, assetId: null }, target, 1000))
})

test('staging send accepts only public Signet invoices on the exact staging proxy', () => {
  const transportEndpoint = 'rpcs://staging.rgb-proxy.utexo.com/json-rpc'
  const staging = { network: 'signet', transportEndpoint }
  const publicInvoice = { ...invoice, network: 'signet', recipientId: 'sb:utxob:fixture', transportEndpoints: [transportEndpoint] }
  assert.equal(prepareRgbSend(request, publicInvoice, staging, 1000).args.recipientId, 'sb:utxob:fixture')
  for (const decoded of [
    { ...publicInvoice, network: 'signetcustom', recipientId: 'sbc:utxob:fixture' },
    { ...publicInvoice, transportEndpoints: ['rpcs://rgb-proxy.utexo.com/json-rpc'] },
    { ...publicInvoice, transportEndpoints: [transportEndpoint, invoice.transportEndpoints[0]] }
  ]) {
    assert.throws(() => prepareRgbSend(request, decoded, staging, 1000), /outside this wallet profile/)
  }
})

test('send recovery accepts evidence only for the same durable transaction and RGB batch', () => {
  const txid = 'ab'.repeat(32)
  const record = {
    kind: 'rgb-send',
    txid,
    args: { assetId, recipientId: invoice.recipientId, amount: '10' },
    stage: 'submitting',
    batchTransferIdx: 5
  }
  const params = sendRecoveryParams(record)
  assert.deepEqual(params, {
    kind: 'rgb-send', txid, assetId, recipientId: invoice.recipientId, amount: '10', batchTransferIdx: 5
  })
  assert.deepEqual(admitSendStatus({ ...params, state: 'unresolved' }, params), {
    state: 'unresolved', txid, batchTransferIdx: 5
  })
  assert.throws(() => admitSendStatus({ ...params, state: 'submitted', batchTransferIdx: 6 }, params), { code: 'SEND_STATUS_MISMATCH' })
  assert.throws(() => admitSendStatus({ ...params, state: 'submitted', txid: 'cd'.repeat(32) }, params), { code: 'SEND_STATUS_MISMATCH' })
  assert.throws(() => sendRecoveryParams({ ...record, stage: 'prepared' }), { code: 'SEND_UNAVAILABLE' })
})
