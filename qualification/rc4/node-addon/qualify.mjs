import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, readdir, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const here = import.meta.dirname
const qualificationRoot = resolve(here, '../..')
const fixtureRoot = join(qualificationRoot, 'fixture')
const retainedRoot = join(fixtureRoot, 'packed-upgrade')
const bare = join(qualificationRoot, 'baseline/sdk-source/node_modules/.bin/bare')
const [phase, consumerArg, nodeArg, admissionArg, archiveArg] = process.argv.slice(2)
assert(['snapshot', 'prepare-baseline', 'run'].includes(phase), 'Use snapshot, prepare-baseline or run; no implicit financial phase')
assert(consumerArg && nodeArg, 'Supply exact installed consumer and Node worker')
const consumer = resolve(consumerArg), worker = resolve(nodeArg)
const statePath = join(here, 'private-state.json')
const snapshotPath = join(here, 'before.json'), resultPath = join(here, 'result.json')
const legacyPath = join(here, 'legacy-private.json'), legacyReportPath = join(here, 'legacy-before.json')
const oldState = JSON.parse(await readFile(join(retainedRoot, 'private-state.json'), 'utf8'))
const oldEvidence = JSON.parse(await readFile(join(retainedRoot, 'evidence.json'), 'utf8'))
const retainedAid = oldEvidence.assetId
const freshIssuer = JSON.parse(await readFile(join(here, 'issuer-fixture/issuer-funded.json'), 'utf8'))
const aid = freshIssuer.asset.assetId
assert.notEqual(aid, retainedAid, 'New issuer must not replace the retained asset')
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

function retainedWallet(runtime, label) {
  const d = label === 'ci-wallet' ? oldState.ciRuntimes[runtime] : oldState.runtimes[runtime]
  return { seed: label === 'fresh-recipient' ? d.fresh.seed : d.seed, dataDir: join(retainedRoot, runtime, label), data: d }
}
async function snapshot(p, runtime, label) {
  const d = retainedWallet(runtime, label)
  await p.open(d.seed, d.dataDir)
  try {
    const result = { keys: await p.request('getPublicKeys'), signingAddress: await p.request('getMessageSigningAddress'),
      btc: await p.request('getBtcBalance'), assets: await p.request('listAssets'), transfers: await p.request('listTransfers') }
    if (label !== 'fresh-recipient') {
      const proof = await p.request('getConsignment', [{ assetId: retainedAid, txid: d.data.burn.txid }])
      result.originalBurn = { txid: d.data.burn.txid, proofSha256: hash(Buffer.from(proof.data, 'base64')) }
    }
    return result
  } finally { await p.request('close') }
}
// The previous URL-parser qualification produced four additional funded wallets.
// Retain their exact operations and proofs as well as the original six wallets.
const previousRoot = join(qualificationRoot, 'release-preparation/funded-rerun')
const previousLegacy = JSON.parse(await readFile(join(previousRoot, 'legacy-private.json'), 'utf8'))
const previousState = JSON.parse(await readFile(join(previousRoot, 'private-state.json'), 'utf8'))
const previousReport = JSON.parse(await readFile(join(previousRoot, 'result.json'), 'utf8'))
async function snapshotPrevious(p, runtime, role) {
  const data = role === 'sender' ? previousLegacy.runtimes[runtime] : previousState.runtimes[runtime]
  await p.open(data.seed, data.dataDir)
  try {
    const result = { keys: await p.request('getPublicKeys'), btc: await p.request('getBtcBalance'), assets: await p.request('listAssets'), transfers: await p.request('listTransfers') }
    if (role === 'sender') {
      const proof = await p.request('getConsignment', [{ assetId: previousReport.assetId, txid: previousReport.runtimes[runtime].burn.txid }])
      result.oldProofSha256 = hash(Buffer.from(proof.data, 'base64'))
    }
    return result
  } finally { await p.request('close') }
}

assert.equal(bitcoin('getblockchaininfo').chain, 'regtest')
assert.equal(fixture('status').chainId, 31337)
const pkgRoot = join(consumer, 'node_modules/@utexo/wdk-wallet-rgb')
const manifest = JSON.parse(await readFile(join(pkgRoot, 'src/onchain-bare-native.json'), 'utf8'))
assert.equal(JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8')).version, '3.0.0-rc.4')
const nativeHashes = {
  node: hash(await readFile(worker)),
  bare: hash(await readFile(join(pkgRoot, 'prebuilds/darwin-arm64/utexo__wdk-wallet-rgb.bare')))
}
assert.equal(nativeHashes.bare, manifest.targets['darwin-arm64'].sha256)
if (phase === 'snapshot') {
  await assert.rejects(readFile(statePath), { code: 'ENOENT' })
  await assert.rejects(readFile(snapshotPath), { code: 'ENOENT' })
  assert.deepEqual(nativeHashes, {
    node: 'b05c4a61e54de051008290aeae0316a651dc3cad27139a8f11ba216f699f41cb',
    bare: 'a6d2a4eb956466a7e71dedb6386fc6198e55e9031911c1eb6de74c6b875d7eed'
  })
  const result = { phase, nativeHashes, wallets: {}, fixtureStatus: fixture('status') }
  for (const runtime of ['node', 'bare']) {
    const p = await peer(runtime)
    try { for (const label of ['wallet', 'fresh-recipient', 'ci-wallet']) result.wallets[runtime + '/' + label] = await snapshot(p, runtime, label) }
    finally { await p.stop() }
  }
  result.previousUrlWallets = {}
  for (const runtime of ['node', 'bare']) {
    const p = await peer(runtime)
    try { for (const role of ['sender', 'receiver']) result.previousUrlWallets[runtime + '/' + role] = await snapshotPrevious(p, runtime, role) }
    finally { await p.stop() }
  }
  await save(snapshotPath, result)
  console.log('Ten retained funded RC4 wallet snapshots recorded; no financial mutation invoked.')
} else if (phase === 'prepare-baseline') {
  await assert.rejects(readFile(legacyPath), { code: 'ENOENT' })
  assert.deepEqual(nativeHashes, {
    node: 'b05c4a61e54de051008290aeae0316a651dc3cad27139a8f11ba216f699f41cb',
    bare: 'a6d2a4eb956466a7e71dedb6386fc6198e55e9031911c1eb6de74c6b875d7eed'
  })
  assert.equal(manifest.source, 'a62fc7d3aa21f715a53c32419ab6d9fbbf1721a2')
  const oldArchive = join(qualificationRoot, 'release-preparation/final/utexo-wdk-wallet-rgb-3.0.0-rc.4.tgz')
  assert.equal(hash(await readFile(oldArchive)), 'c7b42d8bc1bde6ea5f02a66aa1f7927115ac9a3678eaf702a7480c71aa447dbe')
  const check = spawnSync('python3', ['-c', `import json,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[2]);count=0
with tarfile.open(sys.argv[1],'r:gz') as tar:
 for member in tar.getmembers():
  if member.isdir(): continue
  assert member.isfile() and member.name.startswith('package/')
  name=pathlib.PurePosixPath(member.name).relative_to('package')
  assert not name.is_absolute() and '..' not in name.parts
  assert (root/str(name)).read_bytes()==tar.extractfile(member).read(),str(name)
  count+=1
print(json.dumps({'matchedFiles':count,'everyArchiveFileMatched':True}))`, oldArchive, pkgRoot], {encoding:'utf8'})
  assert.equal(check.status, 0, check.stderr)
  const state = { runId: 'nodeaddon-old-' + randomBytes(8).toString('hex'), status: 'running', runtimes: {} }
  const report = { assetId: aid, retainedAssetId: retainedAid, packageSha256: hash(await readFile(oldArchive)), installedAdmission: JSON.parse(check.stdout), nativeHashes, runtimes: {} }
  await save(legacyPath, state)
  for (const runtime of ['node', 'bare']) {
    const id = name => state.runId + '-' + runtime + '-' + name
    const data = { seed: [...randomBytes(64)], dataDir: join(here, 'legacy-wallets', state.runId, runtime) }
    state.runtimes[runtime] = data; await save(legacyPath, state)
    const p = await peer(runtime), row = {}; report.runtimes[runtime] = row
    try {
      await p.open(data.seed, data.dataDir)
      row.fundingTxid = bitcoin('sendtoaddress', [await p.request('getAddress'), 0.02], 'miner'); await save(legacyReportPath, report); await mine()
      row.outputs = await p.request('createUtxos', [{ operationId: id('outputs'), count: 8, size: '10000', feeRate: '2' }]); await save(legacyReportPath, report); await mine(); await p.request('refresh')
      const invoice = await p.request('witnessReceive', [{ amount: '2000000', expirationSeconds: 86400, minConfirmations: 6 }])
      const operationId = id('mint'), beforeBlock = fixture('status').evmBlock + 256
      const prepared = fixture('issuer', { command: 'mint-begin', operationId, assetId: aid, invoice: invoice.invoice, amount: 2000000, beforeBlock })
      row.mint = { operationId, prepared }; await save(legacyReportPath, report)
      let checked
      await wait('legacy verified mint before payment', async () => { await p.request('refresh'); checked = await p.request('getReceivedMintForInvoice', [{ invoice: invoice.invoice, expectedAssetId: aid }]); return checked !== null })
      for (const key of ['opid', 'lockId', 'txid']) assert.equal(checked[key], prepared[key]); assert.equal(checked.amount, '2000000')
      row.mint.checked = checked; await save(legacyReportPath, report)
      const payment = fixture('lock', { operationId }); row.mint.paymentTxid = payment.receipt.transactionHash; await save(legacyReportPath, report)
      row.mint.broadcast = fixture('issuer', { command: 'mint-end', operationId }); assert.equal(row.mint.broadcast.txid, prepared.txid)
      await save(legacyReportPath, report); await mine()
      await wait('legacy funded BFA', async () => { await p.request('refresh'); return (await p.request('getAssetBalance', [aid])).spendable === '2000000' }); fixture('issuer', { command: 'refresh' })
      data.pendingRequest = { method: 'blindReceive', operationId: id('pending-invoice'), requestKey: hash(Buffer.from(id('pending'))), expectedAssetId: aid, options: { amount: '1000000', expirationSeconds: 86400, minConfirmations: 6 } }
      data.pending = await p.request('trustedReceive', [], data.pendingRequest)
      data.burnRequest = { operationId: id('old-burn'), assetId: aid, amount: '500000', feeRate: '2', minConfirmations: 6, burnRecipient: { chainId: 'eip155:42161', address: '0x6666666666666666666666666666666666666666' } }
      await save(legacyPath, state)
      row.burn = await p.request('burn', [], data.burnRequest); await save(legacyReportPath, report); await mine()
      await wait('legacy post-burn BFA', async () => { await p.request('refresh'); return (await p.request('getAssetBalance', [aid])).spendable === '1500000' })
      data.burnProof = await p.request('getConsignment', [{ assetId: aid, txid: row.burn.txid }]); data.burnRecovery = await p.request('recoverBurn', [data.burnRequest.operationId])
      assert.deepEqual(data.burnRecovery.proof, data.burnProof)
      const oldProof = Buffer.from(data.burnProof.data, 'base64')
      await writeFile(join(here, runtime + '-legacy-burn.rgb'), oldProof, { mode: 0o600 })
      row.burn.proofSha256 = hash(oldProof); row.burn.amount = '500000'
      row.ordinary = []
      for (const schema of ['Nia', 'Cfa']) {
        const issued = await p.request('issueAsset' + schema, [{ operationId: id('issue-' + schema.toLowerCase()), name: 'Node Addon Upgrade ' + schema, ...(schema === 'Nia' && { ticker: 'VTEST' }), precision: 2, amounts: ['1000'] }])
        row.ordinary.push({ schema, assetId: issued.assetId }); await save(legacyReportPath, report)
      }
      row.before = { keys: await p.request('getPublicKeys'), signingAddress: await p.request('getMessageSigningAddress'), btc: await p.request('getBtcBalance'), assets: await p.request('listAssets'), transfers: await p.request('listTransfers'), oldProofSha256: hash(Buffer.from(data.burnProof.data, 'base64')), pendingInvoice: data.pending }
      data.complete = true; row.complete = true; await save(legacyPath, state); await save(legacyReportPath, report)
      console.log(runtime + ': fresh exact executable RC4 funded baseline with BFA mint/burn proof, NIA/CFA and pending blinded invoice is ready.')
    } finally { await p.stop() }
  }
  const directories = [join(here, 'issuer-fixture/issuer-state/wallet')]
  let transfer
  while (directories.length && !transfer) {
    const directory = directories.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) directories.push(path)
      else if (entry.name.startsWith('consignment') && (await readFile(path)).subarray(0, 7).equals(Buffer.from('RGB\0TFR'))) { transfer = path; break }
    }
  }
  assert(transfer, 'New fixture must have a real minted consignment')
  const contractPath = join(here, 'public-contract.rgb')
  fixture('issuer', { command: 'export-contract-from-transfer', transferPath: transfer, outputPath: contractPath })
  report.contract = { assetId: aid, sha256: hash(await readFile(contractPath)) }
  state.status = 'complete'; report.complete = true; await save(legacyPath, state); await save(legacyReportPath, report)
} else {
  assert(admissionArg && archiveArg, 'Run needs exact platform receipt and package archive')
  const admitted = JSON.parse(await readFile(resolve(admissionArg), 'utf8'))
  assert.equal(admitted.packageVersion, '3.0.0-rc.4')
  assert.equal(admitted.platforms['node-darwin-arm64'].sha256, nativeHashes.node)
  assert.equal(admitted.platforms['bare-darwin-arm64'].sha256, nativeHashes.bare)
  assert.notEqual(nativeHashes.node, 'b05c4a61e54de051008290aeae0316a651dc3cad27139a8f11ba216f699f41cb')
  assert.equal(nativeHashes.bare, 'a6d2a4eb956466a7e71dedb6386fc6198e55e9031911c1eb6de74c6b875d7eed')
  const admission = spawnSync('python3', ['-c', `import hashlib,json,pathlib,sys,tarfile
archive=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2]);files={}
with tarfile.open(archive,'r:gz') as tar:
 for entry in tar.getmembers():
  if entry.isdir(): continue
  assert entry.isfile() and entry.name.startswith('package/')
  name=pathlib.PurePosixPath(entry.name).relative_to('package')
  assert not name.is_absolute() and '..' not in name.parts and str(name) not in files
  expected=tar.extractfile(entry).read();actual=(root/str(name)).read_bytes()
  assert actual==expected,str(name)
  files[str(name)]=hashlib.sha256(expected).hexdigest()
print(json.dumps({'fileCount':len(files),'everyInstalledFileMatched':True,'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))`, resolve(archiveArg), pkgRoot], { encoding: 'utf8' })
  assert.equal(admission.status, 0, admission.stderr)
  const packageAdmission = JSON.parse(admission.stdout)
  const before = JSON.parse(await readFile(snapshotPath, 'utf8'))
  await assert.rejects(readFile(statePath), { code: 'ENOENT' })
  const privateState = { status: 'running', runId: 'nodeaddon-' + randomBytes(8).toString('hex'), runtimes: {} }
  // Once this marker exists, an interrupted run requires explicit reconciliation.
  // Never replay the phase or invent replacement operation IDs after a lost result.
  await save(statePath, privateState)
  const result = { phase, runId: privateState.runId, source: admitted.producers.node, nativeProducers: admitted.producers, packageSource: '1323731494ec83b87a54d415ea942deaee04e52d',
    packageSha256: hash(await readFile(resolve(archiveArg))), packageAdmission, nativeHashes, retainedWallets: {}, runtimes: {},
    assetId: aid, retainedAssetId: retainedAid, scope: 'Actual new CI-built Node addon / unchanged Bare Darwin ARM64 pack; retained RC4 wallets unchanged, fresh executable RC4 controls and isolated Regtest/Anvil only.' }
  await save(resultPath, result)
  for (const runtime of ['node', 'bare']) {
    const p = await peer(runtime)
    try {
      for (const label of ['wallet', 'fresh-recipient', 'ci-wallet']) {
        const key = runtime + '/' + label
        assert.deepEqual(await snapshot(p, runtime, label), before.wallets[key], 'Retained RC4 wallet changed: ' + key)
        result.retainedWallets[key] = { keysBalancesAssetsTransfersAndOldProofUnchanged: true }
      }
    } finally { await p.stop() }
  }
  result.previousUrlWallets = {}
  for (const runtime of ['node', 'bare']) {
    const p = await peer(runtime)
    try {
      for (const role of ['sender', 'receiver']) {
        const key = runtime + '/' + role
        assert.deepEqual(await snapshotPrevious(p, runtime, role), before.previousUrlWallets[key])
        result.previousUrlWallets[key] = { keysBalancesAssetsTransfersAndOldProofUnchanged: true }
      }
    } finally { await p.stop() }
  }
  await save(resultPath, result)
  const legacy = JSON.parse(await readFile(legacyPath, 'utf8'))
  const legacyReport = JSON.parse(await readFile(legacyReportPath, 'utf8'))
  assert.equal(legacy.status, 'complete'); assert(legacyReport.complete)
  result.directExecutableUpgrade = {}
  for (const runtime of ['node', 'bare']) {
    const data = legacy.runtimes[runtime], before = legacyReport.runtimes[runtime].before
    const p = await peer(runtime)
    try {
      await p.open(data.seed, data.dataDir); await p.request('instrument')
      assert.deepEqual(await p.request('getPublicKeys'), before.keys)
      assert.equal(await p.request('getMessageSigningAddress'), before.signingAddress)
      assert.deepEqual(await p.request('getBtcBalance'), before.btc)
      assert.deepEqual(await p.request('listAssets'), before.assets)
      assert.deepEqual(await p.request('listTransfers'), before.transfers)
      assert.deepEqual(await p.request('getConsignment', [{ assetId: aid, txid: legacyReport.runtimes[runtime].burn.txid }]), data.burnProof)
      assert.deepEqual(await p.request('recoverBurn', [data.burnRequest.operationId]), data.burnRecovery)
      const journal = join(data.dataDir, '.wdk-onchain-invoices-v1', data.pendingRequest.operationId + '.json')
      const beforeBytes = await readFile(journal)
      assert.deepEqual(await p.request('trustedReceive', [], { ...data.pendingRequest, options: { ...data.pendingRequest.options, assetId: aid } }), data.pending)
      assert.deepEqual(await readFile(journal), beforeBytes)
      const calls = await p.request('instrumentation'); assert(!calls.calls.includes('blindReceive')); assert.equal(calls.reviews.length, 0)
      await p.stop()
      const reopened = await peer(runtime)
      try {
        await reopened.open(data.seed, data.dataDir)
        assert.deepEqual(await reopened.request('listAssets'), before.assets)
        assert.deepEqual(await reopened.request('recoverBurn', [data.burnRequest.operationId]), data.burnRecovery)
      } finally { await reopened.stop() }
      result.directExecutableUpgrade[runtime] = { previousPackageSha256: legacyReport.packageSha256, oldNativeSha256: legacyReport.nativeHashes[runtime], newNativeSha256: nativeHashes[runtime], retainedKeysBtcBfaNiaCfaMetadataAndEveryTransferField: true, oldProofSha256: before.oldProofSha256, pendingInvoiceUnchanged: true, noReceiveReallocationOrRepeatedApproval: true, reopenedInFreshProcess: true }
      await save(resultPath, result)
      console.log(runtime + ': direct fresh executable RC4 to new CI pack upgrade and full process reopen passed.')
    } finally { if (!result.directExecutableUpgrade[runtime]) await p.stop().catch(() => {}) }
  }
  async function settled(sender, receiver, txid) {
    await wait('RGB broadcast ' + txid, async () => { await receiver.request('refresh'); await sender.request('refresh'); return bitcoin('getrawmempool').includes(txid) })
    await mine(); await receiver.request('refresh'); await sender.request('refresh')
    assert(bitcoin('getrawtransaction', [txid, true]).confirmations >= 6)
  }
  async function balance(p, assetId, expected) {
    await wait('settled asset balance', async () => { await p.request('refresh'); const b = await p.request('getAssetBalance', [assetId]); return b.spendable === expected && b.settled === expected })
  }
  const contract = await readFile(join(here, 'public-contract.rgb'))
  assert.equal(hash(contract), legacyReport.contract.sha256)
  for (const runtime of ['node', 'bare']) {
    const id = label => privateState.runId + '-' + runtime + '-' + label
    const existing = { ...legacy.runtimes[runtime], data: legacyReport.runtimes[runtime] }
    const fresh = { seed: [...randomBytes(64)], dataDir: join(here, 'wallets', runtime) }
    privateState.runtimes[runtime] = fresh; await save(statePath, privateState)
    let sender = await peer(runtime), receiver = await peer(runtime)
    const row = { nativeSha256: nativeHashes[runtime], ordinary: [] }; result.runtimes[runtime] = row
    try {
      await sender.open(existing.seed, existing.dataDir); await receiver.open(fresh.seed, fresh.dataDir)
      fresh.address = await receiver.request('getAddress'); await save(statePath, privateState)
      row.fundingTxid = bitcoin('sendtoaddress', [fresh.address, 0.02], 'miner'); await save(resultPath, result); await mine()
      row.outputs = await receiver.request('createUtxos', [{ operationId: id('outputs'), count: 8, size: '10000', feeRate: '2' }]); await save(resultPath, result); await mine(); await receiver.request('refresh')
      const importRequest = { assetId: aid, sha256: hash(contract), contract: contract.toString('base64') }
      assert.deepEqual(await receiver.request('register', [], importRequest), { assetId: aid })
      assert.equal(hash(Buffer.from((await receiver.request('export', [aid])).base64, 'base64')), hash(contract))
      await assert.rejects(receiver.request('register', [], importRequest), { code: 'ASSET_ALREADY_KNOWN' })
      const invoice = await receiver.request('witnessReceive', [{ assetId: aid, amount: '1000000', expirationSeconds: 86400, minConfirmations: 6 }])
      const mintId = id('fresh-contract-mint'), beforeBlock = fixture('status').evmBlock + 256
      const prepared = fixture('issuer', { command: 'mint-begin', operationId: mintId, assetId: aid, invoice: invoice.invoice, amount: 1000000, beforeBlock })
      row.mint = { operationId: mintId, prepared }; await save(resultPath, result)
      let checked
      await wait('checked mint before payment', async () => { await receiver.request('refresh'); checked = await receiver.request('getReceivedMintForInvoice', [{ invoice: invoice.invoice, expectedAssetId: aid }]); return checked !== null })
      for (const key of ['opid', 'lockId', 'txid']) assert.equal(checked[key], prepared[key])
      assert.equal(checked.amount, '1000000'); row.mint.checked = checked; await save(resultPath, result)
      const payment = fixture('lock', { operationId: mintId }); row.mint.paymentTxid = payment.receipt.transactionHash; await save(resultPath, result)
      row.mint.broadcast = fixture('issuer', { command: 'mint-end', operationId: mintId }); assert.equal(row.mint.broadcast.txid, prepared.txid)
      await save(resultPath, result); await mine(); await balance(receiver, aid, '1000000'); fixture('issuer', { command: 'refresh' })
      row.importAndMint = { contractSha256: hash(contract), duplicateRejected: true, confirmedBalance: '1000000' }
      const bfaInvoice = await receiver.request('blindReceive', [{ assetId: aid, amount: '100000', expirationSeconds: 86400, minConfirmations: 6 }])
      const bfaRequest = { operationId: id('bfa-send'), assetId: aid, invoice: bfaInvoice.invoice, amount: '100000', feeRate: '2', minConfirmations: 6 }
      row.bfaSend = await sender.request('sendRgbInvoice', [bfaRequest]); await save(resultPath, result)
      await settled(sender, receiver, row.bfaSend.txid); await balance(sender, aid, '1400000'); await balance(receiver, aid, '1100000')
      const bfaTransferProof = await savedTransferProof(existing.dataDir, aid, row.bfaSend.txid)
      await writeFile(join(here, runtime + '-bfa-send.rgb'), bfaTransferProof, { mode: 0o600 })
      row.bfaSend.proofSha256 = hash(bfaTransferProof); await save(resultPath, result)
      await assert.rejects(sender.request('sendRgbInvoice', [bfaRequest]), { code: 'OPERATION_EXISTS' })
      for (const ordinary of existing.data.ordinary) {
        const bytes = Buffer.from((await sender.request('export', [ordinary.assetId])).base64, 'base64')
        await receiver.request('register', [], { assetId: ordinary.assetId, sha256: hash(bytes), contract: bytes.toString('base64') })
        const invoice = await receiver.request('witnessReceive', [{ assetId: ordinary.assetId, amount: '100', expirationSeconds: 86400, minConfirmations: 6 }])
        const send = { operationId: id(ordinary.schema.toLowerCase() + '-send'), assetId: ordinary.assetId, invoice: invoice.invoice, amount: '100', feeRate: '2', minConfirmations: 6, witnessAmountSats: '1000' }
        const tx = await sender.request('sendRgbInvoice', [send]); row.ordinary.push({ ...ordinary, operationId: send.operationId, txid: tx.txid, sent: '100', senderBalance: '900', recipientBalance: '100' }); await save(resultPath, result)
        await settled(sender, receiver, tx.txid); await balance(sender, ordinary.assetId, '900'); await balance(receiver, ordinary.assetId, '100')
        const proof = await savedTransferProof(existing.dataDir, ordinary.assetId, tx.txid)
        await writeFile(join(here, runtime + '-retained-' + ordinary.schema + '.rgb'), proof, { mode: 0o600 })
        row.ordinary.at(-1).proofSha256 = hash(proof); await save(resultPath, result)
        await assert.rejects(sender.request('sendRgbInvoice', [send]), { code: 'OPERATION_EXISTS' })
      }
      row.newIssuance = []
      for (const schema of ['Nia', 'Cfa']) {
        const issued = await receiver.request('issueAsset' + schema, [{ operationId: id('new-issue-' + schema.toLowerCase()), name: 'Addon Native ' + schema, ...(schema === 'Nia' && { ticker: 'VTEST' }), precision: 2, amounts: ['1000'] }])
        const item = { schema, assetId: issued.assetId }
        row.newIssuance.push(item); await save(resultPath, result)
        await balance(receiver, issued.assetId, '1000')
        const bytes = Buffer.from((await receiver.request('export', [issued.assetId])).base64, 'base64')
        await sender.request('register', [], { assetId: issued.assetId, sha256: hash(bytes), contract: bytes.toString('base64') })
        const invoice = await sender.request('witnessReceive', [{ assetId: issued.assetId, amount: '100', expirationSeconds: 86400, minConfirmations: 6 }])
        const send = { operationId: id('new-' + schema.toLowerCase() + '-send'), assetId: issued.assetId, invoice: invoice.invoice, amount: '100', feeRate: '2', minConfirmations: 6, witnessAmountSats: '1000' }
        const transfer = await receiver.request('sendRgbInvoice', [send])
        Object.assign(item, { operationId: send.operationId, txid: transfer.txid, issuerBalance: '900', recipientBalance: '100' }); await save(resultPath, result)
        await settled(receiver, sender, transfer.txid); await balance(receiver, issued.assetId, '900'); await balance(sender, issued.assetId, '100')
        const proof = await savedTransferProof(fresh.dataDir, issued.assetId, transfer.txid)
        await writeFile(join(here, runtime + '-issued-' + schema + '.rgb'), proof, { mode: 0o600 })
        item.proofSha256 = hash(proof); await save(resultPath, result)
        await assert.rejects(receiver.request('sendRgbInvoice', [send]), { code: 'OPERATION_EXISTS' })
      }
      const btcAddress = await receiver.request('getNewAddress')
      const btcRequest = { operationId: id('btc-send'), address: btcAddress, amount: '10000', feeRate: '2' }
      row.btcSend = await sender.request('sendBtc', [btcRequest]); row.btcAddress = btcAddress; await save(resultPath, result); await mine()
      assert.equal((await sender.request('recoverSend', [btcRequest.operationId])).txid, row.btcSend.txid)
      const btc = bitcoin('getrawtransaction', [row.btcSend.txid, true]); assert(btc.confirmations >= 6); assert(btc.vout.some(o => o.scriptPubKey.address === btcAddress && Math.round(o.value * 1e8) === 10000))
      await assert.rejects(sender.request('sendBtc', [btcRequest]), { code: 'OPERATION_EXISTS' })
      const burnRequest = { operationId: id('burn-lost-response'), assetId: aid, amount: '100000', feeRate: '2', minConfirmations: 6, burnRecipient: { chainId: 'eip155:42161', address: '0x5555555555555555555555555555555555555555' } }
      privateState.runtimes[runtime].burnRequest = burnRequest; await save(statePath, privateState)
      await sender.request('instrument', [], { loseOperation: 'burnEnd' })
      await assert.rejects(sender.request('burn', [], burnRequest), { code: 'NATIVE_CLOSED' })
      await sender.request('close'); await sender.open(existing.seed, existing.dataDir)
      const recovered = await sender.request('recoverBurn', [burnRequest.operationId]); assert.deepEqual(await sender.request('recoverBurn', [burnRequest.operationId]), recovered)
      await assert.rejects(sender.request('burn', [], burnRequest), { code: 'OPERATION_EXISTS' })
      const calls = await sender.request('instrumentation'); assert.equal(calls.calls.filter(c => c === 'burnEnd').length, 1)
      await mine(); await balance(sender, aid, '1300000')
      const proof = Buffer.from(recovered.proof.data, 'base64'); await writeFile(join(here, runtime + '-burn.rgb'), proof, { mode: 0o600 })
      row.burn = { operationId: burnRequest.operationId, txid: recovered.txid, amount: '100000', proofSha256: hash(proof), lostSuccessfulNativeEndReply: true, burnEndCalls: 1, duplicateRejected: true }
      await save(resultPath, result)
      row.additionalRoutes = []
      let expectedBfa = 1300000n
      const payouts = [
        { name: 'ethereum', chainId: 'eip155:1', dstEid: 30101, address: '0x7777777777777777777777777777777777777777', recipientHex: '0x7777777777777777777777777777777777777777' },
        { name: 'polygon', chainId: 'eip155:137', dstEid: 30109, address: '0x8888888888888888888888888888888888888888', recipientHex: '0x8888888888888888888888888888888888888888' },
        { name: 'plasma', chainId: 'eip155:9745', dstEid: 30383, address: '0x9999999999999999999999999999999999999999', recipientHex: '0x9999999999999999999999999999999999999999' },
        { name: 'tron', chainId: 'tron:728126428', dstEid: 30420, address: 'TEdvoHEatmDKvTh3o9vBRB9Vdtbhn4QFhy', recipientHex: '0x413333333333333333333333333333333333333333' }
      ]
      for (const payout of payouts) {
        const request = { operationId: id('burn-' + payout.name), assetId: aid, amount: '10000', feeRate: '2', minConfirmations: 6, burnRecipient: { chainId: payout.chainId, address: payout.address } }
        const burned = await sender.request('burn', [], request)
        const item = { ...payout, operationId: request.operationId, txid: burned.txid, amount: '10000' }
        row.additionalRoutes.push(item); await save(resultPath, result)
        await mine(); expectedBfa -= 10000n; await balance(sender, aid, expectedBfa.toString())
        const saved = await sender.request('getConsignment', [{ assetId: aid, txid: burned.txid }])
        const recovery = await sender.request('recoverBurn', [request.operationId]); assert.deepEqual(recovery.proof, saved)
        assert.deepEqual(await sender.request('recoverBurn', [request.operationId]), recovery)
        await assert.rejects(sender.request('burn', [], request), { code: 'OPERATION_EXISTS' })
        const bytes = Buffer.from(saved.data, 'base64')
        await writeFile(join(here, runtime + '-burn-' + payout.name + '.rgb'), bytes, { mode: 0o600 })
        Object.assign(item, { proofSha256: hash(bytes), repeatedRecoveryUnchanged: true, duplicateRejected: true })
        await save(resultPath, result)
      }
      await sender.stop(); sender = undefined; await receiver.stop(); receiver = undefined
      sender = await peer(runtime); receiver = await peer(runtime)
      await sender.open(existing.seed, existing.dataDir); await receiver.open(fresh.seed, fresh.dataDir)
      assert.deepEqual(await sender.request('recoverBurn', [burnRequest.operationId]), recovered)
      assert.equal(hash(Buffer.from((await sender.request('getConsignment', [{ assetId: aid, txid: recovered.txid }])).data, 'base64')), hash(proof))
      assert.equal((await sender.request('recoverSend', [bfaRequest.operationId])).txid, row.bfaSend.txid)
      assert.equal((await sender.request('recoverSend', [btcRequest.operationId])).txid, row.btcSend.txid)
      for (const ordinary of row.ordinary) { assert.equal((await sender.request('recoverSend', [ordinary.operationId])).txid, ordinary.txid); await balance(sender, ordinary.assetId, '900'); await balance(receiver, ordinary.assetId, '100') }
      for (const issued of row.newIssuance) {
        assert.equal((await receiver.request('recoverSend', [issued.operationId])).txid, issued.txid)
        await balance(receiver, issued.assetId, '900'); await balance(sender, issued.assetId, '100')
        issued.freshProcessRecoveryUnchanged = true
      }
      await balance(sender, aid, '1260000'); await balance(receiver, aid, '1100000')
      for (const item of row.additionalRoutes) {
        const recovery = await sender.request('recoverBurn', [item.operationId]); assert.equal(recovery.txid, item.txid)
        assert.equal(hash(Buffer.from(recovery.proof.data, 'base64')), item.proofSha256)
        const proof = await sender.request('getConsignment', [{ assetId: aid, txid: item.txid }])
        assert.equal(hash(Buffer.from(proof.data, 'base64')), item.proofSha256)
        item.freshProcessRecoveryUnchanged = true
      }
      assert.deepEqual(await sender.request('getPublicKeys'), legacyReport.runtimes[runtime].before.keys)
      assert.equal(hash(Buffer.from((await sender.request('getConsignment', [{ assetId: aid, txid: existing.data.burn.txid }])).data, 'base64')), legacyReport.runtimes[runtime].before.oldProofSha256)
      row.restart = { freshProcesses: true, newBurnProofUnchanged: true, originalBurnProofUnchanged: true, transferRecoveriesMatch: true, originalPublicKeysUnchanged: true, bfaSender: '1260000', bfaRecipient: '1100000' }
      row.complete = true; await save(resultPath, result)
      console.log(runtime + ': new CI pack preserved funded state; BTC/NIA/CFA/BFA transfers, fresh mint and interrupted burn recovery passed.')
    } finally { await receiver?.stop(); await sender?.stop() }
  }
  privateState.status = 'complete'; await save(statePath, privateState)
  result.complete = true; result.fixtureStatus = fixture('status'); await save(resultPath, result)
}
