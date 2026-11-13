// SPDX-License-Identifier: Apache-2.0
import { WalletManagerRgb } from '@utexo/wdk-wallet-rgb'

const bare = typeof Bare !== 'undefined'
const fs = bare ? (await import('bare-fs/promises')).default : await import('node:fs/promises')
const join = bare ? (await import('bare-path')).join : (await import('node:path')).join
const [target, sha256, executable] = bare ? Bare.argv.slice(2) : process.argv.slice(2)
if (bare && Bare.Addon.host !== target) throw new Error('Unexpected Bare host')
const directory = await fs.realpath(await fs.mkdtemp(join(await fs.realpath('.'), '.wallet-smoke-')))
const seed = new Uint8Array(64).map((_, i) => i + 1)
const common = {
  startupMode: 'offline',
  nativeSha256: sha256,
  ...(!bare && { nativeExecutable: executable }),
  maxFeeSats: '5000',
  authorize: () => { throw new Error('Offline smoke unexpectedly requested signing') }
}
const configurations = {
  regtest: {
    network: 'regtest', indexerUrl: 'tcp://127.0.0.1:50001',
    transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc'
  },
  mainnet: {
    network: 'mainnet', mode: 'rgb', indexerUrl: 'ssl://electrum.iriswallet.com:50003',
    transportEndpoint: 'rpcs://fixture.example.com/json-rpc'
  },
  signet: {
    network: 'signet', mode: 'rgb', profile: 'public', indexerUrl: 'ssl://electrum.iriswallet.com:50033',
    transportEndpoint: 'rpcs://fixture.example.com/json-rpc'
  },
  dev: {
    network: 'signet', mode: 'rgb', profile: 'dev',
    indexerUrl: 'https://dev.esplora-01.mint.utexo.com',
    transportEndpoint: 'rpcs://dev.rgb-proxy.utexo.com/json-rpc',
    evmRpcUrls: { 42161: 'https://arb1.arbitrum.io/rpc' }
  },
  staging: {
    network: 'signet', mode: 'rgb', profile: 'staging',
    indexerUrl: 'ssl://electrum.iriswallet.com:50033',
    transportEndpoint: 'rpcs://staging.rgb-proxy.utexo.com/json-rpc',
    evmRpcUrls: { 42161: 'https://arb1.arbitrum.io/rpc' }
  }
}

async function expectCode (operation, code) {
  try {
    await operation()
  } catch (error) {
    if (error.code === code) return
    throw error
  }
  throw new Error('Expected ' + code)
}

async function openWallet (network, read) {
  const config = { ...common, ...configurations[network], dataDir: join(directory, network) }
  const manager = new WalletManagerRgb(seed, config)
  try {
    const account = await manager.getAccount()
    if (account.getConnectionStatus() !== 'offline' || await account.getBalance() !== 0n ||
        (await account.listAssets()).length !== 0) throw new Error('Unexpected offline wallet state')
    if (read) {
      if (account.getCapabilities().contractRegistration.status !== 'unavailable') {
        throw new Error('Stock BFA.8 must not advertise standalone contract registration')
      }
      const params = { name: 'Offline Fixture', precision: 2, amounts: ['1000'] }
      await expectCode(() => account.issueAssetNia({ ...params, ticker: 'FIXNIA', operationId: 'fixture-nia-issue-1' }), 'WALLET_OFFLINE')
      await expectCode(() => account.issueAssetCfa({ ...params, operationId: 'fixture-cfa-issue-1' }), 'WALLET_OFFLINE')
      if (account.getInfo().methods.some(method => method.startsWith('issueAsset'))) {
        throw new Error('Issuance is a host API')
      }
    }
    return await account.getMessageSigningAddress()
  } finally {
    await manager.shutdown()
  }
}

try {
  const wrong = new WalletManagerRgb(seed, {
    ...common,
    ...configurations.regtest,
    dataDir: join(directory, 'wrong'),
    nativeSha256: '0'.repeat(64)
  })
  try {
    await expectCode(() => wrong.getAccount(), 'NATIVE_IDENTITY_MISMATCH')
  } finally {
    await wrong.shutdown()
  }
  for (const [network, prefix] of [['regtest', 'bcrt1p'], ['mainnet', 'bc1p'], ['signet', 'tb1p'], ['dev', 'tb1p'], ['staging', 'tb1p']]) {
    const address = await openWallet(network, true)
    if (!address.startsWith(prefix) || address !== await openWallet(network, false)) {
      throw new Error('Reopened wallet identity differs for ' + network)
    }
  }
  console.log(JSON.stringify({
    target, runtime: bare ? Bare.version : process.version, nativeSha256: sha256,
    checks: ['wrong native hash rejection', 'offline Regtest/Mainnet/Public Signet/Dev/staging open, reads and reopen',
      'NIA/CFA issuance reaches native and rejects offline on all five network profiles', 'WebRGB issuance excluded']
  }))
} finally {
  seed.fill(0)
  await fs.rm(directory, { recursive: true, force: true })
}
