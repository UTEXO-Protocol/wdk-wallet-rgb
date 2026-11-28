#!/usr/bin/env bash
# Build a host addon from the exact pinned native dependency graph.
set -euo pipefail

native_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
candidate_dir="$(cd "$native_dir/.." && pwd -P)"
cd "$native_dir"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) host=darwin-arm64; arch=arm64 ;;
  Darwin-x86_64) host=darwin-x64; arch=x86_64 ;;
  Linux-aarch64) host=linux-arm64; elf_machine=AArch64 ;;
  Linux-x86_64) host=linux-x64; elf_machine='Advanced Micro Devices X86-64' ;;
  *) printf '%s\n' 'Build on a supported macOS or glibc Linux host.' >&2; exit 1 ;;
esac
if [[ "$host" == linux-* ]]; then
  getconf GNU_LIBC_VERSION >/dev/null
fi
version="${1:-$(node -p 'require(process.argv[1]).version' "$candidate_dir/package.json")}"
if [[ $# -gt 1 || ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]]; then
  printf '%s\n' 'Expected an exact candidate package version.' >&2
  exit 1
fi

python3 scripts/prepare-source.py --bare
toolchain="$native_dir/target/bare-toolchain"
mkdir -p "$toolchain"
cp bare/package.json bare/package-lock.json "$toolchain/"
npm ci --prefix "$toolchain" --ignore-scripts --no-audit

if [[ "$host" == darwin-* ]]; then export MACOSX_DEPLOYMENT_TARGET=11.0; fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$native_dir/target/bare-rust}"
cargo +1.94.0 build --manifest-path bare/Cargo.toml --release --locked

headers="$toolchain/node_modules/bare-headers/include"
output_dir="${UTEXO_BARE_OUTPUT_DIR:-$native_dir/target/bare-addon}"
mkdir -p "$output_dir"
output="$output_dir/utexo__wdk-wallet-rgb.bare"
temporary="$(mktemp "$output.XXXXXX")"
linker_map=''
trap '[[ ! -e "$temporary" ]] || unlink "$temporary"; [[ -z "$linker_map" ]] || unlink "$linker_map"' EXIT
flags=(-std=c11 -Wall -Wextra -Werror -O2 -fPIC
  "-DBARE_MODULE_NAME=\"utexo__wdk-wallet-rgb@$version\""
  bare/binding.c "$CARGO_TARGET_DIR/release/libutexo_rgb_native_bare.a")
if [[ "$host" == darwin-* ]]; then
  xcrun --sdk macosx clang "${flags[@]}" -I "$headers" -arch "$arch" \
    -mmacosx-version-min=11.0 -dynamiclib -dead_strip -D_DARWIN_C_SOURCE \
    -Wl,-fatal_warnings -Wl,-install_name,utexo__wdk-wallet-rgb@2.bare -Wl,-undefined,dynamic_lookup \
    -Wl,-exported_symbol,_bare_get_module_name_v0 -Wl,-exported_symbol,_bare_register_module_v0 \
    -framework Security -framework CoreFoundation -framework SystemConfiguration \
    -lresolv -liconv -o "$temporary"
  [[ "$(xcrun lipo -archs "$temporary")" == "$arch" ]]
  exports="$(xcrun nm -gjU "$temporary" | sed 's/^_//' | LC_ALL=C sort)"
else
  linker_map="$(mktemp "$output.map.XXXXXX")"
  printf '%s\n' '{ global: bare_get_module_name_v0; bare_register_module_v0; local: *; };' > "$linker_map"
  "${CC:-cc}" "${flags[@]}" -isystem "$headers" -D_GNU_SOURCE -shared \
    -Wl,--version-script,"$linker_map",--exclude-libs,ALL,--gc-sections,--fatal-warnings \
    -Wl,-z,relro,-z,now,-z,noexecstack,-z,nodelete -ldl -lpthread -lm -lrt -lutil -lresolv \
    -o "$temporary"
  [[ "$(LC_ALL=C readelf -h "$temporary" | awk -F ': *' '/Machine:/ {print $2}')" == "$elf_machine" ]]
  exports="$(LC_ALL=C readelf --dyn-syms --wide "$temporary" |
    awk '$5 == "GLOBAL" && $7 != "UND" {print $8}' | LC_ALL=C sort)"
fi
[[ "$exports" == $'bare_get_module_name_v0\nbare_register_module_v0' ]]
chmod 644 "$temporary"
mv -f "$temporary" "$output"
printf '%s\n' "$output"
