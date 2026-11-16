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

test('RGB sends keep the sender proxy when the recipient selects a different proxy', () => {
  for (const [network, sender, recipient] of [
    ['regtest', transportEndpoint, 'rpc://127.0.0.1:49091/json-rpc'],
    ['signet', 'rpcs://staging.rgb-proxy.utexo.com/json-rpc', 'rpcs://recipient.example.com/json-rpc'],
    ['mainnet', 'rpcs://sender.example.com/json-rpc', 'rpcs://recipient.example.com:8443/json-rpc']
  ]) {
    const decoded = { ...invoice, network, transportEndpoints: [recipient] }
    for (const type of ['Blind', 'Witness']) {
      const witness = type === 'Witness'
      const result = prepareRgbSend({ ...request, ...(witness && { witnessAmountSats: '546' }) }, {
        ...decoded, recipientType: type, witnessScriptHex: witness ? scriptHex : null
      }, { network, transportEndpoint: sender }, 1000)
      assert.equal(result.args.senderTransportEndpoint, sender)
      assert.equal(result.args.invoice, request.invoice)
      assert.equal(result.args.recipientId, decoded.recipientId)
    }
  }
})

test('Signet recipient proxies require valid TLS URLs and a single endpoint', () => {
  const transportEndpoint = 'rpcs://staging.rgb-proxy.utexo.com/json-rpc'
  const staging = { network: 'signet', transportEndpoint }
  const publicInvoice = { ...invoice, network: 'signet', recipientId: 'sb:utxob:fixture', transportEndpoints: [transportEndpoint] }
  assert.equal(prepareRgbSend(request, publicInvoice, staging, 1000).args.recipientId, 'sb:utxob:fixture')
  for (const decoded of [
    { ...publicInvoice, network: 'signetcustom', recipientId: 'sbc:utxob:fixture' },
    ...[
      'rpc://recipient.example.com/json-rpc', 'https://recipient.example.com/json-rpc',
      'rpcs://user:secret@recipient.example.com/json-rpc', 'rpcs://recipient.example.com:0/json-rpc',
      'rpcs://recipient.example.com/json-rpc?', 'rpcs://recipient.example.com/json-rpc#fragment',
      'rpcs://recipient.example.com/json-rpc,other', 'rpcs://recipient.example.com/%2fjson-rpc',
      'rpcs://recipient.example.com/white space', 'rpcs://recipient.example.com/line\nfeed',
      'rpcs://recipient.example.com\\other', 'rpcs://127.0.0.1/json-rpc',
      'rpcs://0x7f000001/json-rpc', 'rpcs://[::1]/json-rpc', 'rpcs://localhost/json-rpc',
      'rpcs://proxy.local/json-rpc', 'rpcs://proxy.internal/json-rpc', null, {}
    ].map(endpoint => ({ ...publicInvoice, transportEndpoints: [endpoint] })),
    { ...publicInvoice, transportEndpoints: [] },
    { ...publicInvoice, transportEndpoints: [transportEndpoint, invoice.transportEndpoints[0]] }
  ]) {
    assert.throws(() => prepareRgbSend(request, decoded, staging, 1000), /outside this wallet profile/)
  }
})

test('Regtest recipient proxies stay on loopback even when distinct from the sender', () => {
  for (const endpoint of [
    'rpc://127.0.0.1:49091/json-rpc', 'rpc://localhost:49091/json-rpc', 'rpcs://[::1]:49091/json-rpc'
  ]) assert.doesNotThrow(() => prepareRgbSend(request, { ...invoice, transportEndpoints: [endpoint] }, target, 1000))
  for (const endpoint of [
    'rpc://recipient.example.com/json-rpc', 'rpcs://recipient.example.com/json-rpc',
    'rpc://127.0.0.2:49091/json-rpc', 'rpc://user@127.0.0.1:49091/json-rpc',
    'rpc://127.0.0.1:49091/json-rpc?', 'rpc://127.0.0.1:49091/json-rpc#fragment',
    'rpc://127.0.0.1:49091/%2fjson-rpc', 'rpc://127.0.0.1:49091/json-rpc,other'
  ]) assert.throws(() => prepareRgbSend(request, { ...invoice, transportEndpoints: [endpoint] }, target, 1000), /outside this wallet profile/)
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
