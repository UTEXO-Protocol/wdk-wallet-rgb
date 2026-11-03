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
import { BIP322_CAPABILITIES, bip322MessageBytes, verifyMessageBip322 } from './onchain-message.js'
import { admitSendStatus, checkFeeBlocks, checkRgbInvoice, prepareBtcSend, prepareRgbSend, sendRecoveryParams } from './onchain-send.js'

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
const NATIVE_INTEGRATION = '8dd209a8bb849696e45f301b0ea1b3d4eb0fba06'
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

function assertMutationAuthorized (check) {
  if (check === undefined) return
  if (typeof check !== 'function') throw new TypeError('Mutation guard must be a synchronous assertion')
  const result = check()
  if (result === undefined) return
  if (typeof result?.then === 'function') Promise.resolve(result).catch(() => {})
  throw new WalletRuntimeError('NOT_ENABLED', 'Mutation authorization is no longer active')
}

function checkTxid (txid) {
  if (typeof txid !== 'string' || !HEX_32.test(txid)) throw new TypeError('Invalid transaction ID')
  return txid
}

function httpUrl (value, name, protocols = ['http:', 'https:']) {
  if (typeof value !== 'string' || value.length > 2048) throw new TypeError('Invalid ' + name)
  const url = new URL(value)
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash || url.search) {
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
  if (options.authorizeMessage !== undefined && typeof options.authorizeMessage !== 'function') {
    throw new TypeError('Invalid message authorization callback')
  }
  const routes = (options.burnDestinationRoutes ?? []).map(({ chainId, dstEid }) => {
    if (!ROUTES.has(chainId) || ROUTES.get(chainId) !== dstEid) throw new TypeError('Unknown V1 bridge route')
    return Object.freeze({ chainId, dstEid })
  })
  if (new Set(routes.map(route => route.chainId)).size !== routes.length) throw new TypeError('Duplicate V1 bridge route')

  if (options.bitcoindAuth !== undefined) throw new TypeError('The wallet accepts only Electrum configuration')
  const indexerUrl = httpUrl(options.indexerUrl, 'indexer endpoint', ['tcp:', 'ssl:'])
  const indexer = new URL(indexerUrl)
  if (!indexer.port || !['', '/'].includes(indexer.pathname)) {
    throw new TypeError('Electrum requires an explicit port and no path')
  }
  const online = { indexerUrl }
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
    androidNativeLibraryDir: options.androidNativeLibraryDir,
    authorize: options.authorize,
    authorizeMessage: options.authorizeMessage,
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

  getAccountByPath (path) {
    if (path !== "0'/0/0") return Promise.reject(new RangeError("RGB supports only the default path 0'/0/0"))
    return this.getAccount()
  }

  async getFeeRates () {
    const account = await this.getAccount()
    const normal = await account.estimateFeeResult(6)
    const fast = await account.estimateFeeResult(2)
    return { normal: BigInt(normal.feeRate), fast: BigInt(fast.feeRate) }
  }

  shutdown () { return this.dispose() }

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
  #address
  #prepared

  static async open (config, signer, isDisposed) {
    const dataDir = await privateWalletDir(config.dataDir)
    if (isDisposed()) throw new WalletRuntimeError('WALLET_CLOSED', 'Wallet manager is closed')
    const worker = await OnchainWorker.start(config.nativeExecutable, config.nativeSha256, config.androidNativeLibraryDir)
    try {
      const version = await worker.request('version')
      if (version?.protocol !== 2 || version.indexer !== 'electrum-only' || version.source !== NATIVE_SOURCE || version.overlayTree !== NATIVE_OVERLAY ||
        version.runtime !== nativeRuntime || version.integrationTree !== NATIVE_INTEGRATION) {
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
  get path () { return "0'/0/0" }
  get keyPair () { return null }

  isDisposed () { return this.#closed }
  getNetwork () { return this.#config.network }
  shutdown () { return this.dispose() }

  async dispose () {
    if (!this.#closed) this.#closed = true
    this.#signer.destroy()
    this.#prepared = undefined
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
    const methods = ['getInfo', 'getAddress', 'listAssets', 'getAssetBalance', 'listTransfers', 'blindReceive', 'decodeRgbInvoice']
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

  getAddress () {
    return this.#run(async () => this.#address ?? await this.#allocateAddress())
  }

  getNewAddress () { return this.#run(() => this.#allocateAddress()) }

  async #allocateAddress () {
    const { address } = await this.#worker.request('getAddress')
    this.#assertOpen()
    if (typeof address !== 'string' || !address) throw new WalletRuntimeError('NATIVE_PROTOCOL', 'Invalid receive address')
    this.#address = address
    return address
  }

  getCapabilities () {
    this.#assertOpen()
    return Object.freeze({
      bip322: this.#config.authorizeMessage
        ? BIP322_CAPABILITIES
        : Object.freeze({ status: 'unavailable', reason: 'Message authorization is not configured' })
    })
  }

  async getMessageSigningAddress () {
    this.#assertOpen()
    return this.#signer.getMessageSigningAddress()
  }

  signMessageBip322 (message, address) {
    return this.#run(async () => {
      const messageBytes = bip322MessageBytes(message)
      if (address !== this.#signer.getMessageSigningAddress()) throw new TypeError('Message signing address is not owned by this account')
      const approval = Object.freeze({ kind: 'bip322', message, address, messageSha256: sha256(messageBytes) })
      if (await this.#config.authorizeMessage?.(approval) !== true) {
        throw new WalletRuntimeError('AUTHORIZATION_DECLINED', 'Message signing was declined')
      }
      this.#assertOpen()
      return this.#signer.signMessageBip322(message, address)
    })
  }

  async verifyMessageBip322 (message, address, signature) {
    this.#assertOpen()
    return verifyMessageBip322(message, address, signature, this.#config.network)
  }

  getBtcBalance () { return this.#read('getBtcBalance') }
  getBalanceDetails () { return this.getBtcBalance() }
  async getBalance () { return BigInt((await this.getBtcBalance()).vanilla.spendable) }
  getAssetBalance (assetId) { return this.#read('getAssetBalance', { assetId: checkAsset(assetId) }) }
  async getTokenBalance (assetId) { return BigInt((await this.getAssetBalance(assetId)).spendable) }
  listAssets () { return this.#read('listAssets') }
  getTransactions () { return this.#read('listTransactions') }
  getAssetMetadata (assetId) { return this.#read('getAssetMetadata', { assetId: checkAsset(assetId) }) }

  estimateFeeResult (blocks = 6) { return this.#read('getFeeRate', { blocks: checkFeeBlocks(blocks) }) }

  decodeRgbInvoice (invoice) { return this.#read('decodeInvoice', { invoice: checkRgbInvoice(invoice) }) }

  sendBtc (request) {
    const { args, expectations } = prepareBtcSend(request, this.#config.network)
    return this.#transact(request.operationId, 'btc-send', args, expectations, 'sendBtc')
  }

  sendRgbInvoice (request) {
    checkOperationId(request.operationId)
    const invoice = checkRgbInvoice(request.invoice)
    const copy = { ...request, invoice }
    return this.#run(async () => {
      const decoded = await this.#worker.request('decodeInvoice', { invoice })
      const { args, expectations } = prepareRgbSend(copy, decoded, this.#config)
      return this.#authorizeAndSubmit(await this.#prepare(copy.operationId, 'rgb-send', args, expectations, 'sendRgb'))
    })
  }

  recoverSend (operationId) {
    return this.#run(async () => {
      const record = await this.#journal.get(operationId)
      const params = sendRecoveryParams(record)
      if (record.stage === 'failed') return { state: 'failed', txid: params.txid, batchTransferIdx: params.batchTransferIdx }
      const status = admitSendStatus(await this.#worker.request('getSendStatus', params), params)
      if (status.state !== 'unresolved' && status.state !== record.stage) {
        await this.#journal.save({ ...record, stage: status.state })
      }
      return status
    })
  }

  getReceivedMint (recipientId) {
    if (typeof recipientId !== 'string' || recipientId.length === 0 || recipientId.length > 512) {
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

  refreshTransfers (options = {}) { return this.refresh(options.assetId) }

  sync () { return this.refresh() }

  importRgbContract (options) { return this.registerAssetContract(options) }

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

  blindReceive (options) { return this.#receive('blindReceive', options) }

  witnessReceive (options) { return this.#receive('witnessReceive', options) }

  createRgbInvoice ({ mode = 'blind', ...options } = {}) {
    if (mode === 'blind') return this.blindReceive(options)
    if (mode === 'witness') return this.witnessReceive(options)
    throw new TypeError('Unknown RGB receive mode')
  }

  #receive (method, { assetId, amount, expirationSeconds = 7200, minConfirmations = 3 } = {}) {
    const params = {
      transportEndpoints: [this.#config.transportEndpoint],
      expirationTimestamp: String(Math.floor(Date.now() / 1000) + smallInteger(expirationSeconds, 'invoice expiry', 3600, 604800)),
      minConfirmations: smallInteger(minConfirmations, 'minimum confirmations', 1, 255)
    }
    if (assetId !== undefined) params.assetId = checkAsset(assetId)
    if (amount !== undefined) params.amount = u64(amount, 'Invoice amount')
    return this.#read(method, params)
  }

  async getInvoiceStatus (recipientId) {
    if (typeof recipientId !== 'string' || recipientId.length === 0 || recipientId.length > 512) {
      throw new TypeError('Invalid RGB recipient ID')
    }
    const matches = (await this.listTransfers()).filter(row => row.recipientId === recipientId &&
      ['ReceiveBlind', 'ReceiveWitness', 'Mint'].includes(row.kind))
    if (matches.length > 1) throw new WalletRuntimeError('NATIVE_PROTOCOL', 'Multiple transfers match this recipient')
    return matches[0] ?? null
  }

  #outputPlan ({ count, size, feeRate }) {
    const args = {
      count: smallInteger(count, 'output count', 1, 20),
      size: u64(size, 'Output size', 1_000_000n),
      feeRate: u64(feeRate, 'Fee rate', 1_000n)
    }
    return { args, expectations: { expectedColorableOutputs: { count: args.count, amountSats: args.size } } }
  }

  createUtxos (options) {
    const { args, expectations } = this.#outputPlan(options)
    return this.#transact(options.operationId, 'rgb-output', args, expectations, 'createUtxos')
  }

  prepareCreateUtxos (options) {
    const { args, expectations } = this.#outputPlan(options)
    return this.#run(async () => (await this.#prepare(options.operationId, 'rgb-output', args, expectations, 'createUtxos')).review)
  }

  commitPreparedCreateUtxos ({ operationId, psbtSha256 }) {
    return this.#run(() => this.#authorizeAndSubmit(this.#requireOutputPlan(operationId, psbtSha256)))
  }

  cancelCreateUtxosPlan ({ operationId, psbtSha256 }) {
    return this.#run(async () => {
      const record = await this.#journal.get(operationId)
      if (record?.kind !== 'rgb-output' || record.stage !== 'prepared' ||
          !HEX_32.test(psbtSha256) || record.psbtSha256 !== psbtSha256) {
        throw new WalletRuntimeError('NO_PREPARED_OPERATION', 'Output plan identity does not match')
      }
      if (this.#prepared) {
        await this.#discard(this.#requireOutputPlan(operationId, psbtSha256))
      } else {
        await this.#worker.request('cancelAbandonedOutputs', { txid: checkTxid(record.txid) })
        await this.#journal.save({ ...record, stage: 'declined' })
      }
    })
  }

  #requireOutputPlan (operationId, psbtSha256) {
    const plan = this.#prepared
    if (plan?.record.kind !== 'rgb-output' || plan.record.id !== operationId || plan.plan.psbtSha256 !== psbtSha256) {
      throw new WalletRuntimeError('NO_PREPARED_OPERATION', 'Output plan identity does not match this wallet session')
    }
    return plan
  }

  getCreateUtxosOperation (operationId) {
    return this.#run(async () => {
      const record = await this.#journal.get(operationId)
      return record?.kind === 'rgb-output' ? record : undefined
    })
  }

  listCreateUtxosOperations () {
    return this.#run(async () => (await this.#journal.records()).filter(record => record.kind === 'rgb-output'))
  }

  recoverCreateUtxos (operationId) {
    return this.#run(async () => {
      const record = await this.#journal.get(operationId)
      if (record?.kind !== 'rgb-output' || !['submitting', 'submitted'].includes(record.stage)) {
        throw new WalletRuntimeError('OPERATION_UNRESOLVED', 'No submitted RGB output operation is recorded')
      }
      if (record.stage === 'submitted') return record
      const txid = checkTxid(record.txid)
      const rows = await this.#worker.request('listTransactions')
      if (!rows.some(row => row.txid === txid && row.type === 'CreateUtxos')) {
        throw new WalletRuntimeError('OPERATION_UNRESOLVED', 'The original RGB output transaction was not found')
      }
      const submitted = { ...record, stage: 'submitted' }
      await this.#journal.save(submitted)
      return submitted
    })
  }

  burnAsset ({ operationId, assetId, amount, feeRate, minConfirmations = 6, burnRecipient, burnDestination, assertAuthorized, webRgbBinding }) {
    let binding
    if (webRgbBinding !== undefined) {
      const { scopeKey, requestKey } = webRgbBinding
      if (typeof assertAuthorized !== 'function' || typeof scopeKey !== 'string' || !HEX_32.test(scopeKey) ||
          typeof requestKey !== 'string' || !HEX_32.test(requestKey)) throw new TypeError('Invalid WebRGB burn binding')
      binding = { scopeKey, requestKey }
    }
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
    return this.#transact(operationId, 'rgb-burn', args, {}, 'burn', { destination, recipient, assertAuthorized, binding })
  }

  #transact (id, kind, args, expectations, method, burn) {
    checkOperationId(id)
    return this.#run(async () => this.#authorizeAndSubmit(await this.#prepare(id, kind, args, expectations, method, burn)))
  }

  async #prepare (id, kind, args, expectations, method, burn) {
    checkOperationId(id)
    assertMutationAuthorized(burn?.assertAuthorized)
    if (await this.#journal.get(id)) {
      throw new WalletRuntimeError('OPERATION_EXISTS', 'Operation ID was already recorded. Use recovery to inspect its result.')
    }
    await this.#journal.assertAvailable()
    const record = {
      id, kind, args, stage: 'starting',
      ...(burn && { burnDestination: burn.destination, burnRecipient: { ...burn.recipient } }),
      ...(burn?.binding && { webRgbBinding: burn.binding })
    }
    await this.#journal.save(record)
    try {
      this.#assertOpen()
      assertMutationAuthorized(burn?.assertAuthorized)
    } catch (error) {
      // No native Begin was invoked. The durable ID remains consumed, but
      // this record cannot block future independent wallet operations.
      await this.#journal.save({ ...record, stage: 'declined' })
      throw error
    }
    let draft
    try {
      draft = await this.#worker.request(method + 'Begin', args)
    } catch (error) {
      if (['btc-send', 'rgb-send'].includes(kind) && ['SEND_NOT_PREPARED', 'SEND_PLAN_REJECTED'].includes(error.code)) {
        await this.#journal.save({ ...record, stage: 'declined' })
      }
      throw error
    }
    const { txid, psbt, batchTransferIdx } = draft
    checkTxid(txid)
    const expectation = { kind, maxFeeSats: this.#config.maxFeeSats, approvedOutputs: [], ...expectations }
    Object.assign(record, { txid, stage: 'prepared', batchTransferIdx })
    try {
      const plan = this.#signer.inspect(psbt, expectation)
      if (plan.txid !== txid) throw new WalletRuntimeError('PSBT_MISMATCH', 'Native transaction ID does not match the reviewed PSBT')
      record.psbtSha256 = plan.psbtSha256
      await this.#journal.save(record)
      this.#assertOpen()
      const review = Object.freeze({
        operationId: id,
        ...args,
        ...(burn && { burnDestination: burn.destination, burnRecipient: Object.freeze({ ...burn.recipient }) }),
        plan
      })
      const prepared = { record, psbt, expectation, method, burn, plan, review }
      this.#prepared = prepared
      return prepared
    } catch (error) {
      this.#assertOpen()
      await this.#worker.request('discardPrepared', { txid })
      await this.#journal.save({ ...record, stage: 'declined' })
      throw error
    }
  }

  async #discard ({ record }) {
    this.#prepared = undefined
    this.#assertOpen()
    await this.#worker.request('discardPrepared', { txid: record.txid })
    await this.#journal.save({ ...record, stage: 'declined' })
  }

  async #authorizeAndSubmit (prepared) {
    const { record, psbt, expectation, plan, review, method, burn } = prepared
    let approved
    let rejection
    try {
      approved = await this.#config.authorize(review)
    } catch (error) {
      rejection = error
    }
    this.#assertOpen()
    if (approved !== true) {
      await this.#discard(prepared)
      throw rejection ?? new WalletRuntimeError('AUTHORIZATION_DECLINED', 'Transaction was declined')
    }

    let signedPsbt
    try {
      assertMutationAuthorized(burn?.assertAuthorized)
      signedPsbt = this.#signer.sign(psbt, expectation, plan)
    } catch (error) {
      await this.#discard(prepared)
      throw error
    }
    this.#prepared = undefined
    await this.#journal.save({ ...record, stage: 'submitting' })
    this.#assertOpen()
    try {
      assertMutationAuthorized(burn?.assertAuthorized)
    } catch (error) {
      await this.#discard(prepared)
      throw error
    }
    const result = await this.#worker.request(method + 'End', { signedPsbt })
    if (result?.txid !== record.txid) throw new WalletRuntimeError('TXID_MISMATCH', 'Submitted transaction did not match the reviewed transaction')
    await this.#journal.save({ ...record, stage: 'submitted' })
    return {
      ...result,
      ...(burn && {
        assetId: record.args.assetId,
        amount: record.args.amount,
        minConfirmations: record.args.minConfirmations,
        burnDestination: burn.destination,
        burnRecipient: { ...burn.recipient }
      })
    }
  }

  getOperation (id) { return this.#run(() => this.#journal.get(id)) }

  getConsignment ({ assetId, txid, webRgbScopeKey }) {
    checkAsset(assetId)
    checkTxid(txid)
    if (webRgbScopeKey !== undefined && (typeof webRgbScopeKey !== 'string' || !HEX_32.test(webRgbScopeKey))) {
      throw new TypeError('Invalid WebRGB proof scope')
    }
    return this.#run(async () => {
      const records = await this.#journal.records()
      const record = records.find(item => item.kind === 'rgb-burn' && item.args?.assetId === assetId && item.txid === txid &&
        (webRgbScopeKey === undefined || item.webRgbBinding?.scopeKey === webRgbScopeKey))
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
