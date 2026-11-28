// SPDX-License-Identifier: Apache-2.0
// Exercise independent WalletManagers/native threads from an installed package.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

const [packageArg, outputArg, archiveArg] = process.argv.slice(2)
if (!packageArg || !outputArg || process.argv.length > 5) {
  throw new Error('Usage: node run.mjs INSTALLED_PACKAGE_ROOT OUTPUT_JSON [PACKAGE_ARCHIVE]')
}
async function sha256 (path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
const packageRoot = await realpath(packageArg)
const packageInfo = JSON.parse(await readFile(join(packageRoot, 'package.json')))
assert.equal(packageInfo.name, '@utexo/wdk-wallet-rgb')
const manifestPath = join(packageRoot, 'src/onchain-node-native.json')
const manifest = JSON.parse(await readFile(manifestPath))
assert.equal(manifest.releaseHold, false)
assert.equal(manifest.runtime, 'node-in-process')
const target = process.platform === 'darwin'
  ? 'darwin-' + process.arch
  : process.platform === 'linux'
    ? 'linux-' + process.arch + '-' + (process.report.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl')
    : null
assert.ok(target && Object.hasOwn(manifest.targets, target), 'Package has no addon for this host')
const pin = manifest.targets[target]
const addon = join(packageRoot, 'prebuilds', target, 'utexo-rgb-native.node')
assert.equal((await stat(addon)).size, pin.byteLength)
assert.equal(await sha256(addon), pin.sha256)
const temporary = await mkdtemp(join(await realpath(tmpdir()), 'wdk-node-concurrent-'))
const live = new Set()
const seeds = Array.from({ length: 4 }, () => randomBytes(64))
const originalUmask = process.umask()

try {
  const entry = join(packageRoot, 'onchain.js')
  const addresses = []
  const rounds = []
  async function open (index, expectedFailure) {
    const dataDir = join(temporary, 'wallet-' + index)
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    // Deliberately omit nativeAddon/nativeSha256: use the package's normal discovery.
    const config = {
      dataDir, network: 'regtest', startupMode: 'offline',
      indexerUrl: 'tcp://127.0.0.1:50001', transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc', maxFeeSats: '5000'
    }
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { entry, config, seed: seeds[index] } })
    live.add(worker)
    const pending = new Map()
    let sequence = 0
    let settleReady
    const readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Wallet initialization deadline exceeded')), 30_000)
      settleReady = (error, result) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(result)
      }
    })
    worker.on('error', error => {
      settleReady(error)
      for (const call of pending.values()) call.reject(error)
      pending.clear()
    })
    const exited = new Promise(resolve => worker.once('exit', code => {
      live.delete(worker)
      const error = new Error('Wallet worker exited before completing the acceptance request')
      settleReady(error)
      for (const call of pending.values()) call.reject(error)
      pending.clear()
      resolve(code)
    }))
    worker.on('message', reply => {
      if (Object.hasOwn(reply, 'ready')) return settleReady(null, reply)
      const call = pending.get(reply.id)
      if (!call) throw new Error('Unexpected acceptance response')
      pending.delete(reply.id)
      if (reply.error) call.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }))
      else call.resolve(reply.result)
    })
    const ready = await readyPromise
    if (expectedFailure) {
      assert.deepEqual(ready, { ready: false, code: expectedFailure })
      assert.equal(await exited, 0)
      return
    }
    assert.equal(ready.ready, true)
    assert.match(ready.address, /^bcrt1p/)
    return {
      address: ready.address,
      request (action, args = {}) {
        const id = ++sequence
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Wallet acceptance request deadline exceeded')), 30_000)
          pending.set(id, {
            resolve: value => { clearTimeout(timer); resolve(value) },
            reject: error => { clearTimeout(timer); reject(error) }
          })
          worker.postMessage({ id, action, ...args })
        })
      },
      async close () {
        assert.deepEqual(await this.request('close'), { closed: true })
        assert.equal(await exited, 0)
      }
    }
  }

  let peers = await Promise.all(seeds.map((_, index) => open(index)))
  addresses.push(...peers.map(peer => peer.address))
  assert.equal(new Set(addresses).size, 4)
  for (let round = 0; round < 3; round++) {
    const message = 'Node concurrent acceptance ' + round
    const results = await Promise.all(peers.map(peer => peer.request('readsign', { message })))
    await Promise.all(peers.map((peer, index) => peer.request('verify', {
      message, address: results[(index + 1) % 4].address, signature: results[(index + 1) % 4].signature
    }).then(valid => assert.equal(valid, true))))
    rounds.push({ round, wallets: 4, approvalsPerWallet: results.map(value => value.approvals) })
  }
  // A separate JS isolate bypasses the manager's local directory map. The native
  // file lock must reject it while the original native worker owns that wallet.
  await open(0, 'WALLET_IN_USE')
  await Promise.all(peers.slice(0, 2).map(peer => peer.close()))
  await Promise.all(peers.slice(2).map(peer => peer.request('readsign', { message: 'Other workers remain live' })))
  const reopened = await Promise.all([open(0), open(1)])
  assert.deepEqual(reopened.map(peer => peer.address), addresses.slice(0, 2))
  peers = [...reopened, ...peers.slice(2)]
  await Promise.all(peers.map(peer => peer.request('readsign', { message: 'After partial process teardown' })))
  await Promise.all(peers.map(peer => peer.close()))
  const final = await Promise.all(seeds.map((_, index) => open(index)))
  assert.deepEqual(final.map(peer => peer.address), addresses)
  await Promise.all(final.map(peer => peer.request('readsign', { message: 'After full wallet teardown' })))
  await Promise.all(final.map(peer => peer.close()))
  assert.equal(live.size, 0)
  assert.equal(process.umask(), originalUmask)

  const result = {
    status: 'passed', node: process.version, target,
    packageVersion: packageInfo.version,
    archiveSha256: archiveArg ? await sha256(archiveArg) : null,
    packageJsonSha256: await sha256(join(packageRoot, 'package.json')),
    nativeManifestSha256: await sha256(manifestPath),
    nativeSha256: pin.sha256, nativeBytes: pin.byteLength,
    artifactDiscovery: 'Automatic bundled addon discovery; no path or hash override',
    independentManagers: 4, independentNativeThreads: 4,
    checks: ['simultaneous offline open', 'three concurrent read and BIP-322 rounds', 'cross-wallet public signature verification',
      'native same-directory collision across separate manager isolates', 'partial teardown while other wallets remain live',
      'reopen after partial and full teardown preserves all four identities', 'all workers exit after awaited shutdown', 'host umask unchanged'],
    identityDigests: addresses.map(address => createHash('sha256').update(address).digest('hex')),
    rounds,
    financialActivity: 'None: disposable offline wallets and local message signing only',
    limitation: 'Packed package offline concurrency acceptance. Funded settlement and other platforms require separate acceptance.'
  }
  await writeFile(resolve(outputArg), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ status: result.status, node: result.node, target, nativeSha256: pin.sha256 }))
} finally {
  for (const seed of seeds) seed.fill(0)
  // This fixture never dispatches financial mutations. On failure, terminate only
  // its own disposable offline workers before removing their temporary directories.
  await Promise.all([...live].map(worker => worker.terminate()))
  await rm(temporary, { recursive: true, force: true })
}
