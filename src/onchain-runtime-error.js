// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
export class WalletRuntimeError extends Error {
  constructor (code, message, options) {
    super(message, options)
    this.name = 'WalletRuntimeError'
    this.code = code
  }
}
