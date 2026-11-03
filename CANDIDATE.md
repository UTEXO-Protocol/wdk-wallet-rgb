# On-chain WDK candidate

The private `@utexo/wdk-wallet-rgb@2.1.0-alpha.0` pack is a macOS ARM64 Node regtest candidate. It uses a watch-only native RGB wallet. The app-owned signer holds only the derived signing keys, reviews the PSBT and actual miner fee, and adds Taproot witnesses after explicit authorization. The worker receives public account identity and signed PSBTs. Neither the package nor the worker links RLN or LDK.

| Component | Exact source or version |
| --- | --- |
| WDK starting source | `6d28bc9ff35a7863cd21b21e62a7c03a9b794066` |
| Tether WDK Wallet | `1.0.0-beta.25` |
| RGB library | `v0.3.0-beta.7-upstream-dev-bfa.5`, `0a9d352f2690902df2b6fae9bca1a6c13c3354d4` |
| Native local overlay | Git tree `5b7660a66d53da6a5935407bbaf21f7e73636f35` |
| Signing dependencies | `@scure/btc-signer@2.4.1`, `@scure/bip32@2.4.0`, `@scure/base@2.4.0`, `@noble/hashes@2.4.0` |
| Fixture proxy | RGB Tools proxy server `v0.4.0`, protocol 1.0 |

The native overlay ports validated registration of a public contract from [RGB #4](https://github.com/UTEXO-Protocol/rgb-lib-bfa/pull/4) and checks that the recipient receives the entire mint amount in both validation paths, based on [RGB #8](https://github.com/UTEXO-Protocol/rgb-lib-bfa/pull/8). The BFA library, all private patches and transitive Rust dependencies are pinned. The native source preparation requires authorized read access to those repositories.

## Build and use

From the candidate source workspace:

```sh
cd native
python3 scripts/prepare-source.py
cargo +1.94.0 build --release --locked
cd ../wdk-wallet-rgb
npm ci --ignore-scripts
npm test
npm run check:types
npm pack --ignore-scripts
```

Install the tarball in a separate Node project and supply the native worker's canonical absolute path and verified SHA-256. The worker verifies the network, public account identity and exclusive directory access. Use a fresh, canonical mode-0700 data directory, a disposable 24-word mnemonic and explicit loopback URLs for the indexer, RGB proxy and EVM validation RPC. `WalletManagerRgb` opens the single account asynchronously. Always await `dispose()` to release the native file lock. Treat the entire wallet directory as required state.

`registerAssetContract` accepts public contract bytes, the configured native asset ID and SHA-256. `blindReceive` can then make a typed amountless invoice. A caller can read the validated predeposit mint with `getReceivedMint`, and must wait for chain settlement before spending.

`createUtxos` and `burnAsset` require a stable, unique operation ID. Persist that ID before invocation. The app authorization callback receives the reviewed transaction, exact fee, and, for burns, the amount and destination commitment. `getInfo` reports RGB L1 and the V1 routes explicitly enabled by the fixture profile. Route encoding support and payout settlement are distinct.

`getConsignment({assetId, txid})` returns a bounded base64 proof with asset, txid, size and keccak256 digest. `recoverBurn(operationId)` looks up the same committed burn on a fresh session and returns its V1 destination and proof. `createBurnPackage` packages the existing proof for file recovery. An unknown submission requires reconciliation. The journal blocks new transactions while an earlier submission is unresolved.

## Qualification scope

The host worker and packed consumer qualify the local on-chain path. This candidate does not provide a Bare mobile addon, a React Native wallet integration, VSS or a WalletConnect session controller. Its fixture checks EVM funds locking, RGB receipt and the confirmed V1 burn proof. Hosted mint, payout settlement and mobile device qualification require their own deployment and acceptance runs. The package is private and requires a deliberate release review before changing distribution.
