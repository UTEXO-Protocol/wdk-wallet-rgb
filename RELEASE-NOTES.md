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
- Five Node workers and eleven Bare addons, each admitted by source and hash.

Node requires `^22.21.0 || >=24.9.0`; Bare requires `>=1.37.1`, including embedded
mobile runtimes. Node workers are separate release downloads; the npm archive
contains the Bare addons. Mobile applications link the appropriate native artifact.

Follow [MIGRATION.md](MIGRATION.md) when replacing 2.x. Existing RC3 applications
keep their complete wallet directory and keys; RC4 repairs cached BFA metadata
from retained validated stock. Do not reopen an upgraded directory with an older
binary. A seed alone cannot restore RGB proofs or WDK journals.

The SDK ships no deployment-specific USDT metadata. Mainnet NIA/CFA are supported;
Mainnet BFA, automatic VSS restore and contracts needing missing external media
are outside this release's supported scope. Cancellation excludes BFA, assetless
and progressed receives. Local mint/burn tests do not establish hosted payouts.

The source is public RGB-Tools `a62fc7d3aa21f715a53c32419ab6d9fbbf1721a2`, with
no downstream source patches. The stock URL library update resolves
RUSTSEC-2026-0592. Remaining Esplora TLS findings and maintenance warnings are
recorded in [DEPENDENCY-POLICY.md](DEPENDENCY-POLICY.md).

These notes are prepared for release; publication remains blocked on
[upstream #138](https://github.com/RGB-Tools/rgb-lib/pull/138) and final review.
See [QUALIFICATION.md](QUALIFICATION.md) for exact artifact identities, passing
scopes and the distinction between installed-app, hosted and physical-device tests.
