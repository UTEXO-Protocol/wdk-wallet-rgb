# @utexo/wdk-wallet-rgb

Private review candidate for the on-chain RGB wallet SDK for Node and Bare. The native wallet uses public keys and signed PSBTs. The application owns the signer and approves transactions.

The candidate admits Bitcoin and ordinary RGB (NIA and CFA) on mainnet and Public Signet. For ordinary RGB, configure a TLS proxy that supports protocol 1.0. Applications supply their own assets through contract registration or an admitted transfer. Regtest and the explicit Dev and staging profiles have separate service and bridge policies. Mainnet RGB service and funded public-network qualification are separate release gates.

The [candidate guide](CANDIDATE.md) covers configuration, supported platforms, authorization and recovery. The [SDK repository](https://github.com/UTEXO-Protocol/wdk-wallet-rgb) tracks native build and qualification evidence.
