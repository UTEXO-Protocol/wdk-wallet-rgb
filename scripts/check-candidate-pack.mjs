// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const readJson = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const options = process.argv.slice(2)
const requireNative = options[0] === '--require-native'
assert.equal(options.length, requireNative ? 1 : 0, 'Usage: check-candidate-pack.mjs [--require-native]')
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
for (const path of files) {
  assert.ok(!/^(?:native|scripts|tests[^/]*|evidence|fixtures?)\//.test(path), 'Build-only file packed: ' + path)
  assert.ok(!/(?:^|\/)\.(?:env|git)(?:[./]|$)/.test(path), 'Private file packed: ' + path)
}

const artifacts = [...files].filter(path => path.startsWith('prebuilds/'))
if (!requireNative) {
  assert.deepEqual(artifacts, [], 'Public source-only CI must not contain staged native binaries')
  console.log('Package exports and source-only inventory passed. Native admission is a separate gate.')
} else {
  const native = readJson('src/onchain-bare-native.json')
  assert.match(native.target, /^(?:android|darwin)-arm64$/)
  const path = 'prebuilds/' + native.target + '/utexo__wdk-wallet-rgb.bare'
  assert.deepEqual(artifacts, [path], 'Unexpected packed native addon inventory')
  const bytes = readFileSync(new URL(path, root))
  assert.equal(bytes.length, native.byteLength)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), native.sha256)
  console.log('Package exports and exact native addon inventory passed.')
}
