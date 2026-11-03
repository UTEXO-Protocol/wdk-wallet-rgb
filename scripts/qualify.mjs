// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
// Run from a clean npm consumer with its private regtest directory and isolated fixture.
import { WalletManagerRgb, burnDestinationFor, burnDestinationHash, createBurnPackage } from '@utexo/wdk-wallet-rgb'

const bare = typeof Bare !== 'undefined'
const { default: assert } = await import(bare ? 'bare-assert' : 'node:assert/strict')
const { default: fs } = await import(bare ? 'bare-fs/promises' : 'node:fs/promises')
const { join } = await import(bare ? 'bare-path' : 'node:path')
const { spawnSync } = await import(bare ? 'bare-subprocess' : 'node:child_process')
const { createHash } = await import(bare ? 'bare-crypto' : 'node:crypto')
const { setTimeout } = await import(bare ? 'bare-timers' : 'node:timers')
const { URLSearchParams } = await import(bare ? 'bare-url' : 'node:url')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const { lstat, mkdir, readFile, realpath, writeFile } = fs

const [action, root, expectedOpid] = process.argv.slice(2)
if (!['setup', 'prepare', 'pending', 'decline', 'burn', 'recover'].includes(action) || !root) throw new Error('Use: <bare|node> qualify.mjs <phase> <absolute qualification root>')
const fixture = join(root, 'fixture')
const state = await realpath(process.cwd())
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
async function writeNewFile (path, value) {
  // The harness runs in a single-use private directory. Bare fs 4.8.4 does
  // not enforce 'wx', so check for residue before any qualification writes.
  const existing = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  assert.strictEqual(existing, undefined, 'Qualification output already exists')
  await writeFile(path, value, { mode: 0o600 })
}
const writeJson = async (path, value) => writeNewFile(path, JSON.stringify(value, null, 2) + '\n')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const chain = await readJson(join(fixture, 'runtime/chain.json'))
let nativeConfig
if (bare) {
  const manifest = await readJson(join(root, 'artifacts/bare-package.json'))
  nativeConfig = { nativeSha256: manifest.nativeSha256, indexerUrl: chain.electrumUrl }
  const installed = await readFile(join(state, 'node_modules/@utexo/wdk-wallet-rgb', manifest.addon))
  assert.strictEqual(digest(installed), nativeConfig.nativeSha256)
} else {
  const nativeExecutable = await realpath(join(root, 'artifacts/utexo-rgb-native-darwin-arm64'))
  const nativeManifest = await readJson(join(root, 'artifacts/native-candidate.json'))
  assert.strictEqual(digest(await readFile(nativeExecutable)), nativeManifest.sha256)
  nativeConfig = { nativeExecutable, nativeSha256: nativeManifest.sha256 }
}
const asset = action === 'setup' ? undefined : await readJson(join(fixture, 'runtime/issuer-public.json'))
const assetId = asset?.assetId
const seedFile = join(state, 'disposable-mnemonic.txt')
const outputId = 'regtest-outputs-initial-01'
const burnId = 'regtest-v1-burn-initial-01'
const declineId = 'regtest-v1-burn-decline-01'
const burnRecipient = { chainId: 'eip155:42161', address: '0x1111111111111111111111111111111111111111' }
const routes = [{ chainId: 'eip155:42161', dstEid: 0 }]
const burnDestination = burnDestinationFor(burnRecipient, routes)
const commitment = burnDestinationHash(burnDestination)
assert.strictEqual(commitment, '65101fb7d644f69b71360617954850e0c357789253eb373dde3f0d9077f2fbc7')
const amount = '1000000'

function fixtureCommand (...args) {
  const result = spawnSync('python3', [join(fixture, 'fixture.py'), ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  if (result.error) throw result.error
  assert.strictEqual(result.status, 0)
  return JSON.parse(result.stdout.toString('utf8'))
}

async function waitForAssetBalance (account, expected) {
  let balance
  for (let attempt = 0; attempt < 15; attempt++) {
    await account.refresh(assetId)
    balance = await account.getAssetBalance(assetId)
    if (Object.keys(expected).every(key => balance[key] === expected[key])) return
    if (attempt < 14) await delay(1_000)
  }
  assert.deepStrictEqual(balance, expected)
}

if (action === 'setup') {
  await mkdir(join(state, 'wallet'), { mode: 0o700 })
  await writeNewFile(seedFile, WalletManagerRgb.getRandomSeedPhrase(24))
}
const authorize = review => {
  assert.strictEqual(review.operationId, action === 'setup' ? outputId : action === 'decline' ? declineId : burnId)
  assert.strictEqual(review.plan.kind, action === 'setup' ? 'rgb-output' : 'rgb-burn')
  if (action === 'burn' || action === 'decline') {
    assert.deepStrictEqual(review.burnRecipient, burnRecipient)
    assert.deepStrictEqual(review.burnDestination, burnDestination)
    assert.strictEqual(review.assetId, assetId)
    assert.strictEqual(review.amount, amount)
    assert.strictEqual(review.commitment, commitment)
  } else {
    assert.strictEqual(action, 'setup')
    assert.strictEqual(review.count, 5)
    assert.strictEqual(review.size, '1000')
  }
  assert.ok(BigInt(review.plan.feeSats) > 0n && BigInt(review.plan.feeSats) < 5_000n)
  console.log(JSON.stringify({ reviewed: review.plan.kind, approved: action !== 'decline', txid: review.plan.txid, feeSats: review.plan.feeSats, vsize: review.plan.vsize }))
  return action !== 'decline'
}
const config = {
  network: 'regtest',
  dataDir: join(state, 'wallet'),
  indexerUrl: chain.indexerUrl,
  ...nativeConfig,
  transportEndpoint: chain.proxyEndpoint,
  evmRpcUrls: { [chain.evmChainId]: chain.evmRpc },
  maxFeeSats: '5000',
  burnDestinationRoutes: routes,
  authorize
}
const seed = await readFile(seedFile, 'utf8')
const manager = new WalletManagerRgb(seed, config)

try {
  const account = await manager.getAccount()
  const info = account.getInfo()
  assert.strictEqual(info.protocol, 'RGB_L1')
  assert.ok(info.ready)
  assert.deepStrictEqual(info.burnDestinationRoutes, routes)
  assert.ok(info.methods.includes('burnAsset') && info.methods.includes('getConsignment'))
  if (action === 'setup') {
    const other = new WalletManagerRgb(seed, config)
    try {
      await assert.rejects(other.getAccount(), { code: 'WALLET_IN_USE' })
    } finally {
      await other.dispose()
    }
    if (bare) {
      assert.throws(() => new WalletManagerRgb(seed, { ...config, indexerUrl: chain.indexerUrl }), /Invalid indexer/)
      const wrongHash = new WalletManagerRgb(seed, { ...config, nativeSha256: '0'.repeat(64) })
      try {
        await assert.rejects(wrongHash.getAccount(), { code: 'NATIVE_IDENTITY_MISMATCH' })
      } finally {
        await wrongHash.dispose()
      }
    }
    const address = await account.getAddress()
    assert.match(address, /^bcrt1p/)
    const funding = fixtureCommand('fund', address, '2000000', 'wdk-' + digest(address).slice(0, 12))
    await account.refresh()
    assert.strictEqual((await account.getBtcBalance()).vanilla.spendable, '2000000')
    const setup = await account.createUtxos({ operationId: outputId, count: 5, size: '1000', feeRate: '2' })
    assert.strictEqual(setup.created, 5)
    fixtureCommand('mine', '3')
    await account.refresh()
    const outputs = await account.listUnspents()
    assert.strictEqual(outputs.filter(output => output.utxo.colorable && output.utxo.btcAmount === '1000').length, 5)
    await writeJson(join(state, 'setup.json'), { setup, funding })
    console.log(JSON.stringify({ step: 'setup', setup: setup.txid, address }))
  } else if (action === 'prepare') {
    const contract = await readFile(asset.contractPath)
    assert.strictEqual(digest(contract), asset.contractSha256)
    assert.strictEqual((await account.registerAssetContract({ contract, assetId, sha256: asset.contractSha256 })).assetId, assetId)
    const invoice = await account.blindReceive({ assetId, minConfirmations: 3 })
    assert.match(invoice.invoice, /^rgb:/)
    assert.strictEqual(invoice.expirationTimestamp.length, 10)
    const [path, query] = invoice.invoice.split('?')
    const segments = path.slice(4).split('/')
    assert.strictEqual(segments.length, 4)
    assert.strictEqual(segments[2], '~')
    assert.match(segments[3], /^bcrt:utxob:/)
    const fields = new URLSearchParams(query)
    assert.ok([...fields].every(([key]) => ['assignment_name', 'endpoints', 'expiry', 'pk'].includes(key)))
    assert.ok(!fields.has('assignment_name') || fields.get('assignment_name') === 'assetOwner')
    for (const field of ['endpoints', 'expiry', 'pk']) assert.strictEqual(fields.getAll(field).length, 1)
    assert.strictEqual(fields.get('endpoints'), chain.proxyEndpoint)
    assert.strictEqual(fields.get('expiry'), invoice.expirationTimestamp)
    assert.match(fields.get('pk'), /^[a-f0-9]{64}$/i)
    await writeJson(join(state, 'mint-request.json'), { invoice: invoice.invoice, amount })
    await writeJson(join(state, 'receiver.json'), { recipientId: invoice.recipientId })
    console.log(JSON.stringify({ step: 'prepare', assetId }))
  } else if (action === 'pending') {
    const { recipientId } = await readJson(join(state, 'receiver.json'))
    await account.refresh(assetId)
    const pending = await account.getReceivedMint(recipientId)
    assert.match(expectedOpid, /^[a-f0-9]{64}$/)
    const prepared = await readJson(join(fixture, 'runtime', 'mint-' + expectedOpid + '.prepared.json'))
    assert.strictEqual(pending.opid, prepared.opid)
    assert.strictEqual(pending.amount, amount)
    assert.strictEqual(pending.beforeBlock, prepared.beforeBlock)
    assert.strictEqual(pending.evmChainId, String(chain.evmChainId))
    assert.strictEqual(pending.bridgeContract.toLowerCase(), chain.bridge.toLowerCase())
    assert.deepStrictEqual(await account.getAssetBalance(assetId), { settled: '0', future: '0', spendable: '0' })
    await writeJson(join(state, 'received-mint.json'), pending)
    console.log(JSON.stringify({ step: 'pending', pending }))
  } else if (action === 'burn' || action === 'decline') {
    await waitForAssetBalance(account, { settled: amount, future: amount, spendable: amount })
    const request = { operationId: action === 'decline' ? declineId : burnId, assetId, amount, feeRate: '2', minConfirmations: 6, burnRecipient, burnDestination }
    if (action === 'decline') {
      await assert.rejects(account.burnAsset(request), { code: 'AUTHORIZATION_DECLINED' })
      const record = await account.getOperation(declineId)
      assert.strictEqual(record.stage, 'declined')
      assert.deepStrictEqual(await account.getAssetBalance(assetId), { settled: amount, future: amount, spendable: amount })
      const declined = { txid: record.txid, amountStillSpendable: amount }
      await writeJson(join(state, 'decline.json'), declined)
      console.log(JSON.stringify({ step: 'decline', ...declined }))
    } else {
      await assert.rejects(async () => account.burnAsset({
        ...request, burnDestination: { ...burnDestination, dstEid: 1 }
      }), /does not match/)
      assert.strictEqual(await account.getOperation(burnId), undefined)
      // Fault after actual native End, at the final atomic journal promotion.
      // The test process sees no successful response. Recover the original request
      // and txid in a fresh process without signing or submitting again.
      const rename = fs.rename
      const journalFile = join(state, 'wallet', '.wdk-onchain-journal-v1', burnId + '.json')
      let faultObserved = false
      fs.rename = async (from, to) => {
        if (to === journalFile && (await readJson(from)).stage === 'submitted') {
          faultObserved = true
          throw Object.assign(new Error('Injected post-submit acknowledgement loss'), { code: 'EIO' })
        }
        return rename(from, to)
      }
      try {
        await assert.rejects(account.burnAsset(request), { code: 'EIO' })
      } finally {
        fs.rename = rename
      }
      assert.ok(faultObserved)
      const saved = await account.getOperation(burnId)
      assert.strictEqual(saved.stage, 'submitting')
      assert.deepStrictEqual(saved.burnDestination, burnDestination)
      assert.deepStrictEqual(saved.burnRecipient, burnRecipient)
      fixtureCommand('mine', '6')
      await waitForAssetBalance(account, { settled: '0', future: '0', spendable: '0' })
      await writeJson(join(state, 'burn-submission.json'), { txid: saved.txid, assetId, amount, commitment, acknowledgement: 'injected-loss' })
      console.log(JSON.stringify({ step: 'burn', txid: saved.txid, assetId, amount, commitment, acknowledgement: 'injected-loss' }))
    }
  } else {
    const { txid } = await readJson(join(state, 'burn-submission.json'))
    assert.strictEqual((await account.getOperation(burnId)).stage, 'submitting')
    const recovery = await account.recoverBurn(burnId)
    assert.strictEqual(recovery.txid, txid)
    assert.strictEqual(recovery.assetId, assetId)
    assert.deepStrictEqual(recovery.burnDestination, burnDestination)
    assert.deepStrictEqual(await account.getConsignment({ assetId, txid }), recovery.proof)
    const bytes = Buffer.from(recovery.proof.data, 'base64')
    assert.strictEqual(bytes.length, recovery.proof.byteLength)
    assert.strictEqual((await account.getOperation(burnId)).stage, 'submitted')
    await assert.rejects(account.getConsignment({ assetId, txid: '99'.repeat(32) }), { code: 'PROOF_UNAVAILABLE' })
    await assert.rejects(account.burnAsset({
      operationId: burnId, assetId, amount, feeRate: '2', minConfirmations: 6, burnRecipient, burnDestination
    }), { code: 'OPERATION_EXISTS' })
    await writeNewFile(join(state, 'recovered-burn.rgb'), bytes)
    await writeNewFile(join(state, 'recovered-burn.utexoburn'), createBurnPackage(bytes, burnDestination))
    console.log(JSON.stringify({
      step: 'recover', txid, assetId, amount, commitment,
      byteLength: bytes.length, sha256: digest(bytes), digest: recovery.proof.digest
    }))
  }
} finally {
  await manager.dispose()
}
