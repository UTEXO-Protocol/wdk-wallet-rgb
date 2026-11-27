# Changelog

## 3.0.0-rc.4 — Unreleased

This is the first planned publication of the on-chain version 3 SDK. Earlier
alpha and RC builds were qualification candidates; their evidence remains in
Git history.

### Breaking changes from 2.x

- Replace the synchronous wrapper with asynchronous Node/Bare accounts, an
  application-owned signer, explicit transaction approval and durable operation IDs.
- Use `sendBtc()`, `sendRgbInvoice()` and BIP-322 signing instead of the legacy
  send/sign aliases. Await account shutdown before disposing Tether Core.
- Use an engine-specific wallet directory. There is no 2.x database converter;
  a seed alone does not restore RGB proofs, allocations or operation journals.

### Added

- BTC receive/send; RGB output preparation, approval, creation and recovery;
  NIA/CFA issuance and transfers on every supported RGB profile.
- Optional-amount blinded and witness invoices, exact expired ordinary-receive
  cancellation and durable expected-asset binding for generic receives.
- WebRGB 0.1.7 prepared-mint verification, explicit V1 burn routes and scoped
  proof export/recovery. Arbitrum, Ethereum, Polygon, Plasma and Tron routes
  require application configuration.
- Offline public contract registration/export with expected asset ID and hash,
  bounded bytes and no allocations or transfers created by registration.
- BIP-322, immutable public account keys, Tether Core integration and awaited
  native shutdown. Pure getters can retry one unavailable indexer response;
  financial operations retain their original identity and are not replayed.
- Five Node-API addons and eleven Bare addons with source, lock, ABI and checksum
  admission, all delivered in the npm archive. Node runs the unchanged engine on a
  dedicated thread and waits for native cleanup without replaying interrupted operations.

### Upgrade and dependencies

- Preserve RC3 wallet directories, keys, pending invoices, balances and proof
  files. The pinned upstream BFA metadata repair in
  [RGB-Tools #138](https://github.com/RGB-Tools/rgb-lib/pull/138) remains a release
  dependency. Duplicate contract registration returns `ASSET_ALREADY_KNOWN`;
  it does not validate replacement bytes.
- Pin public RGB-Tools `a62fc7d3aa21f715a53c32419ab6d9fbbf1721a2`, including
  merged public contract APIs, without a downstream source overlay. RGB protocol
  dependencies remain `0.11.2-rc.2`; both runtimes use bundled SQLite 3.54.1.
- Update the stock `url` dependency to 2.5.9 and `form_urlencoded` to 1.2.3 to
  resolve RUSTSEC-2026-0592. Remaining upstream findings are recorded in
  [DEPENDENCY-POLICY.md](DEPENDENCY-POLICY.md).

Publication remains held until upstream #138 is accepted and the final release
source and artifacts are reviewed. The intended npm tag is `next`.

## [2.0.3] — 2026-01-28

### Changed
- README: doc-only refresh.

## [2.0.2] — 2026-01-26

### Fixed
- Release workflow: use the input version for the GitHub Release tag
  so the published tag matches the published npm version.

## [2.0.0] — 2026-01-26

### Removed

- `rgbNodeEndpoint` configuration parameter (no longer required)
- `rgbNodeEndpoint` requirement from `WalletManagerRgb` constructor

### Added

- `indexerUrl` configuration parameter (Electrs indexer URL)
- `transportEndpoint` configuration parameter (Transport endpoint)
- `dataDir` configuration parameter (RGB state data directory)
- `failTransfers(transferId)` method to `WalletAccountRgb` for failing transfers
- `restoreFromBackup()` static method support in `WalletAccountRgb.fromBackup()` for restoring wallets from encrypted backups

### Changed

- `getTransfers()`: Now returns `Array<RgbTransfer>` instead of `Promise<Array<RgbTransfer>>` (synchronous)
- `toReadOnlyAccount()`: Now returns `WalletAccountReadOnlyRgb` instead of `Promise<WalletAccountReadOnlyRgb>` (synchronous)
- `listAssets()`: Now returns `Array<ListAssets>` instead of `Promise<Array<ListAssets>>` (synchronous)
- `issueAssetNia()`: Now returns `IssueAssetNIA` instead of `Promise<IssueAssetNIA>` (synchronous)
- `receiveAsset()`: Now returns `InvoiceReceiveData` instead of `Promise<InvoiceReceiveData>` (synchronous)
- `sendBegin()`: Now returns `string` instead of `Promise<string>` (synchronous)
- `sendEnd()`: Now returns `SendResult` instead of `Promise<SendResult>` (synchronous)
- `createUtxosBegin()`: Now returns `string` instead of `Promise<string>` (synchronous)
- `createUtxosEnd()`: Now returns `number` instead of `Promise<number>` (synchronous)
- `listUnspents()`: Now returns `Array<Unspent>` instead of `Promise<Array<Unspent>>` (synchronous)
- `listTransactions()`: Now returns `Array<RgbTransactionReceipt>` instead of `Promise<Array<RgbTransactionReceipt>>` (synchronous)
- `listTransfers()`: Now returns `Array<RgbTransfer>` instead of `Promise<Array<RgbTransfer>>` (synchronous)
- `refreshWallet()`: Now returns `void` instead of `Promise<void>` (synchronous)
- `syncWallet()`: Now returns `void` instead of `Promise<void>` (synchronous)
- Parameter naming: `asset_id` → `assetId` in `receiveAsset()` and `sendBegin()` methods
- Parameter naming: `witness_data` → `witnessData` in `sendBegin()` method
- Parameter naming: `fee_rate` → `feeRate` in `sendBegin()`, `createUtxos()`, and `createUtxosBegin()` methods
- Parameter naming: `min_confirmations` → `minConfirmations` in `sendBegin()` method
- Parameter naming: `up_to` → `upTo` in `createUtxos()` and `createUtxosBegin()` methods
- Parameter naming: `signed_psbt` → `signedPsbt` in `sendEnd()` and `createUtxosEnd()` methods
- `RegisterWalletResult.btc_balance` → `RegisterWalletResult.btcBalance`
- `createBackup()` return type: `download_url` → `downloadUrl`
- `WalletManagerRgb.getAccount()`: Now passes `dataDir`, `indexerUrl`, and `transportEndpoint` to account creation
- Multiple methods from async to sync where underlying RGB SDK methods are synchronous
- Internal method implementations to align with RGB SDK API changes
- TypeScript definitions to reflect all API changes
- JSDoc comments to reflect new parameter names and return types

### Fixed

- `restoreFromBackup()` call in static `fromBackup()` method - now correctly calls the imported function instead of instance method
- `sendEnd()` method parameter mapping - now correctly uses `signedPsbt` instead of `signed_psbt`
- `quoteSendTransaction()` and `quoteTransfer()` methods to use camelCase parameter names

## [1.0.0] — 2026-01-23

### Added
- Initial release of the RGB wallet SDK wrapper.
