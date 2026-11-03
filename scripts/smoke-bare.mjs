// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
// Run with Bare from a clean, packed consumer. Uses an unfunded private wallet.
import assert from 'bare-assert'
import fs from 'bare-fs/promises'
import { join } from 'bare-path'
import { WalletManagerRgb } from '@utexo/wdk-wallet-rgb'

const [root, mode] = Bare.argv.slice(2)
if (!root || !['lifecycle', 'tampered'].includes(mode)) throw new Error('Use: bare smoke-bare.mjs <qualification root> <mode>')
const { electrumUrl, proxyEndpoint } = JSON.parse(await fs.readFile(join(root, 'fixture/runtime/chain.json'), 'utf8'))
const { nativeSha256 } = JSON.parse(await fs.readFile(join(root, 'artifacts/bare-package.json'), 'utf8'))
const dir = await fs.realpath(await fs.mkdtemp(join(process.cwd(), '.bare-smoke-')))
const seed = new Uint8Array(64).map((_, index) => index + 1)
const config = {
  network: 'regtest',
  dataDir: join(dir, 'wallet'),
  nativeSha256,
  indexerUrl: electrumUrl,
  transportEndpoint: proxyEndpoint,
  maxFeeSats: '5000',
  authorize: () => { throw new Error('A smoke test must never authorize a transaction') }
}

try {
  if (mode === 'tampered') {
    const manager = new WalletManagerRgb(seed, config)
    try {
      await assert.rejects(manager.getAccount(), { code: 'NATIVE_IDENTITY_MISMATCH' })
    } finally {
      await manager.dispose()
    }
  } else {
    const aborted = new WalletManagerRgb(seed, config)
    const opening = aborted.getAccount()
    const closing = aborted.dispose()
    await assert.rejects(opening, { code: 'WALLET_CLOSED' })
    await closing

    const manager = new WalletManagerRgb(seed, config)
    try {
      const account = await manager.getAccount()
      assert.ok(account.getInfo().ready)
      const inFlight = account.getBtcBalance()
      const disposing = manager.dispose()
      await assert.rejects(inFlight, { code: 'NATIVE_CLOSED' })
      await disposing
    } finally {
      await manager.dispose()
    }
    const reopened = new WalletManagerRgb(seed, config)
    try {
      const account = await reopened.getAccount()
      assert.ok(account.getInfo().ready)
      assert.match(await account.getAddress(), /^bcrt1p/)
      assert.strictEqual((await account.getBtcBalance()).vanilla.spendable, '0')
    } finally {
      await reopened.dispose()
    }
  }
  console.log(JSON.stringify({ mode, result: 'passed', runtime: Bare.version, target: Bare.Addon.host }))
} finally {
  seed.fill(0)
  await fs.rm(dir, { recursive: true, force: true })
}
