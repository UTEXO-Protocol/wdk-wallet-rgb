// SPDX-License-Identifier: Apache-2.0
import { WalletManagerRgb } from '@utexo/wdk-wallet-rgb'

const bare = typeof Bare !== 'undefined'
const fs = bare ? (await import('bare-fs/promises')).default : await import('node:fs/promises')
const join = bare ? (await import('bare-path')).join : (await import('node:path')).join
const [target, sha256, addon] = bare ? Bare.argv.slice(2) : process.argv.slice(2)
if (bare && Bare.Addon.host !== target) throw new Error('Unexpected Bare host')
const directory = await fs.realpath(await fs.mkdtemp(join(await fs.realpath('.'), '.wallet-smoke-')))
const seed = new Uint8Array(64).map((_, i) => i + 1)
const common = {
  startupMode: 'offline',
  nativeSha256: sha256,
  ...(!bare && { ...(addon && { nativeAddon: addon }) }),
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
    transportEndpoint: 'rpcs://sandbox.rgb-proxy.utexo.com/json-rpc',
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
    const keys = account.getPublicKeys()
    if (!Object.isFrozen(keys) || keys === account.getPublicKeys() ||
        keys.network !== config.network || !/^[a-f0-9]{8}$/.test(keys.masterFingerprint) ||
        !keys.accountXpubVanilla.startsWith(config.network === 'mainnet' ? 'xpub' : 'tpub') ||
        !keys.accountXpubColored.startsWith(config.network === 'mainnet' ? 'xpub' : 'tpub') ||
        Object.keys(keys).sort().join(',') !== 'accountXpubColored,accountXpubVanilla,masterFingerprint,network') {
      throw new Error('Invalid public account identity')
    }
    if (account.getConnectionStatus() !== 'offline' || await account.getBalance() !== 0n ||
        (await account.listAssets()).length !== 0) throw new Error('Unexpected offline wallet state')
    if (read) {
      if (account.getCapabilities().contractRegistration.status !== 'available' ||
          account.getCapabilities().contractExport.status !== 'available') {
        throw new Error('The native runtime must support public contract import and export')
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

// This public genesis fixture has a synthetic mint-right seal and no allocations.
// Each host validates/imports it through the real packed adapter, then reopens it.
async function verifyPublicContract () {
  const assetId = 'rgb:mp_lQhFX-fPKiRA8-N_Rcwho-QrMcV1N-U2gI6HE-FL96Hj4'
  const contract = new Uint8Array([82, 71, 66, 0, 67, 79, 78, 1, 0, 0, 0, 220, 141, 49, 101, 81, 16, 157, 12, 88, 86, 78, 239, 14, 120, 121, 184, 219, 80, 201, 71, 236, 153, 56, 112, 233, 213, 253, 159, 225, 175, 111, 154, 87, 73, 9, 107, 0, 0, 0, 0, 13, 0, 115, 115, 105, 58, 97, 110, 111, 110, 121, 109, 111, 117, 115, 4, 0, 0, 5, 209, 7, 1, 0, 3, 0, 0, 0, 0, 185, 11, 1, 0, 16, 0, 15, 85, 112, 103, 114, 97, 100, 101, 32, 102, 105, 120, 116, 117, 114, 101, 189, 11, 1, 0, 1, 0, 6, 192, 11, 1, 0, 29, 0, 0, 177, 164, 0, 0, 0, 0, 0, 0, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 195, 11, 1, 0, 5, 0, 4, 66, 70, 65, 49, 1, 0, 173, 15, 0, 1, 0, 0, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 0, 0, 0, 0, 16, 96, 149, 40, 204, 28, 63, 237, 0, 0, 0, 0])
  const digest = 'c7f1400bc974f2a44d0e7c2b16dab25d5d8d7281a5ccec98f1eab43098301041'
  let exported
  for (let round = 0; round < 3; round++) {
    const manager = new WalletManagerRgb(seed, {
      ...common, ...configurations.regtest,
      dataDir: join(directory, round === 2 ? 'contract-copy' : 'contract')
    })
    try {
      const account = await manager.getAccount()
      if (round === 0) {
        const result = await account.registerAssetContract({ assetId, contract, sha256: digest })
        if (result.assetId !== assetId) throw new Error('Contract import acknowledgement mismatch')
        exported = await account.exportAssetContract(assetId)
      } else if (round === 2) {
        const hashes = await import('@noble/hashes/sha2.js')
        const hash = Array.from(hashes.sha256(exported), n => n.toString(16).padStart(2, '0')).join('')
        await account.registerAssetContract({ assetId, contract: exported, sha256: hash })
      }
      const assets = await account.listAssets()
      const balance = await account.getAssetBalance(assetId)
      if (assets.length !== 1 || (await account.listTransfers()).length !== 0 ||
          Object.values(balance).some(value => value !== '0')) {
        throw new Error('Import changed allocations or transfer history')
      }
      const actual = await account.exportAssetContract(assetId)
      if (actual.length !== exported.length || actual.some((byte, i) => byte !== exported[i])) {
        throw new Error('Contract export changed after reopen or reimport')
      }
      await expectCode(() => account.registerAssetContract({ assetId, contract, sha256: digest }), 'ASSET_ALREADY_KNOWN')
    } finally {
      await manager.shutdown()
    }
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
  await verifyPublicContract()
  console.log(JSON.stringify({
    target, runtime: bare ? Bare.version : process.version, nativeSha256: sha256,
    checks: ['wrong native hash rejection', 'offline Regtest/Mainnet/Public Signet/Dev/staging open, reads and reopen',
      'immutable public account keys on all five network profiles',
      'NIA/CFA issuance reaches native and rejects offline on all five network profiles', 'WebRGB issuance excluded',
      'validated public contract import, export, reopen and reimport without allocations']
  }))
} finally {
  seed.fill(0)
  await fs.rm(directory, { recursive: true, force: true })
}
