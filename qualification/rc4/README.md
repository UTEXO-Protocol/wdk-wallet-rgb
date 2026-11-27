# RC4 funded contract API upgrade qualification

`funded-upgrade-local.json` records actual packed Node and Bare Darwin ARM64 tests. Both started from the exact recovered RC3 npm archive and native binaries, created genuine BFA holdings, a burn proof and pending generic receive invoices, then reopened the same wallet directories under RC4. No wallet reset or seed import substituted for that upgrade.

Passing scopes:

- Account keys, address derivation sequence, BTC/BFA balances, transfer identities and the old burn proof survive the upgrade.
- Both old blinded and witness invoice journals return the original invoice when retried with the newly registered asset ID. No repeated approval, native allocation or journal rewrite occurs.
- A mint to an original pending invoice completes after upgrade.
- Dropping a successful native `burnEnd` response leaves a recoverable operation. Repeated recovery and restart preserve the proof; reusing the burn operation ID is rejected and `burnEnd` executes once.
- Fresh BFA contract import/export, duplicate rejection and mint; BFA, NIA, CFA and Bitcoin transfers; BIP-322 and restart checks pass.
- Iris's exact 648-byte Sandbox BUSDT contract imports and exports offline with matching name, ticker and precision. Wrong-chain and wrong-ID imports leave no asset; duplicate import is rejected. No hosted service is contacted for this test.

The initial funded RC4 archive was the local host pack `8b9ba2e5…`, built before scripts-only producer changes. Final local producer `b765e9b…` retains the exact tested Node `ebf19da7…` and Bare `00f0c252…` bytes; its separate clean-source build receipts are in `qualification/local-rc4-node/` and `qualification/local-rc4-bare/`. Complete CI-matrix packaging and execution of those exact CI binaries remain a separate acceptance scope, not implied by these local passes.

The fixture uses Bitcoin regtest, an RGB protocol 1.0 proxy and Anvil. Its unmodified old public RGB issuer is pinned to `567e5b83…` with protocol crates `0.11.2-rc.2`. Actual upstream `MinimalBridge`, `TestERC20` and `MockArbSys` test contracts use pinned OpenZeppelin `cab19933…`. Token locks and Bitcoin mint/burn commitments are real within this isolated fixture. EVM redemption of burns, hosted gateway/TEE enforcement, physical-device behavior and the deleted original Play AAB are outside this receipt.

The public runner sources and locked issuer dependencies are under `funded-upgrade-fixture/`; hashes are in `funded-upgrade-harness-sha256.json`. Their execution layout is a qualification root containing `baseline/`, `upstream-upgrade-audit/old`, `upstream-upgrade-audit/target` and `fixture/`. Place the runner files in `fixture/`, and the issuer files in `fixture/issuer/{Cargo.toml,Cargo.lock,src/main.rs}`. Restore the old immutable source and exact packed baseline, fetch the pinned Solidity dependencies, then use the fixture's `setup`, `old`, `new` and `final` phases. Never rerun a completed financial phase against the same state; reconcile its durable operation records instead.

Generated seeds, native wallet state and private operation files are intentionally excluded. The retained local fixture supports final-pack acceptance without touching shared stacks or existing app wallets.
