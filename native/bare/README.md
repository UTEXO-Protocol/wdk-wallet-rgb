# Bare native builds

The addon uses the same watch-only engine as the Node worker. The application owns the seed, transaction review and signer. Builds use unmodified BFA.8 `2f7b21d8637baad548504ea870deb2c0d4d0a37d` with stock Electrum and Esplora clients. See the [qualification register](../../QUALIFICATION.md) for current results and dependency advisories.

The SDK requires **Bare 1.37.1 or newer**, including embedded mobile runtimes. The build locks pin `bare@1.37.1`, `bare-runtime@1.37.1` and `bare-headers@1.35.0`. Android symbol qualification uses Bare Kit 3.0.1 with Bare source `32aa0ae69da547f0d0cca011f3e8bcbbfc9f44c3`. An older app runtime must be updated and tested before integrating this candidate.

## Supported targets

| Host | Bare targets | Build requirements |
| --- | --- | --- |
| macOS | `darwin-arm64`, `darwin-x64` | Matching native host and Node architecture, Rust 1.94.0, Xcode command-line tools |
| Linux glibc | `linux-arm64`, `linux-x64` | Matching native host, Rust 1.94.0, C compiler, binutils and build tools |
| Android | `android-arm64`, `android-arm`, `android-x64`, `android-ia32` | Rust 1.94.0 target, Android NDK `28.2.13676358` |
| iOS | `ios-arm64`, `ios-arm64-simulator`, `ios-x64-simulator` | macOS, Rust 1.94.0 target and corresponding Xcode SDK |

The [CI workflow](../../.github/workflows/build.yml) builds this matrix and records ABI and binary identities. Desktop jobs execute the packed SDK and teardown tests. Mobile jobs build and inspect the addon; they do not establish application or device acceptance. Windows and Linux musl Bare are outside this matrix. The separate Node worker supports Linux musl x64.

## Build a desktop package

Run from a clean, committed repository checkout. Install the locked JavaScript dependencies and prepare the private RGB source using an authenticated GitHub CLI (`gh`); preparation invokes `gh auth git-credential`. An exact local source clone can instead be supplied as the preparation script's final argument. Compilation does not apply source patches.

```sh
npm ci --ignore-scripts --no-audit
python3 native/scripts/prepare-source.py --bare

# Select the current host from the table above. Use a new absolute output directory.
export UTEXO_BARE_OUTPUT_DIR=/absolute/path/to/new-build-output
export CARGO_BUILD_JOBS=3
bash native/scripts/build-bare.sh
bash scripts/qualify-desktop.sh bare linux-x64 "$UTEXO_BARE_OUTPUT_DIR"
```

Replace `linux-x64` with your host target. The qualifier archives the committed source into a temporary staging directory, records the newly built addon's hash, stages it there, and installs the resulting tarball into a separate consumer. It tests both a clean install and a host with the current `bare-type` dependency. The source checkout is unchanged. The tested `.tgz`, native binary, ABI receipt and logs remain in the output directory.

Use that tested tarball for your own build. `stage-bare.mjs` instead stages an artifact that already matches an admitted manifest pin; it intentionally rejects a different locally compiled binary. Do not copy an old binary into a new candidate or reuse its hash.

Additional engine tests and audits:

```sh
CARGO_TARGET_DIR="$PWD/native/target/bare-rust" \
  cargo +1.94.0 test --manifest-path native/bare/Cargo.toml --release --locked
cargo audit --file native/bare/Cargo.lock
```

macOS addons target the macOS 11 ABI; the selected Bare executable may require a newer macOS version. Linux receipts record the actual libc symbol requirements. Use the [Node build guide](../README.md) for worker verification and shared network/financial policies.

## Android

From the repository root:

```sh
rustup target add --toolchain 1.94.0 aarch64-linux-android
candidate_version="$(node -p 'require("./package.json").version')"
bash native/scripts/build-bare-android.sh "$candidate_version" android-arm64
node native/scripts/verify-bare-android.mjs \
  native/target/bare-addon-android/utexo__wdk-wallet-rgb.bare \
  /absolute/path/to/libbare-kit.so "$candidate_version" android-arm64
```

Use the matching Rust target and Bare target for another ABI. CI builds the exact BareKit runtime used by symbol verification. The addon targets Android API 26; the qualification runtime targets API 29. An application's minimum API must satisfy its complete native graph.

Package the original addon under its target-specific `prebuilds` path. A linked Android bundle uses those same bytes in the application's native library directory as `libutexo__wdk-wallet-rgb.<candidate-version>.so`. The linker sets that SONAME, so no ELF rewrite is needed. Verification covers 16-KiB LOAD alignment, RELRO, non-executable stack, immediate binding, the two Bare exports and imports against the runtime and NDK system symbols. `DF_1_NODELETE` keeps code used by the process-wide Tokio runtime resident across worklet teardown.

Record the original addon hash and final APK entry hash. Verify signed-APK ZIP alignment and execute the app in an actual 16-KiB Android process. ELF inspection alone does not qualify those properties.

## iOS

Install the required Rust target, then run `bash native/scripts/build-bare-ios.sh <target>` from the repository root. The script produces one device or simulator slice with deployment target iOS 16.4, verifies Mach-O platform/architecture and permits unresolved imports only from Bare's C ABI. The supported target names are in the table above.

Bare Link packages and signs the addon as an application framework. Admit the **final framework binary's** hash through the SDK's `nativeSha256` and `iosNativeFrameworkDir`; its bytes differ from the package prebuild. Qualify the framework in the actual application separately.

## Lifecycle

The addon accepts one bounded request at a time on its owning JS worker. Explicit destroy and the JS environment finalizer drop wallet state before releasing its directory lock. A caught panic makes the engine terminal; the host must reopen and reconcile any uncertain mutation. Closing a worker does not authorize replay of a financial request.

Stock RGB installs a process-wide logging panic hook. Dropping the wallet joins its logging thread, but captured hook/logger allocations can accumulate across constructions. The addon does not race the host by replacing its global hook. This cleanup limitation and the dependency audit findings remain distinct from the recorded ownership and reopen tests.
