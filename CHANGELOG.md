# Changelog

All notable changes to `@utexo/wdk-wallet-rgb` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Promote VSS cloud-backup to the public `WalletAccountRgb` surface:
  `configureVssBackup`, `disableVssAutoBackup`, `vssBackup`, and
  `vssBackupInfo` now delegate to the binding directly. Previously
  these existed only on `BareRgbLibBinding`, reachable via the
  `getRgbWallet()` escape hatch.

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
