# RC3 qualification

RC3 uses unmodified public RGB-Tools rgb-lib `567e5b8308f70a6242137475394be5a82fc15c95` and registry RGB protocol crates `0.11.2-rc.2`. The SDK applies no dependency source patch or Cargo source override.

`native-android.json` records the four locally built Android addons admitted for the frozen source `469ac2d`. Those artifacts have build/ABI acceptance; Iris records actual application acceptance separately.

`funded-host.json` separates two exact installed archives. The Android qualification archive was exercised through the Node host with three funded mint receives, blinded/witness verification before payment and restart, five V1 burns, four generic-invoice cases, and four proof-rejection/recovery cases. A later Node-only compatible SQLite lock update was tested with another funded mint, all five V1 burns, and four cross-proxy NIA/CFA transfers. Every burn recovers its original proof after a process restart and lost final acknowledgement without another native Begin/End. The retained artifacts include original receipts and proof hashes; no seeds or wallet state are committed.

These are actual local Regtest/Anvil operations with a separately compiled issuer/proof validator using the same pristine public RGB source. Route commitments are independently verified. They do not establish hosted Dev settlement, external payouts, or mobile execution. The frozen Android and updated Node identities are not represented as one all-platform release archive.

Publication remains on hold. Full SDK release acceptance requires all five Node and eleven Bare targets, independent artifact admission, a complete packed consumer, and the documented dependency-risk decision. Seven upstream Esplora TLS findings remain; the SQLite advisory is absent from both current native locks.
