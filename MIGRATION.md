# Upgrading to the on-chain SDK

Version 3 replaces the 2.x wrapper with an asynchronous Node/Bare wallet, an application-owned signer and durable operation records. It is a breaking release. It does not migrate an existing wallet directory or restore a 2.x encrypted backup.

## Application changes

| Previous integration | Version 3 |
| --- | --- |
| Synchronous native wrapper methods | Await the account's asynchronous methods. |
| `sendTransaction()` / `transfer()` or manual Begin/End calls | Use `sendBtc()` / `sendRgbInvoice()` with a stable operation ID and an authorization callback. |
| Generic signing methods | Use `signMessageBip322()` with explicit message authorization. |
| Implicit native package discovery | Node and Bare select their exact platform addon from the package. Mobile applications link and verify the admitted addon. |
| `dispose()` as the only shutdown step | Await `account.shutdown()` or `manager.shutdown()` before disposing Tether Core or replacing the wallet. |
| Seed or legacy backup treated as full RGB recovery | Preserve the complete wallet directory, including consignments, allocation data and WDK operation/input journals. A seed alone restores keys and discoverable Bitcoin history. |

The public configuration and methods are defined in [onchain.d.ts](onchain.d.ts). The [integration guide](CANDIDATE.md) includes Core registration, authorization, network profiles, issuance and recovery examples.

## Updating RC3 to RC4

RC4 retains the `rgb-l1-beta8-v1` directory identity, account derivation, network/profile identity and existing journals. Keep the complete RC3 wallet directory and update it in place. Do not reset it, import its seed into a new directory, or recreate pending invoices and operation IDs. This is distinct from the unsupported 2.x and earlier-engine conversions below.

The exact RGB source is `a62fc7d3aa21f715a53c32419ab6d9fbbf1721a2`, which includes the merged public contract APIs and the pending [PR #138 metadata repair](https://github.com/RGB-Tools/rgb-lib/pull/138). The repair restores BFA bridge and reject-list metadata from the wallet's retained validated stock; it does not change balances, allocations or transfers. Missing stock fails the open operation rather than inventing metadata. Upstream also migrates consignment file names and adds invoice storage. Preserve a complete private backup before the first upgrade; do not reopen an upgraded database with the older binary. Exact funded wallet and installed-application upgrade acceptance is recorded in the [qualification register](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/candidate/onchain-bfa/QUALIFICATION.md), separately from source tests.

## Updating the Node transport

The Node addon uses the same Rust engine, database schema, directory identity, derivation and operation journals as the earlier RC4 executable. Keep the complete wallet directory and the same configuration. Remove `nativeExecutable`; the SDK now resolves its bundled `.node` addon. An explicit `nativeAddon` path is optional and must match the admitted binary for the current platform. It cannot select an arbitrary native build.

Await shutdown before replacing an account or moving its directory. The addon runs on a dedicated worker thread. A timeout rejects the caller's wait, but a native operation that has already started may still complete. Shutdown waits for that operation and releases the native lock before resolving. Reopen with the original operation ID and use the recovery API; never resend under a new ID. Unlike the previous executable, a native crash affects the host process, so applications must preserve the journals across process restart.

## Earlier wallet engines

Create a new, private directory when moving from 2.x or an incompatible earlier engine. Use distinct directories for Mainnet, Public Signet, Dev Signet and Regtest. Do not copy a legacy database into a new directory or remove the directory identity marker to bypass admission. Earlier BFA.7/BFA.8 directories with an identity other than `rgb-l1-beta8-v1` require their original SDK. The upstream file-codec migration feature does not bypass WDK directory admission.

For qualification of an incompatible engine, use a fresh disposable wallet. Retain an existing funded wallet's original SDK and complete data until funds have been transferred and independently reconciled. This release makes no same-seed, same-address, database-conversion or RGB seed-only recovery guarantee across incompatible engines. These restrictions do not require resetting the RC3 wallets described above.

## Interrupted operations

Keep the original operation ID and parameters when reconciling an interrupted send, output setup or burn. Use the corresponding recovery method; do not create a replacement spend merely because a result was lost. Signed-input reservations and operation journals are part of the wallet's financial state. Do not delete them to make an operation retryable.

Standalone contract registration and export are available through the pinned upstream APIs. Query `getCapabilities()` before offering them; BTC-only accounts do not admit RGB contract operations. Registration requires the binary contract, expected asset ID and SHA-256, adds no allocations and returns `ASSET_ALREADY_KNOWN` for an existing asset. Do not treat that error as validation of the submitted bytes. Generic receive remains supported. Retrying an existing WebRGB receive must retain its operation ID, request key and expected asset: an already-issued generic invoice is recovered unchanged, even if the asset can now be registered.
