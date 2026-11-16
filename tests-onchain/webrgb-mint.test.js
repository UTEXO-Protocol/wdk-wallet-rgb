import assert from 'node:assert/strict'
import test from 'node:test'
import { WebRgbProvider } from '../src/onchain-webrgb.js'

const ASSET = 'rgb:approved-asset'
const INVOICE = 'rgb:local-invoice?pk=' + 'a'.repeat(64)
const RECEIPT = {
  invoice: INVOICE, recipientId: 'recipient-local', assetId: ASSET, network: 'regtest',
  txid: '1'.repeat(64), opid: '2'.repeat(64), lockId: '3'.repeat(64),
  amount: '9007199254740993', beforeBlock: '98765', evmChainId: '42161', bridgeContract: '0x' + '4'.repeat(40)
}
function fixture ({ pinned = true, expiry = String(Math.floor(Date.now() / 1000) + 86400) } = {}) {
  let active = true
  const calls = []
  const info = { ready: true, network: 'regtest', protocol: 'RGB_L1', methods: ['getReceivedMint'], receivedMintVerificationVersion: 1 }
  const wallet = {
    getInfo: () => info,
    decodeRgbInvoice: async invoice => {
      calls.push(['decode', invoice])
      return { network: 'regtest', recipientId: 'recipient-local', assetId: pinned ? ASSET : null,
        assignment: pinned ? { fungible: RECEIPT.amount } : { any: true }, expirationTimestamp: expiry }
    },
    getReceivedMintForInvoice: async request => { calls.push(['verify', request]); return { ...RECEIPT } }
  }
  const web = (method = 'getReceivedMint', methods = ['getInfo', 'getReceivedMint']) => new WebRgbProvider(wallet, {
    scope: { walletId: 'wallet-a', network: 'regtest', methods,
      identity: { origin: 'https://bridge.example', topic: 'a'.repeat(64), id: 1, method: 'rgb_' + method, fingerprint: 'b'.repeat(64) },
      assertAuthorized () { if (!active) throw Error('locked') } },
    policy: { approvedAssetIds: [ASSET] }, confirm: () => assert.fail('Mint verification must not request a financial approval')
  })
  return { wallet, info, calls, web, revoke () { active = false } }
}

test('mint verification is optional and requires native capability, exact method grant and account network', async () => {
  const f = fixture()
  assert.equal((await f.web('getInfo').getInfo()).receivedMintVerificationVersion, 1)
  for (const patch of [{ receivedMintVerificationVersion: undefined }, { methods: [] }]) {
    const previous = { ...f.info }
    Object.assign(f.info, patch)
    assert.ok(!(await f.web('getInfo').getInfo()).methods.includes('getReceivedMint'))
    await assert.rejects(f.web().getReceivedMint({ invoice: INVOICE }), { code: 'METHOD_NOT_SUPPORTED' })
    Object.assign(f.info, previous)
  }
  await assert.rejects(f.web('getReceivedMint', ['getInfo']).getReceivedMint({ invoice: INVOICE }), { code: 'METHOD_NOT_SUPPORTED' })
  f.info.network = 'signet'
  await assert.rejects(f.web().getReceivedMint({ invoice: INVOICE }), { code: 'NOT_ENABLED' })
  assert.equal(f.calls.length, 0)
})

for (const pinned of [true, false]) {
  test(`returns native verified identity and exact large amounts for ${pinned ? 'asset-pinned' : 'assetless'} invoice`, async () => {
    const f = fixture({ pinned })
    assert.deepEqual(await f.web().getReceivedMint({ invoice: INVOICE }), RECEIPT)
    assert.deepEqual(f.calls.at(-1), ['verify', { invoice: INVOICE, ...(pinned ? { expectedAssetId: ASSET } : {}) }])
    f.wallet.getReceivedMintForInvoice = async () => ({ ...RECEIPT, assetId: 'rgb:other-asset' })
    await assert.rejects(f.web().getReceivedMint({ invoice: INVOICE }), { code: 'ASSET_NOT_FOUND' })
  })
}

test('pending returns null; missing or malformed receipt never claims verification', async () => {
  const f = fixture()
  f.wallet.getReceivedMintForInvoice = async () => null
  assert.equal(await f.web().getReceivedMint({ invoice: INVOICE }), null)
  for (const change of [undefined, {}, { ...RECEIPT, invoice: INVOICE + '&expiry=1' }, { ...RECEIPT, recipientId: 'foreign' },
    { ...RECEIPT, network: 'signet' }, { ...RECEIPT, txid: 'bad' }, { ...RECEIPT, lockId: '0x' + RECEIPT.lockId },
    { ...RECEIPT, amount: '9007199254740992' }, { ...RECEIPT, beforeBlock: '01' }, { ...RECEIPT, evmChainId: 42161 },
    { ...RECEIPT, bridgeContract: 'not-a-contract' }]) {
    f.wallet.getReceivedMintForInvoice = async () => change
    await assert.rejects(f.web().getReceivedMint({ invoice: INVOICE }), { code: 'INTERNAL_ERROR' })
  }
})

test('does not forward recipient or asset overrides and rejects expired invoices before verification', async () => {
  const f = fixture()
  for (const request of [INVOICE, {}, { invoice: INVOICE, recipientId: 'foreign' }, { invoice: INVOICE, assetId: ASSET },
    { invoice: 'rgb:bad invoice' }, { invoice: 'rgb:' + 'a'.repeat(8192) }]) {
    await assert.rejects(f.web().getReceivedMint(request), { code: 'INVALID_PARAMS' })
  }
  assert.equal(f.calls.length, 0)
  const expired = fixture({ expiry: '1' })
  await assert.rejects(expired.web().getReceivedMint({ invoice: INVOICE }), { code: 'INVALID_PARAMS' })
  assert.equal(expired.calls.filter(([method]) => method === 'verify').length, 0)
})

test('revocation during native verification suppresses the result and every call revalidates', async () => {
  const f = fixture()
  const first = f.web()
  await first.getReceivedMint({ invoice: INVOICE })
  await first.getReceivedMint({ invoice: INVOICE })
  assert.equal(f.calls.filter(([method]) => method === 'verify').length, 2)
  f.wallet.getReceivedMintForInvoice = async () => { f.revoke(); return RECEIPT }
  await assert.rejects(first.getReceivedMint({ invoice: INVOICE }), { code: 'NOT_ENABLED' })
})
