# Alpha.24 qualification evidence

These receipts describe the unmodified BFA.8 candidate. They contain disposable transaction IDs and public test results, not seeds, wallet databases, signed transactions or proxy credentials.

The native build source is `b550b504ebde2274b9a3c506a2b935324c481728`. BFA.8 is `2f7b21d8637baad548504ea870deb2c0d4d0a37d`, tree `5492824f3cf47b4c821dfca8b7a63fed27858486`. The funded host archive has SHA-256 `c2ecdef68aa785bbad12d6df72b5d96febe8a84595fc658e732fca9a5337ed01`. Its Apple Silicon Node worker and Bare addon are identified in each receipt. Desktop qualification used Node 22.23.3 and Bare 1.37.1 locally; CI uses its separately pinned toolchains.

| Receipt | Actual scope |
| --- | --- |
| [Ordinary RGB](funded-ordinary.json) | Node and Bare: funded NIA/CFA issuance, blinded send, witness return, blinded self-send, six confirmations, restart balances, issuance result-loss recovery, duplicate prevention and allocation on unrelated outputs during an outstanding send. |
| [Bridge](funded-bridge.json) | Node and Bare: two local generic first-receive BFA mints, ten V1 burns, independent commitments/proof validation, post-End journal-write failure and process-restart recovery with the original request. |
| [Core, Bitcoin and signing](funded-core-btc.json) | Latest Core beta.23 on Node and Bare; historical beta.22 policy on Node. Funded seed discovery, BTC send/result-loss recovery, independent authorization, BIP-322 and awaited teardown. |
| [Live indexers](live-indexers.json) | Actual Node connections and reopen on Mainnet, Public Signet, Dev and staging. Empty wallets; no hosted proxy, bridge or payout operation. |
| [Dependency audit](dependency-audit.json) | Locked Rust graph and runtime npm findings, with the advisory database revision. Functional tests do not clear these findings. |

Ordinary tests use a new isolated Bitcoin/Fulcrum/Esplora/proxy fixture. Bridge tests use another isolated Bitcoin/Anvil/proxy fixture and a compatible independent BFA.7 issuer/validator; the wallet remains on stock BFA.8. The bridge test checks all five route commitments with Foundry and verifies exported proofs independently. Its restart is orderly after an injected committed-result failure, not an arbitrary process crash at every possible boundary.

The generic mint receive learns an unknown asset through a real transfer. It does not qualify standalone USDT preregistration, which remains unavailable. Hosted settlement and current Iris application acceptance are not included. Seed-only Bitcoin discovery does not establish RGB state restoration from a seed.

Reproducible repository entry points are [desktop packed qualification](../../scripts/qualify-desktop.sh), [funded sends](../../scripts/qualify-sends.mjs), [real-expiry cancellation](../../scripts/qualify-stock-cancellation.mjs), and [native transport tests](../../native/tests). Each fixture command requires explicitly disposable local services. The bridge and Core receipts additionally record their exact packed inputs and test scopes; they are not claims that those hosted integrations have been exercised.

See the [qualification register](../../QUALIFICATION.md#alpha24-unmodified-bfa8-adapter) for the platform matrix and remaining release limits.
