# Fresh-wallet release qualification

These runners qualify the complete packed SDK against merged, unmodified RGB-Tools source `f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d`. They do not use the legacy BFA metadata repair in #138 or claim upgrades from an older BFA database.

## Exact packages

The funded qualification archive is `64b27875903f9c0ff7f792bc65293052755efb55e91a51964b08331651ca74ab`, built from `c1093ff80e2987110d873034439d241a0f8cfeaa`. Its [independent admission](complete-pack-independent-audit.json), [funded receipt](funded-release.json) and [financial reconciliation](financial-release.json) retain that identity.

The prepared release archive is `f0ecf049ca0b108d3338d4be2e360439029ac67ed196f0a0f7c680c9fe57e1f9`, built from `16d0e23a32495c738b6689bf98e6e001a5b824ac`. It contains 48 files and all five Node and eleven Bare addons. [Final admission](final/complete-pack-independent-audit.json), [installed-file comparison](final/installed-consumer-files.json) and [runtime equivalence](final/funded-runtime-equivalence.json) establish its provenance. Forty-five files are byte-identical to the funded archive; the only changes are one README publication-status sentence and `publicationHold: false` in both native manifests. No financial operation is replayed to qualify that documentation/policy repack.

The [final package receipt](final/complete-pack.json) records the local npm publication dry-run, archive integrity and actual Node 22/24/26 concurrency acceptance. To repeat offline concurrency with a clean installed package:

```sh
node final/concurrency/run.mjs /absolute/consumer/node_modules/@utexo/wdk-wallet-rgb /absolute/new-output.json /absolute/utexo-wdk-wallet-rgb-3.0.0-rc.4.tgz
```

Each invocation creates four disposable wallets and removes them after awaited shutdown. It verifies independent native execution, directory ownership, BIP-322, partial shutdown and reopening. It performs no financial operation. The release archive has not been published; a local npm dry-run does not establish registry authentication or server acceptance.

The [current dependency audit](dependency-audit-summary.json) records the exact npm and Rust lock hashes and the merged RGB source. The locks are byte-identical to the preceding Node-addon candidate; the same seven documented upstream TLS findings remain and npm production audit reports zero findings.

For final-pack recovery, copy `final/final-recovery.mjs`, `final/verify-funded-final.py` and `final/record-evidence.py` into the original private funded-run directory alongside its `result.json`, `private-state.json`, `local_fixture.py` and `packed-peer.mjs`. Do not run them directly in this committed evidence directory. With the original funded results intact, run:

```sh
python3 verify-funded-final.py /absolute/qualification-archive.tgz /absolute/final-archive.tgz
node final-recovery.mjs /absolute/final-consumer /absolute/final-archive.tgz /absolute/final-release-verification.json
```

Keep the fixture and Bare environment variables from the funded invocation. The first command checks exact archive equivalence; the second verifies the final consumer, reopens the funded wallets, recovers the original operations and creates two additional disposable unfunded wallets. It does not replay a send, mint or burn. After both real-expiry cancellation runs finish, `record-evidence.py` writes sanitized receipts. Private state, keys and raw proofs must remain outside Git.

The [final recovery receipt](final/final-packed-recovery.json) records unchanged funded balances, metadata and identities, recovery of the original sends and burn proofs, and successful fresh contract registration/restart with no allocations.

Iris independently qualifies the same archive in its [actual Android APK/AAB and iOS Simulator Release builds](https://github.com/UTEXO-Protocol/utexo-mobile/blob/458c0daadb2227462fca605d0297e1bb45641d71/docs/engineering/native-candidates/onchain-rc4-dev/first-release-app-acceptance.json). That receipt records native/source/signing identities and fresh creation/import, PIN, signing, asset registration and restart. Those mobile wallets were unfunded; the financial receipts here remain local Node/Bare fixture evidence rather than hosted or mobile settlement acceptance.

## Funded local operations

The owned services are the pre-existing `wdk_contract_upgrade_20261127` Regtest/Anvil fixture. Only this run's new issuer, asset and wallet directories are opened. Earlier wallets and issuer state are untouched. The new issuer is compiled from independently pinned public RGB source `567e5b8`; the issuer and proof inspector are external counterparties, not replacements for the packed WDK binaries.

Place these runners together in a new private qualification directory. Point them at the independently prepared owned fixture and the qualified Bare/proof-inspector executables with explicit environment variables; their source directory does not need any particular parent layout. `local_fixture.py setup` creates and funds the new issuer only. Record the existing bridge backing in `backing-before.json` before minting. Install the exact new SDK archive in a separate consumer with dependency scripts disabled, then run:

```sh
export WDK_FRESH_FIXTURE_ROOT=/absolute/owned-fixture
export WDK_BARE_EXECUTABLE=/absolute/bare-1.37.1
export WDK_PROOF_INSPECTOR=/absolute/qualified-contract-inspect
node qualify.mjs /absolute/consumer /absolute/consumer/node_modules/@utexo/wdk-wallet-rgb/prebuilds/darwin-arm64/utexo-rgb-native.node /absolute/platforms.json /absolute/utexo-wdk-wallet-rgb-3.0.0-rc.4.tgz PACKAGE_SOURCE_COMMIT /absolute/release-verification.json
python3 audit.py
```

The fixture root must contain `fixture.py`, its digest-pinned `compose.yaml` named `wdk_contract_upgrade_20261127`, deployed contracts, and the original independent issuer executable at the path declared by that helper. Ports are Bitcoin 48443, Electrum 48001, proxy 48090 and Anvil 48545, all loopback. The old fixture helper is retained from the recorded qualification source; it writes only the new runner directory’s `issuer-fixture` when loaded by `local_fixture.py`.

The runner checks every installed archive file, source pin and both admitted native hashes before touching money. It creates sender and receiver wallets in both Node and Bare, funds them, creates RGB outputs, verifies BIP-322, imports/exports the exact public contract without allocating funds, checks a received mint before paying its EVM lock, and receives the confirmed allocation. It performs Bitcoin and BFA transfers plus new NIA/CFA issuance and transfers. Active ordinary invoices and BFA invoices cannot be cancelled.

Each runtime burns through all five supported destination routes. The first burn deliberately loses its successful native response. The original operation ID retrieves its proof, repeated mutation calls are rejected, and every burn proof remains identical after complete process restart. Other transfers are recovered under their original identities. A seed imported into a new directory discovers Bitcoin funds and the same signing identity; it does not pretend that seed words alone reconstruct private RGB state.

The independent audit decodes exact saved proofs with the separate upstream inspector, checks Bitcoin confirmations/fees/commitments, reconstructs V1 destination commitments with Foundry, verifies Tron encoding, checks NIA/CFA issuance and transfer conservation, and reconciles BFA mint locks, backing and burned amounts.

The state marker is one-shot. On interruption, inspect the saved operation journals and chain receipts; do not delete the marker or replay financial phases under new IDs. Private state, seeds, raw proofs and wallet directories stay outside Git. Only runner sources and sanitized acceptance receipts belong in the PR.

This scope is funded Node/Bare Darwin ARM64 on local Regtest/Anvil. It does not establish hosted gateway/TEE or EVM payout acceptance, mobile execution, physical devices or seed-only RGB recovery. This main funded run checks refusal of active/unsupported cancellations; the separate real-expiry cases below also pass.

## Real expiry cancellation

`qualify-stock-cancellation.mjs` is a qualification copy of the SDK runner. `prepare` creates new NIA/CFA invoices and exits, and `finish` reopens them after the real one-hour expiry plus upstream's five-minute margin. Node and Bare use separate output directories so their expiry clocks can overlap platform compilation. No device clock or wallet row is edited.

The early Node-only pack has no Bare targets and retains Bare's release hold. The two-target Darwin pack admits only those two verified binaries. Both retain publication holds and are explicitly fixture packages, not complete distributions. The final cancellation acceptance uses the full sixteen-target package. `verify-pack-transition.py` first compares every retained runtime file and native binary, checks the complete target matrix against the final installed archive, and records the only permitted changes: independently admitted additional native targets, manifest publication/admission flags and documentation. If any executable source or retained binary differs, the transition fails and the final pack needs separate preparation; the harness never treats a failed equivalence check as permission to replay a mutation.

After recording that equivalence, `finish` verifies expired cancellation, exact recipient matching, the exclusion of arbitrary-asset receives, preservation of unrelated live invoices, release of blinded reservations, recovery after reopening, and one deliberately lost committed cancellation response per runtime.

The [combined final-package receipt](final/cancellation-release.json) records all eight passing NIA/CFA witness/blinded cases. Node completed at 09:54:25 UTC and Bare at 10:01:51 UTC on 2026-11-28, after the original expiry deadlines. `final/finish-cancellation.py` is the exact bounded waiter used in the private run directory; it requires the prepared `cancellation-node`/`cancellation-bare` receipts and fixture files plus the admitted `final-consumer`. It refuses an existing finish log or completed phase instead of replaying it. Copy it alongside the other private runners when reproducing a new run, and verify the scoped-to-final archive transition before starting it.
