# @utexo/wdk-wallet-rgb

An on-chain Bitcoin and RGB wallet SDK for Node and Bare. The application owns the signer and approves transactions; the native engine receives public account data and reviewed signed PSBTs. There is no Lightning dependency.

Version `3.0.0-rc.3` is the release candidate for the new API. It uses unmodified public RGB-Tools `rgb-lib 0.3.0-beta.8`. See the [upgrade guide](MIGRATION.md) before replacing a 2.x integration: the API and wallet directory format change.

## Installation

Install the reviewed package archive in your application:

```sh
npm install ./utexo-wdk-wallet-rgb-3.0.0-rc.3.tgz
```

Node requires `^22.21.0 || >=24.9.0`; Bare requires `>=1.37.1`, including embedded mobile runtimes. The native manifest lists the exact Bare targets admitted in an archive. Qualification archives can contain a subset; a complete SDK release requires all eleven Bare targets. Node applications also need the matching native worker archive for their platform and its recorded SHA-256. There are no native downloads or compilation hooks during installation.

The [integration guide](CANDIDATE.md) covers Node worker configuration, Bare and mobile linking, network selection, transaction approval, Tether Core and error recovery. The repository's [release procedure](RELEASING.md) describes artifact verification and publication.

## Supported operations

- Bitcoin addresses, balances, history, transfers and recovery after interrupted submission.
- NIA/CFA issuance, optional-amount blinded and witness invoices, RGB receive/send, balances and history.
- RGB output preparation, approval, creation and recovery; exact expired ordinary-invoice cancellation.
- BIP-322 message signing and verification with separate application approval.
- Invoice-scoped prepared-mint verification before payment, including a verified asset ID for assetless receives.
- BFA receive/mint validation, explicit V1 burn destinations, scoped proof export and recovery on the bridge profiles.
- Tether Core registration and explicit awaited shutdown.

NIA/CFA issuance and transfers are available on every supported RGB profile: Mainnet, Public Signet, Dev, staging and Regtest. BTC-only mode omits RGB. Bridge profiles advertise only the exact payout routes the application configures. The SDK ships no USDT contract export or asset metadata.

Balance, history, asset, output, fee and chain getters retry one `INDEXER_UNAVAILABLE` response on the same account; each native attempt repeats its chain checks. BTC-only `sync()` inherits the balance getter's retry. RGB `sync()`/`refresh()`, invoice allocation, issuance, transfer submission and recovery are never automatically retried.

## Platforms

| Runtime | Targets |
| --- | --- |
| Node | macOS ARM64 and x64; Linux ARM64 and x64 glibc; Linux x64 musl |
| Desktop Bare | macOS ARM64 and x64; Linux ARM64 and x64 glibc |
| Android Bare | ARM64, ARMv7, x64 and x86 |
| iOS Bare | ARM64 device; ARM64 and x64 simulators |

GNU hosts must provide the GLIBC symbol versions recorded in each worker or addon receipt. macOS binaries target macOS 11 or newer; the selected Node/Bare host runtime can require a newer OS. Linux musl is available for the Node x64 worker only.

Build and ABI verification, packed desktop execution, funded fixture tests and installed application acceptance have separate scopes. The [qualification register](QUALIFICATION.md) records exact versions and evidence. Windows is not supported.

## Current limits

The pinned upstream library has no public standalone contract registration API. `registerAssetContract()` reports `CONTRACT_IMPORT_UNAVAILABLE`; it does not block ordinary RGB issuance or validated transfer receipt. This SDK does not enable upstream's explicit Mainnet BFA schema opt-in; Mainnet NIA/CFA are supported. A seed alone cannot recover missing RGB proofs or WDK journals, and this SDK has no automatic VSS restore implementation.

Expired receive cancellation excludes BFA, assetless and progressed invoices. Ambiguous signed spends retain their original input protection. These restrictions prevent an active mint or uncertain transfer from being discarded.

The release uses the upstream TLS/SQLite dependency graph without source patches. Its known findings and the accepted dependency policy are documented in [DEPENDENCY-POLICY.md](DEPENDENCY-POLICY.md). Third-party attribution is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
