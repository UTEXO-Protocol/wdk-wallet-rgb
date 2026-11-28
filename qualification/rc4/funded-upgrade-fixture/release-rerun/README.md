# RC4 URL-parser rebuild: funded regression fixture

These runners qualify the complete RC4 package rebuilt with `url 2.5.9` and `form_urlencoded 1.2.3`. The RGB source and SDK runtime are unchanged. The fixture uses the public upstream issuer and services described in the parent funded-upgrade fixture; it does not introduce another RGB source patch or hosted integration.

## Execution layout

Restore the parent fixture into a private qualification root `Q`, following the [RC4 fixture guide](../../README.md). Retain the original `fixture/packed-upgrade/` wallets, public evidence and private state; the old RC3 package/consumer/native artifacts under `baseline/`; the original RC4 consumer under `fixture/packed-upgrade/final-consumer/`; and the original RC4 Node worker under `rc4-artifacts/`. The existing issuer binary and proof inspector are built from the parent's locked source under `upstream-upgrade-audit/target/debug/`.

Copy these five files into `Q/release-preparation/funded-rerun/`. The Python helper reuses `Q/fixture/fixture.py` and its owned services but creates a separate issuer state and BFA asset. It copies only the local deployment's public addresses. Original issuer keys and wallet state are not copied or reset.

From `Q`:

```sh
python3 release-preparation/funded-rerun/local_fixture.py setup
node release-preparation/funded-rerun/qualify.mjs snapshot \
  fixture/packed-upgrade/final-consumer \
  rc4-artifacts/node-darwin-arm64/utexo-rgb-native
node release-preparation/funded-rerun/qualify.mjs prepare-rc3 \
  baseline/packed-consumer \
  baseline/artifacts/node-darwin-arm64/utexo-rgb-native
```

Install the complete rebuilt SDK tarball into a new private consumer using `npm install --ignore-scripts`. Then run:

```sh
node release-preparation/funded-rerun/qualify.mjs run \
  /absolute/new-consumer /absolute/new-node-worker \
  /absolute/platforms.json /absolute/package.tgz
python3 release-preparation/funded-rerun/audit.py
```

The run checks every installed archive file and both native binary hashes against the admitted matrix. New financial operations always use a fresh persisted prefix. A phase with an existing marker cannot be restarted. If interrupted, reconcile its recorded operation before making any further financial call; do not delete markers, reset wallets or invent replacement requests.

## Verified scopes

- Six retained RC4 wallets reopen with unchanged keys, balances, metadata, every transfer field and original proofs.
- Two newly funded exact-RC3 wallets each hold a genuine mint, burn/proof, NIA/CFA assets and a live pending blinded invoice. Direct upgrade compares all those fields and retrieves the original invoice without a new allocation or approval. A new process then reopens the wallet and recovers its proof.
- Actual new-pack Node and Bare execution covers fresh contract registration/export and mint, BTC/NIA/CFA/BFA transfers, and all five configured V1 burn routes. The Arbitrum burn deliberately loses its successful native End response. Every route rejects a duplicate operation and recovers identical proof bytes after full process restart.
- The separate audit reads confirmed Bitcoin transactions and EVM lock calldata/receipts, decodes proofs using the original upstream inspector and reconstructs each destination commitment with Foundry. Tron address bytes and checksum are independently decoded in Python.

Arbitrum uses `42161/0`, Ethereum `1/30101`, Polygon `137/30109`, Plasma `9745/30383` and Tron `728126428/30420`. These are explicit fixture routes, not a claim of current hosted payout availability. Four new mints total 6 units; twelve burns total 1.28 (two old-RC3 baseline burns and ten new route burns); the four new wallets retain 4.72. The earlier fixture's separate asset retains 14.5 units. No EVM burn redemption is performed.

Only the sanitized receipts and runner source belong in Git. Generated seeds, `private-state.json`, `legacy-private.json`, issuer keys, native wallet directories, signed transactions and raw proof files remain private. This fixture establishes Darwin ARM64 host behavior; mobile, physical-device, public-network and hosted gateway/TEE acceptance have separate evidence.
