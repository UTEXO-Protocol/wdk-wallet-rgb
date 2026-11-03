# On-chain RGB SDK qualification register

The candidate is an on-chain SDK review branch for Node and Android Bare. It remains private while the release gates below are open. The SDK's approved profile is isolated regtest.

## Current dependencies

The candidate pins the current Tether base wallet `1.0.0-beta.25` and RGB BFA `.5` source with reviewed overlays. It uses the same locked Electrum-only graph on both native entry points. The Android worklet uses Bare Kit `3.0.1` and Bare `1.36.2`. Tether WDK core `1.0.0-beta.22`, Pear worker `1.0.0-beta.17`, React Native core `1.0.0-beta.23`, and WebRGB WalletConnect `0.1.3` were checked separately. They describe the host integration and transport, which have their own compatibility gates.

## SDK and Iris contract

| Area | Candidate SDK surface | Remaining Iris integration or qualification |
| --- | --- | --- |
| Wallet lifecycle | Async open and shutdown, exact account path, stable session address and explicit rotation | Bind the IPC approval ticket to the app's authenticated wallet generation. The current Pear reset path needs to await shutdown. Qualify offline start and native platform lock/reopen in the product host. |
| BTC and RGB | Exact base-unit sends and fee estimates, blind and witness invoices, decoded invoice and transfer status, assets, balances, refresh outcomes and transaction history | Adapt legacy field shapes and amount types. Expose the required network tip and endpoint checks and validate their behavior against the deployed services. |
| RGB output setup | Prepare, commit, cancel, exact-operation recovery and abandoned unsigned reservation release | Qualify the interrupted native Begin boundary. A crash before the native txid is recorded can require operator reconciliation. |
| BIP-322 | Explicit message approval, owned P2TR signing, P2TR/P2WPKH simple verification | Connect app step-up approval and qualify the resulting production worklet and physical devices. |
| WebRGB | Request-scoped facade, explicit V1 payout route and asset allowlists, durable burn identity, proof scoping and recovery | Qualify the actual session transport, persistent grants, invoice-request deduplication and hosted bridge with the app. Verify every advertised route end to end. |
| VSS | Startup and on-chain operations have no VSS dependency | Existing VSS stays optional. Its external-signer backup and recovery require separate qualification. |

The legacy package and the new engine have different public contracts and can derive different wallet identities from the same recovery phrase. Use distinct storage for qualification. A future public release needs an explicit breaking-version or distribution decision before replacing the published package.

## Open release gates

1. **Hosted asset and protocol.** The supplied dev and staging contract exports fail the current RGB BFA codec before asset-ID admission. Obtain compatible official same-ID exports and verify the deployed gateway, signer, proxy and EVM mint contract together. Check deployed source and configuration rather than inferring them from a draft PR. [RGB contract import](https://github.com/UTEXO-Protocol/rgb-lib-bfa/pull/4) · [Gateway migration](https://github.com/UTEXO-Protocol/bridge-utexo/pull/531) · [Signer migration](https://github.com/UTEXO-Protocol/enclave-signer/pull/337)
2. **Network and payout.** Regtest uses real transactions on isolated chains. Public TLS endpoints, Signet settlement, and hosted payout execution need acceptance. The pinned upstream restricts BFA and IFA on mainnet. The SDK must keep network and schema admission consistent with the validated upstream.
3. **Host and platform support.** Verify the actual Iris WDK/Pear worklet with awaited shutdown, approvals and transport. The latest React Native core declares an Expo crypto peer range below Expo 57. Confirm the supported peer graph, iOS binaries, and physical devices. [Tether WDK core](https://docs.wdk.tether.io/sdk/core-module/api-reference/)
4. **Distribution and security.** Complete platform provenance, protected native builds, notices review and package acceptance. RustSec found no known vulnerabilities in the locked Electrum graph and retains an unmaintained `unsafe-libyaml` advisory. Production incident recovery must cover an interruption before exact prepared transaction identity is persisted.
