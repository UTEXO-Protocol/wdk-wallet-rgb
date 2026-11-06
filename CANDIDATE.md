# On-chain WDK candidate

`@utexo/wdk-wallet-rgb@2.1.0-alpha.11` is the private BFA.6 qualification candidate. The native protocol is version 2 and requires the network-check, unsigned-recovery and journal-write capabilities. The native wallet receives public account data and signed PSBTs. The application signer checks outputs, fee, key origins and exact PSBT identity before adding witnesses. The SDK retains one account per manager and rejects implicit migration of existing native wallet directories.

| Component | Pinned version or source |
| --- | --- |
| Tether WDK Wallet | `1.0.0-beta.25` |
| Android embedded runtime | Bare Kit `3.0.1`, Bare `1.36.2` |
| Bare C headers | `1.35.0` |
| RGB library | `v0.3.0-beta.7-upstream-dev-bfa.6`, `5010eefa355beb9c42a4c1b69883f7651241a111` |
| Native overlay | Functional tree `2b9bf63482d8a472492d065d3edd260e0fa418ac`, embedded tree `168fd88d5f1d3e99a34c03e781689d9b2acceb14` |
| Signing | `@scure/btc-signer@2.4.1`, `@scure/bip32@2.4.0`, `@scure/base@2.4.0`, `@noble/curves@2.4.0`, `@noble/hashes@2.4.0` |

The RGB overlay retains standalone genesis registration, native HTTP egress restrictions and Signet checkpoints. The embedded build also disables the process-wide wallet panic hook. BFA.6 enforces full mint conservation upstream. Native preparation verifies the upstream commit and patched tree before building from the locked graph.

## Build and use

Public JavaScript checks run from the lock with `npm ci --ignore-scripts`, `npm test`, and `npm run check:types`. Follow the [native build runbook](native/README.md) to compile and admit a matching native artifact. The reviewed Android pack stages the exact addon with `node scripts/stage-bare.mjs native/target/bare-addon-android/utexo__wdk-wallet-rgb.bare` before `npm pack --ignore-scripts`.

Supply a canonical private data directory and a disposable seed. For Regtest, set `network: 'regtest'` and a loopback `tcp:` or `ssl:` Electrum endpoint with an explicit port. Regtest RGB also needs a loopback RGB proxy and the EVM validation RPC appropriate to the fixture. For public Signet, set `network: 'signet'`, `mode: 'btc-only'`, and `indexerUrl: 'ssl://electrum.iriswallet.com:50033'`. The Signet profile accepts only that certificate-validated endpoint and checks the genesis and public block-one hashes on the wallet indexer and resolver before synchronization. It uses a separate wallet directory and has Bitcoin address allocation, balance, history, sends and message signing. The Bitcoin-only profile rejects RGB service settings and RGB mutations.

To admit RGB on public Signet, set `network: 'signet'`, `mode: 'rgb'` and `profile: 'staging'`, with the same Electrum endpoint, `transportEndpoint: 'rpcs://staging.rgb-proxy.utexo.com/json-rpc'` and `evmRpcUrls: { 42161: 'https://arb1.arbitrum.io/rpc' }`. Use a separate wallet directory. The profile forbids proxy credentials. An application can explicitly configure `{ chainId: 'eip155:42161', dstEid: 0 }` as its sole V1 burn route after qualifying its deployment. Compatible asset bytes and a matching hosted deployment remain separate prerequisites for enabling bridge capabilities.

The BFA.6 candidate requires a fresh wallet directory and contract bytes issued under the BFA.6 schema. Its native and JavaScript gates keep hosted Dev disabled pending qualification of a matching deployment and asset export. The dedicated BFA.5 alpha.10 build remains the manual candidate for the earlier Dev BUSDT deployment. [Dev checkpoint scope](native/README.md#dev-checkpoint-candidate)

The Node entry takes the absolute protocol-2 worker path and pinned SHA-256. Android packs a linked worklet, preserves the admitted addon bytes under the versioned native library name and supplies its canonical `androidNativeLibraryDir`. The SDK verifies addon hash and native profile before opening.

Set `startupMode: 'offline'` to open without waiting on services. Local reads are cached until `connect()` completes. Address allocation, invoice creation and transaction preparation require a connected session. `getConnectionStatus()` describes session state. `getNetworkInfo()` reads the current tip from the configured indexer and checks the selected Signet block-one checkpoint. The indexer is a trusted service for the chain data it reports. The endpoint checks accept only the configured services. A proxy check verifies the advertised protocol independently of credential and mint readiness.

For a seed-only restore into a new directory, explicitly set `mode: 'btc-only'` and supply the same-engine seed and Electrum endpoint. Online discovery searches Bitcoin history within the pinned library's HD scan gap. The directory stays in BTC-only mode across reopen. RGB wallet and bridge capabilities require matching, validated RGB state. Keep the original RGB wallet directory or its complete authenticated backup.

## Wallet operations

- `getAddress()` is stable for the opened account. `getNewAddress()` explicitly allocates another address. `getBalance()` and `getTokenBalance()` return exact bigint base units. Display and history interfaces preserve exact decimal strings.
- `registerAssetContract()` validates public contract bytes, SHA-256 and the asset ID. `blindReceive()` and `witnessReceive()` use the profile's approved proxy. Read and refresh methods expose assets, transactions, transfers and the outcome of each transfer refresh. `getReceivedMint()` returns the EVM `lockId`, which commits to the mint operation and its Bitcoin transaction, alongside the operation ID `opid`.
- `sendBtc()`, `sendRgbInvoice()`, `createUtxos()` and `burnAsset()` require an application-owned stable operation ID. The caller's authorization receives the exact fee and the reviewed PSBT identity. RGB sends require an admitted invoice network, asset, amount, recipient key and proxy. Witness sends also require an explicit BTC output amount.
- RGB output setup can be split into `prepareCreateUtxos()`, `commitPreparedCreateUtxos()` and `cancelCreateUtxosPlan()`. Commit and cancel bind both the operation ID and PSBT digest. An abandoned unsigned reservation can be released only when its exact native transaction is found.
- `recoverSend()`, `recoverCreateUtxos()` and `recoverBurn()` reconcile operations after submission was attempted. `listUnresolvedOperations()` identifies blocked spends. For an interrupted `starting` or `prepared` operation, `recoverUnsubmittedOperation()` compares the durable pre-Begin reservation checkpoint with the native state and releases an exact, uniquely attributable unsigned reservation. The original operation ID stays consumed. `getConsignment()` reads a committed, bounded burn proof. `createBurnPackage()` exports an already validated proof and its V1 destination.
- `signMessageBip322()` signs the first owned BIP86 address after separate message authorization. Verification accepts the supported Taproot key-path and P2WPKH simple witnesses. The API advertises Iris's existing BIP-322 capability identifier.
- `createWorkletApproval()` correlates an approval over the application's trusted IPC with a one-time token, reviewed operation digest and unlocked-wallet generation. Close this controller on lock, then await `shutdown()` before reopening. A native mutation already dispatched may finish during shutdown. Preserve its wallet directory and resolve the recorded operation before trying another spend.
- `toReadOnlyAccount()` gives Tether WDK policy conditions a restricted account view. It reads an address already allocated by the wallet and never rotates it. Transaction receipts report known pending or confirmed wallet history. Bitcoin confirmations remain subject to reorganization. Transaction signing and sending use the SDK's typed intent and authorization methods.

The `/webrgb` subpath serves a scoped wallet request. It relies on the application's session and origin admission. Pairing, durable grants, account and network policy, transport generation, and trusted approval UI belong to the consuming application. Every financial request must retain its original identity across reconnect and recovery. A still-authorized replay of an exact receive request can retrieve its saved invoice until expiry. If allocation was interrupted before the invoice could be recorded, that request remains unresolved and cannot allocate a second invoice.

The native lock owner durably writes both journals before releasing the wallet directory. An unresolved spend blocks later spends. Ambiguous reservation state and older records lacking a checkpoint require reconciliation. After submission begins, an absent transaction or a failed reply is insufficient evidence to release the operation. See the [qualification register](QUALIFICATION.md) for the remaining release and Iris gates.
