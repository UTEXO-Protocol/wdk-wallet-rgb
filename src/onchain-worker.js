// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

// Allows a 10 MiB proof in base64 plus the surrounding response.
const MAX_LINE_BYTES = 14 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 120_000

export class WalletRuntimeError extends Error {
  constructor (code, message, options) {
    super(message, options)
    this.name = 'WalletRuntimeError'
    this.code = code
  }
}

export class OnchainWorker {
  #child
  #stopped
  #pending
  #failure
  #nextId = 1
  #chunks = []
  #responseBytes = 0

  static async start (path, expectedSha256) {
    if (typeof path !== 'string' || !isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new TypeError('An absolute native executable path and lowercase SHA-256 pin are required')
    }
    const file = await lstat(path)
    if (!file.isFile() || await realpath(path) !== path || (file.mode & 0o022) !== 0) {
      throw new TypeError('Native executable must be a regular file at a canonical path')
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (hash.digest('hex') !== expectedSha256) {
      throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Native executable does not match its SHA-256 pin')
    }
    return new OnchainWorker(path)
  }

  constructor (path) {
    // Never inherit application tokens, node preload hooks or user key material.
    this.#child = spawn(path, [], {
      env: { LANG: 'C', PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    })
    this.#stopped = new Promise(resolve => this.#child.once('close', () => {
      this.#fail('NATIVE_CLOSED', 'Native wallet process closed')
      resolve()
    }))
    this.#child.once('error', () => this.#fail('NATIVE_START_FAILED', 'Native wallet process could not start'))
    this.#child.stdin.on('error', () => this.#fail('NATIVE_IO_FAILED', 'Native wallet request could not be delivered'))
    this.#child.stdout.on('data', chunk => this.#receive(chunk))
  }

  get available () { return this.#failure === undefined }

  request (method, params = {}) {
    if (this.#failure) return Promise.reject(this.#failure)
    if (this.#pending) return Promise.reject(new WalletRuntimeError('WALLET_BUSY', 'Native wallet is processing a request'))
    const id = String(this.#nextId++)
    const line = JSON.stringify({ id, method, params }) + '\n'
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new RangeError('Native wallet request is too large')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail('NATIVE_TIMEOUT', 'Native wallet did not respond before the deadline'), REQUEST_TIMEOUT_MS)
      this.#pending = { id, resolve, reject, timer }
      this.#child.stdin.write(line)
    })
  }

  async close () {
    if (!this.#failure) {
      if (this.#pending) {
        this.#fail('NATIVE_CLOSED', 'Native wallet process closed')
      } else {
        this.#failure = new WalletRuntimeError('NATIVE_CLOSED', 'Native wallet process closed')
        this.#child.stdin.end()
      }
    }
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 2_000)
    try { await this.#stopped } finally { clearTimeout(timer) }
  }

  #receive (chunk) {
    if (this.#failure) return
    this.#responseBytes += chunk.length
    if (this.#responseBytes > MAX_LINE_BYTES) {
      this.#fail('NATIVE_PROTOCOL', 'Native wallet response exceeds the maximum size')
      return
    }
    this.#chunks.push(chunk)
    const end = chunk.indexOf(10)
    if (end === -1) return
    const pending = this.#pending
    let response
    try { response = JSON.parse(Buffer.concat(this.#chunks, this.#responseBytes).toString('utf8')) } catch {}
    if (end !== chunk.length - 1 || !pending || response?.id !== pending.id ||
      (Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error'))) {
      this.#fail('NATIVE_PROTOCOL', 'Native wallet response did not match the request')
      return
    }
    this.#chunks = []
    this.#responseBytes = 0
    this.#pending = undefined
    clearTimeout(pending.timer)
    if (Object.hasOwn(response, 'error')) {
      const { code, message } = response.error ?? {}
      if (typeof code !== 'string' || typeof message !== 'string') {
        pending.reject(new WalletRuntimeError('NATIVE_PROTOCOL', 'Invalid native wallet error'))
        this.#fail('NATIVE_PROTOCOL', 'Invalid native wallet error')
      } else {
        pending.reject(new WalletRuntimeError(code, message))
      }
    } else {
      pending.resolve(response.result)
    }
  }

  #fail (code, message) {
    if (this.#failure) return
    this.#failure = new WalletRuntimeError(code, message)
    if (this.#pending) {
      clearTimeout(this.#pending.timer)
      this.#pending.reject(this.#failure)
      this.#pending = undefined
    }
    this.#child.kill()
  }
}
