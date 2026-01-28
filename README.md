# @utexo/wdk-wallet-rgb

> **Beta notice:** This package is currently in beta. Please test thoroughly in development environments before using in production.

`@utexo/wdk-wallet-rgb` bridges the Wallet Development Kit (WDK) interfaces with the RGB ecosystem by wrapping the official `@utexo/rgb-sdk` WalletManager API inside the familiar WDK abstractions. It handles key-derivation, account lifecycle, UTXO orchestration, asset issuance, transfers, and wallet backup flows while keeping the WDK ergonomics you already know.

[RGB SDK Overview – rgb-sdk](https://github.com/RGB-OS/rgb-sdk)
⚠️ Security Notice [https://github.com/UTEXO-Protocol/rgb-sdk/blob/main/SECURITY.md]
If you're migrating from the legacy wdk-wallet-rgb v1.0.0 (which relied on a remote RGB Node server), be aware that wallet metadata such as xpubs have been exposed and this cannot be undone. Treat existing wallets as privacy-compromised.
[@utexo/wdk-wallet-rgb v1 to v2 Migration Guide](./MIGRATION.md)

---

## 🧾 At a Glance

With this package you can:

- derive RGB wallet keys from BIP-39 seed phrases and expose them through the WDK manager interface
- create the single supported RGB account (Taproot / BIP-86) and convert it into a read-only view
- manage RGB state, and orchestrate UTXO management
- issue NIA assets, list asset balances, create blind/witness receive invoices, and complete transfers
- perform the `@utexo/rgb-sdk` `sendBegin → signPsbt → sendEnd` pipeline or fall back to the single-call `transfer`
- create encrypted backups and restore accounts from backup material

---

## ⚙️ Capabilities

### Configuration Parameters

When initializing `WalletManagerRgb` or creating accounts, you must provide the following configuration:

- **`network`** (required): `'mainnet'`, `'testnet'`, or `'regtest'`
- **`indexerUrl`** (optional): Electrs indexer URL (e.g., `'ssl://electrum.iriswallet.com:50013'`)
- **`transportEndpoint`** (optional): RGB transport endpoint (e.g., `'rpcs://proxy.iriswallet.com/0.2/json-rpc'`)
- **`dataDir`** (optional): Local directory for RGB wallet state (defaults to temp directory if not provided)
- **`transferMaxFee`** (optional): Maximum fee amount for transfer operations

### `WalletManagerRgb`

| Method | Description |
| ------ | ----------- |
| `constructor(seed, config)` | Initialises the manager for `seed` with RGB network configuration. |
| `getAccount()` | Returns (and caches) the RGB account at index `0`, deriving keys via `@utexo/rgb-sdk`. |
| `restoreAccountFromBackup(restoreConfig)` | Builds a manager-backed account directly from encrypted backup payloads. |
| `getFeeRates()` | Returns basic Bitcoin fee hints (`{ normal: 1n, fast: 2n }`). |
| `dispose()` | Clears cached accounts and key material in memory. |

### `WalletAccountRgb`

| Method | Description |
| ------ | ----------- |
| `getAddress()` | Returns the taproot deposit address (synchronous). |
| `getBalance()` / `getTokenBalance(assetId)` | Queries BTC satoshis and RGB asset balances (read-only base class). |
| `listAssets()` / `listTransfers(assetId)` / `listTransactions()` / `listUnspents()` | Mirrors the `@utexo/rgb-sdk` inventory views (all synchronous). |
| `createUtxos*` | `createUtxos`, `createUtxosBegin`, `createUtxosEnd` for UTXO management. |
| `issueAssetNia(options)` | Issues a Non-Inflatable Asset using `@utexo/rgb-sdk` defaults (synchronous). |
| `receiveAsset({ assetId?, amount, witness? })` | Creates blind or witness receive invoices (synchronous). |
| `sendBegin` / `signPsbt` / `sendEnd` | Low-level PSBT pipeline for controlled transfers. |
| `transfer(options)` | WDK-style wrapper that orchestrates invoice driven transfers. |
| `createBackup(options)` / `restoreFromBackup(params)` | Backup and restore encrypted wallet snapshots. |
| `refreshWallet()` / `registerWallet()` / `syncWallet()` | Maintenance helpers for wallet state (synchronous). |
| `toReadOnlyAccount()` | Produces a `WalletAccountReadOnlyRgb` sharing the same configuration (synchronous). |
| `dispose()` | Wipes derived key pairs from memory. |

### `WalletAccountReadOnlyRgb`

| Method | Description |
| ------ | ----------- |
| `getBalance()` & `getTokenBalance(assetId)` | View-only BTC and RGB balances. |
| `quoteSendTransaction(tx)` / `quoteTransfer(options)` | Returns placeholder fee hints (`1n`) for UI display. |
| `getTransactionReceipt(hash)` | Returns `null` (not implemented) – use `@utexo/rgb-sdk` directly if required. |

---

## 📦 Installation

```bash
npm install @utexo/wdk-wallet-rgb
```

RGB SDK v2 uses `rgb-lib` directly and stores all wallet data locally. You need access to:

- A Bitcoin indexer (Electrs) for blockchain data
- An RGB transport endpoint for asset transfers

The examples assume a locally running regtest stack.

---

## 🚀 Quick Start

```javascript
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'

const seedPhrase = 'poem twice question inch happy capital grain quality laptop dry chaos what'

// Initialise the WDK manager – it will derive RGB keys on demand
// network is required; indexerUrl, transportEndpoint, and dataDir are optional
const manager = new WalletManagerRgb(seedPhrase, {
  network: 'testnet', // 'mainnet', 'testnet', 'regtest' (required)
  indexerUrl: 'ssl://electrum.iriswallet.com:50013', // optional
  transportEndpoint: 'rpcs://proxy.iriswallet.com/0.2/json-rpc', // optional
  dataDir: './wallet-data' // optional, defaults to temp directory
})

const account = await manager.getAccount()

const address = account.getAddress() // synchronous in v2
console.log('Deposit address:', address)

// Register wallet (synchronous in v2)
const { address: regAddress, btcBalance } = account.registerWallet()
console.log('Registered address:', regAddress)
console.log('BTC Balance:', btcBalance)

// List RGB assets (synchronous in v2)
console.log(account.listAssets())

// Clean up when you are done
account.dispose()
manager.dispose()
```

---

## 🧩 Core Workflows

### Initialise from Seed

```javascript
const manager = new WalletManagerRgb(mnemonic, {
  network: 'regtest',
  indexerUrl: 'http://127.0.0.1:3000',
  transportEndpoint: 'http://127.0.0.1:3000',
  dataDir: './wallet-data'
})
const account = await manager.getAccount() // always index 0
```

### Manage UTXOs

```javascript
const psbt = account.createUtxosBegin({ upTo: true, num: 5, feeRate: 2 }) // synchronous
const signed = await account.signPsbt(psbt)
const created = account.createUtxosEnd({ signedPsbt: signed }) // synchronous
console.log(`Created ${created} UTXOs`)
```

### Issue an Asset

```javascript
const nia = account.issueAssetNia({ // synchronous in v2
  ticker: 'DEMO',
  name: 'Demo Asset',
  precision: 0,
  amounts: [100, 50]
})
console.log('Issued asset:', nia)
```

### Receive & Transfer

```javascript
const invoice = account.receiveAsset({ // synchronous in v2
  assetId: nia.assetId,
  amount: 10
})

const sendResult = await account.transfer({
  recipient: invoice.invoice,
  token: nia.assetId,
  amount: 10,
  minConfirmations: 1
})

console.log('Transfer hash:', sendResult.hash)
```

Enable witness-based receives by passing `witness: true` (see the bundled `examples/rgb-wallet-flow.mjs`).

### Backup & Restore

```javascript
const password = 'strong-password'
const backupPath = './backup.rgb'

// Create backup
const backup = account.createBackup({
  password,
  backupPath
})
console.log('Backup created:', backup.message)

// Restore from backup
import { restoreFromBackup } from '@utexo/rgb-sdk'

// Must call restoreFromBackup BEFORE creating the wallet manager
const dataDir = './restored-wallet'
restoreFromBackup({
  backupFilePath: backupPath,
  password,
  dataDir
})

// Then create wallet manager pointing to restored directory
const restoredManager = new WalletManagerRgb(mnemonic, {
  network: 'regtest',
  dataDir: dataDir
})

const restored = await restoredManager.restoreAccountFromBackup({
  backupFilePath: backupPath,
  password,
  dataDir
})
console.log('Restored address:', restored.getAddress())
```

---

## 📁 Examples

- `examples/rgb-wallet-flow.mjs` – end-to-end flow that mines regtest blocks, issues an asset, performs standard and witness transfers, and demonstrates the backup/restore loop.
- Jest suites (`tests/*.test.js`) show how to mock `@utexo/rgb-sdk` when unit testing against the WDK surface.

Run the example with:

```bash
node examples/rgb-wallet-flow.mjs
```

---

## 🔐 Security Notes

- **Mnemonic hygiene:** store mnemonics offline; do not embed them in source control.
- **Local storage:** wallet data is stored locally in `dataDir` - ensure proper file permissions and backup strategies.
- **Invoice handling:** invoices are single-use; consume them exactly once to avoid race conditions.
- **Backups:** backup files are encrypted but still sensitive—store them alongside the password in a secure vault.
- **Memory management:** call `dispose()` on accounts/managers when you are done to zero private key material.

---

## 🧪 Development

```bash
# Install dependencies
npm install

# type definitions
npm run build:types

# lint
npm run lint
npm run lint:fix

# tests
npm test
npm run test:coverage
```

---

## 📜 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 🆘 Support

For support, please open an issue on the GitHub repository.

---
