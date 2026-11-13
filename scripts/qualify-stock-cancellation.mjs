// SPDX-License-Identifier: Apache-2.0
// Run against an installed tarball and an isolated Regtest fixture. Uses real invoice
// expiry (one hour plus BFA.8's five-minute clock margin), without editing wallet state.
// `prepare` creates the invoices and exits; `finish` checks them after that deadline.
// `run` performs both phases and waits, reporting the actual expiry time.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const [consumerArg, workerArg, fixtureArg, resultArg, phase = 'run'] = process.argv.slice(2)
assert(consumerArg && workerArg && fixtureArg && resultArg,
  'Pass installed tarball consumer, Node worker, local fixture JSON, fresh result directory, and optional prepare/finish/run')
assert(['prepare', 'finish', 'run'].includes(phase))
const consumer = await realpath(consumerArg)
const worker = await realpath(workerArg)
const fixture = JSON.parse(await readFile(fixtureArg, 'utf8'))
const output = resolve(resultArg)
const pkg = join(consumer, 'node_modules/@utexo/wdk-wallet-rgb')
const metadata = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(pkg, 'src/onchain-bare-native.json'), 'utf8'))
const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'))
const installed = lock.packages?.['node_modules/@utexo/wdk-wallet-rgb']
assert.match(installed?.resolved ?? '', /^file:.*\.tgz$/)
assert.match(installed?.integrity ?? '', /^sha512-/)
assert.equal(manifest.source, '2f7b21d8637baad548504ea870deb2c0d4d0a37d')
assert.equal(manifest.overlayTree, '5492824f3cf47b4c821dfca8b7a63fed27858486')
assert.equal(manifest.integrationTree, manifest.overlayTree)
assert.equal(manifest.releaseHold, false)
assert.equal(fixture.disposable, true, 'This script mines and funds only an explicitly disposable fixture')

function loopback (raw, protocols) {
  const url = new URL(raw)
  assert(protocols.includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname))
  assert(Number(url.port) >= 40000 && !url.username && !url.password && !url.search && !url.hash,
    'Use isolated fixture ports, not the shared baseline stack')
  return url
}
const bitcoinUrl = loopback(fixture.bitcoinRpcUrl, ['http:'])
assert.equal(bitcoinUrl.pathname, '/')
const indexerUrl = loopback(fixture.indexerUrl, ['tcp:'])
loopback(fixture.transportEndpoint, ['rpc:'])
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const nodeSha256 = await digest(worker)
const runtimes = ['node']
let bareSha256
if (fixture.bareExecutable) {
  assert.match(fixture.bareTarget, /^(darwin|linux)-(arm64|x64)$/)
  const addon = join(pkg, 'prebuilds', fixture.bareTarget, 'utexo__wdk-wallet-rgb.bare')
  bareSha256 = await digest(addon)
  assert.equal(manifest.targets[fixture.bareTarget].sha256, bareSha256)
  runtimes.push('bare')
}
const identity = { version: metadata.version, integrity: installed.integrity,
  source: manifest.source, tree: manifest.overlayTree, nodeSha256, ...(bareSha256 && { bareSha256 }) }
const evidence = join(output, 'cancellation.json')
const privateState = join(output, 'private-state.json')

let rpcId = 0
async function rpc (method, params = [], wallet) {
  const url = new URL(wallet ? '/wallet/' + encodeURIComponent(wallet) : '/', bitcoinUrl)
  const response = await fetch(url, {
    method: 'POST', headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + Buffer.from(fixture.bitcoinRpcUser + ':' + fixture.bitcoinRpcPassword).toString('base64')
    }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(30_000)
  })
  const reply = await response.json()
  assert(!reply.error, method + ': ' + reply.error?.message)
  assert(response.ok)
  return reply.result
}
assert.equal((await rpc('getblockchaininfo')).chain, 'regtest')

async function waitFor (description, condition) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (await condition()) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1000))
  }
  assert.fail('Timed out waiting for ' + description)
}

async function indexedHeight () {
  return new Promise(resolveHeight => {
    const socket = createConnection({ host: indexerUrl.hostname, port: Number(indexerUrl.port) })
    let data = ''
    socket.setEncoding('utf8').setTimeout(2000)
    socket.once('connect', () => socket.write(JSON.stringify({
      id: 1, method: 'blockchain.headers.subscribe', params: []
    }) + '\n'))
    socket.on('data', chunk => {
      data += chunk
      if (data.includes('\n') || data.length > 4096) {
        socket.destroy()
        try { resolveHeight(JSON.parse(data.split('\n')[0]).result?.height) } catch { resolveHeight(null) }
      }
    })
    socket.once('timeout', () => socket.destroy())
    socket.once('error', () => resolveHeight(null))
    socket.once('close', () => resolveHeight(null))
  })
}

async function mine (faucet, count) {
  const address = await rpc('getnewaddress', [], faucet)
  await rpc('generatetoaddress', [count, address], faucet)
  const height = await rpc('getblockcount')
  await waitFor('indexer height ' + height, async () => await indexedHeight() === height)
}

const peerSource = `
import { WalletManagerRgb } from '@utexo/wdk-wallet-rgb'
const isBare = typeof Bare !== 'undefined'
const io = isBare ? (await import('bare-stdio')).default : { in: process.stdin, out: process.stdout }
const wallets = new Map()
let restore
async function dispatch (request) {
  const { method, name, args = [], params } = request
  if (method === 'open') {
    if (wallets.has(name)) throw new Error('Already open')
    const manager = new WalletManagerRgb(Uint8Array.from(params.seed), { ...params.config, authorize: () => true })
    try { wallets.set(name, { manager, account: await manager.getAccount() }) }
    catch (error) { await manager.shutdown(); throw error }
    return true
  }
  if (method === 'loseCancellationResponse') {
    const base = import.meta.resolve('@utexo/wdk-wallet-rgb')
    const filename = './src/onchain-' + (isBare ? 'bare-worker' : 'worker') + '.js'
    const RuntimeURL = isBare ? (await import('bare-url')).URL : URL
    const { OnchainWorker } = await import(new RuntimeURL(filename, base))
    const original = OnchainWorker.prototype.request
    OnchainWorker.prototype.request = async function (operation, params) {
      const result = await original.call(this, operation, params)
      if (operation === 'cancelReceiveInvoice') {
        restore(); restore = undefined
        await this.close()
        throw Object.assign(new Error('Fixture lost committed cancellation reply'), { code: 'NATIVE_CLOSED' })
      }
      return result
    }
    restore = () => { OnchainWorker.prototype.request = original }
    return true
  }
  if (method === 'stop') {
    restore?.()
    for (const { manager } of wallets.values()) await manager.shutdown()
    wallets.clear()
    return true
  }
  const wallet = wallets.get(name)
  if (!wallet) throw new Error('Closed wallet')
  if (method === 'close') { await wallet.manager.shutdown(); wallets.delete(name); return true }
  return wallet.account[method](...args)
}
let buffer = ''
let stopped = false
try {
  input: for await (const chunk of io.in) {
    buffer += chunk.toString()
    let end
    while ((end = buffer.indexOf('\\n')) !== -1) {
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      let reply
      try { reply = { id: request.id, result: (await dispatch(request)) ?? null } }
      catch (error) { reply = { id: request.id, error: { code: error.code ?? error.name, message: error.message } } }
      const line = JSON.stringify(reply, (_, value) => typeof value === 'bigint' ? value.toString() : value) + '\\n'
      await new Promise((resolve, reject) => io.out.write(line, error => error ? reject(error) : resolve()))
      if (request.method === 'stop' && !reply.error) { stopped = true; break input }
    }
  }
} finally {
  restore?.()
  await Promise.allSettled([...wallets.values()].map(({ manager }) => manager.shutdown()))
}
if (isBare && stopped) Bare.exit(0)
`

async function startPeer (runtime) {
  const peerFile = join(consumer, '.stock-cancellation-peer-' + randomBytes(8).toString('hex') + '.mjs')
  await writeFile(peerFile, peerSource, { flag: 'wx', mode: 0o600 })
  const child = spawn(runtime === 'bare' ? fixture.bareExecutable : process.execPath, [peerFile], {
    cwd: consumer, stdio: ['pipe', 'pipe', 'inherit']
  })
  const lines = createInterface({ input: child.stdout })
  let next = 0
  let pending
  let failure
  function fail (error) { failure ??= error; pending?.reject(failure); pending = undefined }
  child.once('error', fail)
  child.stdin.on('error', fail)
  const exited = new Promise(resolveExit => child.once('close', (code, signal) => {
    fail(new Error('Qualification peer exited: ' + (signal ?? code)))
    resolveExit(code)
  }))
  lines.on('line', line => {
    try {
      const reply = JSON.parse(line)
      assert.equal(reply.id, pending?.id)
      const request = pending; pending = undefined
      if (reply.error) request.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }))
      else request.resolve(reply.result)
    } catch (error) { fail(error) }
  })
  async function request (method, name, args = [], params) {
    if (failure) throw failure
    assert.equal(pending, undefined)
    const timer = setTimeout(() => { fail(new Error('Qualification request timed out: ' + method)); child.kill() }, 150_000)
    try {
      return await new Promise((resolveRequest, reject) => {
        const id = ++next
        pending = { id, resolve: resolveRequest, reject }
        child.stdin.write(JSON.stringify({ id, method, name, args, params }) + '\n')
      })
    } finally { clearTimeout(timer) }
  }
  return { request, call: (name, method, ...args) => request(method, name, args),
    async stop () {
      try { if (!failure) await request('stop') }
      finally {
        child.stdin.end()
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
        try { assert.equal(await exited, 0) } finally {
          clearTimeout(timer); lines.close(); await rm(peerFile)
        }
      }
    }
  }
}

async function open (peer, runtime, name, seed) {
  await peer.request('open', name, [], { seed, config: {
    network: 'regtest', dataDir: join(output, runtime, name), indexerUrl: fixture.indexerUrl,
    transportEndpoint: fixture.transportEndpoint, maxFeeSats: '5000',
    ...(runtime === 'node' ? { nativeExecutable: worker, nativeSha256: nodeSha256 } : { nativeSha256: bareSha256 })
  } })
}

let state
if (phase !== 'finish') {
  await mkdir(output, { mode: 0o700 })
  const faucet = 'stock-cancellation-' + randomBytes(8).toString('hex')
  await rpc('createwallet', [faucet])
  await mine(faucet, 101)
  state = { identity, runtimes: {}, preparedAt: new Date().toISOString(), expiresAfter: 0 }
  for (const runtime of runtimes) {
    await mkdir(join(output, runtime), { mode: 0o700 })
    const peer = await startPeer(runtime)
    const data = { seed: [...randomBytes(64)], invoices: [], live: [] }
    state.runtimes[runtime] = data
    try {
      await open(peer, runtime, 'wallet', data.seed)
      const address = await peer.call('wallet', 'getAddress')
      assert.match(address, /^bcrt1p/)
      data.funding = await rpc('sendtoaddress', [address, 0.02], faucet)
      await mine(faucet, 6)
      assert.equal(await peer.call('wallet', 'getBalance'), '2000000')
      data.outputs = await peer.call('wallet', 'createUtxos', {
        operationId: 'stock-cancel-outputs-' + runtime, count: 8, size: '1000', feeRate: '2'
      })
      await mine(faucet, 6)
      for (const schema of ['Nia', 'Cfa']) {
        const issued = await peer.call('wallet', 'issueAsset' + schema, {
          operationId: 'stock-cancel-issue-' + schema.toLowerCase(), name: 'Cancellation fixture',
          ...(schema === 'Nia' && { ticker: 'VCANCEL' }), precision: 2, amounts: ['1000']
        })
        for (const mode of ['blind', 'witness']) {
          const invoice = await peer.call('wallet', 'createRgbInvoice', {
            mode, assetId: issued.assetId, amount: '10', expirationSeconds: 3600
          })
          const target = { batchTransferIdx: invoice.batchTransferIdx, recipientId: invoice.recipientId }
          await assert.rejects(peer.call('wallet', 'cancelReceiveInvoice', target), { code: 'RECEIVE_CANCELLATION_UNAVAILABLE' })
          const sentinel = await peer.call('wallet', 'createRgbInvoice', {
            mode: 'witness', assetId: issued.assetId, expirationSeconds: 86400
          })
          await assert.rejects(peer.call('wallet', 'cancelReceiveInvoice', { ...target, recipientId: sentinel.recipientId }),
            { code: 'RECEIVE_NOT_FOUND' })
          data.invoices.push({ ...target, assetId: issued.assetId, schema, mode, expiry: Number(invoice.expirationTimestamp) })
          data.live.push(sentinel.recipientId)
          state.expiresAfter = Math.max(state.expiresAfter, Number(invoice.expirationTimestamp) + 301)
        }
      }
      const generic = await peer.call('wallet', 'createRgbInvoice', { mode: 'witness', expirationSeconds: 3600 })
      data.generic = { batchTransferIdx: generic.batchTransferIdx, recipientId: generic.recipientId }
      state.expiresAfter = Math.max(state.expiresAfter, Number(generic.expirationTimestamp) + 301)
    } finally { await peer.stop() }
  }
  await writeFile(privateState, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 })
  await writeFile(evidence, JSON.stringify({ identity, phase: 'awaiting-expiry',
    created: Object.fromEntries(Object.entries(state.runtimes).map(([runtime, data]) => [runtime, {
      funding: data.funding, outputs: data.outputs.txid, invoiceCount: data.invoices.length,
      activeCancellationRejected: true, foreignRecipientRejected: true
    }])), readyAfter: new Date(state.expiresAfter * 1000).toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log('Expiry qualification can finish after ' + new Date(state.expiresAfter * 1000).toISOString())
}
if (phase === 'prepare') process.exit(0)
if (phase === 'finish') {
  assert.equal((await stat(output)).mode & 0o777, 0o700)
  assert.equal((await stat(privateState)).mode & 0o777, 0o600)
  state = JSON.parse(await readFile(privateState, 'utf8'))
  assert.deepEqual(state.identity, identity, 'Finish must use the identical packed/native inputs')
  assert(Date.now() > state.expiresAfter * 1000, 'Real invoice expiry and proxy skew margin have not elapsed')
} else {
  while (Date.now() <= state.expiresAfter * 1000) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(30_000, state.expiresAfter * 1000 - Date.now() + 1)))
  }
}
const results = {}
for (const [runtime, data] of Object.entries(state.runtimes)) {
  const peer = await startPeer(runtime)
  try {
    await open(peer, runtime, 'wallet', data.seed)
    await assert.rejects(peer.call('wallet', 'cancelReceiveInvoice', data.generic), { code: 'RECEIVE_CANCELLATION_UNAVAILABLE' })
    const cases = []
    for (const [index, invoice] of data.invoices.entries()) {
      const target = { batchTransferIdx: invoice.batchTransferIdx, recipientId: invoice.recipientId }
      const loseResponse = index === data.invoices.length - 1
      if (loseResponse) {
        await peer.request('loseCancellationResponse')
        await assert.rejects(peer.call('wallet', 'cancelReceiveInvoice', target), { code: 'NATIVE_CLOSED' })
      } else {
        assert.equal(await peer.call('wallet', 'cancelReceiveInvoice', target), null)
      }
      await peer.call('wallet', 'close')
      await open(peer, runtime, 'wallet', data.seed)
      assert.equal(await peer.call('wallet', 'cancelReceiveInvoice', target), null)
      const row = await peer.call('wallet', 'getInvoiceStatus', target.recipientId)
      assert.equal(row.status, 'Failed')
      assert.equal(row.receiveCancellationEligible, false)
      assert.equal(row.txid, null)
      for (const recipient of data.live) {
        assert.equal((await peer.call('wallet', 'getInvoiceStatus', recipient)).status, 'WaitingCounterparty')
      }
      cases.push({ schema: invoice.schema, mode: invoice.mode, cancelled: true,
        retryAfterRestart: true, lostResponseAfterCommit: loseResponse })
    }
    assert.equal((await peer.call('wallet', 'listUnspents')).reduce((sum, row) => sum + row.pendingBlinded, 0), 0)
    results[runtime] = { cases, arbitraryAssetExcluded: true, unrelatedLiveInvoicesPreserved: true,
      blindedReservationsReleased: true }
  } finally { await peer.stop() }
}
await writeFile(evidence, JSON.stringify({ identity, phase: 'passed', realExpiry: true,
  walletStateEdited: false, machineClockChanged: false, results, completedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
console.log('Passed packed native invoice cancellation and restart qualification')
