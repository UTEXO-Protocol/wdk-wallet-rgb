# On-chain WDK candidate

This private candidate uses unmodified BFA.8 with stock Electrum and Esplora clients. See the [qualification register](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/candidate/onchain-bfa/QUALIFICATION.md) for the exact rebuilt artifacts, tests and outstanding acceptance.

`@utexo/wdk-wallet-rgb` is a private candidate for platform qualification. The native protocol is version 2 and requires network checks, unsigned-operation recovery, journal writes and ordinary RGB asset issuance. The native wallet receives public account data and signed PSBTs. The application signer checks outputs, fee, key origins and exact PSBT identity before adding witnesses. The SDK retains one account per manager and rejects implicit migration of existing native wallet directories.

| Component | Pinned version or source |
| --- | --- |
| Tether WDK Wallet | `1.0.0-beta.25` |
| Bare runtime minimum and test runtime | `1.37.1` (desktop and embedded mobile) |
| Android symbol qualification runtime | Bare Kit `3.0.1`, Bare `1.37.1` |
| Bare C headers | `1.35.0` |
| RGB library | `v0.3.0-beta.7-upstream-dev-bfa.8`, `2f7b21d8637baad548504ea870deb2c0d4d0a37d` |
| Native artifacts | [Exact target pins](src/onchain-bare-native.json), qualified separately |
| Signing | `@scure/btc-signer@2.4.1`, `@scure/bip32@2.4.0`, `@scure/base@2.4.0`, `@noble/curves@2.4.0`, `@noble/hashes@2.4.0` |

The BFA.8 candidate uses a new wallet directory identity. BFA.8 removed a database migration recorded by BFA.7 wallets, so an earlier directory is refused before the database is opened. Keep the earlier directory with its original SDK and use a fresh directory for BFA.8 qualification.

## Build and use

Public JavaScript checks run from the lock with `npm ci --ignore-scripts`, `npm test`, and `npm run check:types`. The [native manifest](src/onchain-bare-native.json) admits only explicitly recorded Bare artifacts. Native builds do not require RGB source patches. The [SDK repository](https://github.com/UTEXO-Protocol/wdk-wallet-rgb) contains the native build runbook and qualification evidence.

Supply a canonical private data directory and a disposable seed for qualification. Use a separate directory for each network and profile.

| Wallet | Configuration | Bitcoin indexer |
| --- | --- | --- |
| Mainnet RGB | `network: 'mainnet', mode: 'rgb'` | `ssl://electrum.iriswallet.com:50003` |
| Public Signet RGB | `network: 'signet', mode: 'rgb', profile: 'public'` | `ssl://electrum.iriswallet.com:50033` |
| Mainnet or Public Signet Bitcoin only | Same network, `mode: 'btc-only'`, omit `profile` | Same endpoint for that network |
| Regtest | `network: 'regtest'` | Loopback `tcp:` or `ssl:` Electrum with explicit port |

For ordinary RGB, supply one `rpcs://` transport endpoint that implements protocol 1.0. Use `checkProxyEndpoint()` to verify its advertised protocol. The wallet directory is bound to its configured proxy. A send invoice must specify that same endpoint. These profiles support NIA and CFA and reject bridge routes, EVM RPC configuration and proxy credentials. Public Signet verifies the public block-one hash in addition to the chain genesis. Bitcoin-only wallets take no RGB configuration. Regtest RGB also needs a loopback proxy and, for BFA fixture tests, the EVM validation RPC appropriate to the fixture.

For the separate staging bridge profile on Public Signet, set `network: 'signet'`, `mode: 'rgb'` and `profile: 'staging'`, with the Public Signet Electrum endpoint, `transportEndpoint: 'rpcs://staging.rgb-proxy.utexo.com/json-rpc'` and `evmRpcUrls: { 42161: 'https://arb1.arbitrum.io/rpc' }`. The profile rejects proxy credentials. The sole V1 payout route is `{ chainId: 'eip155:42161', dstEid: 0 }` when explicitly enabled by the application.

For manual hosted Dev testing, set `network: 'signet'`, `mode: 'rgb'` and `profile: 'dev'`. Set `indexerUrl: 'https://dev.esplora-01.mint.utexo.com'`, `transportEndpoint: 'rpcs://dev.rgb-proxy.utexo.com/json-rpc'` and `evmRpcUrls: { 42161: 'https://arb1.arbitrum.io/rpc' }`. Dev verifies its own block-one checkpoint and uses a separate wallet directory. The application configures its asset ID and exact V1 routes. Stock BFA.8 cannot preregister a standalone genesis: `registerAssetContract()` reports `CONTRACT_IMPORT_UNAVAILABLE`. A generic receive can discover an unknown asset through a validated transfer, but does not replace asset-pinned preregistration. Hosted mint, burn and payout acceptance are tracked separately. [Dev bridge route table](https://github.com/UTEXO-Protocol/utexo-bridge-fe/blob/a0e21415213b9e99adc20424ce59891bff7e7448/utexo/src/mintBurn/burnDestination.ts#L16-L23)

The Node entry takes the absolute protocol-2 worker path and pinned SHA-256. Desktop Bare loads and hashes the addon for its exact host. Android links the worklet, preserves the admitted addon bytes under the versioned native library name and supplies its canonical `androidNativeLibraryDir`. iOS uses Bare Link to build and sign the app framework, then supplies `iosNativeFrameworkDir` and `nativeSha256` for the final framework binary. The iOS package prebuild and the final embedded framework have separate hashes. The SDK verifies the native profile before opening on each target.

Set `startupMode: 'offline'` to open without waiting on services. Local reads are cached until `connect()` completes. Address allocation, invoice creation and transaction preparation require a connected session. `getConnectionStatus()` describes session state. `getNetworkInfo()` reads the current tip from the configured indexer and checks the selected Signet block-one checkpoint. The indexer is a trusted service for the chain data it reports. The endpoint checks accept only the configured services. A proxy check verifies the advertised protocol independently of credential and mint readiness.

Stock Electrum reconnects with its bounded retry policy. WDK checks genesis and the selected Signet block-one checkpoint before connecting and at network-operation boundaries. These checks do not cover each independent socket opened inside RGB. The client may retransmit the identical signed transaction after a lost broadcast response; it does not construct a second payment. Use the original operation ID to reconcile a spend. WDK records inputs before exposing a signed RGB transaction and refuses a later plan that reuses them, including if RGB subsequently reports failure.

A seed restores Bitcoin keys and discoverable history within the pinned library's HD scan gap. It cannot recreate missing RGB consignments, allocations or the SDK operation journal. Preserve the complete wallet directory for RGB recovery. Stock RGB output enrollment is used; the removed provenance patch is not part of this candidate.

## Tether WDK Core

Core `1.0.0-beta.23` is tested with this candidate on Node and Bare. Install Core in the consuming application. The SDK retains its pinned wallet base `1.0.0-beta.25`; the integration also passes when Core resolves wallet base `1.0.0-beta.26` separately.

Core's TypeScript registration constraint expects a constructor with an optional base configuration. RGB requires `CandidateConfig`. Use this local constructor assertion only at the Core registration boundary, keeping the RGB signature last. It preserves configuration checking and does not make the SDK's runtime configuration optional. Core returns a common account type, so retain the RGB account type when your registered manager and middleware preserve those methods.

```ts
import WDK, { type WdkAccount } from '@tetherto/wdk'
import type WalletManager from '@tetherto/wdk-wallet'
import WalletManagerRgb, {
  type CandidateConfig, type WalletAccountRgb
} from '@utexo/wdk-wallet-rgb'

async function readBalance(seed: Uint8Array, config: CandidateConfig) {
  const core = new WDK(seed)
  const RgbManagerForCore = WalletManagerRgb as typeof WalletManager & typeof WalletManagerRgb
  core.registerWallet('rgb', RgbManagerForCore, config)

  let account: (WdkAccount & WalletAccountRgb) | undefined
  try {
    account = await core.getAccountByPath('rgb', "0'/0/0") as WdkAccount & WalletAccountRgb
    return await account.getBalance()
  } finally {
    try { await account?.shutdown() } finally { core.dispose() }
  }
}
```

For an application that keeps the wallet open, perform that shutdown sequence when closing or replacing it. Core's `dispose()` is synchronous; awaiting the RGB account first releases its native handle and wallet lock before reuse.

Core `1.0.0-beta.23` uses `registerMiddleware()` to return an account wrapper. It no longer exposes `registerPolicy()`. Application middleware can deny a request before it reaches the SDK, but an allowed request still needs the SDK's `authorize` or `authorizeMessage` approval. Use `toReadOnlyAccount()` for policy reads. The older Core `1.0.0-beta.22` built-in policy integration is separately tested; it is not a beta.23 API.

## Wallet operations

- `getAddress()` is stable for the opened account. `getNewAddress()` explicitly allocates another address. `getBalance()` and `getTokenBalance()` return exact bigint base units. Display and history interfaces preserve exact decimal strings.
- `registerAssetContract()` validates its byte envelope but reports `CONTRACT_IMPORT_UNAVAILABLE`; `getCapabilities().contractRegistration` exposes that limitation before calling. `blindReceive()` and `witnessReceive()` use the profile's approved proxy. Read and refresh methods expose assets, transactions, transfers and the outcome of each transfer refresh. `getReceivedMint()` returns the EVM `lockId`, which commits to the mint operation and its Bitcoin transaction, alongside the operation ID `opid`.
- `cancelReceiveInvoice({ batchTransferIdx, recipientId })` releases one expired receive reservation for a known ordinary RGB asset after the wallet checks for delivery. Use `listTransfers()` to find rows with `receiveCancellationEligible`. That flag is based on local state. The adapter refreshes incoming transfers for the asset, then revalidates and uses stock `fail_transfers` only for the requested batch before rereading the result. Cancellation follows BFA.8's retention and proxy-loss policy; it does not prove that a pruned proxy never held a transfer. It can fail if delivery evidence appears or a required check is unavailable. BFA and invoices without a known asset stay protected because they may belong to a mint.
- `sendBtc()`, `sendRgbInvoice()`, `createUtxos()` and `burnAsset()` require an application-owned stable operation ID. The caller's authorization receives the exact fee and the reviewed PSBT identity. RGB sends require an admitted invoice network, asset, amount, recipient key and proxy. Witness sends also require an explicit BTC output amount.
- RGB output setup can be split into `prepareCreateUtxos()`, `commitPreparedCreateUtxos()` and `cancelCreateUtxosPlan()`. Commit and cancel bind both the operation ID and PSBT digest. An abandoned unsigned reservation can be released only when its exact native transaction is found.
- `recoverSend()`, `recoverCreateUtxos()` and `recoverBurn()` reconcile operations after submission was attempted. `listUnresolvedOperations()` identifies blocked spends. For an interrupted `starting` or `prepared` operation, `recoverUnsubmittedOperation()` compares the durable pre-Begin reservation checkpoint with the native state and releases an exact, uniquely attributable unsigned reservation. The original operation ID stays consumed. `getConsignment()` reads a committed, bounded burn proof. `createBurnPackage()` exports an already validated proof and its V1 destination.
- `signMessageBip322()` signs the first owned BIP86 address after separate message authorization. Verification accepts the supported Taproot key-path and P2WPKH simple witnesses. The API advertises Iris's existing BIP-322 capability identifier.
- `createWorkletApproval()` correlates an approval over the application's trusted IPC with a one-time token, reviewed operation digest and unlocked-wallet generation. Close this controller on lock, then await `shutdown()` before reopening. A native mutation already dispatched may finish during shutdown. Preserve its wallet directory and resolve the recorded operation before trying another spend.
- `toReadOnlyAccount()` gives Tether WDK policy conditions a restricted account view. It reads an address already allocated by the wallet and never rotates it. Transaction receipts report known pending or confirmed wallet history. Bitcoin confirmations remain subject to reorganization. Transaction signing and sending use the SDK's typed intent and authorization methods.

The `/webrgb` subpath serves a scoped wallet request. It relies on the application's session and origin admission. Pairing, durable grants, account and network policy, transport generation, and trusted approval UI belong to the consuming application. Every financial request must retain its original identity across reconnect and recovery. A still-authorized replay of an exact receive request can retrieve its saved invoice until expiry. If allocation was interrupted before the invoice could be recorded, that request remains unresolved and cannot allocate a second invoice.

The native lock owner durably writes the spend and invoice journals before releasing the wallet directory. An unresolved spend blocks later spends. Ambiguous reservation state and older records lacking a checkpoint require reconciliation. After submission begins, an absent transaction or a failed reply is insufficient evidence to release the operation.

## Issue RGB assets

NIA and CFA issuance is admitted in every supported RGB environment: Mainnet, Regtest, and Signet with `profile: 'public'`, `'dev'` or `'staging'`. This does not enable RGB in a `mode: 'btc-only'` wallet or add unsupported Bitcoin networks. Use a rebuilt artifact listed in the qualification register; older patched binaries do not implement this adapter.

Open a connected RGB wallet. Create RGB outputs with `createUtxos()` using BTC on the selected chain and wait for their confirmation before issuing. Each entry in `amounts` uses a separate available RGB output. Supply positive base-unit amounts as decimal strings or bigint. Safe integer numbers are accepted for compatibility with the old issuance methods.

The example below uses Regtest. Mine the output confirmations on your local chain before running it.

```js
const asset = await account.issueAssetNia({
  operationId: 'local-test-nia-0001',
  ticker: 'TEST',
  name: 'Local test token',
  precision: 2,
  amounts: [10_000n]
})

const invoice = await receivingAccount.blindReceive({ amount: 250n })
await account.sendRgbInvoice({
  operationId: 'local-test-send-001',
  assetId: asset.assetId,
  invoice: invoice.invoice,
  amount: 250n,
  feeRate: 2n
})
```

For a collectible fungible asset, call `issueAssetCfa()` with `name`, optional text `details`, `precision`, `amounts`, and its own `operationId`. Use a receiver invoice without an asset ID for the first transfer. The receiver learns the asset from the validated consignment. The issuance receipt records a balance snapshot at issuance or reconciliation. Read `getAssetBalance()` for the current balance.

Issuance uses existing wallet allocations, requires a connected indexer for new assets and broadcasts no Bitcoin transaction. The invoice and transfer in the example use the configured RGB proxy. The SDK exposes issuance through the host account API for ordinary RGB. Preserve the wallet directory and repeat the exact call with the same operation ID after an interrupted result. A completed call returns the same asset ID on replay. If the wallet reports `INSUFFICIENT_RGB_OUTPUTS`, create and confirm more outputs before retrying.

On Mainnet and every Signet profile, the wallet runs a fresh consistency scan and checks every potential issuance output against the Bitcoin indexer. If any is awaiting confirmation, issuance returns `RGB_OUTPUT_CONFIRMATION_REQUIRED`. Retry after the setup confirms using the same operation ID. If the scan detects a spend outside the wallet, issuance returns `WALLET_INCONSISTENT`. The issuance call needs no proxy connection.

For a disposable Dev asset, use a separate Dev wallet and a distinct operation ID, with a ticker such as `VTEST`. Fund its outputs on Dev's chain; Public Signet funds are not interchangeable with Dev funds. Both parties must use the Dev profile and its configured indexer and proxy. Issuance keeps the same Dev checkpoint checks as other wallet operations. A newly issued NIA or CFA can test RGB transfers, but it is not the bridge's configured BFA asset and cannot be redeemed through its mint/burn flow.

Restart recovery requires the same wallet directory and seed, including the issuance and transfer journals. Retry an interrupted issuance with the exact original parameters and operation ID to recover its original asset. For an interrupted transfer, reconcile its original operation with `recoverSend()` rather than submitting a new one. A seed alone cannot restore the asset's RGB state.
