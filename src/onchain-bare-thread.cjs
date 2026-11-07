// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
const { parentPort } = require('bare-worker')
const native = require.addon('..')

const handle = native.create()

parentPort.on('message', request => {
  if (request === null) {
    try {
      native.destroy(handle)
    } finally {
      parentPort.close()
    }
    return
  }
  parentPort.postMessage(native.request(handle, request))
})
