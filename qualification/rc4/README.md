# RC4 qualification evidence

## Current Node addon pack

The current complete archive is `b6054baa…`, package source `1323731…`. It contains five rebuilt Node-API addons from `ca2deb6…` and eleven unchanged Bare addons from `c5b4c1f…`. `platforms.json` records their exact mixed producers and admission evidence. [Node addon evidence](node-addon/README.md) covers all 48 packed files, actual Node 22/24/26 concurrency, funded in-place executable-to-addon upgrades, transfers, mint/burn and proof recovery. Publication remains held.

The records below remain historical. They qualify their own executable-based archives and provide retained wallet baselines; they do not identify the new Node package. `dependency-audit.json` remains applicable because both Cargo locks and npm dependencies are unchanged.

## Previous executable-based release-preparation pack

The complete archive `c7b42d8b…`, package source `2331119…`, uses all sixteen binaries from producer `c5b4c1f…` with stock `url 2.5.9` and `form_urlencoded 1.2.3`. [the retained platform receipt](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/418b98dddf7b7e71dc6f9bbef3c8e50a89cdb4b5/qualification/rc4/platforms.json) records 19 passing CI jobs; `complete-pack.json` verifies all 41 files, eleven Bare addons, npm integrity and the local publication dry-run. Publication remains held. `dependency-audit.json` records the current locks and findings.

`funded-release.json` and `financial-release.json` record actual Node/Bare execution of that exact archive: two fresh funded RC3 updates, six retained RC4 wallets, fresh contract registration/mint, BTC/NIA/CFA/BFA transfers, all five configured V1 burn routes and lost-response/restart proof recovery. An independent audit checks four mints, twelve burns and eight transfers; new-asset balances reconcile as 6 − 1.28 = 4.72 units. The earlier asset retains 14.5 units. No EVM burn redemption was performed.

[Reproduction instructions and sanitized runners](funded-upgrade-fixture/release-rerun/README.md) reuse the isolated fixture below with a separate issuer and asset. Generated wallet state, seeds and raw proofs are excluded. Those mobile binaries have build/ABI acceptance; prior Iris app results do not qualify those hashes.

## Retained earlier RC4 upgrade evidence

`funded-upgrade-final-ci.json` records actual execution of the complete RC4 npm archive `3513c7b4…` with the CI-produced Darwin ARM64 Node worker `2c7b4f00…` and Bare addon `45c9c683…`. All 41 installed archive files were matched to the final tarball. The archive contains eleven Bare targets; this funded receipt exercises the two Darwin ARM64 runtimes. Other platform and mobile-app results have separate receipts.

Both direct upgrade tests started from fresh wallets created with the exact recovered RC3 archive and original native binaries. Each wallet received a genuine BFA mint, burned part of it, retained its proof and a pending generic blinded invoice, and issued NIA and CFA control assets. The final CI binaries then opened those same wallet directories. No reset or seed import substituted for the upgrade.

Passing final-pack scopes:

- Account keys, signing address, BTC/BFA balances, BFA/NIA/CFA metadata, and every previous transfer field and timestamp survive the direct RC3 upgrade.
- The original generic blinded invoice journal returns the same invoice when retried with the now-registered asset ID, without another approval, allocation or journal write. Both original recipients then receive actual BFA transfers after upgrade, demonstrating preservation of their private receive keys.
- Old burn proofs and recovery results remain byte-identical. Each CI runtime also commits a new burn, loses its successful native `burnEnd` response, recovers repeatedly and after restart, and rejects the duplicate operation. `burnEnd` executes once.
- Additional BFA transfers, transfer recovery after restart, BIP-322 and contract export pass on the final pack. Its runtime source files match those used for the broader local qualification.
- Iris's exact 648-byte Sandbox BUSDT contract imports and exports offline with matching name, ticker and precision. No hosted service is contacted.

`funded-upgrade-local.json` retains the earlier comprehensive local-host results separately. These additionally cover the original pending witness invoice receiving a mint after upgrade, fresh BFA import and mint, wrong-chain/ID/duplicate contract rejection, NIA/CFA issuance and transfer, and Bitcoin transfers. The local Node/Bare hashes differ from CI hashes and are not presented as the final CI binaries. Clean local builder receipts use producer `b765e9b…`; final CI receipt records that producer and SDK pack source `80d7af32…`.

`financial-reconciliation.json` independently checks the confirmed Bitcoin transactions, actual EVM lock calldata and finalized lock records, saved proof hashes and Bitcoin OP_RETURN commitments. A separate inspector built against the original unmodified upstream reads all eight burn proofs; Foundry independently reconstructs each V1 destination hash. The eight mints total 20 units, the eight confirmed burns total 5.5 units, and the six wallet balances after restart sum to the remaining 14.5 units. The bridge retains 20 units of backing because these tests do not redeem the burn proofs on EVM.

The fixture uses Bitcoin regtest, an RGB protocol 1.0 proxy and Anvil. Its unmodified old public RGB issuer is pinned to `567e5b83…` with protocol crates `0.11.2-rc.2`. Actual upstream `MinimalBridge`, `TestERC20` and `MockArbSys` test contracts use pinned OpenZeppelin `cab19933…`. Token locks and Bitcoin mint/burn commitments are real within this isolated fixture. EVM redemption of burns, hosted gateway/TEE enforcement, physical-device behavior and Play delivery/signature testing are outside this receipt. The original uploaded AAB was deleted; its exact SDK/native inputs were recovered.

Public runner sources and locked issuer dependencies are under `funded-upgrade-fixture/`, with hashes in `funded-upgrade-harness-sha256.json` (the original fixture files; the release-rerun subdirectory has its own hashes in `funded-release.json`). The execution layout is a qualification root containing `baseline/`, `upstream-upgrade-audit/old`, `upstream-upgrade-audit/target` and `fixture/`. Place the runner files in `fixture/`, and the issuer files in `fixture/issuer/{Cargo.toml,Cargo.lock,src/main.rs}`; place `contract-inspect.rs` in `fixture/issuer/src/bin/` for the read-only financial audit. Restore the immutable old source and exact packed baseline, fetch the pinned Solidity dependencies, then prepare the isolated fixture. The `old`/`new` phases produce the comprehensive local results. `ci-old`/`ci-old-ordinary` prepare fresh RC3 wallets; `ci-new` executes the direct final upgrade; `ci-pending` delivers to their original blinded invoices; `final` exercises the final pack again on the retained comprehensive-test wallets.

Never repeat a completed financial phase against the same state; reconcile its durable operation records instead. Generated seeds, native wallet state and private operation files are excluded. Shared stacks and existing app wallets were not touched.
