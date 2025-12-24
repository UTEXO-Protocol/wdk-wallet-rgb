# @utexo/wdk-wallet-rgb

> **Beta notice:** this package is still evolving. Please exercise caution and validate behaviour against your RGB node before deploying in production.

`@utexo/wdk-wallet-rgb` bridges the Wallet Development Kit (WDK) interfaces with the RGB ecosystem by wrapping the official `rgb-sdk` WalletManager API inside the familiar WDK abstractions. It handles key-derivation, account lifecycle, UTXO orchestration, asset issuance, transfers, and wallet backup flows while keeping the WDK ergonomics you already know. The library expects an RGB node and Bitcoin backend to be available, just like the upstream `rgb-sdk` tooling.

[RGB SDK Overview – rgb-sdk](https://github.com/RGB-OS/rgb-sdk)

---

## 🧾 At a Glance

With this package you can:
- derive RGB wallet keys from BIP-39 seed phrases and expose them through the WDK manager interface
- create the single supported RGB account (Taproot / BIP-86) and convert it into a read-only view
- register the wallet with an RGB node, refresh state, and orchestrate UTXO management
- issue NIA assets, list asset balances, create blind/witness receive invoices, and complete transfers
- perform the rgb-sdk `sendBegin → signPsbt → sendEnd` pipeline or fall back to the single-call `send`
- create encrypted backups, download them, and restore accounts from backup material

---

## ⚙️ Capabilities

### RGB Node Endpoints

When initializing `WalletManagerRgb` or creating accounts, you must provide an `rgbNodeEndpoint` configuration. The following endpoints are recommended:

- **Testnet**: `https://rgb-node.test.thunderstack.org`
- **Mainnet**: `https://rgb-node.thunderstack.org`

Both `network` and `rgbNodeEndpoint` are required configuration parameters. See the examples below for usage.

### `WalletManagerRgb`

| Method | Description |
|--------|-------------|
| `constructor(seed, config)` | Initialises the manager for `seed` with RGB network + node endpoint configuration. |
| `getAccount()` | Returns (and caches) the RGB account at index `0`, deriving keys via `rgb-sdk`. |
| `restoreAccountFromBackup(restoreConfig)` | Builds a manager-backed account directly from encrypted backup payloads. |
| `getFeeRates()` | Returns basic Bitcoin fee hints (`{ normal: 1n, fast: 2n }`). |
| `dispose()` | Clears cached accounts and key material in memory. |

### `WalletAccountRgb`

| Method | Description |
|--------|-------------|
| `getAddress()` | Fetches the taproot deposit address from rgb-sdk. |
| `getBalance()` / `getTokenBalance(asset_id)` | Queries BTC satoshis and RGB asset balances (read-only base class). |
| `listAssets()` / `listTransfers(assetId)` / `listTransactions()` / `listUnspents()` | Mirrors the rgb-sdk inventory views.[^rgb-sdk] |
| `createUtxos*` | `createUtxos`, `createUtxosBegin`, `createUtxosEnd` for UTXO management. |
| `issueAssetNia(options)` | Issues a Non-Inflatable Asset using rgb-sdk defaults. |
| `receiveAsset({ asset_id?, amount, witness? })` | Creates blind or witness receive invoices. |
| `sendBegin` / `signPsbt` / `sendEnd` | Low-level PSBT pipeline for controlled transfers. |
| `transfer(options)` | WDK-style wrapper that orchestrates invoice driven transfers. |
| `createBackup(password)` / `downloadBackup(xpub?)` / `restoreFromBackup(params)` | Backup, download, and restore encrypted wallet snapshots. |
| `refreshWallet()` / `registerWallet()` / `syncWallet()` | Maintenance helpers for RGB node state. |
| `toReadOnlyAccount()` | Produces a `WalletAccountReadOnlyRgb` sharing the same configuration. |
| `dispose()` | Wipes derived key pairs from memory. |

### `WalletAccountReadOnlyRgb`

| Method | Description |
|--------|-------------|
| `getBalance()` & `getTokenBalance(assetId)` | View-only BTC and RGB balances. |
| `quoteSendTransaction(tx)` / `quoteTransfer(options)` | Returns placeholder fee hints (`1n`) for UI display. |
| `getTransactionReceipt(hash)` | Returns `null` (not implemented) – use rgb-sdk directly if required. |

---

## 📦 Installation

```bash
npm install @utexo/wdk-wallet-rgb
```

You also need access to an RGB node and a Bitcoin backend that the node trusts. The examples assume a locally running regtest stack.

---

## 🚀 Quick Start

```javascript
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'

const seedPhrase = 'poem twice question inch happy capital grain quality laptop dry chaos what';

// Initialise the WDK manager – it will derive RGB keys on demand
// Both network and rgbNodeEndpoint are required
const manager = new WalletManagerRgb(seedPhrase, {
  network: 'testnet', // 'mainnet', 'testnet', 'regtest' (required)
  rgbNodeEndpoint: 'https://rgb-node.test.thunderstack.org' // required - see RGB Node Endpoints section
})

const account = await manager.getAccount()

const address = await account.getAddress()
console.log('Deposit address:', address)

// List RGB assets
console.log(await account.listAssets())

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
  rgbNodeEndpoint: 'https://rgb-node.test.thunderstack.org'
})
const account = await manager.getAccount() // always index 0
```

### Manage UTXOs

```javascript
const psbt = await account.createUtxosBegin({ up_to: true, num: 5, fee_rate: 2 })
const signed = account.signPsbt(psbt)
const created = await account.createUtxosEnd({ signed_psbt: signed })
console.log(`Created ${created} UTXOs`)
```

### Issue an Asset

```javascript
const nia = await account.issueAssetNia({
  ticker: 'DEMO',
  name: 'Demo Asset',
  precision: 0,
  amounts: [100, 50]
})
console.log('Issued asset:', nia)
```

### Receive & Transfer

```javascript
const invoice = await account.receiveAsset({
  asset_id: nia.asset_id,
  amount: 10
})

const sendResult = await account.transfer({
  recipient: invoice.invoice,
  token: nia.asset_id,
  amount: 10,
  minConfirmations: 1
})

console.log('Transfer hash:', sendResult.hash)
```

Enable witness-based receives by passing `witness: true` (see the bundled `examples/rgb-wallet-flow.mjs`).

### Backup & Restore

```javascript
const password = 'strong-password'
const backup = await account.createBackup(password)
const backupFile = await account.downloadBackup() // defaults to the wallet xpub

const restoredManager = new WalletManagerRgb(mnemonic, {
  network: 'regtest',
  rgbNodeEndpoint: 'https://rgb-node.test.thunderstack.org'
})

const restored = await restoredManager.restoreAccountFromBackup({
  backup: backupFile,
  password,
  filename: 'wallet.rgb'
})
console.log('Restored address:', await restored.getAddress())
```

---

## 📁 Examples

- `examples/rgb-wallet-flow.mjs` – end-to-end flow that mines regtest blocks, issues an asset, performs standard and witness transfers, and demonstrates the backup/restore loop.
- Jest suites (`tests/*.test.js`) show how to mock `rgb-sdk` when unit testing against the WDK surface.

Run the example with:

```bash
node examples/rgb-wallet-flow.mjs
```

---

## 🔐 Security Notes

- **Mnemonic hygiene:** store mnemonics offline; do not embed them in source control.
- **RGB node trust:** all calls are proxied through your RGB node; secure transport (TLS, VPN) is strongly recommended.
- **Invoice handling:** invoices are single-use; consume them exactly once to avoid race conditions.
- **Backups:** backup files are encrypted but still sensitive—store them alongside the password in a secure vault.
- **Memory management:** call `dispose()` on accounts/managers when you are done to zero private key material.

---

## 🧪 Development

```bash
# install dependencies
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


## 📜 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 🆘 Support

For support, please open an issue on the GitHub repository.

---