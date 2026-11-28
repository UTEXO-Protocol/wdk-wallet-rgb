# @utexo/wdk-wallet-rgb 3.0.0-rc.4

Version 3 provides an on-chain Bitcoin and RGB SDK for Node and Bare. Applications
own the signer and approve the exact transaction before native submission.
This release candidate replaces the 2.x wrapper and is intended for npm `next`.

- BTC receive/send, RGB output setup, NIA/CFA issuance and transfers.
- Blinded and witness invoices with optional amounts; safe cancellation of an
  exact expired ordinary receive.
- Offline public contract registration/export with asset-ID and SHA-256 checks.
  Registration adds metadata without allocations or transfers.
- WebRGB 0.1.7 prepared-mint verification, configured V1 burn routes for Arbitrum,
  Ethereum, Polygon, Plasma and Tron, and proof recovery after restart.
- Durable operation IDs and exposed-input protection. Reconcile interrupted
  transfers instead of creating replacement payments.
- BIP-322, public account-key export, Tether Core integration and awaited shutdown.
- Five Node-API addons and eleven Bare addons, each admitted by source and hash.

Node requires `^22.21.0 || >=24.9.0`; Bare requires `>=1.37.1`, including embedded
mobile runtimes. The npm archive contains all Node and Bare addons; Node selects
its addon automatically and no longer requires an executable path. Mobile applications link the appropriate native artifact.

Follow [MIGRATION.md](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/v3.0.0-rc.4/MIGRATION.md) when replacing 2.x. This first version 3 release
uses fresh wallet directories. Preserve the complete directory for later
restart and recovery; a seed alone cannot restore RGB proofs or WDK journals.

The SDK ships no deployment-specific USDT metadata. Mainnet NIA/CFA are supported;
Mainnet BFA, automatic VSS restore and contracts needing missing external media
are outside this release's supported scope. Cancellation excludes BFA, assetless
and progressed receives. Local mint/burn tests do not establish hosted payouts.

The source is public RGB-Tools `f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d`, with
no downstream source patches. The stock URL library update resolves
RUSTSEC-2026-0592. Remaining Esplora TLS findings and maintenance warnings are
recorded in [DEPENDENCY-POLICY.md](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/v3.0.0-rc.4/DEPENDENCY-POLICY.md).

These notes are prepared for release; publication remains held until the rebuilt
package passes qualification and final review is complete.
See [QUALIFICATION.md](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/v3.0.0-rc.4/QUALIFICATION.md) for exact artifact identities, passing
scopes and the distinction between installed-app, hosted and physical-device tests.
