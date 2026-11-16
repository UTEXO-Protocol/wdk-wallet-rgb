# Version 3.0.0-rc.1 qualification

The native producer is `a6706783b3d232c190853cbe4a5221763aec8455`. The funded host package is built from `095cadbc337fc090545080dfc3e53dba3e665547`, with archive SHA-256 `5d89a8b80ab521b8a8c8d77592acdd809ce2c791058a1646663366c491f4ad02`. Later source changes may update notices, documentation, artifact pins and qualification tooling; the release-set verifier requires native source equivalence.

- [Platforms](platforms.json): all sixteen binaries from the same producer passed CI and independent artifact admission. Nine desktop targets executed packed consumers; seven mobile targets have build/ABI verification only.
- [Cross-proxy transfers](cross-proxy.json): eight funded NIA/CFA blinded/witness transfers on packed Node and Bare. Every case loses the native End response, restarts before ACK, recovers the same transaction and rejects a duplicate operation. Each settles at six confirmations; final balances survive restart.
- [BFA mint and burn](funded-bridge.json): two generic first-receive mints and ten V1 burns across five routes on packed Node and Bare. Independent commitment/proof validation and process restart recover the original proof without another native burn.
- [Core, Bitcoin and BIP-322](funded-core-btc.json): Core beta.23 on Node and Bare, funded same-engine seed discovery, policy/authorization denial, Bitcoin transfers, interrupted-result recovery and message-signing checks.
- [Dependency audit](dependency-audit.json): the unchanged stock findings, disclosed under the release owner's dependency policy.

Tests used disposable Regtest wallets, normal-retention protocol-1.0 proxies and an isolated BFA fixture with a compatible independent BFA.7 issuer/proof validator. The SDK itself uses unmodified BFA.8. Docker's clock and health were corrected before funding. No fixture expiry, acknowledgement or database record was edited to produce a passing result.

The first host run encountered the Bare CLI's missing executable bit after `npm install --ignore-scripts`. Its reviewed binary bytes were unchanged when executable permission was restored. Node results were retained and the Bare tests ran with fresh wallets. This was a test-host installation correction, not an SDK runtime change.

Seeds, complete wallet state and raw transaction/proof files remain outside the repository. These receipts do not establish hosted EVM payouts, Mainnet BFA, installed mobile-app acceptance or RGB recovery from a seed alone. Earlier cancellation/retention scopes remain identified by their alpha.24 artifacts; they are not relabeled as new RC1 expiry tests.
