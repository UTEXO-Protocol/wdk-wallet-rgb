# @utexo/wdk-wallet-rgb

Private review candidate for the on-chain RGB wallet SDK for Node and Bare. The native wallet uses public keys and signed PSBTs. The application owns the signer and approves transactions.

The adapter builds against unmodified BFA.8. Native artifacts and funded acceptance are tracked in the [qualification register](QUALIFICATION.md); the package remains a private candidate.

The candidate admits Bitcoin and ordinary RGB (NIA and CFA) on mainnet and Public Signet. For ordinary RGB, configure a TLS proxy that supports protocol 1.0. Applications can issue NIA/CFA assets or receive an asset through a validated transfer. Standalone contract registration awaits its public upstream API; it does not block wallet opening or ordinary RGB operations. Regtest and the explicit Dev and staging profiles have separate service and bridge policies. Mainnet RGB service and funded public-network qualification are separate release gates.

The host account exposes `issueAssetNia()` and `issueAssetCfa()` in every supported RGB environment: Mainnet, Regtest, and the Public, Dev and staging Signet profiles. BTC-only wallets do not expose RGB operations. See the [issuance example and prerequisites](CANDIDATE.md#issue-rgb-assets).

The [candidate guide](CANDIDATE.md) covers configuration, supported platforms, authorization and recovery. The [SDK repository](https://github.com/UTEXO-Protocol/wdk-wallet-rgb) tracks native build and qualification evidence.
