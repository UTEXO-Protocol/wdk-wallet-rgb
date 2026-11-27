# Public contract test fixtures

`regtest-public-contract.rgb.base64` contains a pure public RGB contract used by the current native contract registration/export tests. Its 210 decoded bytes have SHA-256 `c7f1400bc974f2a44d0e7c2b16dab25d5d8d7281a5ccec98f1eab43098301041` and asset ID `rgb:mp_lQhFX-fPKiRA8-N_Rcwho-QrMcV1N-U2gI6HE-FL96Hj4`.

The tests check exact asset ID and digest, zero balance and transfers after registration, explicit duplicate rejection, export/reimport, reopen, and wrong-chain rejection without registering the asset. They run offline and do not qualify minting, transfer settlement or a hosted deployment. Funded RC4 fixtures and their independent issuer are documented in [qualification/rc4](../../../qualification/rc4/README.md).

`regtest-bfa.5.rgb.base64` and `regtest-bfa.6.rgb.base64` are retained historical public fixtures. Current native tests do not consume them; their older schema-specific registration checks do not qualify the current upstream source. Their original identities and scope remain in the [historical fixture documentation](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/a6dd195b3988b6fccd70dce9a66c2577ac368853/native/tests/fixtures/README.md).

These files contain no private wallet state. Production applications supply their own issuer-approved export, expected asset ID and SHA-256; the SDK package includes no deployment-specific USDT contract. A re-export preserves an asset ID only when the committed genesis and schema remain unchanged.
