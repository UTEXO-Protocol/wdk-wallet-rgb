# Bare host candidate

Builds use unmodified BFA.8 and stock client crates. Artifact admission is separate from compilation; record and verify each target before packaging. See [current qualification](../../QUALIFICATION.md).

Alpha.14 is the private BFA.7 Android candidate for manual Dev testing. Alpha.10 uses the earlier BFA.5 Dev profile. See the [Dev checkpoint scope](../README.md#dev-checkpoint-candidate).

The private SDK candidate uses the same watch-only engine for the Node and Bare hosts. The standalone Bare build targets an Apple Silicon Mac. The addon receives public wallet keys, transaction and proof requests. The host owns private signing and durable mutation recovery.

## Exact sources

- RGB BFA.8 tag at `2f7b21d8637baad548504ea870deb2c0d4d0a37d`.
- The [source preparation script](../scripts/prepare-source.py) verifies the unmodified upstream tree. Stock RGB installs a process-wide logging panic hook. Wallet close drops its logger guard and joins its logging thread; captured hook/logger allocations can accumulate across constructions. No custom hook replacement is performed by this addon.
- The independent Bare lock enables Electrum and the gated Dev Esplora backend.
- Build headers `bare-headers@1.35.0`, standalone CLI `bare@1.37.1` and `bare-runtime@1.37.1`. The SDK requires Bare 1.37.1 or newer, including embedded mobile runtimes. Android symbol qualification uses Bare Kit 3.0.1 with Bare source `32aa0ae69da547f0d0cca011f3e8bcbbfc9f44c3` (v1.37.1). Earlier runtime acceptance does not qualify this version. Exact npm tarball integrities are recorded in `package-lock.json`.

The recorded Electrum-only RustSec audit reported zero vulnerable crates and one unmaintained `unsafe-libyaml` dependency in the pinned strict-types graph. Repeat the audit for the actual release graph. The binding's wire format is JSON and the linked addon exposes only Bare's registration symbols. The Electrum resolver requires a server that serves verbose transaction responses, as well as genesis and merkle proof calls. This candidate's isolated funded test uses Fulcrum 2.1.4.

## Build and verify

Run from the native workspace. The first build requires authorized GitHub read access to the pinned private RGB source and dependency revisions.

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
