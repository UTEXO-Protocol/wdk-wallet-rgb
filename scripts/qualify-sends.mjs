// SPDX-License-Identifier: Apache-2.0
// Funded test for the Node SDK against a fresh isolated test issuer.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import WalletManagerRgb, { burnDestinationFor } from '@utexo/wdk-wallet-rgb'

const { OnchainWorker } = await import(new URL('./src/onchain-worker.js', import.meta.resolve('@utexo/wdk-wallet-rgb')))

const [nativeFile, fixtureRoot, outputDir] = process.argv.slice(2)
assert(nativeFile && fixtureRoot && outputDir, 'Pass native executable, isolated fixture, and fresh output directory')
const nativeExecutable = await fs.realpath(resolve(nativeFile))
const nativeSha256 = createHash('sha256').update(await fs.readFile(nativeExecutable)).digest('hex')
const fixture = await fs.realpath(resolve(fixtureRoot))
assert(fixture.endsWith('/send-qualification/fixture'), 'The funded test needs a dedicated send fixture')
await fs.mkdir(resolve(outputDir), { mode: 0o700 })
const out = await fs.realpath(resolve(outputDir))
const chain = JSON.parse(await fs.readFile(join(fixture, 'runtime/chain.json')))
assert.equal(chain.electrumUrl, 'tcp://127.0.0.1:49002')
assert.equal(chain.evmRpc, 'http://127.0.0.1:49545')
assert.equal(chain.proxyEndpoint, 'rpc://127.0.0.1:49090/json-rpc')
const issued = JSON.parse(await fs.readFile(join(fixture, 'runtime/issuer-public.json')))
const assetId = issued.assetId
const transportEndpoint = chain.proxyEndpoint
const burnRecipient = { chainId: 'eip155:42161', address: '0x1111111111111111111111111111111111111111' }
const burnDestinationRoutes = [{ chainId: burnRecipient.chainId, dstEid: 0 }]
const burnDestination = burnDestinationFor(burnRecipient, burnDestinationRoutes)

function python (args, options) {
  const child = spawnSync('python3', args, { encoding: 'utf8', timeout: 120000, ...options })
  assert.equal(child.status, 0, child.stderr?.trim() || child.error?.message)
  return JSON.parse(child.stdout)
}
function control (...args) { return python([join(fixture, 'fixture.py'), ...args]) }
function issuer (command, request, ...args) {
  return python([join(fixture, 'issuer.py'), command, ...args], request ? { input: JSON.stringify(request) } : undefined)
}
function mempool () {
  return python(['-c', 'from fixture import BTC,rpc; import json; print(json.dumps(rpc(BTC, "getrawmempool")))'],
    { cwd: fixture })
}
async function checkpoint (name, data) {
  await fs.writeFile(join(out, name + '.json'), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.error('Passed ' + name)
}

const seeds = { sender: randomBytes(64), receiver: randomBytes(64) }
const managers = new Map()
const reviewed = new Map()
let declineId
function approval (review) {
  if (reviewed.has(review.operationId)) throw new Error('Repeated approval prompt for one operation ID')
  reviewed.set(review.operationId, review)
  return review.operationId !== declineId
}
async function open (name) {
  const manager = new WalletManagerRgb(seeds[name], {
    network: 'regtest',
    dataDir: join(out, name),
    indexerUrl: chain.electrumUrl,
    nativeExecutable,
    nativeSha256,
    transportEndpoint,
    evmRpcUrls: { [chain.evmChainId]: chain.evmRpc },
    burnDestinationRoutes,
    maxFeeSats: 5000n,
    authorize: approval
  })
  managers.set(name, manager)
  return manager.getAccount()
}
async function restart (name) {
  await managers.get(name).dispose()
  return open(name)
}
async function interruptAfterSubmission (id, submit) {
  const request = OnchainWorker.prototype.request
  let injected = false
  OnchainWorker.prototype.request = function (method, params) {
    if (method === 'writeJournalRecord' && params?.record?.id === id && params.record.stage === 'submitted') {
      injected = true
      return Promise.reject(Object.assign(new Error('Fixture interrupted before final journal write'), { code: 'EIO' }))
    }
    return request.call(this, method, params)
  }
  try {
    await assert.rejects(submit(), { code: 'EIO' })
  } finally {
    OnchainWorker.prototype.request = request
  }
  assert(injected, id)
}
async function waitFor (description, condition) {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error('Timed out waiting for ' + description)
}
async function assertRgbBalance (account, amount) {
  await waitFor('spendable RGB balance ' + amount, async () => {
    await account.refresh(assetId)
    return (await account.getAssetBalance(assetId)).spendable === amount
  })
}
async function settleSend (sender, receiver, txid) {
  await waitFor('RGB send broadcast', async () => {
    await receiver.refresh(assetId)
    await sender.refresh(assetId)
    return mempool().includes(txid)
  })
  control('mine', '3')
  await receiver.refresh(assetId)
  await sender.refresh(assetId)
  const receipt = control('tx', txid)
  assert(receipt.confirmations >= 3)
  return receipt
}

try {
  let sender = await open('sender')
  const receiver = await open('receiver')
  const senderAddress = await sender.getAddress()
  const receiverAddress = await receiver.getAddress()
  const nonce = randomBytes(4).toString('hex')
  for (const [name, addr] of [['sender', senderAddress], ['receiver', receiverAddress]]) {
    const funding = control('fund', addr, '2000000', name + '-' + nonce)
    assert.equal(funding.sats, 2_000_000)
  }

  const btcOperationId = 'funded-btc-send-001'
  const btcRequest = { operationId: btcOperationId, address: receiverAddress, amount: 20_000n, feeRate: 2n }
  const insufficient = 'funded-btc-insufficient'
  await assert.rejects(sender.sendBtc({ ...btcRequest, operationId: insufficient, amount: 3_000_000n }), { code: 'SEND_NOT_PREPARED' })
  assert.equal((await sender.getOperation(insufficient)).stage, 'declined')
  assert.equal(reviewed.has(insufficient), false)
  await interruptAfterSubmission(btcOperationId, () => sender.sendBtc(btcRequest))
  const btcPending = await sender.getOperation(btcOperationId)
  assert.equal(btcPending.stage, 'submitting')
  assert(mempool().includes(btcPending.txid))
  control('mine', '3')
  sender = await restart('sender')
  assert.deepEqual(await sender.recoverSend(btcOperationId), { state: 'submitted', txid: btcPending.txid })
  await assert.rejects(sender.sendBtc(btcRequest), { code: 'OPERATION_EXISTS' })
  assert.equal((await receiver.getBtcBalance()).vanilla.spendable, '2020000')
  await checkpoint('btc-send', { nativeSha256, txid: btcPending.txid, feeSats: reviewed.get(btcOperationId).plan.feeSats, amount: '20000', recovery: 'submitted' })

  const cancelId = 'funded-output-abandoned'
  const outputReview = await sender.prepareCreateUtxos({ operationId: cancelId, count: 5, size: 1000n, feeRate: 2n })
  const { txid: cancelledTxid, psbtSha256 } = outputReview.plan
  assert.equal((await sender.getCreateUtxosOperation(cancelId)).stage, 'prepared')
  sender = await restart('sender')
  await assert.rejects(sender.cancelCreateUtxosPlan({ operationId: cancelId, psbtSha256: '00'.repeat(32) }),
    { code: 'NO_PREPARED_OPERATION' })
  assert.equal((await sender.getCreateUtxosOperation(cancelId)).stage, 'prepared')
  await sender.cancelCreateUtxosPlan({ operationId: cancelId, psbtSha256 })
  assert.equal((await sender.getCreateUtxosOperation(cancelId)).stage, 'declined')
  assert.equal(mempool().includes(cancelledTxid), false)
  assert.equal(reviewed.has(cancelId), false)
  await checkpoint('cancel-reopened-outputs', { txid: cancelledTxid, psbtSha256, state: 'declined', broadcast: false })

  for (const [name, account] of [['sender', sender], ['receiver', receiver]]) {
    await account.createUtxos({ operationId: 'funded-rgb-outputs-' + name, count: 5, size: 1000n, feeRate: 2n })
  }
  control('mine', '3')
  const contract = new Uint8Array(await fs.readFile(issued.contractPath))
  for (const account of [sender, receiver]) {
    await account.registerAssetContract({ contract, assetId, sha256: issued.contractSha256 })
  }
  const mintInvoice = await sender.blindReceive({ assetId, minConfirmations: 3 })
  const mint = issuer('prepare', { invoice: mintInvoice.invoice, amount: '1000000' })
  await sender.refresh(assetId)
  assert.equal((await sender.getReceivedMint(mintInvoice.recipientId)).opid, mint.opid)
  const mintReceipt = issuer('settle', undefined, mint.opid)
  await assertRgbBalance(sender, '1000000')
  await checkpoint('funded-mint', { txid: mintReceipt.txid, amount: '1000000', opid: mint.opid, assetId })

  declineId = 'funded-rgb-decline-01'
  const declinedInvoice = await receiver.blindReceive({ assetId, amount: 200_000n })
  const decline = { operationId: declineId, invoice: declinedInvoice.invoice, assetId, amount: 200_000n, feeRate: 2n }
  const mismatchId = 'funded-rgb-mismatch-01'
  await assert.rejects(sender.sendRgbInvoice({ ...decline, operationId: mismatchId, amount: 200_001n }), /exact fungible amount/)
  assert.equal(await sender.getOperation(mismatchId), undefined)
  await assert.rejects(sender.sendRgbInvoice(decline), { code: 'AUTHORIZATION_DECLINED' })
  const declined = await sender.getOperation(declineId)
  assert.equal(declined.stage, 'declined')
  assert.equal(mempool().includes(declined.txid), false)
  await assertRgbBalance(sender, '1000000')

  const blindId = 'funded-rgb-blind-send'
  const blindInvoice = await receiver.blindReceive({ assetId, amount: 200_000n })
  const blind = { ...decline, operationId: blindId, invoice: blindInvoice.invoice }
  assert.equal((await sender.decodeRgbInvoice(blind.invoice)).recipientType, 'Blind')
  await interruptAfterSubmission(blindId, () => sender.sendRgbInvoice(blind))
  const blindPending = await sender.getOperation(blindId)
  assert.equal(blindPending.stage, 'submitting')
  sender = await restart('sender')
  assert.deepEqual(await sender.recoverSend(blindId), {
    state: 'submitted', txid: blindPending.txid, batchTransferIdx: blindPending.batchTransferIdx
  })
  await assert.rejects(sender.sendRgbInvoice(blind), { code: 'OPERATION_EXISTS' })
  await settleSend(sender, receiver, blindPending.txid)
  await assertRgbBalance(sender, '800000')
  await assertRgbBalance(receiver, '200000')
  await checkpoint('rgb-blind-send', { txid: blindPending.txid, amount: '200000', declineTxid: declined.txid, recovery: 'submitted' })

  const witnessId = 'funded-rgb-witness-send'
  const witnessInvoice = await receiver.witnessReceive({ assetId, amount: 300_000n })
  const witness = { ...blind, operationId: witnessId, invoice: witnessInvoice.invoice, amount: 300_000n, witnessAmountSats: 1000n }
  assert.equal((await sender.decodeRgbInvoice(witness.invoice)).recipientType, 'Witness')
  const sent = await sender.sendRgbInvoice(witness)
  assert(reviewed.get(witnessId).plan.outputs.some(x => x.role === 'approved' && x.amountSats === '1000'))
  await settleSend(sender, receiver, sent.txid)
  await assertRgbBalance(sender, '500000')
  await assertRgbBalance(receiver, '500000')
  await checkpoint('rgb-witness-send', { txid: sent.txid, amount: '300000', witnessAmountSats: '1000' })

  const burnId = 'funded-burn-recover-01'
  const burn = { operationId: burnId, assetId, amount: 500_000n, feeRate: 2n, minConfirmations: 6, burnRecipient, burnDestination }
  await interruptAfterSubmission(burnId, () => sender.burnAsset(burn))
  const burnPending = await sender.getOperation(burnId)
  assert.equal(burnPending.stage, 'submitting')
  assert(mempool().includes(burnPending.txid))
  control('mine', '6')
  sender = await restart('sender')
  const recovered = await sender.recoverBurn(burnId)
  assert.equal(recovered.txid, burnPending.txid)
  assert.equal((await sender.getOperation(burnId)).stage, 'submitted')
  await assert.rejects(sender.burnAsset(burn), { code: 'OPERATION_EXISTS' })
  const proof = Buffer.from(recovered.proof.data, 'base64')
  const file = join(fixture, 'runtime', 'verified-proof-' + nonce + '.rgb')
  await fs.writeFile(file, proof, { flag: 'wx', mode: 0o600 })
  const validation = issuer('verify-burn', undefined, file, assetId, recovered.txid, '500000', burnPending.args.commitment)
  assert.equal(validation.validation.warnings.length, 0)
  await checkpoint('burn-recovery', { txid: recovered.txid, amount: '500000', proofBytes: proof.length, validation })
  console.log(JSON.stringify({ nativeSha256, assetId, btc: btcPending.txid, blind: blindPending.txid, witness: sent.txid, burn: recovered.txid }))
} finally {
  await Promise.allSettled(Array.from(managers.values(), manager => manager.dispose()))
  Object.values(seeds).forEach(seed => seed.fill(0))
}
