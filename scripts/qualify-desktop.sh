#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Qualify an archived committed checkout; do not rewrite the source worktree.
set -euo pipefail

kind="${1:?runtime kind required}"
target="${2:?host target required}"
out="${3:?producer artifact directory required}"
source_root="$(pwd -P)"
smoke="${4:-$source_root/scripts/packed-platform-smoke.mjs}"
test -z "$(git status --porcelain --untracked-files=normal)"
source_commit="$(git rev-parse HEAD)"
case "$out" in /*) ;; *) printf '%s\n' 'Use an absolute artifact directory.' >&2; exit 1 ;; esac
case "$smoke" in /*) ;; *) smoke="$source_root/$smoke" ;; esac
version="$(node -p 'require("./package.json").version')"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]]
consumer="$(mktemp -d "${RUNNER_TEMP:-/tmp}/wdk-packed-smoke.XXXXXX")"
trap 'rm -rf "$consumer"' EXIT
chmod 0700 "$consumer"
staged="$consumer/source"
mkdir "$staged"
(umask 022; git archive "$source_commit" | tar -xf - -C "$staged")
# The direct addon smoke uses the build checkout's already locked JS toolchain.
# Consumer acceptance below installs the tarball in its own separate dependency tree.
ln -s "$source_root/node_modules" "$staged/node_modules"
cd "$staged"
if [[ "$kind" == bare ]]; then
  binary="$out/utexo__wdk-wallet-rgb.bare"
  node --input-type=module - "$target" "$binary" "$out" "$source_root" <<'JS'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [target, path, out, sourceRoot] = process.argv.slice(2)
const bytes = readFileSync(path)
const digest = value => createHash('sha256').update(value).digest('hex')
const run = (command, args) => execFileSync(command, args, { cwd: sourceRoot, encoding: 'utf8' }).trim()
const manifest = 'src/onchain-bare-native.json'
const native = JSON.parse(readFileSync(manifest, 'utf8'))
const { source, overlayTree, integrationTree, protocol } = native
const pin = { byteLength: bytes.length, sha256: digest(bytes) }
const receipt = {
  target, sdkVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
  sourceCommit: run('git', ['rev-parse', 'HEAD']),
  sourceTree: run('git', ['rev-parse', 'HEAD^{tree}']),
  native: { source, overlayTree, integrationTree, protocol },
  rustc: run('rustc', ['+1.94.0', '-vV']),
  cargoLockSha256: digest(readFileSync('native/bare/Cargo.lock')),
  buildScriptSha256: digest(readFileSync('native/scripts/build-bare.sh')),
  pin,
  abi: process.platform === 'linux'
    ? run('readelf', ['--wide', '--file-header', '--program-headers', '--dynamic', '--version-info', path])
    : run('otool', ['-hvL', path])
}
native.targets = { [target]: pin }
writeFileSync(manifest, JSON.stringify(native, null, 2) + '\n')
writeFileSync(join(out, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
JS
  node scripts/stage-bare.mjs "$binary" "$target"
  node scripts/check-candidate-pack.mjs --require-native
  bare_cli="$(node -p 'require(process.argv[1])("bare")' "$source_root/native/target/bare-toolchain/node_modules/bare-runtime")"
  chmod 0755 "$bare_cli"
  test "$("$bare_cli" --version)" = v1.37.1
  test "$("$bare_cli" -e 'console.log(Bare.Addon.host)')" = "$target"
  ulimit -c 0
  mkdir -p native/target/bare-addon
  "$bare_cli" native/bare/smoke.cjs | tee "$out/direct-smoke.log"
  grep -Fq 'eight worker teardown/reopens passed' "$out/direct-smoke.log"
else
  test "$kind" = node
  binary="$out/utexo-rgb-native"
  node -e 'if (require(process.argv[1]).nativeIdentity.assetIssuance !== 2) process.exitCode = 1' "$out/build-receipt.json"
  node scripts/check-candidate-pack.mjs
fi

sha256() {
  node -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$1"
}
hash="$(sha256 "$binary")"
npm pack --ignore-scripts --pack-destination "$consumer" --json > "$out/npm-pack.json"
archive="$consumer/utexo-wdk-wallet-rgb-$version.tgz"
sha256 "$archive" > "$out/packed-sha256.txt"
cp "$archive" "$out/utexo-wdk-wallet-rgb-$version.tgz"
cp "$smoke" "$consumer/packed-smoke.mjs"
(
  cd "$consumer"
  printf '{"name":"wdk-packed-platform-consumer","private":true}\n' > package.json
  npm install --ignore-scripts --no-audit --no-fund "$archive"
  if [[ "$kind" == bare ]]; then
    "$bare_cli" ./packed-smoke.mjs "$target" "$hash"
    # A host that already uses the current shared Bare leaf must work without
    # consumer overrides or a private copy of an older incompatible graph.
    npm install --ignore-scripts --no-audit --no-fund --save-exact bare-type@1.6.0
    "$bare_cli" ./packed-smoke.mjs "$target" "$hash"
  else
    node ./packed-smoke.mjs "$target" "$hash" "$binary"
  fi
) | tee "$out/packed-smoke.log"
grep -Fq 'NIA/CFA issuance reaches native and rejects offline on all five network profiles' "$out/packed-smoke.log"

test "$(git -C "$source_root" rev-parse HEAD)" = "$source_commit"
test -z "$(git -C "$source_root" status --porcelain --untracked-files=normal)"
