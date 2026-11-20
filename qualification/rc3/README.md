# RC3 qualification

RC3 uses unmodified public RGB-Tools rgb-lib `567e5b8308f70a6242137475394be5a82fc15c95` and registry RGB protocol crates `0.11.2-rc.2`. The SDK applies no dependency source patch or Cargo source override.

`native-android.json` records the four locally built Android addons admitted for the frozen source `469ac2d`. Those artifacts have build/ABI acceptance; Iris records actual application acceptance separately.

`funded-host.json` separates two exact installed archives. The Android qualification archive was exercised through the Node host with three funded mint receives, blinded/witness verification before payment and restart, five V1 burns, four generic-invoice cases, and four proof-rejection/recovery cases. A later Node-only compatible SQLite lock update was tested with another funded mint, all five V1 burns, and four cross-proxy NIA/CFA transfers. Every burn recovers its original proof after a process restart and lost final acknowledgement without another native Begin/End. The retained artifacts include original receipts and proof hashes; no seeds or wallet state are committed.

These are actual local Regtest/Anvil operations with a separately compiled issuer/proof validator using the same pristine public RGB source. Route commitments are independently verified. They do not establish hosted Dev settlement, external payouts, or mobile execution. The frozen Android and updated Node identities are not represented as one all-platform release archive.

All five Node and eleven Bare targets were rebuilt from producer `83c6f65`; all nineteen CI jobs passed. `platforms.json` independently admits the exact archives, native receipts, binary bytes and ABI. Publication remains on hold pending the complete-archive consumer evidence and documented dependency-risk decision. Seven upstream Esplora TLS findings remain; the SQLite advisory is absent from both current native locks.

The complete archive is source `2dfcd57`, SHA-256 `c14c593010b7a21132092f74c7654f326e2e6ff8f6626cfe3587bed5fd515582` (208,355,903 bytes, 41 files). All 30 packed source files match their committed Git blobs; all 11 addons match the admitted manifest. Both actual CI host binaries execute the packed archive successfully. Six funded mint receives, ten V1 burns, eight generic invoices, eight negative-proof/recovery cases and eight cross-proxy NIA/CFA transfers pass. Each runtime also checks immutable public-key export and offline lifecycle on all five profiles. These remain local host tests; mobile application acceptance and hosted Dev settlement are separate.
