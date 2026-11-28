# RC4 qualification register

This register covers `@utexo/wdk-wallet-rgb@3.0.0-rc.4`. Build, packed runtime, funded local and installed-app checks have separate scopes. Receipts and disposable fixtures are excluded from the npm package.

## Current first-release candidate

The release now pins merged RGB-Tools `f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d`, tree `0c20cd05eb2899962c152b6ccac324e2a705dc38`, with the merged public contract APIs from #124 and no downstream source patch. The source package labels itself `0.3.0-beta.7`; the exact commit identifies the implementation. Closed #138 is not included or required for this fresh-wallet release.

All five Node and eleven Bare targets were rebuilt from `60f22b2a62665ee61c4d0898320e29999c9f6209`. [Producer CI](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/actions/runs/46126203212) passes all 19 jobs. [Platform admission](qualification/rc4/platforms.json) independently verifies every source, archive, binary and ABI: nine desktop targets execute packed consumers, and seven mobile targets pass build/ABI checks. Node runs 59 Rust tests per target; desktop Bare runs 51. Native artifact admission is complete. Funded fresh-wallet, final package and installed-app checks are in progress; publication remains held. Historical results below do not substitute for those checks.

Fresh BFA creation/import writes its metadata through the merged upstream API. Qualification does not require upgrading an older alpha/RC wallet database. It does require preserving all wallet state, pending operations and proof bytes across restarts after creation with this candidate. Seed import does not recover missing RGB allocations or proofs.

## Previous Node addon candidate

Node uses a bundled Node-API v8 addon on a dedicated thread instead of a separate Rust executable. In this historical candidate, the shared Rust engine, upstream sources, database identities and Bare native inputs were unchanged. Every Node target was rebuilt and executed; all eleven Bare binaries retained their original hashes. Its complete archive passed funded Node/Bare acceptance.

| Input | Reviewed identity |
| --- | --- |
| RGB source / tree | `a62fc7d3aa21f715a53c32419ab6d9fbbf1721a2` / `a8e6f0e2a67e01fccc2c9882eb599436bc7eaedd` |
| Node native producer | `ca2deb62b68272f037fa22d543625c2af93f24b3` |
| Retained Bare native producer | `c5b4c1f0e15f0fac7f8d05a69734be70aa82825d` |
| Package source | `1323731494ec83b87a54d415ea942deaee04e52d` |
| Complete archive SHA-256 | `b6054baafa939a0cdbda1f127d666b6ef9a46661c14873204822875350bb3b6d` |

| Scope | Result and evidence |
| --- | --- |
| Node platform builds | All five [producer jobs pass](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/actions/runs/46015918020): macOS ARM64/x64, Linux GNU ARM64/x64 and Linux musl x64. Each runs 54 Rust library and five network integration tests, native lifecycle tests and actual packed-consumer automatic/explicit addon loading. [Historical platform admission](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/1d5507c431ed14c932b790abff27fbbc649b6a01/qualification/rc4/platforms.json) independently verifies GitHub ZIP hashes, source/locks, binary identities, ABI, exports and loader protections. |
| Retained Bare platforms | All eleven native artifacts retain the admitted source and hashes from [their successful producer](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/actions/runs/45995455771). The shared engine and Bare bindings are unchanged. Four desktop targets have their retained runtime acceptance; seven mobile targets have retained build/ABI acceptance. That archive's Bare Darwin ARM64 passed the funded tests below. |
| Source and lifecycle tests | 165 JavaScript tests, public types, 36 release/scope regressions, runtime npm audit and strict local Clippy pass. Fourteen real Node-API fixture regressions cover identity/bounds, terminal errors, timeout/close during a dispatched mutation, retained directory ownership and no replay. These fixtures are separate from actual funded execution. |
| Complete package | [Archive receipt](qualification/rc4/node-addon/complete-pack.json): 48 files, 305,412,746 bytes, five Node and eleven Bare addons. Every file matches committed source or an admitted binary. Independent installation comparisons and the local npm publication dry-run pass. Registry authentication and server acceptance are not established. |
| Concurrent native execution | The exact CI Darwin ARM64 addon in the full archive passes on [Node 22, 24 and 26](qualification/rc4/node-addon/concurrency/acceptance.json). Four independent managers/native threads perform reads and BIP-322, enforce native lock exclusion across JS isolates, shut down partially and completely, and reopen with unchanged identities. |
| Funded wallet preservation | [Exact-pack receipt](qualification/rc4/node-addon/funded-release.json): ten retained wallets reopen unchanged. Two freshly funded executable-based RC4 wallets upgrade in place, preserving keys, BTC/BFA balances, NIA/CFA metadata, every prior transfer field, pending blinded invoices and saved burn proofs. No reset or seed restoration substitutes for these updates. |
| Funded operations and recovery | The same pack completes two new mints, four new NIA/CFA issuances, twelve confirmed BTC/BFA/NIA/CFA transfers and ten new V1 burns across Arbitrum, Ethereum, Polygon, Plasma and Tron destinations on isolated Regtest/Anvil. Each runtime loses one successful native burn response; repeated recovery and full process restart return the original proof, duplicate operations are rejected, and `burnEnd` executes once. |
| Independent financial audit | [Reconciliation](qualification/rc4/node-addon/financial-release.json) checks four mints and twelve burns including the executable baselines, all twelve transfers, NIA/CFA supply, confirmed Bitcoin fees/commitments, saved proofs and independently computed V1 destinations. The new asset reconciles as 6 minted − 1.28 burned = 4.72 retained units; all three fixture assets total 23.94 units. The bridge retains 32 units of backing because no EVM redemption was performed. |

The funded runner initially requested the burn-only public proof API for an ordinary BFA transfer. That confirmed transfer was reconciled against its original operation ID, transaction and journal before continuing; it was not resent. The final independent audit reads its saved native consignment. [Reproduction instructions](qualification/rc4/node-addon/README.md) and receipts distinguish this harness correction from SDK behavior.

Node applications remove `nativeExecutable` and the old executable hash, preserve their complete wallet directory, await shutdown, and restart the host process when replacing native code. A worker thread is not a subprocess crash boundary; native code shares the host environment and upstream diagnostics. A caller deadline cannot cancel a dispatched mutation. See [MIGRATION.md](MIGRATION.md).

## Previous executable-based candidate

| Input | Reviewed identity |
| --- | --- |
| RGB source | `a62fc7d3aa21f715a53c32419ab6d9fbbf1721a2` |
| RGB tree | `a8e6f0e2a67e01fccc2c9882eb599436bc7eaedd` |
| RGB protocol | Locked registry `0.11.2-rc.2` crates |
| Native producer | `c5b4c1f0e15f0fac7f8d05a69734be70aa82825d` |
| Package source | `2331119dfc48b782dc1ad5af3f32d21ff38319a1` |
| Archive SHA-256 | `c7b42d8bc1bde6ea5f02a66aa1f7927115ac9a3678eaf702a7480c71aa447dbe` |

This historical public RGB source included the merged contract APIs from [#124](https://github.com/RGB-Tools/rgb-lib/pull/124) and the now-closed [BFA metadata repair in #138](https://github.com/RGB-Tools/rgb-lib/pull/138). No downstream source overlay or Cargo source override was applied. PR #103 is superseded by #124.

The #138 tests covered reconstruction of missing BFA metadata in older databases. Those earlier upgrade results are retained for traceability, not as a current release dependency. The first release does not admit an older alpha/RC database as its upgrade baseline.

The previous candidate had complete native artifact admission. `publicationHold: true` remains. Removing that hold changes a packed file: repack and rerun package admission/consumer checks against the final release source. [RELEASING.md](RELEASING.md) records the review, normal-merge and publication order.

## Previous executable-based verification

| Scope | Result and evidence |
| --- | --- |
| CI and native builds | [19/19 producer jobs pass](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/actions/runs/45995455771), plus CodeQL. [Previous platform admission](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/418b98dddf7b7e71dc6f9bbef3c8e50a89cdb4b5/qualification/rc4/platforms.json) verifies all five Node workers and eleven Bare addons by ZIP digest, source/tree/locks, binary hash and ABI. |
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

- Complete new-source artifact admission and funded fresh-wallet acceptance. Required SDK reviews, npm maintainer authentication and authorized publication remain separate steps.
- Local mint/burn/proof tests do not establish hosted gateway/TEE enforcement, EVM redemption or payouts on external networks. The package contains no deployment-specific USDT export or metadata.
- A seed restores keys and discoverable Bitcoin history, not missing RGB consignments, allocations or journals. Preserve the complete wallet directory. Automatic VSS restore and legacy 2.x wallet conversion are not provided.
- Cancellation follows upstream retention/proxy-loss semantics; BFA, assetless and progressed receives remain excluded. Ambiguous signed inputs stay reserved. Recovery preserves the original operation identity rather than constructing another payment.
- Mainnet NIA/CFA are supported; Mainnet BFA is not enabled. Contract registration excludes missing external media. Duplicate registration does not validate replacement bytes. See [CANDIDATE.md](CANDIDATE.md).

## Retained baseline and historical evidence

[RC3 baseline identities](qualification/rc3/README.md) and its platform receipt remain here to reproduce the historical RC4 upgrade tests. Historical results do not qualify a different package or binary.

Superseded qualification receipts remain available at immutable commit `a6dd195b3988b6fccd70dce9a66c2577ac368853`:

- [Alpha.24](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/alpha24): initial unmodified BFA.8, ordinary transfers, real-expiry cancellation and proxy-retention tests.
- [RC1](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc1): cross-proxy transfers, early release assembly and Core/BTC tests.
- [RC2](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc2): invoice-scoped mint verification and proof rejection/recovery.
- [Earlier RC3 runs](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc3) and [older alpha history](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/a6dd195b3988b6fccd70dce9a66c2577ac368853/QUALIFICATION.md): original sources, APKs and limitations, including previously patched builds.
