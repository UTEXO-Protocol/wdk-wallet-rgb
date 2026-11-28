import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, readdir, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
const here = import.meta.dirname
const [consumerArg, archiveArg, verificationArg] = process.argv.slice(2)
assert(consumerArg && archiveArg && verificationArg && process.env.WDK_FRESH_FIXTURE_ROOT && process.env.WDK_BARE_EXECUTABLE)
const consumer = resolve(consumerArg), fixtureRoot = resolve(process.env.WDK_FRESH_FIXTURE_ROOT), bare = resolve(process.env.WDK_BARE_EXECUTABLE)
const worker = join(consumer, 'node_modules/@utexo/wdk-wallet-rgb/prebuilds/darwin-arm64/utexo-rgb-native.node')
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


const prior = JSON.parse(await readFile(join(here, 'result.json'), 'utf8'))
const state = JSON.parse(await readFile(join(here, 'private-state.json'), 'utf8'))
assert(prior.complete && state.status === 'complete')
const verificationBytes = await readFile(resolve(verificationArg))
const verification = JSON.parse(verificationBytes)
assert.equal(verification.package.sha256, hash(await readFile(resolve(archiveArg))))
assert.equal(verification.native.source, prior.source)
assert.equal(verification.published, false)
assert.equal(verification.assets['utexo-wdk-wallet-rgb-3.0.0-rc.4.tgz'].sha256, verification.package.sha256)
for (const runtime of ['node', 'bare']) {
 assert.equal(verification.source[runtime].producerCommit, prior.nativeProducers[runtime])
 assert.equal(verification.source[runtime].nativeInputsUnchanged, true)
 assert.equal(verification.source[runtime].runtimeFilesUnchangedSinceProducer, true)
}
const equivalence = JSON.parse(await readFile(join(here, 'funded-final-equivalence.json'), 'utf8'))
assert.equal(equivalence.qualifiedPackageSha256, prior.packageSha256)
assert.equal(equivalence.finalPackageSha256, verification.package.sha256)
assert.equal(equivalence.allRuntimeAndNativeBytesIdentical, true)
const pkg = join(consumer, 'node_modules/@utexo/wdk-wallet-rgb')
const admission = spawnSync('python3', ['-c', `import json,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[2]);count=0
with tarfile.open(sys.argv[1]) as tar:
 for member in tar.getmembers():
  if member.isdir():continue
  assert member.isfile() and member.name.startswith('package/')
  relative=pathlib.PurePosixPath(member.name).relative_to('package');assert '..' not in relative.parts
  assert (root/str(relative)).read_bytes()==tar.extractfile(member).read()
  count+=1
print(json.dumps({'matchedFiles':count,'everyArchiveFileMatched':True}))`, resolve(archiveArg), pkg], {encoding:'utf8'})
assert.equal(admission.status, 0, admission.stderr)
const result = { packageSha256: verification.package.sha256, packageSource: verification.source.node.releaseCommit, qualificationPackageSha256: prior.packageSha256,
 releaseVerifierSha256: hash(verificationBytes), packageAdmission: JSON.parse(admission.stdout), nativeHashes: {}, existingFundedWallets: {}, freshWallets: {}, financialMutationsInvoked: false }
const contract = await readFile(join(here, 'public-contract.rgb'))
const expectedMetadata = { assetId: prior.assetId, schema: 'Bfa', name: 'Upgrade Fixture Dollar', ticker: 'BUSDT', precision: 6 }
async function metadata(p) {
 const asset = (await p.request('listAssets')).find(value => value.assetId === prior.assetId)
 assert(asset)
 const value = await p.request('getAssetMetadata', [prior.assetId])
 for (const [key, expected] of Object.entries(expectedMetadata)) { assert.equal(asset[key], expected); assert.equal(value[key], expected) }
}
for (const runtime of ['node', 'bare']) {
 const manifest = JSON.parse(await readFile(join(pkg, 'src/onchain-' + runtime + '-native.json'), 'utf8'))
 assert.equal(manifest.source, prior.source)
 assert.equal(manifest.targets['darwin-arm64'].sha256, prior.nativeHashes[runtime])
 assert.equal(Object.keys(manifest.targets).length, runtime === 'node' ? 5 : 11)
 assert.equal(manifest.publicationHold, false); assert.equal(manifest.releaseHold, false)
 result.nativeHashes[runtime] = manifest.targets['darwin-arm64'].sha256
 const data = state.runtimes[runtime], old = prior.runtimes[runtime]
 const p = await peer(runtime)
 try {
  for (const role of ['sender', 'receiver']) {
   await p.open(data[role].seed, data[role].dataDir)
   await metadata(p)
   assert.equal((await p.request('getAssetBalance', [prior.assetId])).spendable, old.restart[role === 'sender' ? 'bfaSender' : 'bfaRecipient'])
   for (const asset of old.ordinary) assert.equal((await p.request('getAssetBalance', [asset.assetId])).spendable, role === 'sender' ? '900' : '100')
   if (role === 'sender') {
    assert.deepEqual(await p.request('getPublicKeys'), old.keys)
    assert.equal(await p.request('verifyMessageBip322', ['WDK first release qualification', old.signingAddress, old.signature]), true)
    for (const transfer of [old.bfaSend, old.btcSend, ...old.ordinary]) assert.equal((await p.request('recoverSend', [transfer.operationId])).txid, transfer.txid)
    for (const burn of old.burns) {
     const recovered = await p.request('recoverBurn', [burn.operationId]); assert.equal(recovered.txid, burn.txid)
     assert.equal(hash(Buffer.from(recovered.proof.data, 'base64')), burn.proofSha256)
     const proof = await p.request('getConsignment', [{ assetId: prior.assetId, txid: burn.txid }])
     assert.equal(hash(Buffer.from(proof.data, 'base64')), burn.proofSha256)
    }
   }
   await p.request('close')
  }
  result.existingFundedWallets[runtime] = { openedFreshProcess: true, metadataAndBalancesStable: true, originalKeysAndBip322Verified: true, allBurnProofsRecoveredIdentically: true, allTransfersRecoveredByOriginalId: true }
  const fresh = { seed: [...randomBytes(64)], dataDir: join(here, 'final-fresh-wallets', runtime) }
  await p.open(fresh.seed, fresh.dataDir)
  assert.deepEqual(await p.request('listAssets'), [])
  const keys = await p.request('getPublicKeys'), address = await p.request('getMessageSigningAddress')
  const signature = await p.request('signMessageBip322', ['Final packed consumer', address])
  assert.equal(await p.request('verifyMessageBip322', ['Final packed consumer', address, signature]), true)
  await p.request('register', [], { assetId: prior.assetId, sha256: hash(contract), contract: contract.toString('base64') })
  await metadata(p);assert.equal((await p.request('getAssetBalance', [prior.assetId])).spendable, '0')
  await p.request('close');await p.open(fresh.seed, fresh.dataDir)
  assert.deepEqual(await p.request('getPublicKeys'), keys)
  await metadata(p);assert.equal((await p.request('getAssetBalance', [prior.assetId])).spendable, '0')
  const info = await p.request('getInfo');assert.equal(info.protocol, 'RGB_L1');assert.equal(info.burnDestinationVersion, 1)
  assert(info.methods.includes('burnAsset') && info.methods.includes('getConsignment') && info.methods.includes('getReceivedMint'))
  result.freshWallets[runtime] = { creation: true, bip322: true, publicContractRegistration: true, restartKeepsIdentityAndMetadata: true, noInventedAllocations: true, webRgbBurnProofAndMintMethodsAvailable: true }
 } finally { await p.stop() }
}
result.complete = true
await save(join(here, 'final-packed-recovery.json'), result)
console.log(JSON.stringify({complete:true,freshRuntimes:2,fundedWalletsRecovered:4,burnProofsRecovered:10,financialMutationsInvoked:false,packageSha256:result.packageSha256}))
