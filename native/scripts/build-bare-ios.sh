#!/usr/bin/env bash
# Build an iOS Bare addon for one device or simulator slice.
set -euo pipefail

native_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
candidate_dir="$(cd "$native_dir/.." && pwd -P)"
cd "$native_dir"

if [[ $# -lt 1 || $# -gt 2 ]]; then
  printf '%s\n' 'Usage: build-bare-ios.sh <ios-arm64|ios-arm64-simulator|ios-x64-simulator> [version]' >&2
  exit 1
fi
host="$1"
case "$host" in
  ios-arm64)
    rust_target=aarch64-apple-ios
    arch=arm64
    sdk=iphoneos
    platform=IOS
    suffix=
    ;;
  ios-arm64-simulator)
    rust_target=aarch64-apple-ios-sim
    arch=arm64
    sdk=iphonesimulator
    platform=IOSSIMULATOR
    suffix=-simulator
    ;;
  ios-x64-simulator)
    rust_target=x86_64-apple-ios
    arch=x86_64
    sdk=iphonesimulator
    platform=IOSSIMULATOR
    suffix=-simulator
    ;;
  *)
    printf '%s\n' 'Expected an iOS device or simulator Bare target.' >&2
    exit 1
    ;;
esac

version="${2:-$(node -p 'require(process.argv[1]).version' "$candidate_dir/package.json")}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]]; then
  printf '%s\n' 'Expected an exact candidate package version.' >&2
  exit 1
fi

export IPHONEOS_DEPLOYMENT_TARGET=16.4
SDKROOT="$(xcrun --sdk "$sdk" --show-sdk-path)"
export SDKROOT
clang_target="$arch-apple-ios$IPHONEOS_DEPLOYMENT_TARGET$suffix"
if ! rustup target list --installed --toolchain 1.94.0 | grep -Fxq "$rust_target"; then
  printf 'Install Rust 1.94.0 and its %s target.\n' "$rust_target" >&2
  exit 1
fi

python3 scripts/prepare-source.py --bare
toolchain="$native_dir/target/bare-toolchain"
mkdir -p "$toolchain"
cp bare/package.json bare/package-lock.json "$toolchain/"
npm ci --prefix "$toolchain" --ignore-scripts --no-audit

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$native_dir/target/bare-ios}"
cargo +1.94.0 build --manifest-path bare/Cargo.toml --release --locked --target "$rust_target"

headers="$toolchain/node_modules/bare-headers/include"
output_dir="${UTEXO_BARE_OUTPUT_DIR:-$native_dir/target/bare-addon-ios/$host}"
mkdir -p "$output_dir"
staging="$(mktemp -d "$output_dir/.build.XXXXXX")"
binding="$staging/binding.o"
addon="$staging/utexo__wdk-wallet-rgb.bare"
trap '[[ ! -e "$binding" ]] || unlink "$binding"; [[ ! -e "$addon" ]] || unlink "$addon"; rmdir "$staging"' EXIT

xcrun --sdk "$sdk" clang -target "$clang_target" -isysroot "$SDKROOT" \
  -std=c11 -Wall -Wextra -Werror -O2 -fPIC \
  -D_DARWIN_C_SOURCE "-DBARE_MODULE_NAME=\"utexo__wdk-wallet-rgb@$version\"" \
  -I "$headers" -c bare/binding.c -o "$binding"

# Only Bare's C ABI may remain undefined. Bare Link packages the resulting
# dylib as a framework that BareKit resolves from the app's Frameworks folder.
bare_symbols=()
while IFS= read -r symbol; do
  bare_symbols+=("-Wl,-U,$symbol")
done < <(xcrun nm -uj "$binding" | grep '^_js_')
test "${#bare_symbols[@]}" -gt 0

install_name=utexo__wdk-wallet-rgb@2.bare
xcrun --sdk "$sdk" clang -target "$clang_target" -isysroot "$SDKROOT" \
  -dynamiclib "$binding" "$CARGO_TARGET_DIR/$rust_target/release/libutexo_rgb_native_bare.a" \
  -Wl,-dead_strip,-fatal_warnings,-headerpad_max_install_names \
  "-Wl,-install_name,$install_name" "${bare_symbols[@]}" \
  -Wl,-exported_symbol,_bare_get_module_name_v0 -Wl,-exported_symbol,_bare_register_module_v0 \
  -framework Security -framework CoreFoundation -framework SystemConfiguration \
  -lresolv -liconv -lc++ -o "$addon"

test "$(xcrun lipo -archs "$addon")" = "$arch"
build_info="$(xcrun vtool -show-build "$addon")"
grep -Eq "^ *platform $platform$" <<< "$build_info"
grep -Eq '^ *minos 16\.4$' <<< "$build_info"
test "$(xcrun otool -D "$addon" | tail -n 1)" = "$install_name"
test "$(xcrun nm -gjU "$addon" | LC_ALL=C sort)" = $'_bare_get_module_name_v0\n_bare_register_module_v0'
grep -aFq "utexo__wdk-wallet-rgb@$version" "$addon"

output="$output_dir/utexo__wdk-wallet-rgb.bare"
chmod 644 "$addon"
mv -f "$addon" "$output"
printf '%s\n' "$output"
