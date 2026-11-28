// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import manifest from './onchain-node-native.json' with { type: 'json' }
import { WalletRuntimeError } from './onchain-runtime-error.js'

const MAX_REQUEST_BYTES = 6 * 1024 * 1024
const MAX_RESPONSE_BYTES = 14 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 120_000

export const nativeRuntime = 'node-in-process'

function nativeTarget () {
  if (process.platform === 'darwin') return 'darwin-' + process.arch
  if (process.platform === 'linux') {
    const libc = process.report.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl'
    return 'linux-' + process.arch + '-' + libc
  }
  return undefined
}

export class OnchainWorker {
  #worker
  #stopped
  #pending
  #failure
  #nextId = 1

  static async start (nativeAddon, expectedSha256, androidNativeLibraryDir, iosNativeFrameworkDir) {
    if (manifest.releaseHold !== false) {
      throw new WalletRuntimeError('NATIVE_BUILD_BLOCKED', 'No Node addon is approved for this SDK revision')
    }
    if (androidNativeLibraryDir !== undefined || iosNativeFrameworkDir !== undefined) {
      throw new TypeError('Node does not use a mobile native library directory')
    }
    const target = nativeTarget()
    const pin = Object.hasOwn(manifest.targets, target) ? manifest.targets[target] : undefined
    if (!pin) throw new WalletRuntimeError('NATIVE_PLATFORM_UNSUPPORTED', 'No qualified Node addon for this platform')
    const path = nativeAddon ?? fileURLToPath(new URL('../prebuilds/' + target + '/utexo-rgb-native.node', import.meta.url))
    if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.node')) {
      throw new TypeError('Node requires a canonical native addon path ending in .node')
    }
    if (expectedSha256 !== undefined && expectedSha256 !== pin.sha256) {
      throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Node addon does not match the supplied SHA-256 pin')
    }
    const file = await lstat(path)
    if (!file.isFile() || await realpath(path) !== path || (file.mode & 0o022) !== 0 ||
        file.size !== pin.byteLength || file.size <= 0 || file.size > 256 * 1024 * 1024) {
      throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Packaged Node addon failed integrity verification')
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (hash.digest('hex') !== pin.sha256) {
      throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Packaged Node addon failed integrity verification')
    }
    const worker = new OnchainWorker(path, pin)
    try {
      const version = await worker.request('version')
      if (version?.runtime !== nativeRuntime || version.indexer !== 'electrum-and-dev-esplora' ||
          version.integrationTree !== manifest.integrationTree) {
        throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Unexpected Node native build profile')
      }
      return worker
    } catch (error) {
      await worker.close()
      throw error
    }
  }

  constructor (addon, pin) {
    this.#worker = new Worker(new URL('./onchain-node-thread.cjs', import.meta.url), {
      workerData: { addon, pin },
      // Native code remains in this process. Do not inherit JavaScript preload
      // hooks or expose application environment values in the worker's JS context.
      execArgv: [], env: { LANG: 'C', PATH: '/usr/bin:/bin' }, stdout: true, stderr: true
    })
    this.#worker.stdout.resume()
    this.#worker.stderr.resume()
    this.#stopped = new Promise(resolve => this.#worker.once('exit', () => {
      this.#fail('NATIVE_CLOSED', 'Native wallet thread closed', false)
      resolve()
    }))
    this.#worker.on('message', message => this.#receive(message))
    this.#worker.on('messageerror', () => this.#fail('NATIVE_PROTOCOL', 'Invalid native wallet message'))
    this.#worker.on('error', () => this.#fail('NATIVE_IO_FAILED', 'Native wallet thread failed', false))
  }

  get available () { return this.#failure === undefined }

  request (method, params = {}) {
    if (this.#failure) return Promise.reject(this.#failure)
    if (this.#pending) return Promise.reject(new WalletRuntimeError('WALLET_BUSY', 'Native wallet is processing a request'))
    const id = String(this.#nextId++)
    const message = JSON.stringify({ id, method, params })
    if (Buffer.byteLength(message) > MAX_REQUEST_BYTES) throw new RangeError('Native wallet request is too large')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail('NATIVE_TIMEOUT', 'Native wallet did not respond before the deadline'), REQUEST_TIMEOUT_MS)
      this.#pending = { id, resolve, reject, timer }
      try { this.#worker.postMessage(message) } catch {
        this.#fail('NATIVE_IO_FAILED', 'Native wallet request could not be delivered')
      }
    })
  }

  close () {
    // Never terminate a thread while Rust may be committing a mutation. Keep
    // ownership until the dispatched call returns and the native handle is freed.
    this.#fail('NATIVE_CLOSED', 'Native wallet thread closed')
    return this.#stopped
  }

  #receive (message) {
    if (this.#failure) return
    const pending = this.#pending
    let response
    if (typeof message === 'string' && Buffer.byteLength(message) <= MAX_RESPONSE_BYTES) {
      try { response = JSON.parse(message) } catch {}
    }
    if (!pending || response?.id !== pending.id ||
        (Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error'))) {
      this.#fail('NATIVE_PROTOCOL', 'Native wallet response did not match the request')
      return
    }
    if (Object.hasOwn(response, 'error') &&
        (typeof response.error?.code !== 'string' || typeof response.error.message !== 'string')) {
      this.#fail('NATIVE_PROTOCOL', 'Invalid native wallet error')
      return
    }
    this.#pending = undefined
    clearTimeout(pending.timer)
    if (Object.hasOwn(response, 'error')) {
      pending.reject(new WalletRuntimeError(response.error.code, response.error.message))
    } else {
      pending.resolve(response.result)
    }
  }

  #fail (code, message, stop = true) {
    if (this.#failure) return
    this.#failure = new WalletRuntimeError(code, message)
    if (this.#pending) {
      clearTimeout(this.#pending.timer)
      this.#pending.reject(this.#failure)
      this.#pending = undefined
    }
    if (stop) {
      try { this.#worker.postMessage(null) } catch { /* Exit still owns native cleanup. */ }
    }
  }
}
