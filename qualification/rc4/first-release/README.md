# Fresh-wallet release qualification

These runners qualify the complete packed SDK against merged, unmodified RGB-Tools source `f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d`. They do not use the legacy BFA metadata repair in #138 or claim upgrades from an older BFA database.

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

This scope is funded Node/Bare Darwin ARM64 on local Regtest/Anvil. It does not establish hosted gateway/TEE or EVM payout acceptance, mobile execution, physical devices or seed-only RGB recovery. Expired ordinary cancellation has its own native regressions; this funded run checks refusal of active/unsupported cancellations.

## Real expiry cancellation

`qualify-stock-cancellation.mjs` is a qualification copy of the SDK runner. `prepare` creates new NIA/CFA invoices and exits, and `finish` reopens them after the real one-hour expiry plus upstream's five-minute margin. Node and Bare use separate output directories so their expiry clocks can overlap platform compilation. No device clock or wallet row is edited.

The early Node-only pack has no Bare targets and retains Bare's release hold. The two-target Darwin pack admits only those two verified binaries. Both retain publication holds and are explicitly fixture packages, not complete distributions. The final cancellation acceptance uses the full sixteen-target package. `verify-pack-transition.py` first compares every retained runtime file and native binary, checks the complete target matrix against the final installed archive, and records the only permitted changes: independently admitted additional native targets, manifest publication/admission flags and documentation. If any executable source or retained binary differs, the transition fails and the final pack needs separate preparation; the harness never treats a failed equivalence check as permission to replay a mutation.

After recording that equivalence, `finish` verifies expired cancellation, exact recipient matching, the exclusion of arbitrary-asset receives, preservation of unrelated live invoices, release of blinded reservations, recovery after reopening, and one deliberately lost committed cancellation response per runtime.
