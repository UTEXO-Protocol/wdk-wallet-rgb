#!/usr/bin/env bash
# Build the ARM64 APK addon from the pinned native dependency graph.
set -euo pipefail

native_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
candidate_dir="$(cd "$native_dir/.." && pwd -P)"
cd "$native_dir"

sdk_dir="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ndk_dir="$sdk_dir/ndk/28.2.13676358"
llvm="$ndk_dir/toolchains/llvm/prebuilt/darwin-x86_64/bin"
compiler="$llvm/aarch64-linux-android26-clang"
if [[ ! -x "$compiler" ]] || ! grep -qx 'Pkg.Revision = 28.2.13676358' "$ndk_dir/source.properties"; then
  printf '%s\n' 'Install Android NDK r28c (28.2.13676358) in the Android SDK.' >&2
  exit 1
fi

version="${1:-$(node -p 'require(process.argv[1]).version' "$candidate_dir/package.json")}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]]; then
  printf '%s\n' 'Expected an exact candidate package version.' >&2
  exit 1
fi

python3 scripts/prepare-source.py --bare
toolchain="$native_dir/target/bare-toolchain"
mkdir -p "$toolchain"
cp bare/package.json bare/package-lock.json "$toolchain/"
npm ci --prefix "$toolchain" --ignore-scripts --no-audit

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$native_dir/target/bare-android}"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$compiler"
export CC_aarch64_linux_android="$compiler"
export CXX_aarch64_linux_android="$llvm/aarch64-linux-android26-clang++"
export AR_aarch64_linux_android="$llvm/llvm-ar"
export RANLIB_aarch64_linux_android="$llvm/llvm-ranlib"
cargo +1.94.0 build --locked --manifest-path bare/Cargo.toml --release --target aarch64-linux-android

headers="$toolchain/node_modules/bare-headers/include"
output_dir="${UTEXO_BARE_OUTPUT_DIR:-$native_dir/target/bare-addon-android}"
mkdir -p "$output_dir"
output="$output_dir/utexo__wdk-wallet-rgb.bare"
temporary="$(mktemp "$output.XXXXXX")"
trap '[[ ! -e "$temporary" ]] || unlink "$temporary"' EXIT
# BareKit resolves js_* symbols from its global loader group. The exact
# versioned SONAME allows direct byte-copy staging without ELF rewriting.
"$compiler" -std=c11 -Wall -Wextra -Werror -O2 -fPIC -shared \
  "-DBARE_MODULE_NAME=\"utexo__wdk-wallet-rgb@$version\"" \
  -I "$headers" bare/binding.c "$CARGO_TARGET_DIR/aarch64-linux-android/release/libutexo_rgb_native_bare.a" \
  -Wl,--gc-sections,--exclude-libs,ALL,--fatal-warnings \
  -Wl,-z,relro,-z,now,-z,noexecstack,-z,nodelete,-z,max-page-size=16384,-z,common-page-size=16384 \
  "-Wl,-soname,libutexo__wdk-wallet-rgb.$version.so" \
  -ldl -llog -lm -o "$temporary"
chmod 644 "$temporary"
mv -f "$temporary" "$output"
printf '%s\n' "$output"
