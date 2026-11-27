// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'

export const NODE_TARGETS = [
  'darwin-arm64', 'darwin-x64', 'linux-arm64-gnu', 'linux-x64-gnu', 'linux-x64-musl'
]

export function addonPath (target) {
  assert.ok(NODE_TARGETS.includes(target), 'Unexpected Node target: ' + target)
  return `prebuilds/${target}/utexo-rgb-native.node`
}

export function assertTargetPin (target, pin) {
  addonPath(target)
  assert.deepEqual(Object.keys(pin).sort(), ['byteLength', 'sha256'])
  assert.match(pin.sha256, /^[a-f0-9]{64}$/)
  assert.ok(Number.isSafeInteger(pin.byteLength) && pin.byteLength > 0 && pin.byteLength <= 128 * 1024 * 1024)
}
