# Alpha.24 qualification evidence

These receipts describe the unmodified BFA.8 candidate. They contain disposable transaction IDs and public test results, not seeds, wallet databases, signed transactions or proxy credentials.

The native build source is `b550b504ebde2274b9a3c506a2b935324c481728`. BFA.8 is `2f7b21d8637baad548504ea870deb2c0d4d0a37d`, tree `5492824f3cf47b4c821dfca8b7a63fed27858486`. The funded host archive has SHA-256 `c2ecdef68aa785bbad12d6df72b5d96febe8a84595fc658e732fca9a5337ed01`. Its Apple Silicon Node worker and Bare addon are identified in each receipt. Desktop qualification used Node 22.23.3 and Bare 1.37.1 locally; CI uses its separately pinned toolchains.

| Receipt | Actual scope |
| --- | --- |
| [Ordinary RGB](funded-ordinary.json) | Node and Bare: funded NIA/CFA issuance, blinded send, witness return, blinded self-send, six confirmations, restart balances, issuance result-loss recovery, duplicate prevention and allocation on unrelated outputs during an outstanding send. |
| [Bridge](funded-bridge.json) | Node and Bare: two local generic first-receive BFA mints, ten V1 burns, independent commitments/proof validation, post-End journal-write failure and process-restart recovery with the original request. |
| [Core, Bitcoin and signing](funded-core-btc.json) | Latest Core beta.23 on Node and Bare; historical beta.22 policy on Node. Funded seed discovery, BTC send/result-loss recovery, independent authorization, BIP-322 and awaited teardown. |
| [Cancellation](cancellation.json) | All eight runtime/schema/recipient combinations, real expiry, reservation release, restart and lost-response recovery. [Four early attempts](cancellation-skew-window.json) within the clock margin stayed blocked. |
| [Signed-input expiry](signed-input-expiry.json) | Real stock-proxy retention expiry on Node and Bare. Failed transfers retain input protection, while the original signed transaction remains valid to Bitcoin. |
| [Live indexers](live-indexers.json) | Actual Node connections and reopen on Mainnet, Public Signet, Dev and staging. Empty wallets; no hosted proxy, bridge or payout operation. |
| [Platform matrix](platforms.json) | Sixteen admitted CI artifacts and all 19 SDK checks, with separate desktop execution and mobile ABI scopes. The full Bare manifest retains the funded local Apple Silicon addon. |
| [Full package](full-pack.json) | All 35 archive files, eleven native pins, installed consumer bytes and Git sources matched; actual Node and Bare consumers passed. |
| [Dependency audit](dependency-audit.json) | Locked Rust graph and runtime npm findings, with the advisory database revision. Functional tests do not clear these findings. |

The full archive was packed from `0f5395bff6fbc4435c78f2d99b2be5df92b68af0`: 203,483,933 bytes, SHA-256 `92890e387e75124d49f032dbea8528502700411fc817f0e2ab13ad14133c2312`. Runtime source files and the funded Darwin ARM64 addon match the original funded archive byte for byte. The full package adds ten target binaries and updates only documentation, development-dependency metadata and the target manifest. Its independent fresh install and Node/Bare smoke tests are recorded in the full-package receipt.

Ordinary tests use a new isolated Bitcoin/Fulcrum/Esplora/proxy fixture. Bridge tests use another isolated Bitcoin/Anvil/proxy fixture and a compatible independent BFA.7 issuer/validator; the wallet remains on stock BFA.8. The bridge test checks all five route commitments with Foundry and verifies exported proofs independently. Its restart is orderly after an injected committed-result failure, not an arbitrary process crash at every possible boundary.

The generic mint receive learns an unknown asset through a real transfer. It does not qualify standalone USDT preregistration, which remains unavailable. Hosted settlement and current Iris application acceptance are not included. Seed-only Bitcoin discovery does not establish RGB state restoration from a seed.

Reproducible repository entry points are [desktop packed qualification](../../scripts/qualify-desktop.sh), [funded sends](../../scripts/qualify-sends.mjs), [real-expiry cancellation](../../scripts/qualify-stock-cancellation.mjs), and [native transport tests](../../native/tests). Each fixture command requires explicitly disposable local services. The bridge and Core receipts additionally record their exact packed inputs and test scopes; they are not claims that those hosted integrations have been exercised.

See the [qualification register](../../QUALIFICATION.md#alpha24-unmodified-bfa8-adapter) for the platform matrix and remaining release limits.
