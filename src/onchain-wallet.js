// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import WalletManager, { NoSuchElementError, WalletAccountReadOnly } from '@tetherto/wdk-wallet'
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
import { admitFeeEstimate, admitSendStatus, checkFeeBlocks, checkRgbInvoice, prepareBtcSend, prepareRgbSend, sendRecoveryParams } from './onchain-send.js'
import devServices from './onchain-dev-services.json' with { type: 'json' }

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
const NATIVE_SOURCE = '9ec49c08be2e68f08521281e3efbd760ec989cb9'
const NATIVE_OVERLAY = 'd9de67fe9a2512106afd054977a1e32abb9a1184'
const NATIVE_INTEGRATION = '5408b3e56cdb7604316b094aa69ffb2d30513189'
const SIGNET_ELECTRUM = 'ssl://electrum.iriswallet.com:50033'
const STAGING_SERVICES = {
  proxyEndpoint: 'rpcs://staging.rgb-proxy.utexo.com/json-rpc',
  arbitrumRpc: 'https://arb1.arbitrum.io/rpc'
}
const DEV_SERVICES = Object.freeze(devServices)
const PROOF_MAGIC = [82, 71, 66, 0, 84, 70, 82]
const SPEND_KINDS = new Set(['rgb-output', 'btc-send', 'rgb-send', 'rgb-burn'])
const OPEN_WALLET_DIRECTORIES = new Set()

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
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f\\?#]/.test(value) ||
      !/^[a-z]+:\/\/[^/@]+(?:\/|$)/.test(value)) throw new TypeError('Invalid ' + name)
  const url = new URL(value)
  if (!protocols.includes(url.protocol) || url.username || url.password || url.port === '0') {
    throw new TypeError('Invalid ' + name)
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new TypeError('This candidate requires loopback fixture endpoints')
  }
  return value
}

function indexerUrl (value, network, profile) {
  if (network === 'signet') {
    const dev = profile === 'dev'
    const approved = dev ? DEV_SERVICES.indexerUrl : SIGNET_ELECTRUM
    if (value !== approved && value !== approved + '/') {
      throw new TypeError(dev
        ? 'Dev Signet requires the approved HTTPS Esplora endpoint'
        : 'Public Signet requires the approved TLS Electrum endpoint')
    }
    return approved
  }
  const indexer = new URL(httpUrl(value, 'indexer endpoint', ['tcp:', 'ssl:']))
  if (!indexer.port || !['', '/'].includes(indexer.pathname)) {
    throw new TypeError('Electrum requires an explicit port and no path')
  }
  return `${indexer.protocol}//${indexer.hostname}:${indexer.port}`
}

function configFor (options) {
  if (options?.network !== 'regtest' && options?.network !== 'signet') throw new TypeError('Unsupported Bitcoin network')
  const mode = options.mode === undefined ? 'rgb' : options.mode
  if (mode !== 'rgb' && mode !== 'btc-only') throw new TypeError('Invalid wallet mode')
  const dev = options.profile === 'dev'
  if (dev && DEV_SERVICES.enabled !== true) throw new TypeError('Dev Signet hosted access is disabled')
  const services = dev ? DEV_SERVICES : options.profile === 'staging' ? STAGING_SERVICES : undefined
  if (options.profile !== undefined && (!services || options.network !== 'signet' || mode !== 'rgb')) {
    throw new TypeError('The selected RGB profile requires a Signet RGB wallet')
  }
  if (options.network === 'signet' && mode !== 'btc-only' && !services) {
    throw new TypeError('Signet requires Bitcoin-only mode or an explicit RGB profile')
  }
  if (mode === 'btc-only' && ['transportEndpoint', 'evmRpcUrls', 'proxyAuthKeys', 'burnDestinationRoutes'].some(key => options[key] !== undefined)) {
    throw new TypeError('Bitcoin-only mode does not accept RGB service configuration')
  }
  const startupMode = options.startupMode ?? 'online'
  if (startupMode !== 'online' && startupMode !== 'offline') throw new TypeError('Invalid wallet startup mode')
  if (typeof options.authorize !== 'function') throw new TypeError('A transaction authorization callback is required')
  if (options.authorizeMessage !== undefined && typeof options.authorizeMessage !== 'function') {
    throw new TypeError('Invalid message authorization callback')
  }
  const routes = (options.burnDestinationRoutes ?? []).map(({ chainId, dstEid }) => {
    if (!ROUTES.has(chainId) || ROUTES.get(chainId) !== dstEid) throw new TypeError('Unknown V1 bridge route')
    return Object.freeze({ chainId, dstEid })
  })
  if (new Set(routes.map(route => route.chainId)).size !== routes.length) throw new TypeError('Duplicate V1 bridge route')

  if (options.bitcoindAuth !== undefined) throw new TypeError('The wallet does not accept Bitcoin Core credentials')
  const online = { indexerUrl: indexerUrl(options.indexerUrl, options.network, options.profile) }
  let transportEndpoint
  if (services) {
    const entries = Object.entries(options.evmRpcUrls ?? {})
    if (options.transportEndpoint !== services.proxyEndpoint || entries.length !== 1 ||
        entries[0][0] !== '42161' || entries[0][1] !== services.arbitrumRpc || options.proxyAuthKeys !== undefined ||
        routes.some(route => route.chainId !== 'eip155:42161')) {
      throw new TypeError('The selected Signet profile requires its approved RGB proxy and Arbitrum RPC without credentials or unrelated burn routes')
    }
    transportEndpoint = services.proxyEndpoint
    online.evmRpcUrls = { 42161: services.arbitrumRpc }
  } else if (mode === 'rgb') {
    transportEndpoint = httpUrl(options.transportEndpoint, 'RGB proxy endpoint', ['rpc:', 'rpcs:'])
  }
  if (!services && options.evmRpcUrls) {
    online.evmRpcUrls = Object.fromEntries(Object.entries(options.evmRpcUrls).map(([id, url]) => {
      u64(id, 'EVM chain ID')
      return [id, httpUrl(url, 'EVM RPC endpoint')]
    }))
  }
  if (options.proxyAuthKeys) {
    online.proxyAuthKeys = Object.fromEntries(Object.entries(options.proxyAuthKeys).map(([url, key]) => {
      httpUrl(url, 'proxy authentication endpoint', ['rpc:', 'rpcs:'])
      if (typeof key !== 'string' || !HEX_32.test(key)) throw new TypeError('Invalid proxy authentication key')
      return [url, key]
    }))
  }
  return {
    network: options.network,
    mode,
    profile: options.profile,
    startupMode,
    dataDir: options.dataDir,
    nativeExecutable: options.nativeExecutable,
    nativeSha256: options.nativeSha256,
    androidNativeLibraryDir: options.androidNativeLibraryDir,
    authorize: options.authorize,
    authorizeMessage: options.authorizeMessage,
    maxFeeSats: u64(options.maxFeeSats, 'Fee cap', 2_100_000_000_000_000n),
    transportEndpoint,
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
  #invoices
  #busy = false
  #closed = false
  #closing
  #journalWrite
  #releaseDirectory
  #connected = false
  #address
  #prepared

  static async open (config, signer, isDisposed) {
    const dataDir = await privateWalletDir(config.dataDir)
    if (isDisposed()) throw new WalletRuntimeError('WALLET_CLOSED', 'Wallet manager is closed')
    if (OPEN_WALLET_DIRECTORIES.has(dataDir)) throw new WalletRuntimeError('WALLET_IN_USE', 'Another wallet account already owns this directory')
    OPEN_WALLET_DIRECTORIES.add(dataDir)
    const releaseDirectory = () => { OPEN_WALLET_DIRECTORIES.delete(dataDir) }
    let worker
    try {
      worker = await OnchainWorker.start(config.nativeExecutable, config.nativeSha256, config.androidNativeLibraryDir)
      const version = await worker.request('version')
      if (version?.protocol !== 2 || version.indexer !== 'electrum-and-dev-esplora' || version.networkChecks !== 4 || version.source !== NATIVE_SOURCE || version.overlayTree !== NATIVE_OVERLAY ||
        version.runtime !== nativeRuntime || version.integrationTree !== NATIVE_INTEGRATION || version.unsignedRecovery !== 1 || version.journalWrites !== 1) {
        throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Unexpected RGB native source or protocol')
      }
      const identity = signer.identity
      const opened = await worker.request('open', {
        ...identity, network: config.network, mode: config.mode, profile: config.profile, dataDir
      })
      if (opened?.watchOnly !== true || opened.network !== config.network || opened.profile !== config.profile) {
        throw new WalletRuntimeError('NATIVE_IDENTITY_MISMATCH', 'Native wallet did not attest the requested watch-only profile')
      }
      const journal = new OnchainJournal(dataDir, { worker })
      const invoices = new OnchainJournal(dataDir, { invoices: true, worker })
      const identityFields = [config.network, identity.accountXpubVanilla, identity.accountXpubColored, identity.masterFingerprint]
      // Domain-separate Signet profiles and BTC-only storage from the legacy RGB profile.
      if (config.profile) identityFields.push(config.profile)
      else if (config.mode === 'btc-only') identityFields.push(config.mode)
      const journalIdentity = sha256(new TextEncoder().encode(JSON.stringify(identityFields)))
      await journal.bind(journalIdentity, config.mode)
      await invoices.bind(journalIdentity, config.mode)
      const account = new WalletAccountRgb(worker, signer, config, journal, invoices, releaseDirectory)
      if (config.startupMode === 'online') await account.connect()
      if (isDisposed()) throw new WalletRuntimeError('WALLET_CLOSED', 'Wallet manager is closed')
      return account
    } catch (error) {
      try { await worker?.close() } finally { releaseDirectory() }
      throw error
    }
  }

  constructor (worker, signer, config, journal, invoices, releaseDirectory) {
    this.#worker = worker
    this.#signer = signer
    this.#config = config
    this.#journal = journal
    this.#invoices = invoices
    this.#releaseDirectory = releaseDirectory
  }

  get disposed () { return this.#closed }
  get path () { return "0'/0/0" }
  get keyPair () { return null }

  isDisposed () { return this.#closed }
  getNetwork () { return this.#config.network }
  shutdown () { return this.dispose() }

  dispose () {
    if (this.#closing) return this.#closing
    this.#closed = true
    this.#signer.destroy()
    this.#prepared = undefined
    // The native worker owns the directory lock. Keep it alive through an
    // admitted journal write, while closing admission to any later writes.
    // A user approval or pending native request must never delay shutdown.
    this.#closing = (this.#journalWrite ?? Promise.resolve()).catch(() => {})
      .then(() => this.#worker.close()).finally(this.#releaseDirectory)
    return this.#closing
  }

  #assertOpen () {
    if (this.#closed) throw new WalletRuntimeError('WALLET_CLOSED', 'Wallet account is closed')
  }

  #assertConnected () {
    if (!this.#connected) throw new WalletRuntimeError('WALLET_OFFLINE', 'The wallet has no online indexer session')
  }

  #assertRgbMode () {
    this.#assertOpen()
    if (this.#config.mode === 'btc-only') {
      const message = this.#config.network === 'signet'
        ? 'This Signet wallet is configured for Bitcoin only.'
        : 'This wallet was restored for Bitcoin only. RGB state requires a verified wallet backup.'
      throw new WalletRuntimeError('RGB_MODE_UNAVAILABLE', message)
    }
  }

  #saveRecord (record, journal = this.#journal) {
    this.#assertOpen()
    const pending = Promise.resolve(journal.save(record))
    this.#journalWrite = pending
    return pending.finally(() => { this.#journalWrite = undefined })
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

  getConnectionStatus () {
    this.#assertOpen()
    if (!this.#worker.available) return 'unavailable'
    return this.#connected ? 'connected' : 'offline'
  }

  connect () {
    return this.#run(async () => {
      if (this.#connected) {
        if (!this.#worker.available) throw new WalletRuntimeError('NATIVE_CLOSED', 'Reopen the wallet to reconnect')
        return
      }
      await this.#worker.request('goOnline', this.#config.online)
      this.#assertOpen()
      this.#connected = true
    })
  }

  getNetworkInfo () {
    return this.#run(async () => {
      this.#assertConnected()
      const result = await this.#worker.request('getNetworkInfo')
      this.#assertOpen()
      if (result?.network !== this.#config.network || !Number.isSafeInteger(result.height) ||
          result.height < 0 || result.height > 0xffffffff || typeof result.blockHash !== 'string' ||
          !HEX_32.test(result.blockHash)) {
        throw new WalletRuntimeError('NATIVE_PROTOCOL', 'Invalid Bitcoin chain tip')
      }
      return { network: result.network, height: result.height, blockHash: result.blockHash }
    })
  }

  checkIndexerUrl (url = this.#config.online.indexerUrl) {
    const { network, profile, online } = this.#config
    const indexerProtocol = profile === 'dev' ? 'Esplora' : 'Electrum'
    if (indexerUrl(url, network, profile) !== online.indexerUrl) {
      throw new TypeError(`Only the configured ${indexerProtocol} endpoint can be checked`)
    }
    return this.#run(async () => {
      const result = await this.#worker.request('checkIndexerUrl', { url: online.indexerUrl })
      this.#assertOpen()
      if (result?.ok !== true || result.indexerProtocol !== indexerProtocol) {
        throw new WalletRuntimeError('NATIVE_PROTOCOL', `Invalid ${indexerProtocol} endpoint response`)
      }
      return { ok: true, indexerProtocol }
    })
  }

  checkProxyEndpoint (url = this.#config.transportEndpoint) {
    this.#assertRgbMode()
    if (url !== this.#config.transportEndpoint) throw new TypeError('Only the configured RGB proxy endpoint can be checked')
    return this.#run(async () => {
      const result = await this.#worker.request('checkProxyEndpoint', { url })
      this.#assertOpen()
      if (result?.ok !== true) throw new WalletRuntimeError('NATIVE_PROTOCOL', 'Invalid RGB proxy endpoint response')
      return { ok: true }
    })
  }

  getInfo () {
    this.#assertOpen()
    const ready = this.getConnectionStatus() === 'connected'
    if (this.#config.mode === 'btc-only') {
      return { ready, network: this.#config.network, protocol: 'BTC_L1', methods: [] }
    }
    const burnDestinationRoutes = [...this.#config.routes]
    const methods = ['getInfo', 'getAddress', 'listAssets', 'getAssetBalance', 'listTransfers', 'blindReceive', 'witnessReceive', 'decodeRgbInvoice']
    if (burnDestinationRoutes.length) methods.push('burnAsset', 'getConsignment')
    return {
      ready,
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
    this.#assertConnected()
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

  async getBtcBalance () {
    const balance = await this.#read('getBtcBalance')
    if (this.#config.mode !== 'btc-only') return balance
    return { vanilla: balance.vanilla, colored: { ...balance.colored, spendable: '0' } }
  }
  getBalanceDetails () { return this.getBtcBalance() }
  async getBalance () { return BigInt((await this.getBtcBalance()).vanilla.spendable) }
  getAssetBalance (assetId) { return this.#read('getAssetBalance', { assetId: checkAsset(assetId) }) }
  async getTokenBalance (assetId) { return BigInt((await this.getAssetBalance(assetId)).spendable) }
  listAssets () { return this.#read('listAssets') }
  getTransactions () { return this.#read('listTransactions') }
  getAssetMetadata (assetId) { return this.#read('getAssetMetadata', { assetId: checkAsset(assetId) }) }

  async #findTransaction (hash) {
    checkTxid(hash)
    return (await this.getTransactions()).find(transaction => transaction.txid === hash)
  }

  async getTransaction (hash) {
    const transaction = await this.#findTransaction(hash)
    if (!transaction) throw new NoSuchElementError('Transaction is absent from wallet history')
    const { confirmationTime, fee } = transaction
    return {
      hash,
      finality: confirmationTime ? 'confirmed' : 'pending',
      ...(confirmationTime && { block: confirmationTime.height, success: true }),
      ...(BigInt(fee) > 0n && { fee: BigInt(fee) })
    }
  }

  async getTransactionReceipt (hash) {
    const transaction = await this.#findTransaction(hash)
    return transaction?.confirmationTime ? transaction : null
  }

  waitForTransaction (hash, options) {
    return this.toReadOnlyAccount().then(account => account.waitForTransaction(hash, options))
  }

  async toReadOnlyAccount () {
    this.#assertOpen()
    const account = this
    return Object.freeze(new class extends WalletAccountReadOnly {
      async getAddress () {
        account.#assertOpen()
        if (!account.#address) throw new WalletRuntimeError('ADDRESS_UNALLOCATED', 'Allocate a receive address on the wallet first')
        return account.#address
      }

      getBalance () { return account.getBalance() }
      getTokenBalance (assetId) { return account.getTokenBalance(assetId) }
      getTransaction (hash) { return account.getTransaction(hash) }
      getTransactionReceipt (hash) { return account.getTransactionReceipt(hash) }
    }())
  }

  async estimateFeeResult (blocks = 6) {
    return admitFeeEstimate(await this.#read('getFeeRate', { blocks: checkFeeBlocks(blocks) }))
  }

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
      this.#assertRgbMode()
      const decoded = await this.#worker.request('decodeInvoice', { invoice })
      const { args, expectations } = prepareRgbSend(copy, decoded, this.#config)
      return this.#authorizeAndSubmit(await this.#prepare(copy.operationId, 'rgb-send', args, expectations, 'sendRgb'))
    })
  }

  recoverSend (operationId) {
    return this.#run(async () => {
      const record = await this.#journal.get(operationId)
      if (record?.kind === 'rgb-send') this.#assertRgbMode()
      const params = sendRecoveryParams(record)
      if (record.stage === 'failed') return { state: 'failed', txid: params.txid, batchTransferIdx: params.batchTransferIdx }
      const status = admitSendStatus(await this.#worker.request('getSendStatus', params), params)
      if (status.state !== 'unresolved' && status.state !== record.stage) {
        await this.#saveRecord({ ...record, stage: status.state })
      }
      return status
    })
  }

  getReceivedMint (recipientId) {
    if (typeof recipientId !== 'string' || recipientId.length === 0 || recipientId.length > 512) {
      throw new TypeError('Invalid RGB recipient ID')
    }
    return this.#read('getReceivedMint', { recipientId }).then(mint => {
      if (mint === null) return null
      if (typeof mint?.opid !== 'string' || !HEX_32.test(mint.opid) ||
          typeof mint.lockId !== 'string' || !HEX_32.test(mint.lockId) ||
          typeof mint.bridgeContract !== 'string' || !/^0x[a-f0-9]{40}$/i.test(mint.bridgeContract)) {
        throw new WalletRuntimeError('NATIVE_PROTOCOL', 'Invalid received mint commitment')
      }
      return mint
    })
  }

  listUnspents () { return this.#read('listUnspents') }

  listTransfers ({ assetId, txid } = {}) {
    return this.#read('listTransfers', {
      ...(assetId !== undefined && { assetId: checkAsset(assetId) }),
      ...(txid !== undefined && { txid: checkTxid(txid) })
    })
  }

  refresh (assetId) {
    this.#assertRgbMode()
    return this.#read('refresh', assetId === undefined ? {} : { assetId: checkAsset(assetId) })
  }

  refreshTransfers (options = {}) { return this.refresh(options.assetId) }

  async sync () {
    if (this.#config.mode !== 'btc-only') return this.refresh()
    this.#assertConnected()
    await this.getBtcBalance()
    return { transfers: [] }
  }

  importRgbContract (options) { return this.registerAssetContract(options) }

  registerAssetContract ({ contract, assetId, sha256: expectedSha256 }) {
    this.#assertRgbMode()
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

  #receiveParams ({ assetId, amount, expirationSeconds = 7200, minConfirmations = 3 } = {}) {
    const params = {
      transportEndpoints: [this.#config.transportEndpoint],
      expirationTimestamp: String(Math.floor(Date.now() / 1000) + smallInteger(expirationSeconds, 'invoice expiry', 3600, 604800)),
      minConfirmations: smallInteger(minConfirmations, 'minimum confirmations', 1, 255)
    }
    if (assetId !== undefined) params.assetId = checkAsset(assetId)
    if (amount !== undefined) params.amount = u64(amount, 'Invoice amount')
    return params
  }

  #receive (method, options) {
    const params = this.#receiveParams(options)
    return this.#run(() => {
      this.#assertRgbMode()
      this.#assertConnected()
      return this.#worker.request(method, params)
    })
  }

  // Host-only entry point. A lost response can disclose the exact previously
  // authorized invoice to that same request. It can never allocate another one.
  receiveWebRgbInvoice ({ method, operationId, requestKey, options, assertAuthorized, approve }) {
    if (!['blindReceive', 'witnessReceive'].includes(method) || typeof requestKey !== 'string' || !HEX_32.test(requestKey) ||
        typeof assertAuthorized !== 'function' || typeof approve !== 'function') {
      throw new TypeError('Invalid trusted receive request')
    }
    checkOperationId(operationId)
    const params = this.#receiveParams(options)
    return this.#run(async () => {
      this.#assertRgbMode()
      this.#assertConnected()
      assertMutationAuthorized(assertAuthorized)
      const existing = await this.#invoices.get(operationId)
      this.#assertOpen()
      assertMutationAuthorized(assertAuthorized)
      if (existing !== undefined) {
        if (existing.kind !== 'rgb-receive' || existing.method !== method || existing.requestKey !== requestKey) {
          throw new WalletRuntimeError('INVALID_PARAMS', 'Receive request identity does not match')
        }
        if (existing.stage === 'submitted' && typeof existing.result?.expirationTimestamp === 'string' &&
            Number(existing.result.expirationTimestamp) > Math.floor(Date.now() / 1000)) return existing.result
        throw new WalletRuntimeError('INVOICE_UNAVAILABLE', 'The original invoice is expired or requires reconciliation')
      }

      await approve()
      this.#assertOpen()
      assertMutationAuthorized(assertAuthorized)
      const entry = { id: operationId, kind: 'rgb-receive', stage: 'starting', method, requestKey }
      await this.#saveRecord(entry, this.#invoices)
      this.#assertOpen()
      assertMutationAuthorized(assertAuthorized)
      const result = await this.#worker.request(method, params)
      if (typeof result?.invoice !== 'string' || result.invoice.length > 8192 || !result.invoice.startsWith('rgb:') ||
          typeof result.recipientId !== 'string' || !result.recipientId || result.recipientId.length > 1024 ||
          result.expirationTimestamp !== params.expirationTimestamp) {
        throw new WalletRuntimeError('NATIVE_PROTOCOL', 'Invalid receive invoice response')
      }
      const invoice = { invoice: result.invoice, recipientId: result.recipientId, expirationTimestamp: result.expirationTimestamp }
      await this.#saveRecord({ ...entry, stage: 'submitted', result: invoice }, this.#invoices)
      this.#assertOpen()
      assertMutationAuthorized(assertAuthorized)
      return invoice
    })
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
      this.#assertRgbMode()
      const record = await this.#journal.get(operationId)
      if (record?.kind !== 'rgb-output' || record.stage !== 'prepared' ||
          !HEX_32.test(psbtSha256) || record.psbtSha256 !== psbtSha256) {
        throw new WalletRuntimeError('NO_PREPARED_OPERATION', 'Output plan identity does not match')
      }
      if (this.#prepared) {
        await this.#discard(this.#requireOutputPlan(operationId, psbtSha256))
      } else if (Array.isArray(record.unsignedCheckpoint)) {
        await this.#discardAbandoned(record)
      } else {
        await this.#worker.request('cancelAbandonedOutputs', { txid: checkTxid(record.txid) })
        await this.#saveRecord({ ...record, stage: 'declined' })
      }
    })
  }

  #requireOutputPlan (operationId, psbtSha256) {
    this.#assertRgbMode()
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
      this.#assertRgbMode()
      const record = await this.#journal.get(operationId)
      if (record?.kind !== 'rgb-output' || !['submitting', 'submitted'].includes(record.stage)) {
        throw new WalletRuntimeError('OPERATION_UNRESOLVED', 'No submitted RGB output operation is recorded')
      }
      if (record.stage === 'submitted') return record
      this.#assertConnected()
      const txid = checkTxid(record.txid)
      const rows = await this.#worker.request('listTransactions')
      if (!rows.some(row => row.txid === txid && row.type === 'CreateUtxos')) {
        throw new WalletRuntimeError('OPERATION_UNRESOLVED', 'The original RGB output transaction was not found')
      }
      const submitted = { ...record, stage: 'submitted' }
      await this.#saveRecord(submitted)
      return submitted
    })
  }

  burnAsset ({ operationId, assetId, amount, feeRate, minConfirmations = 6, burnRecipient, burnDestination, assertAuthorized, webRgbBinding }) {
    this.#assertRgbMode()
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
    if (kind !== 'btc-send') this.#assertRgbMode()
    this.#assertConnected()
    assertMutationAuthorized(burn?.assertAuthorized)
    if (await this.#journal.get(id)) {
      throw new WalletRuntimeError('OPERATION_EXISTS', 'Operation ID was already recorded. Use recovery to inspect its result.')
    }
    await this.#journal.assertAvailable()
    const { reservations: unsignedCheckpoint } = await this.#worker.request('snapshotUnsigned', { kind })
    if (!Array.isArray(unsignedCheckpoint)) throw new WalletRuntimeError('NATIVE_PROTOCOL', 'Unsigned reservation checkpoint is invalid')
    const record = {
      id, kind, args, stage: 'starting', unsignedCheckpoint,
      ...(burn && { burnDestination: burn.destination, burnRecipient: { ...burn.recipient } }),
      ...(burn?.binding && { webRgbBinding: burn.binding })
    }
    await this.#saveRecord(record)
    try {
      this.#assertOpen()
      assertMutationAuthorized(burn?.assertAuthorized)
    } catch (error) {
      // No native Begin was invoked. If the wallet is closing, leave the
      // durable checkpoint for the next owner and make no further writes.
      if (!this.#closed) await this.#saveRecord({ ...record, stage: 'declined' })
      throw error
    }
    let draft
    try {
      draft = await this.#worker.request(method + 'Begin', args)
    } catch (error) {
      if (['btc-send', 'rgb-send'].includes(kind) && ['SEND_NOT_PREPARED', 'SEND_PLAN_REJECTED'].includes(error.code)) {
        await this.#saveRecord({ ...record, stage: 'declined' })
      } else if (this.#worker.available) {
        // A live worker can reconcile a rejected Begin without waiting for the host to retry.
        // If reconciliation fails, leave the checkpoint intact and surface the original fault.
        await this.#discardAbandoned(record).catch(() => {})
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
      await this.#saveRecord(record)
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
      await this.#saveRecord({ ...record, stage: 'declined' })
      throw error
    }
  }

  async #discard ({ record }) {
    this.#prepared = undefined
    this.#assertOpen()
    await this.#worker.request('discardPrepared', { txid: record.txid })
    await this.#saveRecord({ ...record, stage: 'declined' })
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
    await this.#saveRecord({ ...record, stage: 'submitting' })
    this.#assertOpen()
    try {
      assertMutationAuthorized(burn?.assertAuthorized)
    } catch (error) {
      await this.#discard(prepared)
      throw error
    }
    const result = await this.#worker.request(method + 'End', { signedPsbt })
    if (result?.txid !== record.txid) throw new WalletRuntimeError('TXID_MISMATCH', 'Submitted transaction did not match the reviewed transaction')
    await this.#saveRecord({ ...record, stage: 'submitted' })
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

  listUnresolvedOperations () {
    return this.#run(async () => (await this.#journal.records()).filter(record => SPEND_KINDS.has(record.kind) &&
      ['starting', 'prepared', 'submitting'].includes(record.stage)))
  }

  recoverUnsubmittedOperation (operationId) {
    return this.#run(async () => {
      const record = await this.#journal.get(operationId)
      if (record && record.kind !== 'btc-send') this.#assertRgbMode()
      if (!record || !SPEND_KINDS.has(record.kind) || !Array.isArray(record.unsignedCheckpoint)) {
        throw new WalletRuntimeError('OPERATION_UNRESOLVED', 'No unsigned reservation checkpoint is available')
      }
      if (record.stage === 'declined') return record
      if (!['starting', 'prepared'].includes(record.stage) || this.#prepared) {
        throw new WalletRuntimeError('OPERATION_UNRESOLVED', 'This operation cannot be discarded as an abandoned unsigned plan')
      }
      return this.#discardAbandoned(record)
    })
  }

  async #discardAbandoned (record) {
    this.#assertOpen()
    const result = await this.#worker.request('discardUnsubmitted', {
      kind: record.kind,
      checkpoint: record.unsignedCheckpoint,
      ...(record.stage === 'prepared' && { expected: { txid: checkTxid(record.txid), batchTransferIdx: record.batchTransferIdx } })
    })
    if (result?.discarded !== true) throw new WalletRuntimeError('NATIVE_PROTOCOL', 'Unsigned reservation cleanup was not acknowledged')
    this.#assertOpen()
    const declined = { ...record, stage: 'declined' }
    await this.#saveRecord(declined)
    return declined
  }

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
    this.#assertRgbMode()
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
    if (record.stage === 'submitting') await this.#saveRecord({ ...record, stage: 'submitted' })
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
