# RC3 upgrade baseline

These inputs are retained to reproduce the direct RC3-to-RC4 wallet upgrade. They are historical qualification artifacts, not the current release package.

| Input | Identity |
| --- | --- |
| SDK version | `3.0.0-rc.3` |
| Package source | `fd34803214b9c490f71e2cf8155b063ef9b6175c` |
| Archive SHA-256 | `9ea21275c335cb037c93646bf2d47182c79a1c48d1be56b4a7af98b6b3a9e1c4` |
| Archive inventory | 208,357,458 bytes; 41 files; eleven Bare addons |
| Native producer | `5de1c87f1fe448a571aad8724e9d24217ffb6b2e` |
| RGB source | `567e5b8308f70a6242137475394be5a82fc15c95` |
| Native producer CI | [Run 44795524124](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/actions/runs/44795524124) |

[Platform admission](platforms.json) preserves all sixteen native binary identities, archive digests, ABI requirements and source/lock receipts. [The historical dependency audit](dependency-audit.json) retains the findings and lock hashes for that graph; the RC4 audit is recorded separately.

The RC4 fixture uses the exact recovered archive and original host binaries to create and fund old wallets before opening their complete directories with the new package. [RC4 evidence](../rc4/README.md) records those executed upgrades. Recreating an empty wallet or importing its seed is not an upgrade test.

Superseded RC3 funded runs, early Android-only artifacts and historical application results remain available at [immutable commit a6dd195](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/tree/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc3). Their distinct source and package identities must not be reassigned to RC4.
