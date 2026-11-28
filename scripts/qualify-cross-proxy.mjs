// SPDX-License-Identifier: Apache-2.0
// Funded cross-proxy NIA/CFA transfers using an installed tarball and fresh wallets.
// Requires an explicitly disposable Regtest fixture with two independent RGB proxies.
// Each send loses its native End response, then resumes from the exact journal after
// a full host-process restart; no transfer is reconstructed or automatically replayed.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const [consumerArg, workerArg, fixtureArg, resultArg, runtimeSelection = 'both'] = process.argv.slice(2)
assert(consumerArg && workerArg && fixtureArg && resultArg,
  'Pass installed tarball consumer, Node worker, local fixture JSON, fresh result directory, with two independent proxy endpoints')
assert(['node', 'bare', 'both'].includes(runtimeSelection), 'Optional runtime selector must be node, bare or both')
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
assert.equal(manifest.source, 'f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d')
assert.equal(manifest.overlayTree, '0c20cd05eb2899962c152b6ccac324e2a705dc38')
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
loopback(fixture.recipientTransportEndpoint, ['rpc:'])
assert.notEqual(fixture.transportEndpoint, fixture.recipientTransportEndpoint)
assert.notEqual(new URL(fixture.transportEndpoint).port, new URL(fixture.recipientTransportEndpoint).port)
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const nodeSha256 = await digest(worker)
await access(worker, constants.X_OK)
const runtimes = runtimeSelection === 'bare' ? [] : ['node']
let bareSha256
let bareRuntimeSha256
if (runtimeSelection !== 'node') {
  assert(fixture.bareExecutable, 'A qualified Bare executable is required')
  await access(fixture.bareExecutable, constants.X_OK)
  bareRuntimeSha256 = await digest(fixture.bareExecutable)
  assert.match(fixture.bareTarget, /^(darwin|linux)-(arm64|x64)$/)
  const addon = join(pkg, 'prebuilds', fixture.bareTarget, 'utexo__wdk-wallet-rgb.bare')
  bareSha256 = await digest(addon)
  assert.equal(manifest.targets[fixture.bareTarget].sha256, bareSha256)
  runtimes.push('bare')
}
const identity = { version: metadata.version, integrity: installed.integrity,
  source: manifest.source, tree: manifest.overlayTree, nodeSha256, ...(bareSha256 && { bareSha256, bareRuntimeSha256 }) }
const evidence = join(output, 'cross-proxy-transfers.json')
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

// Do not fund wallets against a stale VM clock or the zero-retention expiry
// fixture: BFA.8 requires a full day of sender retention before a recipient ACK.
const proxyChecks = []
for (const endpoint of [fixture.transportEndpoint, fixture.recipientTransportEndpoint]) {
  const response = await fetch('http:' + endpoint.slice('rpc:'.length), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: null, method: 'server.info' }),
    redirect: 'error', signal: AbortSignal.timeout(5000)
  })
  assert(response.ok, 'Proxy must be reachable before qualification')
  const info = await response.json()
  assert.equal(info.jsonrpc, '2.0')
  assert.equal(info.id, null)
  assert(!info.error)
  assert.equal(info.result?.protocol_version, '1.0')
  const serverTime = Number(info.result.current_time)
  const retention = Number(info.result.retention_grace_secs)
  const maxExpiry = Number(info.result.max_expiry_secs)
  assert(Number.isSafeInteger(serverTime) && Math.abs(serverTime - Date.now() / 1000) < 60,
    'Proxy VM clock must match the host before creating timed invoices')
  assert(Number.isSafeInteger(retention) && retention >= 86400, 'Sender proxy must retain ACK data for at least one day')
  assert(Number.isSafeInteger(maxExpiry) && maxExpiry >= 86400, 'Proxy must admit the 24-hour test invoices')
  proxyChecks.push({ endpoint, version: info.result.version, protocolVersion: info.result.protocol_version,
    serverTime, retentionGraceSeconds: retention, maxExpirySeconds: maxExpiry })
}

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
  if (method === 'ping') return { runtime: isBare ? 'Bare ' + Bare.version : 'Node ' + process.version }
  if (method === 'open') {
    if (wallets.has(name)) throw new Error('Already open')
    const manager = new WalletManagerRgb(Uint8Array.from(params.seed), { ...params.config, authorize: () => true })
    try { wallets.set(name, { manager, account: await manager.getAccount() }) }
    catch (error) { await manager.shutdown(); throw error }
    return true
  }
  if (method === 'loseSendResponse') {
    const base = import.meta.resolve('@utexo/wdk-wallet-rgb')
    const filename = './src/onchain-' + (isBare ? 'bare-worker' : 'worker') + '.js'
    const RuntimeURL = isBare ? (await import('bare-url')).URL : URL
    const { OnchainWorker } = await import(new RuntimeURL(filename, base))
    const original = OnchainWorker.prototype.request
    OnchainWorker.prototype.request = async function (operation, params) {
      const result = await original.call(this, operation, params)
      if (operation === 'sendRgbEnd') {
        restore(); restore = undefined
        await this.close()
        throw Object.assign(new Error('Fixture lost submitted send reply'), { code: 'NATIVE_CLOSED' })
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
  const peerFile = join(consumer, '.cross-proxy-peer-' + randomBytes(8).toString('hex') + '.mjs')
  await writeFile(peerFile, peerSource, { flag: 'wx', mode: 0o600 })
  const child = spawn(runtime === 'bare' ? fixture.bareExecutable : process.execPath, [peerFile], {
    cwd: consumer, stdio: ['pipe', 'pipe', 'inherit']
  })
  const lines = createInterface({ input: child.stdout })
  let next = 0
  let pending
  let failure
  let stopping
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
  async function stop () {
    if (!stopping) stopping = (async () => {
      const priorFailure = failure
      try { if (!failure) await request('stop') }
      finally {
        child.stdin.end()
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
        try {
          const code = await exited
          if (code !== 0) throw priorFailure ?? new Error('Qualification peer exited: ' + code)
        } finally {
          clearTimeout(timer); lines.close(); await rm(peerFile)
        }
      }
    })()
    return stopping
  }
  return { request, call: (name, method, ...args) => request(method, name, args), stop }
}

await mkdir(output, { mode: 0o700 })
const faucet = 'cross-proxy-' + randomBytes(8).toString('hex')
await rpc('createwallet', [faucet])
await mine(faucet, 101)
const state = { identity, runtimes: {} }
const results = {}
const proxies = { A: fixture.transportEndpoint, B: fixture.recipientTransportEndpoint }
for (const runtime of runtimes) {
  const root = join(output, runtime)
  await mkdir(root, { mode: 0o700 })
  const seeds = { A: [...randomBytes(64)], B: [...randomBytes(64)] }
  state.runtimes[runtime] = { seeds }
  await writeFile(privateState, JSON.stringify(state) + '\n', { mode: 0o600 })
  let peer = await startPeer(runtime)
  const call = (name, method, ...args) => peer.call(name, method, ...args)
  async function open (name) {
    await peer.request('open', name, [], { seed: seeds[name], config: {
      network: 'regtest', dataDir: join(root, name), indexerUrl: fixture.indexerUrl,
      transportEndpoint: proxies[name], maxFeeSats: '5000',
      ...(runtime === 'node' ? { nativeAddon: worker, nativeSha256: nodeSha256 } : { nativeSha256: bareSha256 })
    } })
  }
  async function restart () {
    await peer.stop()
    peer = await startPeer(runtime)
    for (const name of ['A', 'B']) await open(name)
  }
  async function balance (name, assetId, amount) {
    await waitFor(name + ' balance ' + amount, async () => {
      await call(name, 'refresh')
      const value = await call(name, 'getAssetBalance', assetId)
      return ['settled', 'future', 'spendable'].every(key => value[key] === amount)
    })
  }
  async function transfer (schema, assetId, from, to, mode, amount, unknownAsset) {
    const invoice = await call(to, 'createRgbInvoice', {
      mode, ...(!unknownAsset && { assetId, amount }), expirationSeconds: 86400, minConfirmations: 6
    })
    const decoded = await call(from, 'decodeRgbInvoice', invoice.invoice)
    assert.deepEqual(decoded.transportEndpoints, [proxies[to]])
    assert.notEqual(decoded.transportEndpoints[0], proxies[from])
    assert.equal(decoded.recipientType, mode === 'blind' ? 'Blind' : 'Witness')
    assert.equal(decoded.assetId, unknownAsset ? null : assetId)
    const operationId = `cross-proxy-${runtime}-${schema.toLowerCase()}-${mode}`
    const request = { operationId, invoice: invoice.invoice, assetId, amount, feeRate: '2', minConfirmations: 6,
      ...(mode === 'witness' && { witnessAmountSats: '1000' }) }
    await peer.request('loseSendResponse')
    await assert.rejects(call(from, 'sendRgbInvoice', request), { code: 'NATIVE_CLOSED' })
    await restart()
    const saved = await call(from, 'getOperation', operationId)
    assert.equal(saved.stage, 'submitting')
    assert.equal(saved.kind, 'rgb-send')
    assert.equal(saved.args.senderTransportEndpoint, proxies[from])
    assert.equal(saved.args.invoice, invoice.invoice)
    assert.match(saved.txid, /^[a-f0-9]{64}$/)
    assert(!(await rpc('getrawmempool')).includes(saved.txid), 'No recipient ACK yet: no broadcast')
    const pendingTransfer = (await call(from, 'listTransfers', { assetId })).filter(row => row.txid === saved.txid && row.kind === 'Send')
    assert.equal(pendingTransfer.length, 1)
    assert.equal(pendingTransfer[0].status, 'WaitingCounterparty')
    // The committed End record is sufficient to recover SDK submission, even
    // while the counterparty ACK and Bitcoin broadcast remain pending.
    const pendingRecovery = await call(from, 'recoverSend', operationId)
    assert.equal(pendingRecovery.state, 'submitted')
    assert.equal(pendingRecovery.txid, saved.txid)
    await assert.rejects(call(from, 'sendRgbInvoice', request), { code: 'OPERATION_EXISTS' })
    await waitFor('cross-proxy ACK and broadcast', async () => {
      await call(to, 'refresh')
      await call(from, 'refresh')
      return (await rpc('getrawmempool')).includes(saved.txid)
    })
    const inPool = await rpc('getrawmempool')
    assert.equal(inPool.filter(txid => txid === saved.txid).length, 1)
    await mine(faucet, 6)
    await call(to, 'refresh')
    await call(from, 'refresh')
    const transaction = await rpc('getrawtransaction', [saved.txid, true])
    assert(transaction.confirmations >= 6)
    const exposureFile = join(root, from, '.wdk-onchain-exposed-inputs-v1', saved.txid + '.json')
    const exposure = JSON.parse(await readFile(exposureFile, 'utf8'))
    assert.equal(exposure.txid, saved.txid)
    assert.equal(exposure.kind, 'rgb-send')
    assert.equal((await stat(exposureFile)).mode & 0o777, 0o600)
    await restart()
    const beforeRetry = await rpc('getrawmempool')
    const recovered = await call(from, 'recoverSend', operationId)
    assert.equal(recovered.state, 'submitted')
    assert.equal(recovered.txid, saved.txid)
    await assert.rejects(call(from, 'sendRgbInvoice', request), { code: 'OPERATION_EXISTS' })
    assert.deepEqual(await rpc('getrawmempool'), beforeRetry)
    const transfers = (await call(from, 'listTransfers', { assetId })).filter(row => row.txid === saved.txid && row.kind === 'Send')
    assert.equal(transfers.length, 1)
    assert.equal(transfers[0].status, 'Settled')
    return { schema, mode, from, to, amount, assetId, txid: saved.txid, confirmations: transaction.confirmations,
      senderProxy: proxies[from], recipientProxy: proxies[to], lostEndResponse: true,
      restartedBeforeAck: true, recoveredAfterRestart: true, exactIdRetryRejected: true, signedInputsPersisted: true }
  }
  try {
    const version = await peer.request('ping')
    const funding = {}
    for (const name of ['A', 'B']) {
      await open(name)
      const address = await call(name, 'getAddress')
      assert.match(address, /^bcrt1p/)
      funding[name] = await rpc('sendtoaddress', [address, 0.02], faucet)
    }
    await mine(faucet, 6)
    for (const name of ['A', 'B']) {
      assert.equal(await call(name, 'getBalance'), '2000000')
      await call(name, 'createUtxos', { operationId: `cross-proxy-outputs-${runtime}-${name.toLowerCase()}`,
        count: 12, size: '1000', feeRate: '2' })
    }
    await mine(faucet, 6)
    const cases = []
    for (const schema of ['Nia', 'Cfa']) {
      const issued = await call('A', 'issueAsset' + schema, {
        operationId: `cross-proxy-issue-${runtime}-${schema.toLowerCase()}`, name: 'Cross proxy fixture',
        ...(schema === 'Nia' && { ticker: 'VPROXY' }), precision: 2, amounts: ['1000']
      })
      assert.equal(issued.schema, schema)
      const { assetId } = issued
      await balance('A', assetId, '1000')
      cases.push(await transfer(schema, assetId, 'A', 'B', 'blind', '450', true))
      await balance('A', assetId, '550')
      await balance('B', assetId, '450')
      cases.push(await transfer(schema, assetId, 'B', 'A', 'witness', '150', false))
      await balance('A', assetId, '700')
      await balance('B', assetId, '300')
      await restart()
      await balance('A', assetId, '700')
      await balance('B', assetId, '300')
    }
    results[runtime] = { runtime: version.runtime, funding, cases, finalBalances: { A: '700', B: '300' } }
    await writeFile(evidence, JSON.stringify({ identity, proxyChecks, results, completedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
    console.log('Passed packed ' + runtime + ' cross-proxy transfers and restart recovery')
  } finally { await peer.stop() }
}
