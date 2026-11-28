// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'

export const BARE_TARGETS = [
  'android-arm', 'android-arm64', 'android-ia32', 'android-x64',
  'darwin-arm64', 'darwin-x64',
  'ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator',
  'linux-arm64', 'linux-x64'
]

export function addonPath (target) {
  assert.ok(BARE_TARGETS.includes(target), 'Unexpected Bare target: ' + target)
  return `prebuilds/${target}/utexo__wdk-wallet-rgb.bare`
}

export function linkedAddonName (target, version) {
  const stem = `utexo__wdk-wallet-rgb.${version}`
  if (target.startsWith('android-')) return `lib${stem}.so`
  if (target.startsWith('ios-')) return `${stem}.framework/${stem}`
}

export function assertTargetPin (target, pin, version) {
  addonPath(target)
  const linkedName = linkedAddonName(target, version)
  assert.deepEqual(Object.keys(pin).sort(), linkedName
    ? ['byteLength', 'linkedName', 'sha256']
    : ['byteLength', 'sha256'])
  assert.equal(pin.linkedName, linkedName)
  assert.match(pin.sha256, /^[a-f0-9]{64}$/)
  assert.ok(Number.isSafeInteger(pin.byteLength) && pin.byteLength > 0 && pin.byteLength <= 128 * 1024 * 1024)
}
