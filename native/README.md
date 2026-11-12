# On-chain RGB native qualification worker

This directory contains the watch-only RGB engine and its host adapters. Node launches the worker over private pipes. Bare loads an in-process addon on a dedicated JS worker thread. The host owns transaction authorization, the signer and the durable operation journal. See [Bare build and qualification](bare/README.md) for that profile.

Native builds are on hold pending [upstream RGB safeguards](../QUALIFICATION.md#upstream-requirements-for-an-unpatched-build). The [source preparation script](scripts/prepare-source.py) can verify the unmodified [BFA.8](https://github.com/UTEXO-Protocol/rgb-lib-bfa/releases/tag/v0.3.0-beta.7-upstream-dev-bfa.8) source with `--rgb-source-only`. It checks commit `2f7b21d8637baad548504ea870deb2c0d4d0a37d` and tree `5492824f3cf47b4c821dfca8b7a63fed27858486`. Normal source preparation and native packaging stop at the hold. The adapter calls and test fixtures below are retained for requalification when upstream provides the required APIs. The former patched build is recorded in the [alpha.23 qualification](../QUALIFICATION.md#alpha23-bfa8-historical-patched-candidate).

Proxy expiry values must fit the receiver's locally recorded invoice window and checked retention arithmetic. Invalid values, malformed acknowledgement replies and ambiguous released-transaction results retain pending state and output reservations. Old poisoned or missing broadcast deadlines cannot overflow or free an output early. Recovery can repeat the same signed acknowledgement or rebroadcast the exact saved transaction; it does not prepare a new payment. Valid deadlines keep their original skew, grace and expiry boundaries. This uses the existing database transaction, so it does not close the inherited process-death window between remote acknowledgement acceptance and local commit.

Run `python3 scripts/check-proxy-deadline.py` from this directory to test the exact admitted policy and the real proxy/SQLite paths. The fixture uses disposable source copies with distinct Cargo package identities and loopback HTTP. Its test-only module is excluded from production native binaries.

The patched Electrum client checks genesis and the relevant Signet checkpoint on each actual socket, including the two separate sockets used for wallet sync and RGB validation. A transport error allows one checked replacement and retry for read-only RPCs. A broadcast is transmitted once per call. The wallet keeps the existing operation identity and signed bytes for reconciliation.

Run `cargo +1.94.0 test --release --offline --locked --test electrum_checked_reconnect` after source preparation to exercise socket loss, chain mismatch and ambiguous broadcast responses.

## Dev checkpoint candidate

The Dev profile selects `https://dev.esplora-01.mint.utexo.com`. The wallet
indexer and RGB witness resolver each check Signet genesis and Dev block one
(`0000001b808e4ece11c0cd922eaf9eee8d7dfba7e23e90b4f9614248daaf72cb`).
The blocking Esplora transport uses the pinned reqwest stack, with redirects
and automatic retries disabled for Dev. Alpha.14 enables the exact Dev service policy for manual hosted testing. Alpha.13 retains its closed policy and existing qualification. The earlier alpha.10 APK used BFA.5 and its matching BUSDT export.

The loopback matrix checks the historical Dev and public Signet headers. Run it after preparing the pinned Bare RGB source. The separate offline compatibility test checks that the exact BFA.5 Dev BUSDT export is rejected by the BFA.7 candidate.

```sh
env MACOSX_DEPLOYMENT_TARGET=11.0 CARGO_TARGET_DIR="$PWD/target/dev-signet-host" \
  python3 scripts/check-dev-signet.py
UTEXO_DEV_BUSDT_CONTRACT=/absolute/path/to/Dev-BUSDT-genesis-e2e-41698713237.rgb \
  cargo +1.94.0 test --release --offline --locked recovered_bfa5_dev_busdt_is_rejected_offline -- --ignored
UTEXO_DEV_BFA6_GENESIS_CONTRACT=/absolute/path/to/dev-busdt-a6-bfa7-genesis-con1.rgb \
  cargo +1.94.0 test --release --offline --locked dev_busdt_registers_idempotently_in_the_offline_dev_profile -- --ignored
```

## Build

Run these commands from this `native/` directory with Rust 1.94.0. The first build needs authorized GitHub read access to the UTEXO BFA source and the pinned dependency revisions. The preparation script uses the local `gh` credential helper. The same commit and tree checks admit a local Git directory via an optional path argument. It also verifies the Electrum and Esplora client crate SHA-256 digests and patched trees. Build credentials stay with the authorized builder. Consumer installs use the packed artifact.

```sh
python3 scripts/prepare-source.py --bare
env CARGO_NET_GIT_FETCH_WITH_CLI=true \
  GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0='' \
  GIT_CONFIG_KEY_1=credential.helper 'GIT_CONFIG_VALUE_1=!gh auth git-credential' \
  cargo +1.94.0 build --release --locked
python3 scripts/prepare-source.py --bare
shasum -a 256 Cargo.lock target/release/utexo-rgb-native
cargo +1.94.0 test --release --offline --locked
```

Format only the owned adapter source with `rustfmt +1.94.0 --edition 2024 src/main.rs`. Cargo formatting with `--all` would also format the prepared upstream path dependency, invalidating its exact upstream tree.

## IPC and safety model

A request is one bounded UTF-8 JSON line such as `{"id":"r1","method":"version","params":{}}`. The response contains the same `id` and exactly one of `result` or `error:{code,message}`. Fields named amount, fee rate, size, timestamp and EVM chain ID use canonical decimal strings. Transfer IDs, vouts, counts and confirmation policies are bounded integers.

- `open` takes `{dataDir,network,accountXpubVanilla,accountXpubColored,masterFingerprint,mode?,profile?,transportEndpoint?}`. Mainnet and the Public Signet RGB profile require an explicit mode. Ordinary RGB wallets supply one TLS proxy in `transportEndpoint`, which is bound to the wallet directory and attested in the response. The private 0700 directory stores an identity marker and an exclusive 0600 file lock. The BIP-86 wallet opens watch-only. The worker rejects older wallet directory identities before opening the database.
- `goOnline` takes `{indexerUrl,evmRpcUrls?,proxyAuthKeys?}` and requires the indexer protocol admitted by the wallet profile. Wallet consistency checks stay enabled. Proxy authentication is distinct from the recipient invoice public key. The worker does not return credentials or raw upstream errors. Native wallet logs remain local to its app-private directory.
- Read methods include `getBtcBalance`, `getAssetBalance`, `getAssetMetadata`, `listAssets`, `listTransactions`, `listUnspents`, `listTransfers`, `getFeeRate`, `decodeInvoice`, `getReceivedMint` with its distinct EVM `lockId`, and the configured endpoint and tip checks. Offline BTC reads use locally cached history. `getAddress` allocates the next receive index. `refresh` reports results of pending transfer progression.
- `bindJournal` and `writeJournalRecord` handle both SDK journal scopes while the native worker owns the wallet lock. Records are bounded, written to a private staging file, synced and atomically renamed. A worker that loses the lock can no longer persist an operation.
- `importContract({contractBase64,expectedAssetId,sha256})` verifies the bounded bytes and contract ID, schema and network before storing only validated genesis. It creates no asset balance. `blindReceive` and `witnessReceive` take exact optional amount and asset, proxy endpoint list, expiry and confirmation floor.
- `cancelReceiveInvoice({batchTransferIdx,recipientId})` requires a matching expired incoming batch and invoice. The wallet checks the colored indexer state, local transfer evidence, and the bound proxy’s clock and transfer list before releasing the reservation. A missing or pruned proxy record cannot establish that delivery was clear. The call never signs or broadcasts a transaction. A retry of the same eligible failed batch reports success.
- `issueAsset({operationId,schema,name,ticker?,details?,precision,amounts})` admits NIA and CFA on Mainnet RGB, Public Signet RGB and Regtest RGB. On the public networks, all potentially selectable outputs must be confirmed by the pinned Bitcoin resolver. Issuance uses existing allocation slots and needs neither a signed transaction nor a proxy connection. Before issuance, the native lock owner durably records the exact request and a committed issuance checkpoint. Recovery uses the committed transfer and matching contract metadata to recover the receipt after an interrupted response. The request ID binds to its original parameters.
- `createUtxosBegin({count,size,feeRate})`, `sendBtcBegin({address,amount,feeRate})`, `sendRgbBegin({invoice,assetId,amount,feeRate,minConfirmations,expirationTimestamp,senderTransportEndpoint,witnessAmountSat?})` and `burnBegin({assetId,amount,feeRate,minConfirmations,commitment})` prepare a PSBT and fixed txid. `burnBegin` independently inspects the committed RGB transition's asset, amount and reason. RGB send admits the sender's explicitly configured proxy. A matching `*End({signedPsbt})` accepts exactly the prepared PSBT with one final 64-byte key-path witness added per input, consumes its authority before the native call, and never automatically retries it.
- `discardPrepared({txid})` only admits the exact still-unsigned PSBT of this live worker. `snapshotUnsigned` records the baseline before Begin. `discardUnsubmitted` reconciles an exact unsigned BTC, output, RGB send or burn reservation after interruption, including loss of the Begin response. The host must establish that submission never began before invoking it. Unknown cleanup outcomes stay blocked for reconciliation.
- `getConsignment({assetId,txid,commitment,amount?})` reads a capped byte buffer only for a wallet-owned, committed Burn record, then independently inspects the exact copied bytes for the matching BFA transition. It returns base64, SHA-256, asset ID, txid, reason and amount. Bitcoin confirmation and EVM payout verification occur separately.
- `close` drops the native wallet and then the exclusive lock. After a crash, fresh reads and reconciliation establish the result of a submitted operation.

The tracked fixture is a synthetic Regtest asset issued independently against the pinned RGB source. The default native tests validate the exact admitted contract and reject malformed bytes without registration. See [contract fixture scope](tests/fixtures/README.md) for hosted compatibility evidence and release requirements.

## Artifact review

Build from a committed checkout with the locked graph on an authorized host. The build and execution checks have separate scopes.

| Runtime | Build targets | Command from the repository root |
| --- | --- | --- |
| Node worker | macOS ARM64 and x64, Linux glibc ARM64 and x64, Linux musl x64 | `node native/scripts/node-host.mjs build <target> <new-output-directory>` |
| Desktop Bare | macOS ARM64 and x64, Linux glibc ARM64 and x64 | `bash native/scripts/build-bare.sh` on the target host |
| Android Bare | ARM64, ARMv7, x64 and x86 | `bash native/scripts/build-bare-android.sh <version> <target>` |
| iOS Bare | ARM64 device, ARM64 and x64 simulator | `bash native/scripts/build-bare-ios.sh <target>` |

The Node build command executes an offline wallet smoke test on the target host and records the worker hash. Consumers pass that worker's canonical absolute path and SHA-256. Android verification takes the addon, a matching Bare Kit library, the version and the target. The iOS build checks the raw Mach-O slice. Verify the linked and signed app framework separately.

After independent review, record each Bare addon hash and byte count in `src/onchain-bare-native.json`. Stage it with `node scripts/stage-bare.mjs <built-addon> <target>`. Use `node scripts/check-candidate-pack.mjs --require-native` to check the exact pinned inventory, or `--require-all-targets` to require the full Bare matrix. Pack with `npm pack --ignore-scripts` and exercise the tarball on the target runtimes. Keep Node workers, private source, build outputs, fixture data, deployment asset metadata, qualification evidence and credentials outside the npm package.

The PR workflow validates Node tests, public types, runtime npm dependencies and the source-only package inventory. Native build and device evidence must be supplied separately because the pinned upstream source is private. Publication requires a separate reviewed workflow. A source build on a different compiler, SDK or absolute build path may produce a different digest, so validate and record that artifact before packing.

Run `python3 scripts/record-candidate-build.py --worker <worker> --addon <addon> --tarball <pack> --apk <apk>` from the SDK root after committing the artifact manifest. The record includes the source tree, lock and overlay digests, runtime license metadata and build artifact hashes. It compares the Android addon bytes across the standalone build, npm tarball and APK. Treat the license inventory as input to redistribution review. For a byte-identical package comparison, use the same npm version and extract the clean Git archive with umask `022` inside a private directory. npm includes file permission bits in the tarball.

Both candidate adapters use the same locked Electrum and Dev Esplora graph and protocol version 2. The Node executable and Android addon require separate runtime qualification.
