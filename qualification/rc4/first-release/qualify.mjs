import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, readdir, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
const here = import.meta.dirname
assert(process.env.WDK_FRESH_FIXTURE_ROOT && process.env.WDK_BARE_EXECUTABLE, 'Set the owned fixture root and exact Bare executable')
const fixtureRoot = resolve(process.env.WDK_FRESH_FIXTURE_ROOT)
const bare = resolve(process.env.WDK_BARE_EXECUTABLE)
const [consumerArg, nodeArg, admissionArg, archiveArg, packageSource, verificationArg] = process.argv.slice(2)
assert(consumerArg && nodeArg && admissionArg && archiveArg && verificationArg && /^[a-f0-9]{40}$/.test(packageSource), 'Supply installed consumer, Node addon, platform admission, exact archive, package source and release-verifier receipt')
const consumer = resolve(consumerArg), worker = resolve(nodeArg)
const statePath = join(here, 'private-state.json'), resultPath = join(here, 'result.json')
const freshIssuer = JSON.parse(await readFile(join(here, 'issuer-fixture/issuer-funded.json'), 'utf8'))
const aid = freshIssuer.asset.assetId
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
await chmod(here, 0o700)
async function save(path, value) {
  await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(path + '.tmp', path)
}
function fixture(command, input) {
  const r = spawnSync('python3', [join(here, 'local_fixture.py'), command], {
    input: input && JSON.stringify(input), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
function bitcoin(method, params = [], wallet) {
  const code = 'import fixture,json,sys;r=json.load(sys.stdin);print(json.dumps(fixture.rpc(48443,r["method"],r["params"],r.get("wallet"))))'
  const r = spawnSync('python3', ['-c', code], { cwd: fixtureRoot,
    input: JSON.stringify({ method, params, wallet }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
async function wait(label, predicate) {
  for (let i = 0; i < 60; i++) { if (await predicate()) return; await delay(500) }
  throw new Error('Timed out: ' + label)
}
async function indexed() {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port: 48001 })
    let buffer = ''
    socket.setEncoding('utf8').setTimeout(2000)
    socket.once('connect', () => socket.write(JSON.stringify({ id: 1, method: 'blockchain.headers.subscribe', params: [] }) + '\n'))
    socket.on('data', data => {
      buffer += data
      if (buffer.includes('\n')) {
        socket.destroy()
        try { done(JSON.parse(buffer.split('\n')[0]).result?.height) } catch { done(null) }
      }
    })
    socket.once('error', () => done(null)); socket.once('timeout', () => socket.destroy()); socket.once('close', () => done(null))
  })
}
async function mine() {
  fixture('mine')
  const height = fixture('status').bitcoinHeight
  await wait('Electrum indexing', async () => await indexed() === height)
}
const config = {
  network: 'regtest', indexerUrl: 'tcp://127.0.0.1:48001',
  transportEndpoint: 'rpc://127.0.0.1:48090/json-rpc',
  evmRpcUrls: { 31337: 'http://127.0.0.1:48545' },
  burnDestinationRoutes: [
    { chainId: 'eip155:42161', dstEid: 0 },
    { chainId: 'eip155:1', dstEid: 30101 },
    { chainId: 'eip155:137', dstEid: 30109 },
    { chainId: 'eip155:9745', dstEid: 30383 },
    { chainId: 'tron:728126428', dstEid: 30420 }
  ], maxFeeSats: '10000'
}
async function peer(runtime) {
  const file = join(consumer, '.rc4-release-peer-' + randomBytes(6).toString('hex') + '.mjs')
  await writeFile(file, await readFile(join(here, 'packed-peer.mjs')), { mode: 0o600, flag: 'wx' })
  const binary = runtime === 'node' ? worker : join(consumer, 'node_modules/@utexo/wdk-wallet-rgb/prebuilds/darwin-arm64/utexo__wdk-wallet-rgb.bare')
  const nativeSha = hash(await readFile(binary))
  const proc = spawn(runtime === 'node' ? process.execPath : bare, [file], { cwd: consumer, stdio: ['pipe', 'pipe', 'pipe'] })
  let id = 0, pending, error, stderr = ''
  proc.stderr.on('data', data => { stderr = (stderr + data).slice(-10000) })
  function fail(e) { error ??= e; pending?.reject(error); pending = undefined }
  proc.on('error', fail); proc.stdin.on('error', fail)
  const exit = new Promise(done => proc.once('close', (code, signal) => { fail(new Error('Peer exited: ' + (signal ?? code) + ' ' + stderr)); done(code) }))
  const lines = createInterface({ input: proc.stdout })
  lines.on('line', line => {
    try {
      const reply = JSON.parse(line); assert.equal(reply.id, pending?.id)
      const p = pending; pending = undefined
      reply.error ? p.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code })) : p.resolve(reply.result)
    } catch (e) { fail(e) }
  })
  async function request(method, args = [], params) {
    if (error) throw error
    assert.equal(pending, undefined)
    const timer = setTimeout(() => { fail(new Error('Peer timeout: ' + method)); proc.kill() }, 180000)
    try {
      return await new Promise((yes, no) => { pending = { id: ++id, resolve: yes, reject: no }; proc.stdin.write(JSON.stringify({ id, method, args, params }) + '\n') })
    } finally { clearTimeout(timer) }
  }
  return { request, nativeSha,
    async open(seed, dataDir) {
      return request('open', [], { seed, config: { ...config, dataDir,
        ...(runtime === 'node' ? { [worker.endsWith('.node') ? 'nativeAddon' : 'nativeExecutable']: worker, nativeSha256: nativeSha } : { nativeSha256: nativeSha }) } })
    },
    async stop() {
      try { if (!error) await request('stop') }
      finally {
        proc.stdin.end(); const timer = setTimeout(() => proc.kill('SIGKILL'), 5000)
        try { assert.equal(await exit, 0) } finally { clearTimeout(timer); lines.close(); await rm(file) }
      }
    }
  }
}
async function savedTransferProof(dataDir, assetId, txid) {
  assert(/^rgb:[A-Za-z0-9_~\-]+$/.test(assetId) && /^[a-f0-9]{64}$/.test(txid))
  const matches = []
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(dataDir, entry.name, 'transfers', txid, assetId.slice(4), 'consignment_out.rgb')
    try { matches.push(await readFile(path)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  assert.equal(matches.length, 1, 'Require one exact native transfer consignment in the disposable fixture')
  return matches[0]
}

assert.equal(bitcoin('getblockchaininfo').chain, 'regtest')
assert.equal(fixture('status').chainId, 31337)
const pkgRoot = join(consumer, 'node_modules/@utexo/wdk-wallet-rgb')
const nativeHashes = { node: hash(await readFile(worker)), bare: hash(await readFile(join(pkgRoot, 'prebuilds/darwin-arm64/utexo__wdk-wallet-rgb.bare'))) }
const admitted = JSON.parse(await readFile(resolve(admissionArg), 'utf8'))
assert.equal(admitted.packageVersion, '3.0.0-rc.4')
assert.equal(admitted.producerCommit, '60f22b2a62665ee61c4d0898320e29999c9f6209')
const verificationBytes = await readFile(resolve(verificationArg))
const verified = JSON.parse(verificationBytes)
assert.equal(verified.package.sha256, hash(await readFile(resolve(archiveArg))))
assert.equal(verified.native.source, 'f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d')
for (const runtime of ['node', 'bare']) {
 assert.equal(verified.source[runtime].releaseCommit, packageSource)
 assert.equal(verified.source[runtime].producerCommit, admitted.producerCommit)
 assert.equal(verified.source[runtime].nativeInputsUnchanged, true)
 assert.equal(verified.source[runtime].runtimeFilesUnchangedSinceProducer, true)
}

for (const runtime of ['node', 'bare']) {
 const manifest = JSON.parse(await readFile(join(pkgRoot, 'src/onchain-' + runtime + '-native.json'), 'utf8'))
 assert.equal(manifest.source, 'f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d')
 assert.equal(manifest.targets['darwin-arm64'].sha256, nativeHashes[runtime])
 assert.equal(admitted.platforms[runtime + '-darwin-arm64'].sha256, nativeHashes[runtime])
}
const admission = spawnSync('python3', ['-c', `import json,pathlib,sys,tarfile
archive=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2]);count=0
with tarfile.open(archive,'r:gz') as tar:
 for entry in tar.getmembers():
  if entry.isdir():continue
  assert entry.isfile() and entry.name.startswith('package/')
  name=pathlib.PurePosixPath(entry.name).relative_to('package')
  assert not name.is_absolute() and '..' not in name.parts
  assert (root/str(name)).read_bytes()==tar.extractfile(entry).read(),str(name)
  count+=1
print(json.dumps({'matchedFiles':count,'everyArchiveFileMatched':True}))`, resolve(archiveArg), pkgRoot], { encoding: 'utf8' })
assert.equal(admission.status, 0, admission.stderr)
await assert.rejects(readFile(statePath), { code: 'ENOENT' })
// A retained marker means reconcile the original operations, never replay this phase.
const state = { runId: 'first-release-' + randomBytes(8).toString('hex'), status: 'running', runtimes: {} }
const result = { runId: state.runId, source: 'f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d', packageSource,
 packageSha256: hash(await readFile(resolve(archiveArg))), releaseVerifierReceiptSha256: hash(verificationBytes), packageAdmission: JSON.parse(admission.stdout), nativeProducers: admitted.producers ?? { node: admitted.producerCommit, bare: admitted.producerCommit },
 nativeHashes, assetId: aid, runtimes: {}, scope: 'Fresh wallets using the complete admitted pack, Darwin ARM64 Node and Bare, isolated Regtest/Anvil. No legacy database upgrade, hosted settlement or seed-only RGB recovery claim.' }
await save(statePath, state); await save(resultPath, result)
async function bfaMetadata(p) {
 const assets = await p.request('listAssets')
 const asset = assets.find(row => row.assetId === aid)
 assert(asset, 'BFA asset must be enumerable without the legacy metadata repair')
 const metadata = await p.request('getAssetMetadata', [aid])
 const expected = { assetId: aid, schema: 'Bfa', name: 'Upgrade Fixture Dollar', ticker: 'BUSDT', precision: 6 }
 for (const [key, value] of Object.entries(expected)) { assert.equal(asset[key], value); assert.equal(metadata[key], value) }
 return { ...expected, nativeAssetListingSucceeded: true }
}
async function balance(p, assetId, expected) {
 await wait('settled asset balance ' + expected, async () => { await p.request('refresh'); const b = await p.request('getAssetBalance', [assetId]); return b.spendable === expected && b.settled === expected })
}
async function settled(sender, receiver, txid) {
 await wait('RGB broadcast', async () => {
  await receiver.request('refresh'); await sender.request('refresh')
  if (bitcoin('getrawmempool').includes(txid)) return true
  try { return bitcoin('getrawtransaction', [txid, true]).confirmations >= 1 } catch { return false }
 })
 await mine(); await receiver.request('refresh'); await sender.request('refresh')
 assert(bitcoin('getrawtransaction', [txid, true]).confirmations >= 6)
}
async function fund(p, id) {
 const address = await p.request('getAddress')
 const txid = bitcoin('sendtoaddress', [address, 0.02], 'miner')
 await mine()
 const outputs = await p.request('createUtxos', [{ operationId: id, count: 12, size: '10000', feeRate: '2' }])
 await mine(); await p.request('refresh')
 return { address, fundingTxid: txid, outputs }
}
const payouts = [
 { name: 'arbitrum', chainId: 'eip155:42161', dstEid: 0, address: '0x5555555555555555555555555555555555555555', recipientHex: '0x5555555555555555555555555555555555555555', amount: '100000' },
 { name: 'ethereum', chainId: 'eip155:1', dstEid: 30101, address: '0x7777777777777777777777777777777777777777', recipientHex: '0x7777777777777777777777777777777777777777', amount: '10000' },
 { name: 'polygon', chainId: 'eip155:137', dstEid: 30109, address: '0x8888888888888888888888888888888888888888', recipientHex: '0x8888888888888888888888888888888888888888', amount: '10000' },
 { name: 'plasma', chainId: 'eip155:9745', dstEid: 30383, address: '0x9999999999999999999999999999999999999999', recipientHex: '0x9999999999999999999999999999999999999999', amount: '10000' },
 { name: 'tron', chainId: 'tron:728126428', dstEid: 30420, address: 'TEdvoHEatmDKvTh3o9vBRB9Vdtbhn4QFhy', recipientHex: '0x413333333333333333333333333333333333333333', amount: '10000' }
]
for (const runtime of ['node', 'bare']) {
 const id = label => state.runId + '-' + runtime + '-' + label
 const data = { sender: { seed: [...randomBytes(64)], dataDir: join(here, 'wallets', runtime, 'sender') }, receiver: { seed: [...randomBytes(64)], dataDir: join(here, 'wallets', runtime, 'receiver') } }
 state.runtimes[runtime] = data; await save(statePath, state)
 let sender = await peer(runtime), receiver = await peer(runtime)
 const row = { nativeSha256: nativeHashes[runtime], ordinary: [], burns: [] }; result.runtimes[runtime] = row
 try {
  await sender.open(data.sender.seed, data.sender.dataDir); await receiver.open(data.receiver.seed, data.receiver.dataDir)
  assert.deepEqual(await sender.request('listAssets'), [])
  row.sender = await fund(sender, id('sender-outputs')); await save(resultPath, result)
  row.receiver = await fund(receiver, id('receiver-outputs')); await save(resultPath, result)
  row.keys = await sender.request('getPublicKeys'); row.signingAddress = await sender.request('getMessageSigningAddress')
  row.signature = await sender.request('signMessageBip322', ['WDK first release qualification', row.signingAddress])
  assert.equal(await sender.request('verifyMessageBip322', ['WDK first release qualification', row.signingAddress, row.signature]), true)
  row.bip322Verified = true
  if (runtime === 'bare') {
   const bytes = await readFile(join(here, 'public-contract.rgb'))
   await sender.request('register', [], { assetId: aid, sha256: hash(bytes), contract: bytes.toString('base64') })
   assert.equal((await sender.request('getAssetBalance', [aid])).spendable, '0')
   row.importBeforeMint = true; row.senderMetadataAfterImport = await bfaMetadata(sender)
  }
  const invoice = await sender.request('witnessReceive', [{ ...(runtime === 'bare' && { assetId: aid }), amount: '2000000', expirationSeconds: 86400, minConfirmations: 6 }])
  const operationId = id('mint'), beforeBlock = fixture('status').evmBlock + 256
  const prepared = fixture('issuer', { command: 'mint-begin', operationId, assetId: aid, invoice: invoice.invoice, amount: 2000000, beforeBlock })
  row.mint = { operationId, prepared }; await save(resultPath, result)
  let checked
  await wait('checked mint before payment', async () => { await sender.request('refresh'); checked = await sender.request('getReceivedMintForInvoice', [{ invoice: invoice.invoice, expectedAssetId: aid }]); return checked !== null })
  for (const key of ['opid', 'lockId', 'txid']) assert.equal(checked[key], prepared[key])
  assert.equal(checked.amount, '2000000')
  const deployment = JSON.parse(await readFile(join(here, 'issuer-fixture/deployment.json'), 'utf8'))
  assert.equal(checked.evmChainId, '31337'); assert.equal(checked.bridgeContract, deployment.bridge.deployedTo.toLowerCase())
  row.mint.checked = checked; await save(resultPath, result)
  const payment = fixture('lock', { operationId }); row.mint.paymentTxid = payment.receipt.transactionHash; await save(resultPath, result)
  row.mint.broadcast = fixture('issuer', { command: 'mint-end', operationId }); assert.equal(row.mint.broadcast.txid, prepared.txid)
  await save(resultPath, result); await mine(); await balance(sender, aid, '2000000'); fixture('issuer', { command: 'refresh' })
  const contract = Buffer.from((await sender.request('export', [aid])).base64, 'base64')
  if (runtime === 'node') await writeFile(join(here, 'public-contract.rgb'), contract)
  else assert.equal(hash(contract), hash(await readFile(join(here, 'public-contract.rgb'))))
  row.senderMetadataAfterMint = await bfaMetadata(sender)
  row.contract = { assetId: aid, sha256: hash(contract) }
  const importRequest = { assetId: aid, sha256: hash(contract), contract: contract.toString('base64') }
  await receiver.request('instrument')
  await assert.rejects(receiver.request('register', [], { ...importRequest, sha256: '00'.repeat(32) }), { code: 'TypeError' })
  assert.deepEqual(await receiver.request('register', [], importRequest), { assetId: aid })
  assert.equal(hash(Buffer.from((await receiver.request('export', [aid])).base64, 'base64')), hash(contract))
  await assert.rejects(receiver.request('register', [], importRequest), { code: 'ASSET_ALREADY_KNOWN' })
  assert.equal((await receiver.request('getAssetBalance', [aid])).spendable, '0')
  row.receiverMetadataAfterImport = await bfaMetadata(receiver)
  row.contractImport = { publicApi: true, duplicateRejected: true, hashMismatchRejected: true, exportedBytesIdentical: true, noInventedAllocations: true }
  const bfaInvoice = await receiver.request('blindReceive', [{ assetId: aid, amount: '100000', expirationSeconds: 86400, minConfirmations: 6 }])
  await assert.rejects(receiver.request('cancelReceiveInvoice', [{ batchTransferIdx: bfaInvoice.batchTransferIdx, recipientId: bfaInvoice.recipientId }]), { code: 'RECEIVE_CANCELLATION_UNAVAILABLE' })
  row.bfaCancellationRejected = true
  const bfaRequest = { operationId: id('bfa-send'), assetId: aid, invoice: bfaInvoice.invoice, amount: '100000', feeRate: '2', minConfirmations: 6 }
  row.bfaSend = await sender.request('sendRgbInvoice', [bfaRequest]); row.bfaSend.operationId = bfaRequest.operationId; await save(resultPath, result)
  await settled(sender, receiver, row.bfaSend.txid); await balance(sender, aid, '1900000'); await balance(receiver, aid, '100000')
  const bfaProof = await savedTransferProof(data.sender.dataDir, aid, row.bfaSend.txid)
  await writeFile(join(here, runtime + '-bfa-send.rgb'), bfaProof, { mode: 0o600 }); row.bfaSend.proofSha256 = hash(bfaProof)
  await assert.rejects(sender.request('sendRgbInvoice', [bfaRequest]), { code: 'OPERATION_EXISTS' })
  for (const schema of ['Nia', 'Cfa']) {
   const issue = { operationId: id('issue-' + schema.toLowerCase()), name: 'First Release ' + schema, ...(schema === 'Nia' && { ticker: 'VTEST' }), precision: 2, amounts: ['1000'] }
   const issued = await sender.request('issueAsset' + schema, [issue]); await balance(sender, issued.assetId, '1000')
   const item = { schema, assetId: issued.assetId, issuanceOperationId: issue.operationId }; row.ordinary.push(item); await save(resultPath, result)
   const bytes = Buffer.from((await sender.request('export', [issued.assetId])).base64, 'base64')
   await receiver.request('register', [], { assetId: issued.assetId, sha256: hash(bytes), contract: bytes.toString('base64') })
   const invoice = await receiver.request('witnessReceive', [{ assetId: issued.assetId, amount: '100', expirationSeconds: 86400, minConfirmations: 6 }])
   await assert.rejects(receiver.request('cancelReceiveInvoice', [{ batchTransferIdx: invoice.batchTransferIdx, recipientId: invoice.recipientId }]), { code: 'RECEIVE_CANCELLATION_UNAVAILABLE' })
   item.unexpiredCancellationRejected = true
   const send = { operationId: id(schema.toLowerCase() + '-send'), assetId: issued.assetId, invoice: invoice.invoice, amount: '100', feeRate: '2', minConfirmations: 6, witnessAmountSats: '1000' }
   const tx = await sender.request('sendRgbInvoice', [send]); Object.assign(item, { operationId: send.operationId, txid: tx.txid, sent: '100', issuerBalance: '900', recipientBalance: '100' }); await save(resultPath, result)
   await receiver.request('refresh'); await sender.request('refresh')
   const pending = await receiver.request('getInvoiceStatus', [invoice.recipientId])
   assert(['WaitingCounterparty', 'WaitingConfirmations'].includes(pending.status))
   await assert.rejects(receiver.request('cancelReceiveInvoice', [{ batchTransferIdx: invoice.batchTransferIdx, recipientId: invoice.recipientId }]), { code: 'RECEIVE_CANCELLATION_UNAVAILABLE' })
   item.pendingCancellationRejected = true; item.pendingStatus = pending.status
   await settled(sender, receiver, tx.txid); await balance(sender, issued.assetId, '900'); await balance(receiver, issued.assetId, '100')
   assert.equal((await receiver.request('getInvoiceStatus', [invoice.recipientId])).status, 'Settled')
   await assert.rejects(receiver.request('cancelReceiveInvoice', [{ batchTransferIdx: invoice.batchTransferIdx, recipientId: invoice.recipientId }]), { code: 'RECEIVE_CANCELLATION_UNAVAILABLE' })
   item.settledCancellationRejected = true
   const proof = await savedTransferProof(data.sender.dataDir, issued.assetId, tx.txid); await writeFile(join(here, runtime + '-' + schema + '.rgb'), proof, { mode: 0o600 })
   item.proofSha256 = hash(proof); await assert.rejects(sender.request('sendRgbInvoice', [send]), { code: 'OPERATION_EXISTS' }); await save(resultPath, result)
  }
  const btcAddress = await receiver.request('getNewAddress'), btcRequest = { operationId: id('btc-send'), address: btcAddress, amount: '10000', feeRate: '2' }
  row.btcSend = { ...await sender.request('sendBtc', [btcRequest]), operationId: btcRequest.operationId }; row.btcAddress = btcAddress; await save(resultPath, result); await mine()
  assert.equal((await sender.request('recoverSend', [btcRequest.operationId])).txid, row.btcSend.txid)
  const btc = bitcoin('getrawtransaction', [row.btcSend.txid, true]); assert(btc.confirmations >= 6); assert(btc.vout.some(o => o.scriptPubKey.address === btcAddress && Math.round(o.value * 1e8) === 10000))
  await assert.rejects(sender.request('sendBtc', [btcRequest]), { code: 'OPERATION_EXISTS' })
  let expectedBfa = 1900000n
  for (const payout of payouts) {
   const request = { operationId: id('burn-' + payout.name), assetId: aid, amount: payout.amount, feeRate: '2', minConfirmations: 6, burnRecipient: { chainId: payout.chainId, address: payout.address } }
   data.burnRequest = request; await save(statePath, state)
   let recovered
   if (payout.name === 'arbitrum') {
    await sender.request('instrument', [], { loseOperation: 'burnEnd' })
    await assert.rejects(sender.request('burn', [], request), { code: 'NATIVE_CLOSED' })
    await sender.request('close'); await sender.open(data.sender.seed, data.sender.dataDir)
    recovered = await sender.request('recoverBurn', [request.operationId])
    const calls = await sender.request('instrumentation'); assert.equal(calls.calls.filter(c => c === 'burnEnd').length, 1)
   } else {
    const burned = await sender.request('burn', [], request)
    recovered = await sender.request('recoverBurn', [request.operationId]); assert.equal(recovered.txid, burned.txid)
   }
   const item = { ...payout, operationId: request.operationId, txid: recovered.txid, lostSuccessfulNativeEndReply: payout.name === 'arbitrum', ...(payout.name === 'arbitrum' && { burnEndCalls: 1 }) }; row.burns.push(item); await save(resultPath, result)
   assert.deepEqual(await sender.request('recoverBurn', [request.operationId]), recovered)
   await assert.rejects(sender.request('burn', [], request), { code: 'OPERATION_EXISTS' })
   await mine(); expectedBfa -= BigInt(payout.amount); await balance(sender, aid, expectedBfa.toString())
   const proof = await sender.request('getConsignment', [{ assetId: aid, txid: recovered.txid }]); assert.deepEqual(proof, recovered.proof)
   const bytes = Buffer.from(proof.data, 'base64'); await writeFile(join(here, runtime + '-burn-' + payout.name + '.rgb'), bytes, { mode: 0o600 })
   Object.assign(item, { proofSha256: hash(bytes), repeatedRecoveryUnchanged: true, duplicateRejected: true }); await save(resultPath, result)
  }
  // Same seed in a fresh directory restores Bitcoin identity; it does not fabricate RGB state.
  await sender.request('sync'); const fundedBtc = await sender.request('getBtcBalance')
  await sender.stop(); sender = undefined
  const imported = await peer(runtime)
  try {
   await imported.open(data.sender.seed, join(here, 'wallets', runtime, 'seed-import'))
   await imported.request('sync')
   assert.deepEqual(await imported.request('getPublicKeys'), row.keys)
   assert.equal(await imported.request('getMessageSigningAddress'), row.signingAddress)
   const restoredBtc = await imported.request('getBtcBalance'); assert(BigInt(restoredBtc.vanilla.spendable) > 0n)
   assert.deepEqual(await imported.request('listAssets'), [])
   await imported.request('register', [], importRequest)
   assert.equal((await imported.request('getAssetBalance', [aid])).spendable, '0')
   row.seedImport = { samePublicKeysAndSigningAddress: true, bitcoinFundsDiscovered: true, metadataImportWithoutInventedRgbBalance: true, rgbStateRequiresWalletBackup: true, originalBtc: fundedBtc, restoredBtc }
  } finally { await imported.stop() }
  await receiver.stop(); receiver = undefined
  sender = await peer(runtime); receiver = await peer(runtime)
  await sender.open(data.sender.seed, data.sender.dataDir); await receiver.open(data.receiver.seed, data.receiver.dataDir)
  assert.deepEqual(await sender.request('getPublicKeys'), row.keys)
  assert.equal(await sender.request('verifyMessageBip322', ['WDK first release qualification', row.signingAddress, row.signature]), true)
  assert.equal((await sender.request('recoverSend', [bfaRequest.operationId])).txid, row.bfaSend.txid)
  assert.equal((await sender.request('recoverSend', [btcRequest.operationId])).txid, row.btcSend.txid)
  for (const item of row.ordinary) { assert.equal((await sender.request('recoverSend', [item.operationId])).txid, item.txid); await balance(sender, item.assetId, '900'); await balance(receiver, item.assetId, '100'); item.freshProcessRecoveryUnchanged = true }
  for (const item of row.burns) {
   const recovered = await sender.request('recoverBurn', [item.operationId]); assert.equal(recovered.txid, item.txid)
   assert.equal(hash(Buffer.from(recovered.proof.data, 'base64')), item.proofSha256)
   assert.equal(hash(Buffer.from((await sender.request('getConsignment', [{ assetId: aid, txid: item.txid }])).data, 'base64')), item.proofSha256)
   item.freshProcessRecoveryUnchanged = true
  }
  await balance(sender, aid, '1760000'); await balance(receiver, aid, '100000')
  assert.deepEqual(await bfaMetadata(sender), row.senderMetadataAfterMint)
  assert.deepEqual(await bfaMetadata(receiver), row.receiverMetadataAfterImport)
  row.metadataAfterRestart = { senderAndReceiverStable: true, sdkMetadataFields: ['assetId', 'schema', 'name', 'ticker', 'precision'], bridgeLocationValidatedByReceivedMint: true, rejectList: 'Fixture contract has none; public SDK metadata omits that field.' }
  row.restart = { freshProcesses: true, retainedPublicKeys: true, retainedBip322Verification: true, allTransferRecoveriesMatch: true, allBurnProofsUnchanged: true, bfaSender: '1760000', bfaRecipient: '100000' }
  row.complete = true; await save(resultPath, result)
  console.log(runtime + ': fresh creation/import, contract import, mint, BTC/NIA/CFA/BFA transfers and five V1 burn/recovery routes passed.')
 } finally { await receiver?.stop(); await sender?.stop() }
}
state.status = 'complete'; await save(statePath, state)
result.complete = true; result.fixtureStatus = fixture('status'); await save(resultPath, result)
