// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { addonPath, assertTargetPin, BARE_TARGETS } from './bare-targets.mjs'

const root = new URL('../', import.meta.url)
const readJson = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const options = process.argv.slice(2)
const requireAll = options[0] === '--require-all-targets'
const requireNative = requireAll || options[0] === '--require-native'
assert.equal(options.length, requireNative ? 1 : 0, 'Usage: check-candidate-pack.mjs [--require-native|--require-all-targets]')
const manifest = readJson('package.json')
assert.equal(manifest.name, '@utexo/wdk-wallet-rgb')
assert.equal(manifest.private, true, 'The review candidate must remain private')
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  cwd: root,
  encoding: 'utf8'
}))
assert.equal(pack.name, manifest.name)
assert.equal(pack.version, manifest.version)
const files = new Set(pack.files.map(file => file.path))
function checkTarget (target) {
  if (typeof target === 'string') {
    assert.ok(target.startsWith('./') && files.has(target.slice(2)), 'Missing packed export: ' + target)
    return
  }
  for (const value of Object.values(target)) checkTarget(value)
}
checkTarget(manifest.exports)
assert.ok(files.has('LICENSE'), 'Missing package license')
assert.ok(files.has('src/onchain-dev-services.json'), 'Missing Dev Signet service policy')
assert.ok(!files.has('QUALIFICATION.md'), 'Keep deployment qualification evidence outside the package')

// These release checks stay in the repository. The host supplies deployment
// asset metadata and contract bytes at runtime.
const devAssetMarkers = [
  'BUSDT',
  'Bridged USDT',
  'rgb:A6k89KtR-e3oXqRP-uH3jUrz-LU_sYL3-hMZ0k3O-6u8DXbE',
  '9307e39016e6373bd0ee1ea9fa5d6a4130120513d48da9268777893e150344e9',
  '60a1b4f0d79706a7a51c6388fa14b951e119bae1ceffd811f4ebc62249817c4c',
  '6372ee2f86c3a551290635736b25855124932eed'
]
function checkAssetMarkers (path, bytes) {
  assert.ok(devAssetMarkers.every(marker => !bytes.includes(marker)), 'Dev asset metadata in packed file: ' + path)
}
for (const path of files) {
  assert.ok(!/^(?:native|scripts|tests[^/]*|evidence|fixtures?)\//.test(path), 'Build-only file packed: ' + path)
  assert.ok(!/(?:^|\/)\.(?:env|git)(?:[./]|$)/.test(path), 'Private file packed: ' + path)
  if (!path.startsWith('prebuilds/')) checkAssetMarkers(path, readFileSync(new URL(path, root)))
}

const artifacts = [...files].filter(path => path.startsWith('prebuilds/'))
const native = readJson('src/onchain-bare-native.json')
assert.match(native.source, /^[a-f0-9]{40}$/)
assert.match(native.overlayTree, /^[a-f0-9]{40}$/)
assert.match(native.integrationTree, /^[a-f0-9]{40}$/)
assert.equal(native.protocol, 2)
const targets = Object.keys(native.targets)
if (native.releaseHold !== false) {
  assert.deepEqual(targets, [], 'Native targets must be empty while the release is blocked')
  assert.ok(!requireNative, 'Native pack blocked pending upstream RGB safeguards')
}
for (const target of targets) assertTargetPin(target, native.targets[target], manifest.version)
if (!requireNative) {
  assert.deepEqual(artifacts, [], 'Public source-only CI must not contain staged native binaries')
  console.log('Package exports and source-only inventory passed. Native admission is a separate gate.')
} else {
  assert.ok(targets.length, 'No reviewed Bare artifacts')
  if (requireAll) assert.deepEqual(targets.sort(), [...BARE_TARGETS].sort(), 'Incomplete Bare target coverage')
  assert.deepEqual(artifacts.sort(), targets.map(addonPath).sort(), 'Unexpected packed native addon inventory')
  const servicePolicy = readFileSync(new URL('src/onchain-dev-services.json', root))
  for (const target of targets) {
    const pin = native.targets[target]
    const path = addonPath(target)
    const bytes = readFileSync(new URL(path, root))
    checkAssetMarkers(path, bytes)
    assert.equal(bytes.length, pin.byteLength)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256)
    for (const identity of [native.source, native.overlayTree, native.integrationTree]) {
      assert.ok(bytes.includes(Buffer.from(identity)), 'Native addon does not contain the admitted source identity')
    }
    assert.ok(bytes.includes(Buffer.from('electrum-and-dev-esplora')), 'Native addon lacks the expected indexer capabilities')
    assert.ok(bytes.includes(Buffer.from('ssl://electrum.iriswallet.com:50003')), 'Native addon lacks mainnet indexer admission')
    // The live SDK handshake checks the issuance capability. A compiler can
    // inline or split short JSON keys, so searching the binary cannot attest it.
    assert.ok(bytes.includes(servicePolicy), 'Native addon and package disagree on the Dev Signet service policy')
  }
  console.log('Package exports and exact native addon inventory passed.')
}
