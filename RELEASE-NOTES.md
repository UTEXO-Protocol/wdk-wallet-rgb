# @utexo/wdk-wallet-rgb 3.0.0-rc.4

This release candidate introduces the on-chain Node/Bare SDK using the public RGB-Tools contract APIs and the existing-BFA-wallet repair from [upstream PR #138](https://github.com/RGB-Tools/rgb-lib/pull/138), pinned at `a62fc7d3aa21f715a53c32419ab6d9fbbf1721a2`. Applications own the signer and approve the exact transaction before native submission. It is a breaking replacement for the previous 2.x wrapper and is intended for the `next` distribution tag.

- `getReceivedMint({ invoice })` over WebRGB: refreshes the exact owned receive and returns checked asset, transaction, LockId, amount, EVM chain, bridge contract and deadline before payment. Pending returns `null`; invoice mismatches, expired invoices and invalid commitment evidence fail. Upstream retains prior time-dependent validation; the payment application still checks the current EVM chain, contract and deadline.
- WebRGB `0.1.7` single native burn destinations, with strict route checks and private commitment encoding.
- Public contract registration and export with exact asset ID and SHA-256 checks, bounded bytes and no native paths. Registration adds metadata without allocations or transfers.
- Durable expected-asset binding for generic receives; existing invoices keep their original operation and request identity after upgrade.
- BTC send/receive, RGB output setup and NIA/CFA issuance and transfers across all supported RGB profiles.
- Blinded and witness invoices with optional amounts; exact expired ordinary-invoice cancellation.
- BFA mint validation and V1 burns with scoped proof retrieval and restart recovery. Arbitrum, Ethereum, Polygon, Plasma and Tron routes must be explicitly configured.
- Separate sender and recipient RGB proxies, with endpoint admission on both the JavaScript and native boundaries.
- Stable operation identities, authorization, exposed-input protection and recovery without constructing a replacement transfer.
- BIP-322 message signing, immutable public account-key export, Tether Core integration and awaited wallet shutdown.
- Exact target manifests and third-party notices. Full SDK publication requires five Node workers and eleven Bare addons; qualification archives may contain a subset and retain a publication hold.

Node requires `^22.21.0 || >=24.9.0`; Bare requires `>=1.37.1`, including embedded mobile runtimes. Node workers are separate verified downloads. The npm archive contains the Bare addons; mobile applications must link the appropriate native artifact.

When replacing the 2.x wrapper, use a new engine-specific directory and follow [MIGRATION.md](MIGRATION.md). Existing RC3 applications keep their complete wallet directory and keys; this candidate includes the upstream BFA metadata backfill required for that update. Seed recovery does not reconstruct missing RGB consignments or WDK journals. There is no 2.x wallet-directory converter.

Contracts requiring external media are outside the current registration envelope. PR #138 still requires upstream review; this is an unreleased qualification candidate, with no downstream RGB source patch. Automatic VSS restore and Mainnet BFA are not provided. The SDK ships no USDT contract metadata. Node and Bare use bundled SQLite 3.54.1. Seven upstream Esplora TLS findings remain under the documented dependency policy, without source patches or audit suppression.

See [QUALIFICATION.md](QUALIFICATION.md) for exact passing test scopes and artifact identities. Mobile build/ABI verification does not establish installed-app acceptance, and local mint/burn fixtures do not establish hosted bridge payouts.
