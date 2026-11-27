// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
const { parentPort, workerData, isMainThread } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, realpathSync } = require('node:fs')

if (isMainThread || !parentPort) throw new Error('Native wallet requires its dedicated worker')
const { addon, pin } = workerData
// Check again in the loading isolate, immediately before loading the module.
const file = lstatSync(addon)
if (!file.isFile() || realpathSync(addon) !== addon || (file.mode & 0o022) !== 0 ||
    file.size !== pin.byteLength || createHash('sha256').update(readFileSync(addon)).digest('hex') !== pin.sha256) {
  throw new Error('Native addon identity changed before loading')
}
const native = require(addon)
const handle = native.create()
let closed = false
function close () {
  if (closed) return
  closed = true
  try { native.destroy(handle) } finally { parentPort.close() }
}
parentPort.on('close', close)
parentPort.on('message', request => {
  if (closed) return
  if (request === null) return close()
  try {
    parentPort.postMessage(native.request(handle, request))
  } catch {
    close()
    // Never forward native diagnostics that may contain private wallet context.
    throw new Error('Native wallet request failed')
  }
})
