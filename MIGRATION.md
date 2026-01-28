# Migration Guide: @utexo/wdk-wallet-rgb v1 to v2

This guide explains how to migrate your RGB wallet state from `@utexo/wdk-wallet-rgb` v1 to v2.

## Overview

`@utexo/wdk-wallet-rgb` v2 uses RGB SDK v2, which stores all wallet data locally using `rgb-lib` directly (no RGB Node server required). The migration process consists of:

1. Creating a backup of your wallet state in v1
2. Restoring the backup in v2 to a local directory
3. Initializing your wallet in v2 pointing to the restored directory

## 🔐 Privacy Recommendation (Important)

If you are migrating from `@utexo/wdk-wallet-rgb` v1, it is important to understand the privacy implications of the legacy architecture.

Version 1 relied on an RGB Node server, which means that wallet metadata (such as extended public keys and transaction graph information) may have been exposed to the node operator. This exposure is **permanent** and cannot be reversed by upgrading software alone.

### Recommended approach (if privacy matters)

If wallet privacy is important to you, we strongly recommend:

1. **Creating a brand new wallet with a new seed phrase in v2**
2. Migrating assets from the old wallet to the new wallet using standard RGB transfers
3. Discontinuing use of the old seed phrase and xpubs

This is the **only way** to fully eliminate historical metadata exposure.

### Alternative (state migration)

The migration steps below restore wallet state using the **same seed phrase** and preserve balances and history. This approach is safe from a funds perspective, but it **does not remove prior privacy exposure**.

Choose the approach that best matches your threat model.


## Step 1: Backup Wallet State in v1

A backup of your wallet state is created using `@utexo/wdk-wallet-rgb` v1:

```javascript
import WalletManagerRgb from '@utexo/wdk-wallet-rgb@^1.0.0'

const seedPhrase = 'your seed phrase here'

// Initialize wallet manager in v1
const manager = new WalletManagerRgb(seedPhrase, {
  network: 'testnet',
  rgbNodeEndpoint: 'https://rgb-node.test.thunderstack.org' // v1 required parameter
})

const account = await manager.getAccount()

// Create backup
const password = 'your-strong-password'
const backup = await account.createBackup(password)

// backup structure:
// {
//   message: string;
//   download_url: string;
// }

// Download and save the backup file
import fs from 'fs'
import https from 'https'
import path from 'path'

const backupDir = './backups'
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true })
}

const backupFilePath = path.join(backupDir, 'wallet.backup')

// Download backup from download_url
const file = fs.createWriteStream(backupFilePath)
https.get(backup.download_url, (response) => {
  response.pipe(file)
  file.on('finish', () => {
    file.close()
    console.log('Backup saved to:', backupFilePath)
  })
})
```

**Important:** The backup file should be saved securely and the password used to encrypt it should be remembered.

## Step 2: Restore Wallet in v2

The backup is restored using `@utexo/wdk-wallet-rgb` v2:

```javascript
import { restoreFromBackup } from '@utexo/rgb-sdk'
import path from 'path'
import fs from 'fs'

const backupFilePath = './backups/wallet.backup'
const password = 'your-strong-password'
const dataDir = path.resolve('./restored-wallet')

// Ensure restore directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

// Restore wallet from backup
// This MUST be called BEFORE creating the WalletManager instance
// Note: restoreFromBackup is imported from @utexo/rgb-sdk
const responseMsg = restoreFromBackup({
  backupFilePath,
  password,
  dataDir
})

console.log(responseMsg.message)
```

## Step 3: Initialize Wallet in v2

After the restore is complete, the wallet instance is created pointing to the restored directory:

```javascript
import WalletManagerRgb from '@utexo/wdk-wallet-rgb@^2.0.0'

const seedPhrase = 'your seed phrase here'

// Initialize wallet manager in v2 pointing to restored directory
const manager = new WalletManagerRgb(seedPhrase, {
  network: 'testnet',
  dataDir: './restored-wallet', // Point to restored directory
  indexerUrl: 'ssl://electrum.iriswallet.com:50013', // optional
  transportEndpoint: 'rpcs://proxy.iriswallet.com/0.2/json-rpc' // optional
})

const account = await manager.getAccount()

// Register wallet (synchronous in v2)
const { address, btcBalance } = account.registerWallet()
console.log('Wallet address:', address)
console.log('BTC Balance:', btcBalance)

// List assets (synchronous in v2)
const assets = account.listAssets()
console.log('Assets:', assets)

//  RGB state is now stored locally!
```

## Complete Migration Example

Here's a complete example showing the full migration process:

```javascript
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import { restoreFromBackup } from '@utexo/rgb-sdk'
import fs from 'fs'
import path from 'path'
import https from 'https'

async function migrateFromV1ToV2() {
  const seedPhrase = 'your seed phrase here'
  const backupPassword = 'your-strong-password'

  // ============================================
  // STEP 1: Backup in v1 
  // ============================================
  console.log('Step 1: Creating backup in v1...')

  // Use v1 SDK for this step
  const { default: WalletManagerRgbV1 } = await import('@utexo/wdk-wallet-rgb@^1.0.0')

  const managerV1 = new WalletManagerRgbV1(seedPhrase, {
    network: 'testnet',
    rgbNodeEndpoint: 'https://rgb-node.test.thunderstack.org'
  })

  const accountV1 = await managerV1.getAccount()
  const backup = await accountV1.createBackup(backupPassword)

  // Save backup file
  const backupDir = './backups'
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true })
  }

  const backupFilePath = path.join(backupDir, 'wallet.backup')

  // Download backup
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(backupFilePath)
    https.get(backup.download_url, (response) => {
      response.pipe(file)
      file.on('finish', () => {
        file.close()
        resolve()
      })
    }).on('error', reject)
  })

  console.log('Backup saved to:', backupFilePath)

  // Cleanup v1
  accountV1.dispose()
  managerV1.dispose()

  // ============================================
  // STEP 2: Restore in v2
  // ============================================
  console.log('Step 2: Restoring backup in v2...')

  const dataDir = path.resolve('./restored-wallet')
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  restoreFromBackup({
    backupFilePath,
    password: backupPassword,
    dataDir
  })

  console.log('Wallet restored to:', dataDir)

  // ============================================
  // STEP 3: Initialize wallet in v2
  // ============================================
  console.log('Step 3: Initializing wallet in v2...')

  const managerV2 = new WalletManagerRgb(seedPhrase, {
    network: 'testnet',
    dataDir: dataDir,
    indexerUrl: 'ssl://electrum.iriswallet.com:50013',
    transportEndpoint: 'rpcs://proxy.iriswallet.com/0.2/json-rpc'
  })

  const accountV2 = await managerV2.getAccount()

  // Register wallet (synchronous in v2)
  const { address, btcBalance } = accountV2.registerWallet()
  console.log('Wallet address:', address)
  console.log('BTC Balance:', btcBalance)

  // List assets (synchronous in v2)
  const assets = accountV2.listAssets()
  console.log('Assets:', assets)

  console.log('Migration complete! Your RGB state is now stored locally.')

  // Cleanup
  accountV2.dispose()
  managerV2.dispose()
}

migrateFromV1ToV2().catch(console.error)
```

## What Gets Preserved

- All RGB assets and their balances
- Transfer history
- UTXO state
- Wallet keys (derived from seed phrase, so same seed = same keys)

## Next Steps

After migration:

1. Test your wallet by checking balances and listing assets
2. Verify all your RGB assets are present
3. Test a transfer to ensure everything works correctly
4. Remove the old RGB Node server dependency if no longer needed

For more information, see the [README.md](./README.md) and [CHANGELOG.md](./CHANGELOG.md).
