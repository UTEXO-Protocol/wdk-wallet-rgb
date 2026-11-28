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

const result = JSON.parse(await readFile(snapshotPath, 'utf8'))
assert(!result.previousUrlWallets)
result.previousUrlWallets = {}
for (const runtime of ['node','bare']) {
  const p = await peer(runtime)
  try { for (const role of ['sender','receiver']) result.previousUrlWallets[runtime+'/'+role] = await snapshotPrevious(p,runtime,role) }
  finally { await p.stop() }
}
await save(snapshotPath,result)
console.log('Four additional retained RC4 wallet snapshots added; ten now recorded.')
