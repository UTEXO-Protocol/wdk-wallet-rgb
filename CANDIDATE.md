# On-chain WDK candidate

The private `@utexo/wdk-wallet-rgb@2.1.0-alpha.2` pack targets Android ARM64 Bare qualification. It runs the packaged Electrum-only addon on a dedicated worker thread. The earlier alpha.1 pack carries the macOS ARM64 addon. The Node entry uses the separate host executable from alpha.0. It uses a watch-only native RGB wallet. The app-owned signer holds only the derived signing keys, reviews the PSBT and actual miner fee, and adds Taproot witnesses after explicit authorization. The worker receives public account identity and signed PSBTs. Neither the package nor the worker links RLN or LDK.

| Component | Exact source or version |
| --- | --- |
| WDK starting source | `6d28bc9ff35a7863cd21b21e62a7c03a9b794066` |
| Android embedded runtime | Bare Kit `3.0.1` / Bare `1.36.0` |
| Bare headers | `1.35.0` |
| Tether WDK Wallet | `1.0.0-beta.25` |
| RGB library | `v0.3.0-beta.7-upstream-dev-bfa.5`, `0a9d352f2690902df2b6fae9bca1a6c13c3354d4` |
| Native local overlay | Git tree `5b7660a66d53da6a5935407bbaf21f7e73636f35` |
| Bare integration overlay | Git tree `8dd209a8bb849696e45f301b0ea1b3d4eb0fba06` |
| Signing dependencies | `@scure/btc-signer@2.4.1`, `@scure/bip32@2.4.0`, `@scure/base@2.4.0`, `@noble/hashes@2.4.0` |
| Fixture proxy | RGB Tools proxy server `v0.4.0`, protocol 1.0 |

The native overlay ports validated registration of a public contract from [RGB #4](https://github.com/UTEXO-Protocol/rgb-lib-bfa/pull/4) and checks that the recipient receives the entire mint amount in both validation paths, based on [RGB #8](https://github.com/UTEXO-Protocol/rgb-lib-bfa/pull/8). The BFA library, all private patches and transitive Rust dependencies are pinned. The native source preparation requires authorized read access to those repositories.

## Build and use

Build the Android addon and stage it against the exact candidate manifest from the candidate source workspace:

```sh
./native/scripts/build-bare-android.sh
cd wdk-wallet-rgb
npm ci --ignore-scripts
npm test
npm run check:types
node scripts/stage-bare.mjs ../native/target/bare-addon-android/utexo__wdk-wallet-rgb.bare
npm pack --ignore-scripts
```

Install the tarball in a separate project and pack a linked Android worklet. Package the addon bytes unchanged under the versioned native library name in its manifest. Supply Android's canonical application native library directory via `androidNativeLibraryDir`. The package checks the resolved library name, SHA-256, target and native source profile. An optional `nativeSha256` configuration pin allows the consumer to check the expected addon independently of the package. Bare accepts a loopback Electrum URL with an explicit port and a `tcp:` or `ssl:` scheme. For the Node entry point, supply the separate worker's canonical absolute path and verified SHA-256.

Use a fresh, canonical mode-0700 data directory, a disposable 24-word mnemonic and explicit loopback URLs for the RGB proxy and EVM validation RPC. `WalletManagerRgb` opens the single account asynchronously. Always await `dispose()` to release the native file lock. Closing a wallet during a native mutation cancels the local wait. The already-dispatched native operation can still finish, and disposal waits for the worker to release the lock. Treat the entire wallet directory as required state.

`registerAssetContract` accepts public contract bytes, the configured native asset ID and SHA-256. `blindReceive` can then make a typed amountless invoice. A caller can read the validated predeposit mint with `getReceivedMint`, and must wait for chain settlement before spending.

`createUtxos` and `burnAsset` require a stable, unique operation ID. Persist that ID before invocation. The app authorization callback receives the reviewed transaction, exact fee, and, for burns, the amount and destination commitment. `getInfo` reports RGB L1 and the V1 routes explicitly enabled by the fixture profile. Route encoding support and payout settlement are distinct.

`getConsignment({assetId, txid})` returns a bounded base64 proof with asset, txid, size and keccak256 digest. `recoverBurn(operationId)` looks up the same committed burn on a fresh session and returns its V1 destination and proof. `createBurnPackage` packages the existing proof for file recovery. An unknown submission requires reconciliation. The journal blocks new transactions while an earlier submission is unresolved.

## Qualification scope

The Android ARM64 Bare candidate covers the local on-chain path. Its fixture checks EVM funds locking, RGB receipt and the confirmed V1 burn proof. iOS, React Native wallet integration, VSS and WalletConnect session support are separate scopes. Hosted mint, payout settlement and mobile device qualification require their own deployment and acceptance runs. The package is private and requires a deliberate release review before changing distribution.
