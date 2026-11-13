# On-chain RGB native worker

The watch-only engine is shared by the Node pipe worker and the Bare addon. The application owns the seed, transaction review and signer. Native code receives public account keys and an exact signed PSBT after approval.

The build uses unmodified BFA.8 commit `2f7b21d8637baad548504ea870deb2c0d4d0a37d`, tree `5492824f3cf47b4c821dfca8b7a63fed27858486`. Electrum 0.25.2 and Esplora 0.12.3 are registry sources with Cargo checksums. There are no downstream RGB or client source patches. The RGB protocol crates retain the exact source revisions required by BFA.8. The legacy manifest fields `overlayTree` and `integrationTree` now both identify the unmodified upstream tree.

## Build and test

Use a clean, committed repository checkout, Rust 1.94.0, and an authorized source clone or authenticated GitHub CLI (`gh`). Preparation uses `gh auth git-credential` when fetching the private source. Consumer installs do not fetch private source or run Rust builds.

Run from the repository root on the target architecture. Supported Node targets are `darwin-arm64`, `darwin-x64`, `linux-arm64-gnu`, `linux-x64-gnu` and `linux-x64-musl`. macOS requires Xcode command-line tools. Linux requires a C compiler, binutils and build tools; build the musl target inside a musl userland, as the CI workflow does.

```sh
npm ci --ignore-scripts --no-audit
python3 native/scripts/prepare-source.py --bare

# Replace the target with your current host and use a new absolute output directory.
node native/scripts/node-host.mjs build linux-x64-gnu /absolute/path/to/new-build-output
bash scripts/qualify-desktop.sh node linux-x64-gnu /absolute/path/to/new-build-output

cargo +1.94.0 test --manifest-path native/Cargo.toml --release --locked
python3 native/scripts/check-dev-signet.py
```

The preparation script verifies the exact upstream commit, tree, index, working files and untracked files. It can accept a local Git directory as its final argument. The qualifier packs an archive of the committed source and installs it into a separate consumer, then tests the exact worker, its source/hash admission and lifecycle. The worker, tested package, build receipt and logs remain in the output directory. Supply the worker's absolute path and SHA-256 through `nativeExecutable` and `nativeSha256`; Node workers are distributed separately from the JavaScript package. The supported matrix is in [CI](../.github/workflows/build.yml) and the [Bare runbook](bare/README.md).

Format only owned source with `rustfmt +1.94.0 --edition 2024 native/src/main.rs`. Do not run formatting across the prepared upstream path dependency.

## Network and operation boundaries

Mainnet RGB, Regtest RGB, and Public, Dev and staging Signet RGB admit NIA/CFA issuance. BTC-only mode excludes RGB operations. Every non-Regtest issuance checks consistency and confirmed allocation outputs. Its durable intent and receipt recover the original issued asset after interrupted result delivery.

Dev uses stock `IndexerConfig::Esplora` at the configured HTTPS endpoint. WDK checks the chain genesis and selected Signet block-one checkpoint before connection and online operation boundaries. Stock RGB performs its own genesis/protocol checks. The WDK check does not attest every internal resolver or reconnect socket. Input URL validation and the proxy probe remain in WDK; peer and issuer URLs opened internally follow stock RGB policy.

Stock Electrum may reconnect and resend an RPC with identical arguments. A repeated broadcast contains the same transaction bytes, not a newly signed payment. SDK recovery uses the original operation ID and transaction ID. Read reconnect, bounded retry and identical-byte broadcast behavior are covered by the local transport tests.

Each native worker exclusively locks a private wallet directory. Journal writes are identity-bound, bounded, synced and atomically promoted. The signer checks amounts, fee, destinations, key origins, input roles and exact PSBT identity. BTC and output-creation transactions cannot use colored inputs.

Before an RGB send or burn reaches native `End`, WDK persists its exposed input set. Later plans cannot reuse those inputs even if stock RGB marks the old transfer failed. Issuance and blinded receive also refuse a stock allocation candidate whose input remains exposed. Witness receive does not allocate an existing colored output. These reservations do not reconstruct RGB data lost with a wallet directory.

## Receive cancellation and contract registration

`cancelReceiveInvoice` identifies one expired NIA/CFA receive by batch index and recipient. It verifies the stored invoice, network, schema, expiry and absence of delivery evidence, refreshes incoming transfers for that asset, then revalidates and invokes stock transactional `fail_transfers` only for the requested batch. The result is reread. Active, BFA, assetless and progressed invoices are excluded. The same already-failed eligible batch can be acknowledged after restart. No transaction is signed or broadcast.

Cancellation uses BFA.8's retention and proxy-loss rules. It does not preserve the removed patch's stronger requirement for authenticated proof of an empty proxy record. Display eligibility is only an observation; the mutation checks current state again.

Stock BFA.8 has no public standalone contract registration API. `importContract` checks its bounded byte envelope and SHA-256, then returns `CONTRACT_IMPORT_UNAVAILABLE` without changing RGB state. No fake transfer, outpoint or private database write substitutes for it. This affects preregistering Iris's USDT contract, not wallet opening, NIA/CFA issuance or receipt through a real transfer. Track [RGB-Tools #103](https://github.com/RGB-Tools/rgb-lib/pull/103) and a BFA-compatible port separately.

## Recovery and qualification

Proof export verifies the saved burn consignment against the requested asset, transaction, amount and V1 destination commitment. Recovery reads the original committed proof; it never invokes burn again. A seed alone restores keys, not missing RGB proofs or operation journals. Retain complete wallet state for RGB recovery.

Stock RGB installs a global panic hook capturing its logger and the previous hook. Dropping the wallet's logger guard ends its logging thread, but hook allocations can accumulate. The Bare addon does not race the host by replacing its global hook. Teardown/reopen acceptance is required on the actual packed runtime.

See [QUALIFICATION.md](../QUALIFICATION.md) for completed scopes, exact artifact identities and pending platform or funded acceptance. Historical patched binaries are not evidence for this build.
