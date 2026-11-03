import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { burnDestinationFor, burnDestinationHash, createBurnPackage, WalletManagerRgb } from '../onchain.js'
import { OnchainJournal } from '../src/onchain-journal.js'
import { OnchainWorker } from '../src/onchain-worker.js'

const routes = [
  { chainId: 'eip155:42161', dstEid: 0 },
  { chainId: 'eip155:1', dstEid: 30101 },
  { chainId: 'eip155:137', dstEid: 30109 },
  { chainId: 'eip155:9745', dstEid: 30383 },
  { chainId: 'tron:728126428', dstEid: 30420 }
]

async function scratch (t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'wdk-onchain-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('matches independent go-ethereum bridge vectors and exports the V1 proof package', async () => {
  const { vectors } = JSON.parse(await readFile(new URL('./fixtures/bridge-burn-destination-vectors.json', import.meta.url)))
  for (const vector of vectors) {
    const { version, destinationChainId, dstEid, recipient } = vector
    assert.equal('0x' + burnDestinationHash({ version, destinationChainId, dstEid, recipient }), vector.hash)
  }
  const address = '0x2222222222222222222222222222222222222222'
  for (const route of routes.slice(0, -1)) {
    const destination = burnDestinationFor({ chainId: route.chainId, address }, routes)
    assert.equal(destination.dstEid, route.dstEid)
    assert.equal(destination.recipient, address)
  }
  assert.throws(() => burnDestinationFor({ chainId: 'eip155:1', address }, [routes[0]]), /route/)
  const tron = burnDestinationFor({
    chainId: 'tron:728126428',
    address: 'TEdvoHEatmDKvTh3o9vBRB9Vdtbhn4QFhy'
  }, routes)
  assert.equal('0x' + burnDestinationHash(tron), vectors.find(vector => vector.name === 'layerzero-21-byte-recipient').hash)
  assert.throws(() => burnDestinationFor({ chainId: 'tron:728126428', address }, routes), /Tron/)
  const destination = burnDestinationFor({ chainId: 'eip155:1', address }, routes)
  const proof = Buffer.from('RGB\0TFRx')
  const payload = JSON.parse(createBurnPackage(proof, destination))
  assert.deepEqual(payload, {
    format: 'utexo-burn',
    version: 1,
    consignment: { encoding: 'base64', byteLength: proof.length, data: proof.toString('base64') },
    burnDestination: destination
  })
  assert.throws(() => createBurnPackage(Buffer.from('wrong'), destination))
})

test('journal preserves unknown submission across reopen and refuses cross-wallet use', async t => {
  const dir = await scratch(t)
  const id = 'burn-20261103-test-01'
  const journal = new OnchainJournal(dir)
  await journal.bind('wallet-a')
  assert.equal(await journal.get(id), undefined)
  await journal.save({ id, stage: 'starting' })
  await journal.save({ id, stage: 'submitting', txid: 'ab'.repeat(32) })

  const reopened = new OnchainJournal(dir)
  await reopened.bind('wallet-a')
  await assert.rejects(reopened.assertAvailable(), { code: 'OPERATION_UNRESOLVED' })
  assert.equal((await reopened.get(id)).stage, 'submitting')
  await assert.rejects(reopened.bind('wallet-b'), { code: 'WALLET_IDENTITY_MISMATCH' })
  await assert.rejects(reopened.get('../../tmp/bad-file'), /stable, unique operation ID/)
})

test('worker rejects unpinned binaries and mismatched response identifiers', async t => {
  const dir = await scratch(t)
  const file = join(dir, 'worker')
  const source = `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'wrong') request.id += 'x'
  process.stdout.write(JSON.stringify({ id: request.id, result: request.params }) + '\\n')
})
`
  await writeFile(file, source, { mode: 0o700 })
  await assert.rejects(OnchainWorker.start(file, '0'.repeat(64)), { code: 'NATIVE_IDENTITY_MISMATCH' })
  const worker = await OnchainWorker.start(file, createHash('sha256').update(source).digest('hex'))
  try {
    assert.deepEqual(await worker.request('echo', { a: 1 }), { a: 1 })
    await assert.rejects(worker.request('wrong'), { code: 'NATIVE_PROTOCOL' })
    await assert.rejects(worker.request('echo'), { code: 'NATIVE_PROTOCOL' })
  } finally {
    await worker.close()
  }
})

test('manager requires a loopback fixture profile and owns a copied seed', async () => {
  const seed = Uint8Array.from({ length: 64 }, (_, i) => i + 1)
  const config = {
    network: 'regtest',
    indexerUrl: 'http://127.0.0.1:3002',
    transportEndpoint: 'rpc://127.0.0.1:3003/json-rpc',
    maxFeeSats: '2000',
    authorize: () => false,
    burnDestinationRoutes: routes
  }
  assert.throws(() => new WalletManagerRgb(seed, { ...config, network: 'signet' }), /isolated regtest/)
  assert.throws(() => new WalletManagerRgb(seed, { ...config, indexerUrl: 'https://example.com' }), /loopback/)
  assert.throws(() => new WalletManagerRgb(seed, { ...config, burnDestinationRoutes: [{ chainId: 'eip155:1', dstEid: 0 }] }), /route/)
  const manager = new WalletManagerRgb(seed, config)
  assert.equal(manager.seed, undefined)
  assert.deepEqual(seed, Uint8Array.from({ length: 64 }, (_, i) => i + 1))
  await manager.dispose()
  await assert.rejects(manager.getAccount(), { code: 'WALLET_CLOSED' })
})
