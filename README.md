# @utexo/wdk-wallet-rgb

[![Built with WDK](./assets/built-with-wdk.png)](https://github.com/tetherto/wdk)

> **Beta notice:** This package is currently in beta. Please test thoroughly in development environments before using in production.

`@utexo/wdk-wallet-rgb` bridges the Wallet Development Kit (WDK) interfaces with the RGB ecosystem by wrapping the `@utexo/rgb-lib-bare` native addon and `@utexo/rgb-sdk` Taproot signer inside the familiar WDK abstractions. It handles key derivation, account lifecycle, UTXO orchestration, asset issuance, transfers, and wallet backup flows while keeping WDK ergonomics.

---

## At a Glance

With this package you can:

- derive RGB wallet keys from BIP-39 seed phrases and expose them through the WDK manager interface
- create the single supported RGB account (Taproot / BIP-86) and convert it into a read-only view
- manage RGB state and orchestrate UTXO allocation
- issue NIA, CFA, UDA, and IFA assets; inflate IFA supply; drain wallets
- list asset balances, create blind or witness receive invoices, and complete transfers
- perform the `sendBegin → signPsbt → sendEnd` pipeline or fall back to the single-call `transfer`
- send native BTC (with or without the begin/end granular flow)
- create encrypted backups and restore accounts from backup material

---

## Configuration

### Parameters

When initializing `WalletManagerRgb` or creating accounts, provide the following configuration:

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `network` | yes | `'mainnet' \| 'testnet' \| 'testnet4' \| 'signet' \| 'utexo' \| 'regtest'` | Target network. `utexo` is a UTEXO-branded signet; rgb-lib treats it as Signet internally but the endpoints default to UTEXO-managed infrastructure (see Network selection below). |
| `dataDir` | yes | `string` | Persistent, app-private path where rgb-lib stores its SQLite state (UTXO allocations, asset metadata, in-flight transfers). Losing this directory invalidates every RGB asset balance even though seed-derived BTC addresses still work, so the caller must pick a durable location — on iOS that is `Library/Application Support/` or `Documents/`, on Android that is the app's `filesDir`, and in Node/CLI contexts any stable path the host controls. The constructor throws if this field is missing. |
| `indexerUrl` | no | `string` | Electrs indexer URL. Defaults to the per-network entry in `@utexo/rgb-sdk-core`'s `DEFAULT_INDEXER_URLS`. |
| `transportEndpoint` | no | `string` | RGB transport endpoint. Defaults to the per-network entry in `@utexo/rgb-sdk-core`'s `DEFAULT_TRANSPORT_ENDPOINTS`. |
| `transferMaxFee` | no | `number \| bigint` | Maximum fee amount for transfer operations. |

### Network selection

Networks map to endpoints through `@utexo/rgb-sdk-core`. When a caller specifies `network: 'utexo'`, the binding automatically resolves:

- `DEFAULT_TRANSPORT_ENDPOINTS.utexo` → `rpcs://rgb-proxy-utexo.utexo.com/json-rpc`
- `DEFAULT_INDEXER_URLS.utexo` → `https://esplora-api.utexo.com`
- rgb-lib `BitcoinNetwork` → `Signet`

Passing `network: 'signet'` instead resolves to iriswallet's public signet endpoints, still using rgb-lib's Signet backend. Any of the defaults can be overridden by passing `indexerUrl` / `transportEndpoint` explicitly. `utexo` is the recommended choice for production deployments backed by UTEXO-managed infrastructure.

---

## API

### `WalletManagerRgb`

| Method | Description |
| --- | --- |
| `constructor(seed, config)` | Initialises the manager for `seed` with RGB network configuration. Throws if `network` or `dataDir` is missing. |
| `getAccount()` | Returns (and caches) the RGB account at index `0`, deriving keys from the seed. |
| `restoreAccountFromBackup(restoreConfig)` | Builds a manager-backed account directly from encrypted backup payloads. |
| `getFeeRates()` | Returns Bitcoin fee hints sourced from mempool.space. |
| `dispose()` | Clears cached accounts and key material from memory. |

### `WalletAccountRgb`

Standard WDK contract methods (inherited from `WalletAccount`):

| Method | Description |
| --- | --- |
| `getAddress()` | Returns the Taproot deposit address (synchronous). |
| `sign(message)` / `verify(message, signature)` | BIP-322 message sign/verify via rgb-sdk-core. |
| `sendTransaction({ to, value })` | One-shot native BTC send. |
| `quoteSendTransaction({ to, value })` | Pre-flight fee estimate for a BTC send. |
| `transfer({ token, recipient, amount, feeRate?, minConfirmations?, witnessData? })` | Combined RGB send: `sendBegin → signPsbt → sendEnd`. |
| `quoteTransfer({ token, recipient, amount })` | Pre-flight fee estimate for a transfer. |
| `dispose()` | Wipes derived key material from memory. |
| `toReadOnlyAccount()` | Produces a `WalletAccountReadOnlyRgb` sharing the same configuration. |

RGB-specific methods:

| Method | Description |
| --- | --- |
| `issueAssetNia({ ticker, name, precision, amounts })` | Issues a Non-Inflatable Asset. |
| `issueAssetCfa({ name, precision, amounts, details?, filePath? })` | Issues a Collectible Fungible Asset. |
| `issueAssetUda({ ticker, name, precision, details?, mediaFilePath?, attachmentsFilePaths? })` | Issues a Unique Digital Asset (NFT). |
| `issueAssetIfa({ ticker, name, precision, amounts, inflationAmounts, rejectListUrlOpt? })` | Issues an Inflatable Fungible Asset. |
| `inflate({ assetId, amounts, feeRate?, minConfirmations? })` | Mints additional supply of an IFA. |
| `drainTo({ address, destroyAssets?, feeRate? })` | Sends all sats to `address`, optionally burning RGB allocations. |
| `receiveAsset({ witness, assetId?, amount?, transportEndpoints? })` | Creates a blind receive (`witness: false`) or witness receive (`witness: true`) invoice. |
| `sendBegin(options)` / `sendEnd({ signedPsbt })` | Granular RGB send flow for external signers. |
| `sendBtcBegin(options)` / `sendBtcEnd({ signedPsbt })` | Granular BTC send flow. |
| `createUtxos({ upTo, num, size, feeRate })` | Combined UTXO creation. |
| `createUtxosBegin(options)` / `createUtxosEnd({ signedPsbt })` | Granular UTXO creation flow. |
| `signPsbt(psbt)` | Signs a PSBT via the embedded `BareSigner`. |
| `getAssetBalance(assetId)` | Returns the full `{ settled, future, spendable }` balance breakdown. |
| `listAssets()` / `listUnspents()` / `listTransactions()` | Inventory views. |
| `getTransfers({ assetId?, limit?, skip? })` / `listTransfers(assetId)` | RGB transfer history. |
| `failTransfers(transferId)` | Marks an in-flight transfer as failed. |
| `refreshWallet()` / `syncWallet()` | Pull new state from the indexer; re-sync from chain. |
| `registerWallet()` | Reports the deposit address plus current BTC balance. |
| `createBackup({ password, backupPath })` / `restoreFromBackup({ backupFilePath, password, dataDir })` | Encrypted backup and restore. |
| `backupInfo()` | Metadata about the last backup. |
| `decodeRGBInvoice({ invoice })` | Parse an RGB invoice URI into its structured fields. |
| `estimateFeeRate(blocks)` | Target fee rate for inclusion within `blocks` confirmations. |

### `WalletAccountReadOnlyRgb`

| Method | Description |
| --- | --- |
| `getBalance()` / `getTokenBalance(assetId)` | View-only BTC and RGB balances. |
| `verify(message, signature)` | BIP-322 signature verification (no private key required). |
| `quoteSendTransaction(tx)` / `quoteTransfer(options)` | Fee estimates for display. |
| `getTransactionReceipt(hash)` / `getTransferReceipt(hash)` | Placeholder implementations returning `null`; use the full account for receipts. |

---

## Installation

```bash
npm install @utexo/wdk-wallet-rgb
```

The wallet stores its state locally under `dataDir`. You need access to:

- a Bitcoin indexer (Electrs or Esplora) reachable from the runtime
- an RGB transport endpoint (proxy) for asset transfers

Both default to UTEXO-managed infrastructure when `network: 'utexo'` is selected.

---

## Quick Start

```javascript
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'

const seedPhrase = 'poem twice question inch happy capital grain quality laptop dry chaos what'

// `network` and `dataDir` are required; indexer and transport endpoints
// default to the UTEXO-managed endpoints for the chosen network.
const manager = new WalletManagerRgb(seedPhrase, {
  network: 'utexo',
  dataDir: './wallet-data'
})

const account = await manager.getAccount()

const address = account.getAddress()
console.log('Deposit address:', address)

// Register wallet and fetch the current BTC balance.
const { address: regAddress, btcBalance } = account.registerWallet()
console.log('Registered address:', regAddress)
console.log('BTC Balance:', btcBalance)

// List RGB assets.
console.log(account.listAssets())

// Clean up.
account.dispose()
manager.dispose()
```

---

## Core Workflows

### Initialise from Seed

```javascript
const manager = new WalletManagerRgb(mnemonic, {
  network: 'regtest',
  indexerUrl: 'tcp://localhost:50001',
  transportEndpoint: 'rpc://localhost:3000/json-rpc',
  dataDir: './wallet-data'
})
const account = await manager.getAccount() // always index 0
```

### Manage UTXOs

```javascript
// Combined flow
const created = await account.createUtxos({ upTo: true, num: 5, size: 2000, feeRate: 2 })
console.log(`Created ${created} UTXOs`)

// Granular flow for external signers
const psbt = account.createUtxosBegin({ upTo: true, num: 5, feeRate: 2 })
const signed = await account.signPsbt(psbt)
const count = account.createUtxosEnd({ signedPsbt: signed })
```

### Issue an Asset

```javascript
// NIA
const nia = account.issueAssetNia({
  ticker: 'DEMO',
  name: 'Demo Asset',
  precision: 0,
  amounts: [100, 50]
})

// CFA
const cfa = account.issueAssetCfa({
  name: 'Collectible Edition',
  precision: 0,
  amounts: [1000]
})

// UDA (NFT)
const uda = account.issueAssetUda({
  ticker: 'TNFT',
  name: 'Test NFT',
  precision: 0
})

// IFA (inflatable)
const ifa = account.issueAssetIfa({
  ticker: 'TIFA',
  name: 'Inflatable',
  precision: 0,
  amounts: [1000],
  inflationAmounts: [500]
})

// Later: mint more supply of the IFA.
await account.inflate({ assetId: ifa.assetId, amounts: [100], feeRate: 2 })
```

### Receive and Transfer

```javascript
const invoice = account.receiveAsset({
  witness: false,
  assetId: nia.assetId,
  amount: 10
})

const sendResult = await account.transfer({
  recipient: invoice.invoice,
  token: nia.assetId,
  amount: 10,
  feeRate: 2,
  minConfirmations: 1
})

console.log('Transfer hash:', sendResult.hash)
```

Pass `witness: true` to generate a witness-style invoice; the bundled `examples/rgb-wallet-flow.mjs` covers both flows end-to-end.

### Backup and Restore

```javascript
const password = 'strong-password'
const backupPath = './backup.rgb'

// Create backup.
const backup = account.createBackup({ password, backupPath })
console.log('Backup created:', backup.message)

// Restore into a fresh dataDir.
const restoredManager = new WalletManagerRgb(mnemonic, {
  network: 'regtest',
  dataDir: './restored-wallet'
})
const restored = await restoredManager.restoreAccountFromBackup({
  backupFilePath: backupPath,
  password,
  dataDir: './restored-wallet'
})
console.log('Restored address:', restored.getAddress())
```

---

## Security Notes

- **Mnemonic hygiene:** store mnemonics offline; do not embed them in source control.
- **Local storage:** wallet data is stored locally in `dataDir`. Ensure app-private file permissions and a backup strategy that covers this directory.
- **Invoice handling:** invoices are single-use; consume them exactly once to avoid race conditions.
- **Backups:** backup files are encrypted but still sensitive. Store them alongside the password in a secure vault.
- **Memory management:** call `dispose()` on accounts and managers when finished to zero private key material.

---

## Development

```bash
# Install dependencies
npm install

# Emit type definitions
npm run build:types

# Lint
npm run lint
npm run lint:fix

# Tests
npm test
npm run test:coverage
```

---

## License

Apache License 2.0 — see the [LICENSE](LICENSE) file for details.

## Contributing

Pull requests are welcome.

## Support

Open an issue on the GitHub repository.
