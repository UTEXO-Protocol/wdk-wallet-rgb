# On-chain RGB native qualification worker

This directory contains the watch-only RGB engine and its host adapters. Node launches the worker over private pipes. Bare loads an in-process Electrum-only addon on a dedicated JS worker thread. The host owns transaction authorization, the signer and the durable operation journal. See [Bare build and qualification](bare/README.md) for that profile.

The exact private source base is [rgb-lib-bfa BFA.5](https://github.com/UTEXO-Protocol/rgb-lib-bfa/releases/tag/v0.3.0-beta.7-upstream-dev-bfa.5), commit `0a9d352f2690902df2b6fae9bca1a6c13c3354d4`, base tree `5b54078be8e447f7959359b10dfb393649ab9840`. The local candidate patch registers a validated genesis-only contract using the narrow part of [RGB #4](https://github.com/UTEXO-Protocol/rgb-lib-bfa/pull/4) and applies full mint conservation from [RGB #8](https://github.com/UTEXO-Protocol/rgb-lib-bfa/pull/8) with checked addition to both receive paths. The overlay carries only the on-chain changes needed by this engine. The resulting Git tree is `be8930be04b8d65a704333fe7c215ba1f2186c35`. The functional patches are `patches/rgb-lib-bfa.5-onchain.patch`, `patches/rgb-lib-bfa.5-public-signet.patch`, `patches/rgb-lib-bfa.5-native-egress.patch` and `patches/rgb-lib-bfa.5-staging-evm-egress.patch`. Public networks require HTTPS for peer proxy, issuer reject-list and EVM RPC requests. The shared HTTP connector rejects non-public literals and DNS answers, disables redirects, environment proxies and transport retries, and preserves loopback endpoints for Regtest. The private source checkout stays under the ignored build-only `.sources` directory.

## Build

Run these commands from this `native/` directory with Rust 1.94.0. The first build needs authorized GitHub read access to the UTEXO BFA source and its pinned private mirrors (the mirror commit identities match the private sources named by BFA.5). The preparation script uses the local `gh` credential helper. The same commit and tree checks admit a local Git directory via an optional path argument. Build credentials stay with the authorized builder. Consumer installs use the packed artifact.

```sh
python3 scripts/prepare-source.py --bare
env CARGO_NET_GIT_FETCH_WITH_CLI=true \
  GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0='' \
  GIT_CONFIG_KEY_1=credential.helper 'GIT_CONFIG_VALUE_1=!gh auth git-credential' \
  cargo +1.94.0 build --release --locked
python3 scripts/prepare-source.py --bare
shasum -a 256 Cargo.lock target/release/utexo-rgb-native
cargo +1.94.0 test --release --offline --locked
python3 scripts/check-mint-conservation.py
```

Format only the owned adapter source with `rustfmt +1.94.0 --edition 2024 src/main.rs`. Cargo formatting with `--all` would also format the prepared upstream path dependency, invalidating its exact tree.

## IPC and safety model

A request is one bounded UTF-8 JSON line such as `{"id":"r1","method":"version","params":{}}`. The response contains the same `id` and exactly one of `result` or `error:{code,message}`. Fields named amount, fee rate, size, timestamp and EVM chain ID use canonical decimal strings. Transfer IDs, vouts, counts and confirmation policies are bounded integers.

- `open` takes `{dataDir,network,accountXpubVanilla,accountXpubColored,masterFingerprint,mode?}`. The private 0700 directory stores an identity marker and an exclusive 0600 file lock. The BIP-86 wallet opens watch-only. The app cannot reuse an RLN directory.
- `goOnline` takes `{indexerUrl,evmRpcUrls?,proxyAuthKeys?}` and requires a compatible Electrum endpoint. Wallet consistency checks stay enabled. Proxy authentication is distinct from the recipient invoice public key. The worker does not return credentials or raw upstream errors. Native wallet logs remain local to its app-private directory.
- Read methods include `getBtcBalance`, `getAssetBalance`, `getAssetMetadata`, `listAssets`, `listTransactions`, `listUnspents`, `listTransfers`, `getFeeRate`, `decodeInvoice`, `getReceivedMint`, and the configured endpoint and tip checks. Offline BTC reads use locally cached history. `getAddress` allocates the next receive index. `refresh` reports results of pending transfer progression.
- `bindJournal` and `writeJournalRecord` handle both SDK journal scopes while the native worker owns the wallet lock. Records are bounded, written to a private staging file, synced and atomically renamed. A worker that loses the lock can no longer persist an operation.
- `importContract({contractBase64,expectedAssetId,sha256})` verifies the bounded bytes and contract ID, schema and network before storing only validated genesis. It creates no asset balance. `blindReceive` and `witnessReceive` take exact optional amount and asset, proxy endpoint list, expiry and confirmation floor.
- `createUtxosBegin({count,size,feeRate})`, `sendBtcBegin({address,amount,feeRate})`, `sendRgbBegin({invoice,assetId,amount,feeRate,minConfirmations,expirationTimestamp,senderTransportEndpoint,witnessAmountSat?})` and `burnBegin({assetId,amount,feeRate,minConfirmations,commitment})` prepare a PSBT and fixed txid. `burnBegin` independently inspects the committed RGB transition's asset, amount and reason. RGB send admits the sender's explicitly configured proxy. A matching `*End({signedPsbt})` accepts exactly the prepared PSBT with one final 64-byte key-path witness added per input, consumes its authority before the native call, and never automatically retries it.
- `discardPrepared({txid})` only admits the exact still-unsigned PSBT of this live worker. `snapshotUnsigned` records the baseline before Begin. `discardUnsubmitted` reconciles an exact unsigned BTC, output, RGB send or burn reservation after interruption, including loss of the Begin response. The host must establish that submission never began before invoking it. Unknown cleanup outcomes stay blocked for reconciliation.
- `getConsignment({assetId,txid,commitment,amount?})` reads a capped byte buffer only for a wallet-owned, committed Burn record, then independently inspects the exact copied bytes for the matching BFA transition. It returns base64, SHA-256, asset ID, txid, reason and amount. Bitcoin confirmation and EVM payout verification occur separately.
- `close` drops the native wallet and then the exclusive lock. After a crash, fresh reads and reconciliation establish the result of a submitted operation.

The tracked fixture is a synthetic Regtest asset issued independently against the pinned RGB source. The default native tests validate the exact admitted contract and reject malformed bytes without registration. See [contract fixture scope](tests/fixtures/README.md) for hosted compatibility evidence and release requirements.

## Artifact review

Commit the source, patches and both Cargo lockfiles. Rebuild on an authorized host with the documented toolchain and verify the selected target and locked graph. Stage the independently reviewed addon using `node scripts/stage-bare.mjs <built-addon>` from the repository root. Then run `node scripts/check-candidate-pack.mjs --require-native` and exercise the exact tarball on each supported runtime. The private source checkout, build outputs, fixture runtime, wallet data and credentials belong outside the package.

The PR workflow validates Node tests, public types, runtime npm dependencies and the source-only package inventory. Native build and device evidence must be supplied separately because the pinned upstream source is private. Publication requires a separate reviewed workflow. A source build on a different compiler, SDK or absolute build path may produce a different digest, so validate and record that artifact before packing.

Run `python3 scripts/record-candidate-build.py --worker <worker> --addon <addon> --tarball <pack> --apk <apk>` from the SDK root after committing the artifact manifest. The record includes the source tree, lock and overlay digests, runtime license metadata and build artifact hashes. It compares the Android addon bytes across the standalone build, npm tarball and APK. Treat the license inventory as input to redistribution review. For a byte-identical package comparison, use the same npm version and extract the clean Git archive with umask `022` inside a private directory. npm includes file permission bits in the tarball.

Both candidate adapters use the same Electrum-only graph and protocol version 2. The Node executable and Android addon require separate runtime qualification. The earlier multi-indexer Node artifact is outside this candidate profile.
