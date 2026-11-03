// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { WalletRuntimeError } from './onchain-worker.js'

const ID = /^[a-z0-9][a-z0-9-]{15,79}$/
const BLOCKING = new Set(['starting', 'prepared', 'submitting'])
const STAGES = new Set([...BLOCKING, 'declined', 'submitted'])

export function checkOperationId (id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new TypeError('A stable, unique operation ID is required')
  return id
}

export async function privateWalletDir (path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('An absolute wallet directory is required')
  await mkdir(path, { mode: 0o700, recursive: true })
  const stat = await lstat(path)
  if (!stat.isDirectory() || await realpath(path) !== path || (stat.mode & 0o077) !== 0) {
    throw new TypeError('Wallet directory must be private and canonical')
  }
  return path
}

async function writeAtomically (dir, name, value) {
  const temp = join(dir, '.' + randomUUID() + '.tmp')
  try {
    const file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(value) + '\n')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, join(dir, name))
    const directory = await open(dir, 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    await unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

export class OnchainJournal {
  #dir

  constructor (dataDir) { this.#dir = join(dataDir, '.wdk-onchain-journal-v1') }

  async bind (identity) {
    await privateWalletDir(this.#dir)
    const name = 'identity.json'
    const saved = await this.#read(name)
    if (saved === undefined) {
      const files = await readdir(this.#dir)
      if (files.some(file => file.endsWith('.json'))) throw new Error('Operation journal has no wallet identity')
      await writeAtomically(this.#dir, name, { identity })
    } else if (saved?.identity !== identity) {
      throw new WalletRuntimeError('WALLET_IDENTITY_MISMATCH', 'Wallet directory belongs to another on-chain account')
    }
  }

  async get (id) {
    const value = await this.#read(checkOperationId(id) + '.json')
    if (value !== undefined && (value?.id !== id || !STAGES.has(value.stage))) {
      throw new WalletRuntimeError('JOURNAL_CORRUPT', 'Wallet operation journal requires review')
    }
    return value
  }

  async records () {
    const files = await readdir(this.#dir)
    return Promise.all(files.filter(file => file !== 'identity.json' && file.endsWith('.json')).map(file => this.get(file.slice(0, -5))))
  }

  async assertAvailable () {
    if ((await this.records()).some(record => BLOCKING.has(record.stage))) {
      throw new WalletRuntimeError('OPERATION_UNRESOLVED', 'A previous operation requires reconciliation before another transaction')
    }
  }

  async save (record) {
    await writeAtomically(this.#dir, checkOperationId(record.id) + '.json', record)
  }

  async #read (name) {
    try {
      const path = join(this.#dir, name)
      const stat = await lstat(path)
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 32_768) {
        throw new Error('Unsafe wallet journal entry')
      }
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }
}
