// SPDX-License-Identifier: Apache-2.0
// Run from a clean consumer of the candidate tarball and the pinned Tether Core.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import WDK from '@tetherto/wdk'
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'

const [executable, expectedSha256, fixtureDir, outputDir] = process.argv.slice(2)
assert(executable && /^[a-f0-9]{64}$/.test(expectedSha256) && fixtureDir && outputDir,
  'Pass a native executable, its SHA-256, the isolated fixture, and a fresh output directory')
const nativeExecutable = await realpath(resolve(executable))
const nativeSha256 = createHash('sha256').update(await readFile(nativeExecutable)).digest('hex')
assert.equal(nativeSha256, expectedSha256)
const fixture = await realpath(resolve(fixtureDir))
assert(fixture.endsWith('/send-qualification/fixture'), 'Use the dedicated send fixture')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const chain = await readJson(join(fixture, 'runtime/chain.json'))
assert.equal(chain.electrumUrl, 'tcp://127.0.0.1:49002')
assert.equal(chain.proxyEndpoint, 'rpc://127.0.0.1:49090/json-rpc')
const corePackage = await readJson(new URL(import.meta.resolve('@tetherto/wdk/package')))
const sdkPackage = await readJson(new URL(import.meta.resolve('@utexo/wdk-wallet-rgb/package')))
assert.equal(corePackage.version, '1.0.0-beta.22')
await mkdir(resolve(outputDir), { mode: 0o700 })
const root = await realpath(resolve(outputDir))

function fixtureCommand (...args) {
  const child = spawnSync('python3', [join(fixture, 'fixture.py'), ...args], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  return JSON.parse(child.stdout)
}

function mempool () {
  const child = spawnSync('python3', ['-c', 'from fixture import BTC, rpc; import json; print(json.dumps(rpc(BTC, "getrawmempool")))'],
    { cwd: fixture, encoding: 'utf8', timeout: 20_000 })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  return JSON.parse(child.stdout)
}

const seed = randomBytes(64)
const reviews = []
const path = "0'/0/0"
const wallets = []
const fundingAmount = 180_000n
const blockId = 'core-policy-denied-send'
const allowId = 'core-policy-allowed-send'

async function open (name, startupMode, mode = 'rgb') {
  const core = new WDK(seed)
  const holder = { core }
  wallets.push(holder)
  core.registerWallet('rgb', WalletManagerRgb, {
    network: 'regtest',
    dataDir: join(root, name),
    indexerUrl: chain.electrumUrl,
    ...(mode === 'btc-only' ? { mode } : { transportEndpoint: chain.proxyEndpoint }),
    nativeExecutable,
    nativeSha256,
    startupMode,
    maxFeeSats: 5000n,
    authorize (review) {
      reviews.push(review)
      return false
    }
  })
  holder.account = await core.getAccount('rgb', 0)
  assert.equal(await core.getAccountByPath('rgb', path), holder.account)
  return holder
}

async function close ({ core, account }) {
  // The published Core's synchronous dispose does not await wallet teardown.
  try { await account?.shutdown() } finally { core.dispose() }
}

try {
  const original = await open('original', 'online')
  assert.equal(await original.account.getBalance(), 0n)
  const addresses = [await original.account.getAddress()]
  for (let index = 0; index < 3; index++) addresses.push(await original.account.getNewAddress())
  assert.equal(new Set(addresses).size, addresses.length)
  assert(addresses.every(address => address.startsWith('bcrt1p')))
  await close(original)

  const label = 'core-restore-' + randomBytes(4).toString('hex')
  const funding = fixtureCommand('fund', addresses.at(-1), fundingAmount.toString(), label)
  assert.equal(funding.sats, Number(fundingAmount))
  assert(funding.confirmations >= 3)

  const restored = await open('restored', 'offline', 'btc-only')
  assert.equal(restored.account.getConnectionStatus(), 'offline')
  await assert.rejects(restored.account.getAddress(), { code: 'WALLET_OFFLINE' })
  await assert.rejects(restored.account.getNewAddress(), { code: 'WALLET_OFFLINE' })
  await assert.rejects(restored.account.getNetworkInfo(), { code: 'WALLET_OFFLINE' })
  await restored.account.connect()
  await restored.account.connect()
  assert.equal(restored.account.getConnectionStatus(), 'connected')
  assert.deepEqual(restored.account.getInfo(), { ready: true, network: 'regtest', protocol: 'BTC_L1', methods: [] })
  await assert.rejects(restored.account.blindReceive(), { code: 'RGB_MODE_UNAVAILABLE' })
  assert.equal(await restored.account.getBalance(), fundingAmount)
  const fundingTx = await restored.account.getTransaction(funding.txid)
  assert.equal(fundingTx.finality, 'confirmed')
  assert.equal(fundingTx.hash, funding.txid)
  const readOnly = await restored.account.toReadOnlyAccount()
  await assert.rejects(readOnly.getAddress(), { code: 'ADDRESS_UNALLOCATED' })
  const address = await restored.account.getAddress()
  assert(!addresses.includes(address), 'Fresh storage must advance past the discovered receive address')
  assert.equal(await readOnly.getAddress(), address)

  let policyViewChecks = 0
  restored.core.registerPolicy({
    id: 'rgb-sdk-qualification',
    name: 'RGB SDK qualification',
    scope: 'account',
    wallet: 'rgb',
    accounts: [path],
    rules: [
      {
        name: 'explicit-deny', operation: 'sendBtc', action: 'DENY',
        conditions: [({ args }) => args[0].operationId === blockId]
      },
      {
        name: 'explicit-allow', operation: 'sendBtc', action: 'ALLOW',
        conditions: [async ({ account, args }) => {
          if (args[0].operationId !== allowId) return false
          assert(Object.isFrozen(account))
          for (const method of ['sendBtc', 'getNewAddress', 'shutdown', 'signMessageBip322']) {
            assert.equal(account[method], undefined)
          }
          assert.equal(await account.getAddress(), address)
          assert.equal(await account.getBalance(), fundingAmount)
          policyViewChecks++
          return true
        }]
      }
    ]
  })
  const governed = await restored.core.getAccountByPath('rgb', path)
  assert.notEqual(governed, restored.account)
  const request = { address: addresses[0], amount: 20_000n, feeRate: 2n }
  const before = mempool()
  await assert.rejects(governed.sendBtc({ ...request, operationId: blockId }), {
    name: 'PolicyViolationError', ruleName: 'explicit-deny', code: 'RULE_DENIED'
  })
  assert.equal(reviews.length, 0)
  assert.equal(await restored.account.getOperation(blockId), undefined)
  await assert.rejects(governed.sendBtc({ ...request, operationId: allowId }), { code: 'AUTHORIZATION_DECLINED' })
  assert.equal(policyViewChecks, 1)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].operationId, allowId)
  const declined = await restored.account.getOperation(allowId)
  assert.equal(declined.stage, 'declined')
  assert.equal(declined.txid, reviews[0].plan.txid)
  assert.deepEqual(mempool().sort(), before.sort())
  assert.equal(await restored.account.getBalance(), fundingAmount)
  await close(restored)
  await assert.rejects(readOnly.getAddress(), { code: 'WALLET_CLOSED' })
  await assert.rejects(open('restored', 'offline'), { code: 'WALLET_MODE_MISMATCH' })
  const reopened = await open('restored', 'online', 'btc-only')
  assert.equal(await reopened.account.getBalance(), fundingAmount)
  await close(reopened)

  const result = {
    core: corePackage.version,
    sdk: sdkPackage.version,
    nativeSha256,
    sameEngineSeedDiscovery: { fundingTxid: funding.txid, confirmations: funding.confirmations, amountSats: fundingAmount.toString(), fundedDerivationIndex: 3 },
    offlineStartThenConnect: true,
    persistedBtcOnlyMode: true,
    registeredAccountPath: path,
    explicitPolicyDenialBeforeAuthorization: true,
    independentSdkDenialAfterPolicyAllow: { txid: declined.txid, broadcast: false },
    readOnlyPolicyView: true,
    awaitedShutdown: true
  }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(result))
} finally {
  await Promise.allSettled(wallets.map(close))
  seed.fill(0)
}
