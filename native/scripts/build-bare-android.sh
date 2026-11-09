#!/usr/bin/env bash
# Build an Android APK addon from the pinned native dependency graph.
set -euo pipefail

native_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
candidate_dir="$(cd "$native_dir/.." && pwd -P)"
cd "$native_dir"

if (( $# > 2 )); then
  printf '%s\n' 'Usage: build-bare-android.sh [CANDIDATE_VERSION] [BARE_TARGET]' >&2
  exit 1
fi
version="${1:-$(node -p 'require(process.argv[1]).version' "$candidate_dir/package.json")}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]]; then
  printf '%s\n' 'Expected an exact candidate package version.' >&2
  exit 1
fi
target="${2:-android-arm64}"
case "$target" in
  android-arm64) rust_target=aarch64-linux-android; clang_target=aarch64-linux-android ;;
  android-arm) rust_target=armv7-linux-androideabi; clang_target=armv7a-linux-androideabi ;;
  android-x64) rust_target=x86_64-linux-android; clang_target=x86_64-linux-android ;;
  android-ia32) rust_target=i686-linux-android; clang_target=i686-linux-android ;;
  *) printf 'Unsupported Bare Android target: %s\n' "$target" >&2; exit 1 ;;
esac

case "$(uname -s)" in
  Darwin) ndk_host=darwin-x86_64; default_sdk="$HOME/Library/Android/sdk" ;;
  Linux) ndk_host=linux-x86_64; default_sdk="$HOME/Android/Sdk" ;;
  *) printf '%s\n' 'Use a macOS or Linux Android NDK host.' >&2; exit 1 ;;
esac
sdk_dir="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$default_sdk}}"
ndk_dir="$sdk_dir/ndk/28.2.13676358"
llvm="$ndk_dir/toolchains/llvm/prebuilt/$ndk_host/bin"
compiler="$llvm/${clang_target}26-clang"
if [[ ! -x "$compiler" ]] || ! grep -qx 'Pkg.Revision = 28.2.13676358' "$ndk_dir/source.properties"; then
  printf '%s\n' 'Install Android NDK r28c (28.2.13676358) in the Android SDK.' >&2
  exit 1
fi

python3 scripts/prepare-source.py --bare
toolchain="$native_dir/target/bare-toolchain"
mkdir -p "$toolchain"
cp bare/package.json bare/package-lock.json "$toolchain/"
npm ci --prefix "$toolchain" --ignore-scripts --no-audit

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$native_dir/target/bare-android}"
toolchain_target="${rust_target//-/_}"
linker_target="$(printf '%s' "$toolchain_target" | tr '[:lower:]' '[:upper:]')"
export "CARGO_TARGET_${linker_target}_LINKER=$compiler"
export "CC_${toolchain_target}=$compiler"
export "CXX_${toolchain_target}=$compiler++"
export "AR_${toolchain_target}=$llvm/llvm-ar"
export "RANLIB_${toolchain_target}=$llvm/llvm-ranlib"
cargo +1.94.0 build --locked --manifest-path bare/Cargo.toml --release --target "$rust_target"

headers="$toolchain/node_modules/bare-headers/include"
default_output_dir="$native_dir/target/bare-addon-$target"
if [[ "$target" == android-arm64 ]]; then
  default_output_dir="$native_dir/target/bare-addon-android"
fi
output_dir="${UTEXO_BARE_OUTPUT_DIR:-$default_output_dir}"
mkdir -p "$output_dir"
output="$output_dir/utexo__wdk-wallet-rgb.bare"
temporary="$(mktemp "$output.XXXXXX")"
trap '[[ ! -e "$temporary" ]] || unlink "$temporary"' EXIT
# BareKit resolves js_* symbols from its global loader group. The exact
# versioned SONAME allows direct byte-copy staging without ELF rewriting.
"$compiler" -std=c11 -Wall -Wextra -Werror -O2 -fPIC -shared \
  "-DBARE_MODULE_NAME=\"utexo__wdk-wallet-rgb@$version\"" \
  -I "$headers" bare/binding.c "$CARGO_TARGET_DIR/$rust_target/release/libutexo_rgb_native_bare.a" \
  -Wl,--gc-sections,--exclude-libs,ALL,--fatal-warnings \
  -Wl,-z,relro,-z,now,-z,noexecstack,-z,nodelete,-z,max-page-size=16384,-z,common-page-size=16384 \
  "-Wl,-soname,libutexo__wdk-wallet-rgb.$version.so" \
  -ldl -llog -lm -o "$temporary"
chmod 644 "$temporary"
mv -f "$temporary" "$output"
printf '%s\n' "$output"
