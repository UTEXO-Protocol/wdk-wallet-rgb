// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { lstat, open, realpath } from 'bare-fs/promises'
import { fileURLToPath } from 'bare-url'
import { isAbsolute, join } from 'bare-path'
import { clearTimeout, setTimeout } from 'bare-timers'
import Worker from 'bare-worker'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import manifest from './onchain-bare-native.json' with { type: 'json' }
import { WalletRuntimeError } from './onchain-runtime-error.js'

export const nativeRuntime = 'bare-in-process'

const MAX_REQUEST_BYTES = 6 * 1024 * 1024
const MAX_RESPONSE_BYTES = 14 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 120_000

async function verifyAddon (addon, expectedSha256, expectedLength) {
  const stat = await lstat(addon)
  if (!stat.isFile() || await realpath(addon) !== addon || (stat.mode & 0o022) !== 0 ||
      stat.size <= 0 || stat.size > 256 * 1024 * 1024 ||
      (expectedLength !== undefined && stat.size !== expectedLength)) {
    throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Packaged Bare addon failed integrity verification')
  }
  const file = await open(addon, 'r')
  const hash = sha256.create()
  try {
    const chunk = new Uint8Array(64 * 1024)
    let offset = 0
    while (offset < stat.size) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset)
      if (bytesRead === 0) break
      hash.update(chunk.subarray(0, bytesRead))
      offset += bytesRead
    }
    if (offset !== stat.size || hex.encode(hash.digest()) !== expectedSha256) {
      throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Packaged Bare addon failed integrity verification')
    }
  } finally {
    await file.close()
  }
}

async function linkedAddonPath (resolution, linkedName, directory) {
  if (resolution !== 'linked:' + linkedName || typeof directory !== 'string' ||
      !isAbsolute(directory) || await realpath(directory) !== directory) {
    throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Native addon must resolve from the app native library directory')
  }
  return join(directory, linkedName)
}

export class OnchainWorker {
  #worker
  #stopped
  #pending
  #failure
  #nextId = 1

  static async start (executable, expectedSha256, androidNativeLibraryDir, iosNativeFrameworkDir) {
    if (executable !== undefined) throw new TypeError('The Bare candidate loads its packaged addon')
    const host = Bare.Addon.host
    const target = Object.hasOwn(manifest.targets, host) ? manifest.targets[host] : undefined
    if (!target) {
      throw new WalletRuntimeError('NATIVE_PLATFORM_UNSUPPORTED', 'No qualified Bare addon for this platform')
    }
    const resolution = import.meta.addon.resolve('..')
    let addon
    if (host.startsWith('ios-')) {
      if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
        throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'iOS requires a SHA-256 pin for the final embedded framework')
      }
      addon = await linkedAddonPath(resolution, target.linkedName, iosNativeFrameworkDir)
      await verifyAddon(addon, expectedSha256)
    } else {
      if (expectedSha256 !== undefined && expectedSha256 !== target.sha256) {
        throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Native addon does not match the supplied SHA-256 pin')
      }
      addon = target.linkedName
        ? await linkedAddonPath(resolution, target.linkedName, androidNativeLibraryDir)
        : fileURLToPath(resolution)
      await verifyAddon(addon, target.sha256, target.byteLength)
    }
    const worker = new OnchainWorker()
    try {
      const version = await worker.request('version')
      if (version?.indexer !== 'electrum-and-dev-esplora' || version.integrationTree !== manifest.integrationTree) {
        throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Unexpected Bare native build profile')
      }
      return worker
    } catch (error) {
      await worker.close()
      throw error
    }
  }

  constructor () {
    this.#worker = new Worker(import.meta.resolve('./onchain-bare-thread.cjs'))
    this.#stopped = new Promise(resolve => this.#worker.once('exit', () => {
      this.#fail('NATIVE_CLOSED', 'Native wallet thread closed', false)
      resolve()
    }))
    this.#worker.on('message', response => this.#receive(response))
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
      try {
        this.#worker.postMessage(message)
      } catch {
        this.#fail('NATIVE_IO_FAILED', 'Native wallet request could not be delivered')
      }
    })
  }

  close () {
    // The worker releases the native handle after any dispatched operation finishes.
    // A caller can reject its wait, but cannot assume a dispatched mutation was cancelled.
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
    if (stop) this.#worker.postMessage(null)
  }
}
