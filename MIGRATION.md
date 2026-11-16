# Upgrading to the on-chain SDK

Version 3 replaces the 2.x wrapper with an asynchronous Node/Bare wallet, an application-owned signer and durable operation records. It is a breaking release. It does not migrate an existing wallet directory or restore a 2.x encrypted backup.

## Application changes

| Previous integration | Version 3 |
| --- | --- |
| Synchronous native wrapper methods | Await the account's asynchronous methods. |
| `sendTransaction()` / `transfer()` or manual Begin/End calls | Use `sendBtc()` / `sendRgbInvoice()` with a stable operation ID and an authorization callback. |
| Generic signing methods | Use `signMessageBip322()` with explicit message authorization. |
| Implicit native package discovery | Node supplies a worker path and its SHA-256; Bare uses the exact platform addon from the package. Mobile applications link and verify the admitted addon. |
| `dispose()` as the only shutdown step | Await `account.shutdown()` or `manager.shutdown()` before disposing Tether Core or replacing the wallet. |
| Seed or legacy backup treated as full RGB recovery | Preserve the complete wallet directory, including consignments, allocation data and WDK operation/input journals. A seed alone restores keys and discoverable Bitcoin history. |

The public configuration and methods are defined in [onchain.d.ts](onchain.d.ts). The [integration guide](CANDIDATE.md) includes Core registration, authorization, network profiles, issuance and recovery examples.

## Wallet data

Create a new, private directory for this engine. Use distinct directories for Mainnet, Public Signet, Dev Signet and Regtest. Do not copy a legacy database into a new directory or remove the directory identity marker to bypass admission. BFA.8 also removed a database migration recorded by earlier BFA.7 candidates; those directories require their original SDK.

For disposable testing, use a fresh wallet. For an existing funded wallet, retain the original SDK and its complete data until funds have been transferred and independently reconciled. This release makes no same-seed, same-address, database-conversion or RGB seed-only recovery guarantee across engines. There is no production wallet migration implementation in this PR.

## Interrupted operations

Keep the original operation ID and parameters when reconciling an interrupted send, output setup or burn. Use the corresponding recovery method; do not create a replacement spend merely because a result was lost. Signed-input reservations and operation journals are part of the wallet's financial state. Do not delete them to make an operation retryable.

Standalone contract registration remains unavailable in stock BFA.8. Query `getCapabilities()` before offering asset preregistration. Generic receive can learn a new asset from a validated transfer; it does not register a standalone contract export.
