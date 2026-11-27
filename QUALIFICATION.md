# RC4 qualification register

This register covers `@utexo/wdk-wallet-rgb@3.0.0-rc.4`. It separates native builds, packed execution, funded local tests and installed application acceptance. Qualification receipts and disposable fixtures stay outside the npm package.

## Retained RC4 qualification and release status

| Input | Reviewed identity |
| --- | --- |
| RGB source | `a62fc7d3aa21f715a53c32419ab6d9fbbf1721a2` |
| RGB tree | `a8e6f0e2a67e01fccc2c9882eb599436bc7eaedd` |
| RGB protocol | Locked registry `0.11.2-rc.2` crates |
| Native producer | `b765e9b46a3872ab012cbdbc1f1c04ee1a377f4e` |
| Qualified package source | `80d7af32d2131c7a4133622a733414af8e07a5e7` |
| Qualified archive SHA-256 | `3513c7b4e02739abe7bfcbd4306054ba2f436ba152aff6aff3b4a462f3f3906f` |

The RGB source includes the public contract APIs merged through [RGB-Tools #124](https://github.com/RGB-Tools/rgb-lib/pull/124) and the pending [BFA metadata upgrade repair in #138](https://github.com/RGB-Tools/rgb-lib/pull/138). Its crate label is `0.3.0-beta.7`; the exact commit identifies this newer source. WDK applies no source overlay or Cargo source override. PR #103 is superseded by #124.

PR #138 remains a merge dependency. Without its repair, an older BFA database can migrate without its new `bridge_location` field and then panic when listing the asset. The repair reconstructs metadata and the reject-list cache from retained validated stock during transactional wallet initialization. It does not change keys, allocations or transfers; missing stock fails without a partial backfill.

The artifacts in the table were admitted for their recorded lockfiles. The URL parser update has now passed all 19 jobs of [the corrected producer run](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/actions/runs/45995455771). The current [platform receipt](qualification/rc4/platforms.json) admits all sixteen binaries from `c5b4c1f0e15f0fac7f8d05a69734be70aa82825d`; the complete package and funded rerun are being verified separately. The table above identifies the earlier pack, not these new binaries. `publicationHold: true` remains. Final documentation or hold changes produce a different npm archive and require a new package receipt and packed-consumer checks. The archive above must not be presented as an already published release. Follow [RELEASING.md](RELEASING.md) for upstream acceptance, final verification, review and publication order.

## Passing scopes

| Scope | Evidence and limits |
| --- | --- |
| Source checks | 152 JavaScript tests, public types, 56 Node and 51 Bare native Release tests, strict adapter Clippy and 17 release-tool regressions passed for the recorded RC4 implementation. |
| Native matrix | [All 19 producer checks passed](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/actions/runs/45975022979). [Original platform admission](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc4/platforms.json) verifies five Node workers and eleven Bare addons against producer, source, locks, archive digest, binary hash and ABI. Nine desktop jobs execute packed contract import/export/reopen; seven mobile targets have build/ABI acceptance. |
| Complete package | [Archive receipt](qualification/rc4/complete-pack.json): 41 files, 211,960,068 bytes; all source files match committed Git blobs and all eleven addons match admitted native hashes. |
| Direct funded RC3 update | [Final CI-binary receipt](qualification/rc4/funded-upgrade-final-ci.json): the complete archive and actual CI-built Darwin ARM64 Node/Bare binaries open genuine funded RC3 wallets in place. Keys, BTC/BFA balances, BFA/NIA/CFA metadata, every previous transfer field and timestamp, pending generic invoice journals and retained burn proofs survive. Both original blinded recipients receive real BFA transfers afterward. |
| Burn recovery | The same final receipt commits a new burn per runtime, loses the successful native End response, recovers repeatedly and after restart, and rejects a duplicate request. End executes once and proof bytes remain identical. Additional BFA transfers, BIP-322 and approved Sandbox contract import/export pass. |
| Broader local fixture | [Local-host receipt](qualification/rc4/funded-upgrade-local.json) additionally covers an original witness invoice receiving a mint after upgrade, fresh contract registration and mint, wrong-chain/ID/duplicate rejection, NIA/CFA issuance and transfers, and Bitcoin transfers. These local binaries have different hashes from CI and are identified separately. |
| Independent reconciliation | [Financial audit](qualification/rc4/financial-reconciliation.json) checks confirmed Bitcoin transactions, EVM lock calldata and finalized locks, saved proofs and Bitcoin commitments. Eight mints total 20 units; eight burns total 5.5; six wallets retain 14.5 after restart. EVM burn redemption is not performed. |
| Android application update | [Installed update receipt](qualification/rc4/iris-android-update.json): Iris 1.0.1/code2 on an ARM64 Android 37.2 emulator with 16 KiB pages retains the existing wallet, native identities, pending invoice, recovery phrase, unit preference and signing address. Fingerprint/PIN, BIP-322, Settings, Connected apps, witness receive, fresh import and no-lock creation pass. Mobile wallets are unfunded. |

The Android update baseline reconstructs the distributed application's exact source and recovered SDK/native inputs. The original uploaded AAB was deleted. This is not evidence of testing the original bundle, Google Play delivery or Play App Signing. Installed iOS acceptance and additional app evidence are maintained in [Iris PR #11](https://github.com/UTEXO-Protocol/utexo-mobile/pull/11), independently of the SDK's platform-build receipts.

The [RC4 fixture guide](qualification/rc4/README.md) records runner sources, locked independent issuer dependencies, phases and recovery rules. Tests use isolated Regtest, protocol-1.0 proxy and Anvil services. No shared stack or pre-existing app wallet was reset.

## Remaining release and integration limits

- **Upstream and publication.** Obtain #138 review/merge, verify the accepted source, and rebuild if the pin or native inputs change. Final package admission, required SDK approvals and authorized publication remain separate steps. A normal merge preserves native-producer ancestry.
- **Dependency findings.** The unmodified graph retains the disclosed Esplora TLS findings and chrono/YAML maintenance warnings. Current audits and the accepted disposition are recorded in [DEPENDENCY-POLICY.md](DEPENDENCY-POLICY.md). A functional test pass is not a clean native security audit.
- **Hosted settlement.** Local fixture mint/burn/proof tests do not establish hosted gateway/TEE behavior, EVM redemption or payouts on external networks. Deployment metadata, gateway, signer, proxy and contracts must be qualified together. The npm pack contains no deployment-specific USDT export or asset metadata.
- **Recovery.** A seed restores keys and discoverable Bitcoin history, not missing RGB consignments, allocations or operation journals. Preserve the complete wallet directory. Automatic VSS restore and legacy 2.x wallet conversion are not provided.
- **Native behavior.** Cancellation follows stock upstream retention/proxy-loss semantics. BFA, assetless and progressed invoices remain excluded. Stock Electrum may rebroadcast identical signed bytes; WDK keeps the original operation identity and will not construct a replacement transfer during recovery. Ambiguous signed inputs remain reserved.
- **Supported features.** Mainnet NIA/CFA are supported; Mainnet BFA is not enabled. Contract registration excludes external media attachments and duplicates do not prove validation of newly supplied bytes. These limits are described in the [integration guide](CANDIDATE.md).
- **Application acceptance.** Build/ABI checks do not qualify every mobile architecture on a real device. Funded mobile release, physical devices and genuine hosted settlement require their own evidence. Iris's registry dependency update follows SDK publication and is tested separately.

## Retained baseline and historical evidence

[RC3 baseline identities](qualification/rc3/README.md) and its platform receipt remain here because the RC4 upgrade tests depend on those exact older inputs. Historical results do not qualify a different package or binary.

Superseded qualification receipts remain available at immutable commit `a6dd195b3988b6fccd70dce9a66c2577ac368853`:

- [Alpha.24](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/alpha24): initial unmodified BFA.8, ordinary transfers, real-expiry cancellation and proxy-retention tests.
- [RC1](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc1): cross-proxy transfers, early release assembly and Core/BTC tests.
- [RC2](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc2): invoice-scoped mint verification and proof rejection/recovery.
- [Earlier RC3 runs](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc3) and [older alpha history](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/a6dd195b3988b6fccd70dce9a66c2577ac368853/QUALIFICATION.md): original sources, APKs and limitations, including previously patched builds.
