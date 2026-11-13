# Changelog

All notable changes to `@utexo/wdk-wallet-rgb` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0-alpha.24] — Unreleased

- Use unmodified BFA.8 and stock Electrum/Esplora clients; remove custom upstream API dependencies from the adapter.
- Enable NIA/CFA issuance on every supported RGB profile and preserve bridge configuration during consistency rescans.
- Implement exact expired ordinary-invoice cancellation through the public library API.
- Preserve exposed transaction inputs independently of ambiguous RGB transfer failure.
- Check the configured Bitcoin chain at WDK network boundaries and retain operation identities across reconnects.
- Report the missing standalone contract import API without blocking unrelated wallet operations.
- Add native builds and packed desktop qualification for the supported Node/Bare target matrix.
- Require Bare 1.37.1 or newer, including embedded mobile runtimes, and verify clean and existing-host dependency installs.

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
