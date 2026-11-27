# RC4 qualification register

This register covers `@utexo/wdk-wallet-rgb@3.0.0-rc.4`. Build, packed runtime, funded local and installed-app checks have separate scopes. Receipts and disposable fixtures are excluded from the npm package.

## Node addon qualification in progress

Node now uses a bundled Node-API addon on a dedicated thread instead of a separate Rust executable. The Rust engine, upstream sources, database identities and Bare native inputs are unchanged. The five Node targets are on artifact-admission hold until the new builds and packed consumers pass. Publication remains held.

Local verification passes 165 JavaScript tests and public types, 54 Rust library tests and strict Clippy. The same Darwin ARM64 Node-API v8 binary executes on Node 22, 24 and 26. Lifecycle regressions cover timeout/close during native mutation, retained directory ownership, no automatic replay and result recovery after reopen. These local checks do not qualify the final cross-platform archive; funded upgrade and exact-pack checks are underway.

## Previous executable-based candidate

| Input | Reviewed identity |
| --- | --- |
| RGB source | `a62fc7d3aa21f715a53c32419ab6d9fbbf1721a2` |
| RGB tree | `a8e6f0e2a67e01fccc2c9882eb599436bc7eaedd` |
| RGB protocol | Locked registry `0.11.2-rc.2` crates |
| Native producer | `c5b4c1f0e15f0fac7f8d05a69734be70aa82825d` |
| Package source | `2331119dfc48b782dc1ad5af3f32d21ff38319a1` |
| Archive SHA-256 | `c7b42d8bc1bde6ea5f02a66aa1f7927115ac9a3678eaf702a7480c71aa447dbe` |

The public RGB source includes merged contract APIs from [#124](https://github.com/RGB-Tools/rgb-lib/pull/124) and the pending [BFA metadata repair in #138](https://github.com/RGB-Tools/rgb-lib/pull/138). Its crate label is `0.3.0-beta.7`; the exact commit identifies this newer source. No downstream source overlay or Cargo source override is applied. PR #103 is superseded by #124.

**#138 remains a merge dependency.** It reconstructs missing BFA bridge/reject-list metadata from retained validated stock during transactional wallet initialization, preserving keys, allocations and transfers. Missing stock fails without a partial backfill. Without the repair, an older BFA database can migrate and then panic when listing an asset.

The previous candidate had complete native artifact admission. `publicationHold: true` remains. Removing that hold changes a packed file: repack and rerun package admission/consumer checks against the final release source. [RELEASING.md](RELEASING.md) records the review, normal-merge and publication order.

## Previous executable-based verification

| Scope | Result and evidence |
| --- | --- |
| CI and native builds | [19/19 producer jobs pass](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/actions/runs/45995455771), plus CodeQL. [Platform admission](qualification/rc4/platforms.json) verifies all five Node workers and eleven Bare addons by ZIP digest, source/tree/locks, binary hash and ABI. |
| Desktop runtime | All nine desktop jobs execute packed consumers, contract import/export/reopen and native Release tests (56 Node / 51 Bare cases). Every packed source member matches the producer. Seven mobile targets have build/ABI acceptance. |
| Source and release tools | 152 JavaScript tests, public types, runtime npm audit, source-only package checks and 24 release-tool regressions pass. Qualification-only verification rejects output assembly and keeps publication blocked. |
| Complete package | [Exact archive receipt](qualification/rc4/complete-pack.json): 41 files, 211,940,487 bytes, all eleven Bare targets. Every file matches committed source or an admitted binary. The npm publication dry-run passes locally; registry authentication and server acceptance remain unverified. |
| Funded exact-pack tests | [Node/Bare receipt](qualification/rc4/funded-release.json): direct RC3 updates retain keys, balances, metadata, pending invoices and old proofs; six retained RC4 wallets reopen unchanged. Fresh contract import/mint, BTC/NIA/CFA/BFA transfers and ten new V1 burns across all five routes pass. Lost native End replies, duplicate rejection and exact proof recovery after process restart pass. |
| Independent financial audit | [Reconciliation](qualification/rc4/financial-release.json) verifies four new mints, twelve burns (including two RC3 baseline burns) and eight transfers against confirmed transactions, saved proofs and independent destination commitments. New asset: 6 minted − 1.28 burned = 4.72 retained; the earlier asset retains 14.5. No EVM redemption was performed. |
| Dependency audit | [Current receipt](qualification/rc4/dependency-audit.json): `url 2.5.9` and `form_urlencoded 1.2.3` resolve RUSTSEC-2026-0592. Seven retained TLS findings and chrono/YAML maintenance warnings remain; npm production audit reports zero. See [DEPENDENCY-POLICY.md](DEPENDENCY-POLICY.md). |

## Earlier RC4 and application evidence

The prior RC4 archive `3513c7b4…`, producer `b765e9b…`, has separate [funded upgrade](qualification/rc4/funded-upgrade-final-ci.json), [broader local](qualification/rc4/funded-upgrade-local.json) and [financial reconciliation](qualification/rc4/financial-reconciliation.json) receipts. Its [original package and platform identities](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc4) remain immutable. These results cover additional pending witness/blinded receives and approved Sandbox contract import, but do not qualify the rebuilt URL-library binaries by themselves.

The [Android update receipt](qualification/rc4/iris-android-update.json) and iOS results in [Iris #11](https://github.com/UTEXO-Protocol/utexo-mobile/pull/11) use those earlier native hashes. Android replacement installation preserved wallet state, authentication settings, pending invoices and signing identity; fresh creation/import also passed. The deleted original AAB was reconstructed from exact source and recovered SDK/native inputs. This is not original-bundle, Google Play delivery/signing, physical-device or funded-mobile acceptance. Iris must rebuild and qualify its final registry integration separately.

## Remaining limits

- Obtain upstream #138 acceptance, verify the accepted source, and rebuild if native inputs change. Required SDK reviews, npm maintainer authentication and authorized publication remain separate steps.
- Local mint/burn/proof tests do not establish hosted gateway/TEE enforcement, EVM redemption or payouts on external networks. The package contains no deployment-specific USDT export or metadata.
- A seed restores keys and discoverable Bitcoin history, not missing RGB consignments, allocations or journals. Preserve the complete wallet directory. Automatic VSS restore and legacy 2.x wallet conversion are not provided.
- Cancellation follows upstream retention/proxy-loss semantics; BFA, assetless and progressed receives remain excluded. Ambiguous signed inputs stay reserved. Recovery preserves the original operation identity rather than constructing another payment.
- Mainnet NIA/CFA are supported; Mainnet BFA is not enabled. Contract registration excludes missing external media. Duplicate registration does not validate replacement bytes. See [CANDIDATE.md](CANDIDATE.md).

## Retained baseline and historical evidence

[RC3 baseline identities](qualification/rc3/README.md) and its platform receipt remain here because the RC4 upgrade tests depend on those exact older inputs. Historical results do not qualify a different package or binary.

Superseded qualification receipts remain available at immutable commit `a6dd195b3988b6fccd70dce9a66c2577ac368853`:

- [Alpha.24](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/alpha24): initial unmodified BFA.8, ordinary transfers, real-expiry cancellation and proxy-retention tests.
- [RC1](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc1): cross-proxy transfers, early release assembly and Core/BTC tests.
- [RC2](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc2): invoice-scoped mint verification and proof rejection/recovery.
- [Earlier RC3 runs](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc3) and [older alpha history](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/a6dd195b3988b6fccd70dce9a66c2577ac368853/QUALIFICATION.md): original sources, APKs and limitations, including previously patched builds.
