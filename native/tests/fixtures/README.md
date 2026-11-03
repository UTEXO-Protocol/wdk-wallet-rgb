# Contract fixture scope

`regtest-bfa.5.rgb.base64` is a synthetic public BFA contract independently issued by the isolated Regtest fixture. The decoded bytes have SHA-256 `7eabc7ff78e046ad2b6f26e1d61b5c151ffa53870ced7001bc2a15c80ddfd3f8`. They contain no wallet private material. The test validates exact contract identity and idempotent genesis registration with no settled or spendable balance.

The earlier hosted compatibility check used the exact dev and staging public exports outside this repository. Both failed decoding on the pinned BFA.5 graph before asset registration. The older crates.io `rgb-ops 0.11.2-rc.1` and the newer BFA.5 private mirror share a version label and use different serialized layouts. [Mirror change](https://github.com/UTEXO-Protocol/rgb-ops-s-bfa/commit/864995c8a26b89811b94ed27ec4cc0946a82cd46)

| Environment | Export SHA-256 |
| --- | --- |
| Dev | `dfb49261fed5ad3dd237dd3a03913793b76fe70e486372bbeb0769b82158a895` |
| Staging | `206cf6de601806d4ffbdfc05398e6934586a6523ede51aab3cd1360c04416bc5` |

Use issuer-approved re-exports that preserve the original asset IDs. Qualify the exact deployed invoice, mint and proof protocol with gateway, signer, proxy and contracts together. Keep externally supplied exports and test wallet state outside the checked-in fixture set.
