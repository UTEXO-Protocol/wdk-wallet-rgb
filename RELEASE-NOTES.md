# @utexo/wdk-wallet-rgb 3.0.0-rc.2

This release candidate introduces the on-chain Node/Bare SDK on unmodified BFA.8. Applications own the signer and approve the exact transaction before native submission. It is a breaking replacement for the previous 2.x wrapper and is intended for the `next` distribution tag.

- `getReceivedMint({ invoice })` over WebRGB: refreshes the exact owned receive and returns checked asset, transaction, LockId, amount, EVM chain, bridge contract and deadline before payment. Pending returns `null`; invoice mismatches, expired invoices and invalid commitment evidence fail. Stock BFA.8 retains prior time-dependent validation; the payment application still checks the current EVM chain, contract and deadline.
- Durable expected-asset binding for a generic first receive without claiming standalone contract import.
- BTC send/receive, RGB output setup and NIA/CFA issuance and transfers across all supported RGB profiles.
- Blinded and witness invoices with optional amounts; exact expired ordinary-invoice cancellation.
- BFA mint validation and V1 burns with scoped proof retrieval and restart recovery. Arbitrum, Ethereum, Polygon, Plasma and Tron routes must be explicitly configured.
- Separate sender and recipient RGB proxies, with endpoint admission on both the JavaScript and native boundaries.
- Stable operation identities, authorization, exposed-input protection and recovery without constructing a replacement transfer.
- BIP-322 message signing, Tether Core integration and awaited wallet shutdown.
- Five Node and eleven Bare platform artifacts, verified distribution manifests and third-party notices.

Node requires `^22.21.0 || >=24.9.0`; Bare requires `>=1.37.1`, including embedded mobile runtimes. Node workers are separate verified downloads. The npm archive contains the Bare addons; mobile applications must link the appropriate native artifact.

Use a new engine-specific directory and follow [MIGRATION.md](MIGRATION.md) for the API changes. Seed recovery does not reconstruct missing RGB consignments or WDK journals. There is no legacy wallet-directory migration.

Standalone contract registration still awaits a public BFA API and is reported unavailable through capabilities. Automatic VSS restore and Mainnet BFA are not provided. The SDK ships no USDT contract metadata. The stock TLS/SQLite dependency findings are retained under the documented dependency policy, without source patches or audit suppression.

See [QUALIFICATION.md](QUALIFICATION.md) for exact passing test scopes and artifact identities. Mobile build/ABI verification does not establish installed-app acceptance, and local mint/burn fixtures do not establish hosted bridge payouts.
