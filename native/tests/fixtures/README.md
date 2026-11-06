# Contract fixture scope

`regtest-bfa.6.rgb.base64` is a synthetic public BFA contract independently issued on isolated Regtest using upstream RGB BFA.6 at `5010eefa355beb9c42a4c1b69883f7651241a111`. The 309 decoded bytes have SHA-256 `60e78d9fc22b69ebd61aafbd37a530f98440cff7b33da5671494790fd3d78be1` and asset ID `rgb:seHWHNYA-~Fy85Df-sLB28o5-EcqC9F8-HW3mUaM-b7kRJgM`. The test validates exact identity, network binding and idempotent genesis registration with no settled or spendable balance.

`regtest-bfa.5.rgb.base64` is the prior synthetic public contract, with decoded SHA-256 `7eabc7ff78e046ad2b6f26e1d61b5c151ffa53870ced7001bc2a15c80ddfd3f8`. It tests rejection by the BFA.6 adapter. Both files contain public contract bytes.

The earlier hosted compatibility check used the exact dev and staging public exports outside this repository. Both failed decoding on the pinned BFA.5 graph before asset registration. The older crates.io `rgb-ops 0.11.2-rc.1` and the newer BFA.5 private mirror share a version label and use different serialized layouts. [Mirror change](https://github.com/UTEXO-Protocol/rgb-ops-s-bfa/commit/864995c8a26b89811b94ed27ec4cc0946a82cd46)

| Environment | Export SHA-256 |
| --- | --- |
| Dev | `dfb49261fed5ad3dd237dd3a03913793b76fe70e486372bbeb0769b82158a895` |
| Staging | `206cf6de601806d4ffbdfc05398e6934586a6523ede51aab3cd1360c04416bc5` |

The later BUSDT export recovered from Dev run `41698713237` is a separate BFA.5 contract. The offline BFA.6 rejection test reads it from `UTEXO_DEV_BUSDT_CONTRACT` and verifies SHA-256 `a678ebf73f3a0523b307cd2fe8019a321ac938eaf547c2c65a7ac079948332ce` before exercising the adapter.

Use issuer-approved re-exports that preserve the original asset IDs. Qualify the exact deployed invoice, mint and proof protocol with gateway, signer, proxy and contracts together. Keep externally supplied exports and test wallet state outside the checked-in fixture set.
