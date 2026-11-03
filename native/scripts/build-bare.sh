#!/usr/bin/env bash
# Build a host addon from the exact admitted Electrum-only graph.
set -euo pipefail

native_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
candidate_dir="$(cd "$native_dir/.." && pwd -P)"
cd "$native_dir"

if [[ "$(uname -s)-$(uname -m)" != Darwin-arm64 ]]; then
  printf '%s\n' 'This candidate only builds for Darwin arm64.' >&2
  exit 1
fi

python3 scripts/prepare-source.py --bare
toolchain="$native_dir/target/bare-toolchain"
mkdir -p "$toolchain"
cp bare/package.json bare/package-lock.json "$toolchain/"
npm ci --prefix "$toolchain" --ignore-scripts --no-audit

export MACOSX_DEPLOYMENT_TARGET=11.0
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$native_dir/target/bare-rust}"
cargo +1.94.0 build --manifest-path bare/Cargo.toml --release --locked

headers="$toolchain/node_modules/bare-headers/include"
version="$(node -p 'require(process.argv[1]).version' "$candidate_dir/package.json")"
output_dir="${UTEXO_BARE_OUTPUT_DIR:-$native_dir/target/bare-addon}"
mkdir -p "$output_dir"
output="$output_dir/utexo__wdk-wallet-rgb.bare"
temporary="$(mktemp "$output.XXXXXX")"
trap '[[ ! -e "$temporary" ]] || unlink "$temporary"' EXIT
xcrun --sdk macosx clang -std=c11 -Wall -Wextra -Werror -arch arm64 \
  -mmacosx-version-min=11.0 -O2 -dynamiclib -dead_strip \
  -D_DARWIN_C_SOURCE "-DBARE_MODULE_NAME=\"utexo__wdk-wallet-rgb@$version\"" \
  -I "$headers" bare/binding.c "$CARGO_TARGET_DIR/release/libutexo_rgb_native_bare.a" \
  -Wl,-fatal_warnings -Wl,-install_name,utexo__wdk-wallet-rgb@2.bare -Wl,-undefined,dynamic_lookup \
  -Wl,-exported_symbol,_bare_get_module_name_v0 -Wl,-exported_symbol,_bare_register_module_v0 \
  -framework Security -framework CoreFoundation -framework SystemConfiguration \
  -lresolv -liconv -o "$temporary"
mv -f "$temporary" "$output"
printf '%s\n' "$output"
