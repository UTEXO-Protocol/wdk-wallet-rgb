#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Build a host Node-API addon from the pinned Node native dependency graph.
set -euo pipefail

native_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$native_dir"
if [[ $# != 2 ]]; then
  printf '%s\n' 'Usage: native/node/build.sh TARGET OUTPUT' >&2
  exit 1
fi
target="$1"
output="$2"
case "$target" in
  darwin-arm64) rust_target=aarch64-apple-darwin; system=Darwin; machine=arm64; arch=arm64 ;;
  darwin-x64) rust_target=x86_64-apple-darwin; system=Darwin; machine=x86_64; arch=x86_64 ;;
  linux-arm64-gnu) rust_target=aarch64-unknown-linux-gnu; system=Linux; machine=aarch64; elf_machine=AArch64 ;;
  linux-x64-gnu) rust_target=x86_64-unknown-linux-gnu; system=Linux; machine=x86_64; elf_machine='Advanced Micro Devices X86-64' ;;
  linux-x64-musl) rust_target=x86_64-unknown-linux-musl; system=Linux; machine=x86_64; elf_machine='Advanced Micro Devices X86-64' ;;
  *) printf '%s\n' 'Unsupported Node native target.' >&2; exit 1 ;;
esac
[[ "$(uname -s)" == "$system" && "$(uname -m)" == "$machine" ]]
[[ "$output" == /* ]]
if [[ "$target" == *-gnu ]]; then getconf GNU_LIBC_VERSION >/dev/null; fi
if [[ "$target" == *-musl ]]; then
  [[ "$(ldd --version 2>&1 || true)" == *'musl libc'* ]]
fi

headers="${NODE_INCLUDE_DIR:-$(node -p 'require("node:path").resolve(require("node:fs").realpathSync(process.execPath), "../../include/node")')}"
[[ -f "$headers/node_api.h" && -f "$headers/js_native_api.h" ]]
python3 scripts/prepare-source.py
if [[ "$system" == Darwin ]]; then export MACOSX_DEPLOYMENT_TARGET=11.0; fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$native_dir/target}"
if [[ "$target" == *-musl ]]; then
  # The addon is loaded into Node's existing musl process, not a static executable.
  export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C target-feature=-crt-static"
fi
cargo +1.94.0 build --manifest-path Cargo.toml --release --locked --lib --target "$rust_target"

mkdir -p "$(dirname "$output")"
temporary="$(mktemp "$output.XXXXXX")"
linker_map=''
trap '[[ ! -e "$temporary" ]] || unlink "$temporary"; [[ -z "$linker_map" ]] || unlink "$linker_map"' EXIT
flags=(-std=c11 -Wall -Wextra -Werror -O2 -fPIC -fvisibility=hidden -DNAPI_VERSION=8
  -DBUILDING_NODE_EXTENSION node/binding.c "$CARGO_TARGET_DIR/$rust_target/release/libutexo_rgb_native.a")
if [[ "$system" == Darwin ]]; then
  xcrun --sdk macosx clang "${flags[@]}" -isystem "$headers" -arch "$arch" \
    -mmacosx-version-min=11.0 -dynamiclib -dead_strip -D_DARWIN_C_SOURCE \
    -Wl,-fatal_warnings -Wl,-install_name,utexo-rgb-native.node -Wl,-undefined,dynamic_lookup \
    -Wl,-exported_symbol,_napi_register_module_v1 -Wl,-exported_symbol,_node_api_module_get_api_version_v1 \
    -framework Security -framework CoreFoundation -framework SystemConfiguration \
    -lresolv -liconv -o "$temporary"
  [[ "$(xcrun lipo -archs "$temporary")" == "$arch" ]]
  exports="$(xcrun nm -gjU "$temporary" | sed 's/^_//' | LC_ALL=C sort)"
else
  linker_map="$(mktemp "$output.map.XXXXXX")"
  printf '%s\n' '{ global: napi_register_module_v1; node_api_module_get_api_version_v1; local: *; };' > "$linker_map"
  "${CC:-cc}" "${flags[@]}" -isystem "$headers" -D_GNU_SOURCE -shared \
    -Wl,--version-script,"$linker_map",--exclude-libs,ALL,--gc-sections,--fatal-warnings \
    -Wl,-z,relro,-z,now,-z,noexecstack,-z,nodelete -ldl -lpthread -lm -lrt -lutil -lresolv \
    -o "$temporary"
  [[ "$(LC_ALL=C readelf -h "$temporary" | awk -F ': *' '/Machine:/ {print $2}')" == "$elf_machine" ]]
  exports="$(LC_ALL=C readelf --dyn-syms --wide "$temporary" |
    awk '$5 == "GLOBAL" && $7 != "UND" {print $8}' | LC_ALL=C sort)"
fi
[[ "$exports" == $'napi_register_module_v1\nnode_api_module_get_api_version_v1' ]]
chmod 644 "$temporary"
mv -f "$temporary" "$output"
printf '%s\n' "$output"
