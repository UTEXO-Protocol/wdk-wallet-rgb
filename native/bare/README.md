# Bare host candidate

The alpha.7 qualification record below covers the Electrum-only build. Alpha.8
and alpha.9 carry the Dev Esplora backend with hosted Dev access disabled.
Alpha.10 enables the exact Dev profile for manual testing. See the
[Dev native test instructions](../README.md#dev-checkpoint-candidate).

The private SDK candidate uses the same watch-only engine for the Node and Bare hosts. The standalone Bare build targets an Apple Silicon Mac. The addon receives public wallet keys, transaction and proof requests. The host owns private signing and durable mutation recovery.

## Exact sources

- RGB BFA.5 tag and default branch at `0a9d352f2690902df2b6fae9bca1a6c13c3354d4`.
- Functional contract admission, mint conservation, public Signet and guarded proxy, issuer and EVM egress overlay tree `be8930be04b8d65a704333fe7c215ba1f2186c35`.
- Embedded integration tree for the existing alpha.7 artifact `3697d02a29d126acb22aaf9ac19cccf9412cce84`. Its additional patch removes rgb-lib's wallet-open panic hook. That process-global hook otherwise chains on every reopen and retains the closed wallet logger.
- The independent Bare `Cargo.lock` and `Cargo.toml` enable Electrum and omit Esplora and Bitcoin Core indexer features. The lock includes the latest versions resolved for Rust 1.94.0 from the refreshed dependency index. `crypto-common 0.1.7` requires `generic-array =0.14.7`.
- Build headers `bare-headers@1.35.0` and standalone test CLI `bare@1.36.2`. The macOS CLI run reported runtime `1.36.0`. The Android Bare Kit 3.0.1 worklet reported runtime `1.36.2`. Exact npm tarball integrities are recorded in `package-lock.json`.

The recorded Electrum-only RustSec audit reported zero vulnerable crates and one unmaintained `unsafe-libyaml` dependency in the pinned strict-types graph. Repeat the audit for the actual release graph. The binding's wire format is JSON and the linked addon exposes only Bare's registration symbols. The Electrum resolver requires a server that serves verbose transaction responses, as well as genesis and merkle proof calls. This candidate's isolated funded test uses Fulcrum 2.1.4.

The [Dev checkpoint source candidate](../README.md#dev-checkpoint-candidate) uses a new tree identity. The Android verifier on this branch requires that identity. The existing alpha.7 pack uses the artifact identities listed above.

## Build and verify

Run from the native workspace. The first build requires authorized GitHub read access to the pinned private RGB source and mirrors.

```sh
env CARGO_NET_GIT_FETCH_WITH_CLI=true \
  GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0='' \
  GIT_CONFIG_KEY_1=credential.helper 'GIT_CONFIG_VALUE_1=!gh auth git-credential' \
  bash scripts/build-bare.sh

env MACOSX_DEPLOYMENT_TARGET=11.0 CARGO_TARGET_DIR="$PWD/target/bare-rust" \
  cargo +1.94.0 test --manifest-path bare/Cargo.toml --release --locked
cargo audit --file bare/Cargo.lock
```

The script checks the exact prepared RGB source tree and builds the addon into `target/bare-addon/utexo__wdk-wallet-rgb.bare`. Stage that file under the candidate package's `prebuilds/darwin-arm64/` and generate the package manifest from its byte count and SHA-256 before packing. The binary builds against the macOS 11 ARM64 deployment ABI. The tested Bare runtime has a macOS 13 minimum. Run the direct addon smoke test from the native workspace after installing the candidate package's dependencies.

```sh
target/bare-toolchain/node_modules/.bin/bare bare/smoke.cjs
```

The addon accepts one bounded request at a time on its owning JS worker. Each wrapped wallet has an explicit destroy path and a JS environment finalizer. Closing or destroying releases wallet state before the file lock, including when a worker tears down with a live wrapper. The addon keeps its code mapped for the rgb-lib process-wide Tokio runtime, which can outlive any one JS worker. Native failures return fixed error messages. A caught panic makes the affected engine terminal so the host can reopen and reconcile any uncertain mutation.

The earlier alpha.1 qualification covered desktop Bare, isolated Regtest and loopback services. Public Electrum TLS, hosted bridge settlement and wallet app integration require separate qualification.

## Android test addon

The Android test candidate builds the pinned Electrum and Dev Esplora
engine on macOS ARM64 with Rust 1.94.0 and Android NDK r28c
`28.2.13676358`. Its native target is `aarch64-linux-android` with API 26.
The standalone app's BareKit runtime can impose a higher minimum API.

```sh
rustup target add --toolchain 1.94.0 aarch64-linux-android
candidate_version="$(node -p 'require("../package.json").version')"
bash scripts/build-bare-android.sh "$candidate_version"
node scripts/verify-bare-android.mjs \
  target/bare-addon-android/utexo__wdk-wallet-rgb.bare \
  /absolute/path/to/libbare-kit.so "$candidate_version"
```

Package the original build under `prebuilds/android-arm64/utexo__wdk-wallet-rgb.bare`.
For a linked Android bundle, copy its exact bytes into the app's native library
directory under `libutexo__wdk-wallet-rgb.<candidate-version>.so`. The linker already
sets that SONAME, so this addon needs no ELF rewrite. The verifier checks
16-KiB LOAD alignment, RELRO protection for the dynamic table and GOT, non-
executable stack, immediate binding, the two Bare exports and imports against
the exact BareKit runtime and NDK system symbols. The Android link sets
`DF_1_NODELETE` to keep the process-wide Tokio code resident across worklet
teardown.

Record both the original addon hash and its final APK entry hash. Confirm the
signed APK's 16-KiB ZIP alignment and test it in an actual 16-KiB Android
process. Building the ELF alone establishes none of those runtime properties.
