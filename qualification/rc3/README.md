# RC3 qualification

RC3 uses unmodified public RGB-Tools rgb-lib `567e5b8308f70a6242137475394be5a82fc15c95` and registry RGB protocol crates `0.11.2-rc.2`. The SDK applies no dependency source patch or Cargo source override.

## Current Sandbox rebuild and application

The current [platform receipt](platforms.json) names producer `5de1c87f1fe448a571aad8724e9d24217ffb6b2e`, not the earlier producer `83c6f65`. [Run 44795524124](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/actions/runs/44795524124) passes all nineteen jobs for five Node workers and eleven Bare addons. Nine desktop targets execute packed consumers; seven mobile targets have build/ABI acceptance. Both current locks use SQLx `0.9.1` and bundled SQLite `3.54.1`. Seven upstream Esplora TLS findings remain.

The complete qualification archive is SDK source `fd34803214b9c490f71e2cf8155b063ef9b6175c`, SHA-256 `9ea21275c335cb037c93646bf2d47182c79a1c48d1be56b4a7af98b6b3a9e1c4`, 208,357,458 bytes and 41 files. All thirty packed source files match their committed blobs and all eleven Bare addons match admitted originals. Actual packed Darwin ARM64 Node 22 and Bare 1.37.1 consumers pass a local BFA mint and ten V1 burns across all five configured routes, losing final acknowledgement and recovering the exact original proof after restart without another burn. Independent commitment/proof checks and eight blinded/witness optional-amount invoice cases pass. These are isolated Regtest/Anvil host operations, not public payout acceptance.

[Iris #11](https://github.com/UTEXO-Protocol/utexo-mobile/pull/11) source `1d7dd66bb3ca83eb36e0aa5a1add429a009c4fb9` uses that exact SDK archive. Its admitted Android Release APK SHA-256 is `81f1d26805d139299164309e9f3b8b119d00be47c6e184291eb4be54330e22b2`. Installed replacement preserves the funded wallet; genuine biometric unlock, automatic 24-hour Witness receive, invoice copy and Connected apps controls pass. All 4,675 source tests, types and lint pass. Sandbox now uses the `signet` WalletConnect namespace with WebRGB/WalletConnect `0.1.7`; Dev retains `utexo`. Hosted relay/mint/burn, new iOS execution and physical-device acceptance are not established. An intermittent receive-status refresh warning remains unresolved.

`publicationHold: true` remains. [Release order and provenance requirements](../../RELEASING.md#pr-and-application-order) apply before using a new archive or registry package. Repository-only documentation updates do not change the frozen archive identity above.

## Earlier RC3 receipts

The following records retain their original sources and archive identities. In particular, `funded-host.json` describes earlier packs and does not qualify the later Sandbox producer by itself.

`native-android.json` records the four locally built Android addons admitted for the frozen source `469ac2d`. Those artifacts have build/ABI acceptance; Iris records actual application acceptance separately.

`funded-host.json` separates two exact installed archives. The Android qualification archive was exercised through the Node host with three funded mint receives, blinded/witness verification before payment and restart, five V1 burns, four generic-invoice cases, and four proof-rejection/recovery cases. A later Node-only compatible SQLite lock update was tested with another funded mint, all five V1 burns, and four cross-proxy NIA/CFA transfers. Every burn recovers its original proof after a process restart and lost final acknowledgement without another native Begin/End. The retained artifacts include original receipts and proof hashes; no seeds or wallet state are committed.

These are actual local Regtest/Anvil operations with a separately compiled issuer/proof validator using the same pristine public RGB source. Route commitments are independently verified. They do not establish hosted Dev settlement, external payouts, or mobile execution. The frozen Android and updated Node identities are not represented as one all-platform release archive.

The earlier complete RC3 matrix rebuilt all five Node and eleven Bare targets from producer `83c6f65`; all nineteen CI jobs passed. The current `platforms.json` has since been replaced by the separately admitted Sandbox producer described above. Publication remained on hold; these older receipts must retain their original binary and archive identities.

The complete archive is source `2dfcd57`, SHA-256 `c14c593010b7a21132092f74c7654f326e2e6ff8f6626cfe3587bed5fd515582` (208,355,903 bytes, 41 files). All 30 packed source files match their committed Git blobs; all 11 addons match the admitted manifest. Both actual CI host binaries execute the packed archive successfully. Six funded mint receives, ten V1 burns, eight generic invoices, eight negative-proof/recovery cases and eight cross-proxy NIA/CFA transfers pass. Each runtime also checks immutable public-key export and offline lifecycle on all five profiles. These remain local host tests; mobile application acceptance and hosted Dev settlement are separate.

The final JavaScript submission repair is packed from `2210de2`, SHA-256 `640bf91ab4437a15a318683106540e76c2671223eee35e345937fe73421f9f24` (208,356,588 bytes; the same 30 source files and 11 exact producer83 addons). Its 96 JavaScript tests and 17 release regressions pass. Actual installed Node/Bare consumers each pass five funded vanilla failure/recovery cases: pre-End output and BTC aborts, shutdown during the submitting journal write, and lost responses after output/BTC End. Only the exact live native prepared guard plus a durable terminal journal acknowledgement resolves a failed pre-End operation. A consumed/missing guard, failed persistence or closed worker leaves it unknown. No End is retried.

The final archive also repeats two actual BFA mints and all ten five-route burns across Node and Bare, including lost final acknowledgement, process restart, exact proof recovery, independent commitment/proof checks and rejected replay. All native build inputs remain equivalent to producer83. These tests establish the repaired race and local host behavior; they do not establish the cause of the earlier Dev APK output failure.
