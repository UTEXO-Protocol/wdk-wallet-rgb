# @utexo/wdk-wallet-rgb

An on-chain Bitcoin and RGB wallet SDK for Node and Bare. The application owns the signer and approves transactions; the native engine receives public account data and reviewed signed PSBTs. There is no Lightning dependency.

Version `3.0.0-rc.4` is a qualification candidate. It pins public RGB-Tools `rgb-lib` commit `a62fc7d3aa21f715a53c32419ab6d9fbbf1721a2`, including the pending [upstream BFA metadata upgrade repair](https://github.com/RGB-Tools/rgb-lib/pull/138); WDK applies no source overlay. The source package labels itself `0.3.0-beta.7`, but the exact commit follows the previously pinned beta.8 source. See the [upgrade guide](MIGRATION.md) for the in-place RC3 update and the separate breaking change from 2.x.

## Installation

Install the reviewed package archive in your application:

```sh
npm install ./utexo-wdk-wallet-rgb-3.0.0-rc.4.tgz
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
- Offline public contract registration and export, without creating an allocation or transfer.

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

`registerAssetContract()` registers an approved binary contract using its expected asset ID and SHA-256. `exportAssetContract()` returns the public contract as bytes; this is separate from transfer consignments and burn proofs. Both work offline on RGB profiles and accept at most 1 MiB. Registration creates no balance or allocation. An existing asset returns `ASSET_ALREADY_KNOWN`, which does not validate a newly supplied export. This SDK does not enable upstream's explicit Mainnet BFA schema opt-in; Mainnet NIA/CFA are supported. A seed alone cannot recover missing RGB proofs or WDK journals, and this SDK has no automatic VSS restore implementation.

Expired receive cancellation excludes BFA, assetless and progressed invoices. Ambiguous signed spends retain their original input protection. These restrictions prevent an active mint or uncertain transfer from being discarded.

The release uses the upstream TLS/SQLite dependency graph without source patches. Its known findings and the accepted dependency policy are documented in [DEPENDENCY-POLICY.md](DEPENDENCY-POLICY.md). Third-party attribution is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
