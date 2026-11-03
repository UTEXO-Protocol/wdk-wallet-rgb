// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import WalletManager from '@tetherto/wdk-wallet'
import { sha256 as hashSha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { base64, hex } from '@scure/base'
import { URL } from '#onchain-io'
import { OnchainWorker, nativeRuntime } from '#onchain-worker'
import { burnDestinationFor, burnDestinationHash, MAX_BURN_PROOF_BYTES, validateBurnDestination } from './burn-destination.js'
import { checkOperationId, OnchainJournal, privateWalletDir } from './onchain-journal.js'
import { deriveOnchainSigner } from './onchain-signer.js'
import { WalletRuntimeError } from './onchain-runtime-error.js'

const ROUTES = new Map([
  ['eip155:42161', 0],
  ['eip155:1', 30101],
  ['eip155:137', 30109],
  ['eip155:9745', 30383],
  ['tron:728126428', 30420]
])
const HEX_32 = /^[a-f0-9]{64}$/
const MAX_U64 = 0xffffffffffffffffn
const MAX_CONTRACT_BYTES = 1024 * 1024
const NATIVE_SOURCE = '0a9d352f2690902df2b6fae9bca1a6c13c3354d4'
const NATIVE_OVERLAY = '5b7660a66d53da6a5935407bbaf21f7e73636f35'
const PROOF_MAGIC = [82, 71, 66, 0, 84, 70, 82]

function sha256 (bytes) { return hex.encode(hashSha256(bytes)) }

function u64 (value, label, maximum = MAX_U64) {
  if (typeof value === 'bigint') value = value.toString()
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > maximum) {
    throw new TypeError(label + ' must be a positive integer in base units')
  }
  return value
}

function smallInteger (value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('Invalid ' + label)
  return value
}

function checkAsset (value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:~_-]{1,160}$/.test(value)) throw new TypeError('Invalid asset ID')
  return value
}

function checkTxid (txid) {
  if (typeof txid !== 'string' || !HEX_32.test(txid)) throw new TypeError('Invalid transaction ID')
  return txid
}

function httpUrl (value, name, protocols = ['http:', 'https:']) {
  const url = new URL(value)
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError('Invalid ' + name)
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new TypeError('This candidate requires loopback fixture endpoints')
  }
  return value
}

function configFor (options) {
  if (options?.network !== 'regtest') throw new TypeError('The candidate supports isolated regtest only')
  if (typeof options.authorize !== 'function') throw new TypeError('A transaction authorization callback is required')
  const routes = (options.burnDestinationRoutes ?? []).map(({ chainId, dstEid }) => {
    if (!ROUTES.has(chainId) || ROUTES.get(chainId) !== dstEid) throw new TypeError('Unknown V1 bridge route')
    return Object.freeze({ chainId, dstEid })
  })
  if (new Set(routes.map(route => route.chainId)).size !== routes.length) throw new TypeError('Duplicate V1 bridge route')

  const electrumOnly = nativeRuntime === 'bare-in-process'
  const indexerProtocols = electrumOnly ? ['tcp:', 'ssl:'] : ['http:', 'https:', 'tcp:', 'ssl:']
  const online = { indexerUrl: httpUrl(options.indexerUrl, 'indexer endpoint', indexerProtocols) }
  if (options.bitcoindAuth) {
    if (electrumOnly) throw new TypeError('The Bare candidate accepts only Electrum configuration')
    online.bitcoindAuth = { ...options.bitcoindAuth }
  }
  if (options.evmRpcUrls) {
    online.evmRpcUrls = Object.fromEntries(Object.entries(options.evmRpcUrls).map(([id, url]) => {
      u64(id, 'EVM chain ID')
      return [id, httpUrl(url, 'EVM RPC endpoint')]
    }))
  }
  if (options.proxyAuthKeys) {
    online.proxyAuthKeys = Object.fromEntries(Object.entries(options.proxyAuthKeys).map(([url, key]) => {
      httpUrl(url, 'proxy authentication endpoint', ['http:', 'https:', 'rpc:', 'rpcs:'])
      if (typeof key !== 'string' || !HEX_32.test(key)) throw new TypeError('Invalid proxy authentication key')
      return [url, key]
    }))
  }
  return {
    network: options.network,
    dataDir: options.dataDir,
    nativeExecutable: options.nativeExecutable,
    nativeSha256: options.nativeSha256,
    authorize: options.authorize,
    maxFeeSats: u64(options.maxFeeSats, 'Fee cap', 2_100_000_000_000_000n),
    transportEndpoint: httpUrl(options.transportEndpoint, 'RGB proxy endpoint', ['rpc:', 'rpcs:']),
    routes,
    online
  }
}

export class WalletManagerRgb extends WalletManager {
  #config
  #signer
  #opening
  #closing

  constructor (seed, options) {
    const config = configFor(options)
    if (typeof seed !== 'string' && !(seed instanceof Uint8Array)) throw new TypeError('A seed is required')
    super(seed instanceof Uint8Array ? Uint8Array.from(seed) : seed, {})
    try {
      this.#signer = deriveOnchainSigner(this.seed, { network: config.network })
      this.#config = config
    } finally {
      this.seed.fill(0)
      this._seed = undefined
    }
  }

  async getAccount (index = 0) {
    if (index !== 0) throw new RangeError('RGB supports only account 0')
    if (this.disposed) throw new WalletRuntimeError('WALLET_CLOSED', 'Wallet manager is closed')
    if (!this.#opening) {
      this.#opening = WalletAccountRgb.open(this.#config, this.#signer, () => this.disposed).catch(error => {
        this.#opening = undefined
        throw error
      })
    }
    return this.#opening
  }

  dispose () {
    if (this.#closing) return this.#closing
    super.dispose()
    this.#signer.destroy()
    this.#closing = this.#opening?.then(account => account.dispose(), () => {}) ?? Promise.resolve()
    return this.#closing
  }
}

export class WalletAccountRgb {
  #worker
  #signer
  #config
  #journal
  #busy = false
  #closed = false

  static async open (config, signer, isDisposed) {
    const dataDir = await privateWalletDir(config.dataDir)
    if (isDisposed()) throw new WalletRuntimeError('WALLET_CLOSED', 'Wallet manager is closed')
    const worker = await OnchainWorker.start(config.nativeExecutable, config.nativeSha256)
    try {
      const version = await worker.request('version')
      if (version?.protocol !== 1 || version.source !== NATIVE_SOURCE || version.overlayTree !== NATIVE_OVERLAY ||
        version.runtime !== nativeRuntime) {
        throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Unexpected RGB native source or protocol')
      }
      const identity = signer.identity
      const opened = await worker.request('open', { ...identity, network: config.network, dataDir })
      if (opened?.watchOnly !== true || opened.network !== config.network) {
        throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Native wallet did not attest the requested watch-only network')
      }
      const journal = new OnchainJournal(dataDir)
      await journal.bind(sha256(new TextEncoder().encode(JSON.stringify([config.network, identity.accountXpubVanilla, identity.accountXpubColored, identity.masterFingerprint]))))
      await worker.request('goOnline', config.online)
      if (isDisposed()) throw new WalletRuntimeError('WALLET_CLOSED', 'Wallet manager is closed')
      return new WalletAccountRgb(worker, signer, config, journal)
    } catch (error) {
      await worker.close()
      throw error
    }
  }

  constructor (worker, signer, config, journal) {
    this.#worker = worker
    this.#signer = signer
    this.#config = config
    this.#journal = journal
  }

  get disposed () { return this.#closed }

  async dispose () {
    if (!this.#closed) this.#closed = true
    this.#signer.destroy()
    await this.#worker.close()
  }

  #assertOpen () {
    if (this.#closed) throw new WalletRuntimeError('WALLET_CLOSED', 'Wallet account is closed')
  }

  async #run (callback) {
    this.#assertOpen()
    if (this.#busy) throw new WalletRuntimeError('WALLET_BUSY', 'Wallet account is processing an operation')
    this.#busy = true
    try { return await callback() } finally { this.#busy = false }
  }

  #read (method, params) {
    return this.#run(() => this.#worker.request(method, params))
  }

  getInfo () {
    this.#assertOpen()
    const burnDestinationRoutes = [...this.#config.routes]
    const methods = ['getInfo', 'getAssetBalance', 'blindReceive']
    if (burnDestinationRoutes.length) methods.push('burnAsset', 'getConsignment')
    return {
      ready: this.#worker.available,
      network: this.#config.network,
      protocol: 'RGB_L1',
      methods,
      ...(burnDestinationRoutes.length && {
        burnDestinationVersion: 1,
        burnDestinationRoutes,
        burnRecipientNamespaces: [...new Set(burnDestinationRoutes.map(route => route.chainId.split(':')[0]))]
      })
    }
  }

  async getAddress () {
    const { address } = await this.#read('getAddress')
    return address
  }

  getBtcBalance () { return this.#read('getBtcBalance') }
  getAssetBalance (assetId) { return this.#read('getAssetBalance', { assetId: checkAsset(assetId) }) }
  getReceivedMint (recipientId) {
    if (typeof recipientId !== 'string' || recipientId.length === 0 || recipientId.length > 1024) {
      throw new TypeError('Invalid RGB recipient ID')
    }
    return this.#read('getReceivedMint', { recipientId })
  }

  listUnspents () { return this.#read('listUnspents') }

  listTransfers ({ assetId, txid } = {}) {
    return this.#read('listTransfers', {
      ...(assetId !== undefined && { assetId: checkAsset(assetId) }),
      ...(txid !== undefined && { txid: checkTxid(txid) })
    })
  }

  refresh (assetId) {
    return this.#read('refresh', assetId === undefined ? {} : { assetId: checkAsset(assetId) })
  }

  registerAssetContract ({ contract, assetId, sha256: expectedSha256 }) {
    if (!(contract instanceof Uint8Array) || contract.length === 0 || contract.length > MAX_CONTRACT_BYTES ||
      typeof expectedSha256 !== 'string' || sha256(contract) !== expectedSha256) {
      throw new TypeError('Contract bytes must match the configured SHA-256')
    }
    return this.#read('importContract', {
      contractBase64: base64.encode(contract),
      expectedAssetId: checkAsset(assetId),
      sha256: expectedSha256
    })
  }

  blindReceive ({ assetId, amount, expirationSeconds = 7200, minConfirmations = 3 } = {}) {
    const params = {
      transportEndpoints: [this.#config.transportEndpoint],
      expirationTimestamp: String(Math.floor(Date.now() / 1000) + smallInteger(expirationSeconds, 'invoice expiry', 3600, 604800)),
      minConfirmations: smallInteger(minConfirmations, 'minimum confirmations', 1, 255)
    }
    if (assetId !== undefined) params.assetId = checkAsset(assetId)
    if (amount !== undefined) params.amount = u64(amount, 'Invoice amount')
    return this.#read('blindReceive', params)
  }

  createUtxos ({ operationId, count, size, feeRate }) {
    const args = {
      count: smallInteger(count, 'output count', 1, 20),
      size: u64(size, 'Output size', 1_000_000n),
      feeRate: u64(feeRate, 'Fee rate', 1_000n)
    }
    return this.#transact(operationId, 'rgb-output', args, {
      expectedColorableOutputs: { count: args.count, amountSats: args.size }
    }, 'createUtxos')
  }

  burnAsset ({ operationId, assetId, amount, feeRate, minConfirmations = 6, burnRecipient, burnDestination }) {
    const recipient = { chainId: burnRecipient?.chainId, address: burnRecipient?.address }
    const destination = burnDestinationFor(recipient, this.#config.routes)
    const expectedHash = burnDestinationHash(destination)
    if (burnDestinationHash(validateBurnDestination(burnDestination)) !== expectedHash) {
      throw new TypeError('V1 burn destination does not match the requested recipient')
    }
    const args = {
      assetId: checkAsset(assetId),
      amount: u64(amount, 'Burn amount'),
      feeRate: u64(feeRate, 'Fee rate', 1_000n),
      minConfirmations: smallInteger(minConfirmations, 'minimum burn confirmations', 6, 255),
      commitment: expectedHash
    }
    return this.#transact(operationId, 'rgb-burn', args, {}, 'burn', { destination, recipient })
  }

  #transact (id, kind, args, expectations, method, burn) {
    checkOperationId(id)
    return this.#run(async () => {
      if (await this.#journal.get(id)) {
        throw new WalletRuntimeError('OPERATION_EXISTS', 'Operation ID was already recorded. Use recovery to inspect its result.')
      }
      await this.#journal.assertAvailable()
      const record = { id, kind, args, ...(burn && { burnDestination: burn.destination, burnRecipient: { ...burn.recipient } }), stage: 'starting' }
      await this.#journal.save(record)
      this.#assertOpen()
      const prepared = await this.#worker.request(method + 'Begin', args)
      const txid = checkTxid(prepared.txid)
      const expectation = { kind, maxFeeSats: this.#config.maxFeeSats, approvedOutputs: [], ...expectations }
      Object.assign(record, { txid, stage: 'prepared', batchTransferIdx: prepared.batchTransferIdx })
      await this.#journal.save(record)
      this.#assertOpen()

      let plan
      let approved
      let rejection
      try {
        plan = this.#signer.inspect(prepared.psbt, expectation)
        if (plan.txid !== txid) throw new WalletRuntimeError('PSBT_MISMATCH', 'Native transaction ID does not match the reviewed PSBT')
        approved = await this.#config.authorize(Object.freeze({
          operationId: id,
          ...args,
          ...(burn && { burnDestination: burn.destination, burnRecipient: Object.freeze({ ...burn.recipient }) }),
          plan
        }))
      } catch (error) {
        rejection = error
      }
      this.#assertOpen()
      if (approved !== true) {
        await this.#worker.request('discardPrepared', { txid })
        await this.#journal.save({ ...record, stage: 'declined' })
        throw rejection ?? new WalletRuntimeError('AUTHORIZATION_DECLINED', 'Transaction was declined')
      }

      const signedPsbt = this.#signer.sign(prepared.psbt, expectation, plan)
      await this.#journal.save({ ...record, stage: 'submitting' })
      this.#assertOpen()
      const result = await this.#worker.request(method + 'End', { signedPsbt })
      if (result?.txid !== txid) throw new WalletRuntimeError('TXID_MISMATCH', 'Submitted transaction did not match the reviewed transaction')
      await this.#journal.save({ ...record, stage: 'submitted' })
      return {
        ...result,
        ...(burn && {
          assetId: args.assetId,
          amount: args.amount,
          minConfirmations: args.minConfirmations,
          burnDestination: burn.destination,
          burnRecipient: { ...burn.recipient }
        })
      }
    })
  }

  getOperation (id) { return this.#run(() => this.#journal.get(id)) }

  getConsignment ({ assetId, txid }) {
    checkAsset(assetId)
    checkTxid(txid)
    return this.#run(async () => {
      const records = await this.#journal.records()
      const record = records.find(item => item.kind === 'rgb-burn' && item.args?.assetId === assetId && item.txid === txid)
      return (await this.#proof(record)).proof
    })
  }

  recoverBurn (operationId) {
    return this.#run(async () => this.#proof(await this.#journal.get(operationId)))
  }

  async #proof (record) {
    if (record?.kind !== 'rgb-burn' || !['submitting', 'submitted'].includes(record.stage)) {
      throw new WalletRuntimeError('PROOF_UNAVAILABLE', 'No matching submitted burn is recorded for this wallet')
    }
    const { txid, args: { assetId, amount, commitment }, burnDestination } = record
    if (burnDestinationHash(burnDestination) !== commitment) {
      throw new WalletRuntimeError('JOURNAL_CORRUPT', 'Saved burn commitment does not match its destination')
    }
    const result = await this.#worker.request('getConsignment', { assetId, txid, commitment, amount })
    if (result?.assetId !== assetId || result.txid !== txid || result.commitment !== commitment || result.amount !== amount ||
      typeof result.data !== 'string' || result.data.length > Math.ceil(MAX_BURN_PROOF_BYTES / 3) * 4) {
      throw new WalletRuntimeError('PROOF_MISMATCH', 'Burn proof does not match the wallet operation')
    }
    let bytes
    try { bytes = base64.decode(result.data) } catch {}
    if (!bytes || bytes.length <= PROOF_MAGIC.length || bytes.length > MAX_BURN_PROOF_BYTES ||
      !PROOF_MAGIC.every((byte, index) => byte === bytes[index]) || base64.encode(bytes) !== result.data || sha256(bytes) !== result.sha256) {
      throw new WalletRuntimeError('PROOF_INVALID', 'Native wallet returned an invalid burn proof')
    }
    if (record.stage === 'submitting') await this.#journal.save({ ...record, stage: 'submitted' })
    return {
      txid,
      assetId,
      burnDestination,
      proof: {
        assetId,
        txid,
        encoding: 'base64',
        byteLength: bytes.length,
        data: result.data,
        digest: { algorithm: 'keccak256', value: '0x' + hex.encode(keccak_256(bytes)) }
      }
    }
  }
}
