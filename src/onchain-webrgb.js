// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { ascii, base64, hex } from '@scure/base'
import { URL } from '#onchain-io'
import { burnDestinationFor, burnDestinationHash, MAX_BURN_PROOF_BYTES, validateBurnDestination } from './burn-destination.js'

export { burnDestinationFor, burnDestinationHash, createBurnPackage, MAX_BURN_PROOF_BYTES, validateBurnDestination } from './burn-destination.js'

const NETWORKS = new Set(['mainnet', 'testnet', 'testnet4', 'signet', 'regtest'])
const KEY = /^[a-f0-9]{64}$/
const ASSET = /^rgb:[A-Za-z0-9~_-]{1,156}$/
const CAIP2 = /^(?:eip155|tron):[1-9]\d{0,15}$/
const MAX_U64 = 0xffffffffffffffffn
const PROOF_MAGIC = [82, 71, 66, 0, 84, 70, 82]
const METHODS = Object.freeze([
  'enable', 'getInfo', 'getAddress', 'blindReceive', 'witnessReceive', 'listAssets',
  'getAssetBalance', 'listTransfers', 'getTransferStatus', 'decodeRgbInvoice', 'burnAsset', 'getConsignment'
])
const MESSAGES = Object.freeze({
  INVALID_PARAMS: 'Invalid WebRGB request',
  NOT_ENABLED: 'Wallet session is no longer authorized',
  METHOD_NOT_SUPPORTED: 'WebRGB method is unavailable for this wallet session',
  ASSET_NOT_FOUND: 'The approved asset is not registered in this wallet',
  USER_REJECTED: 'The wallet approval was declined',
  INTERNAL_ERROR: 'The wallet could not complete this request'
})

export class WebRgbError extends Error {
  constructor (code, message = MESSAGES[code]) {
    super(message)
    this.name = 'WebRgbError'
    this.code = code
  }

  toJSON () { return { name: this.name, code: this.code, message: this.message } }
}

function fail (code = 'INVALID_PARAMS') { throw new WebRgbError(code) }

function record (input, keys) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail()
  const values = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!keys.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    values[key] = descriptor.value
  }
  return values
}

function text (value, max, code = 'INVALID_PARAMS') {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(code)
  return value
}

function hash (value) { return hex.encode(sha256(ascii.decode(JSON.stringify(value)))) }

function checkedAsset (id, code = 'INVALID_PARAMS') {
  if (typeof id !== 'string' || !ASSET.test(id)) fail(code)
  return id
}

function assetSet (ids = []) {
  if (!Array.isArray(ids) || ids.length > 64) fail()
  const result = new Set(ids.map(id => checkedAsset(id)))
  if (result.size !== ids.length) fail()
  return result
}

function integer (value, min, max, code = 'INVALID_PARAMS') {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code)
  return value
}

function exactAmount (value, { allowZero = false, code = 'INVALID_PARAMS' } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) ||
      (!allowZero && value === '0') || BigInt(value) > MAX_U64) fail(code)
  return value
}

function nativeNumber (value) {
  if (typeof value === 'string') value = Number(exactAmount(value, { allowZero: true, code: 'INTERNAL_ERROR' }))
  return integer(value, 0, Number.MAX_SAFE_INTEGER, 'INTERNAL_ERROR')
}

function scopedOrigin (value) {
  try {
    const url = new URL(text(value, 256))
    const secure = url.protocol === 'https:'
    const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if ((!secure && !local) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail()
    const port = url.port && url.port !== (secure ? '443' : '80') ? ':' + url.port : ''
    const origin = url.protocol + '//' + url.hostname + port
    if (value !== origin) fail()
    return origin
  } catch { return fail() }
}

function checkedRoutes (input = []) {
  if (!Array.isArray(input) || input.length > 32) fail()
  const routes = new Map()
  for (const value of input) {
    const { chainId, dstEid } = record(value, ['chainId', 'dstEid'])
    if (typeof chainId !== 'string' || !CAIP2.test(chainId) || routes.has(chainId)) fail()
    integer(dstEid, chainId.startsWith('tron:') ? 1 : 0, 0xffffffff)
    routes.set(chainId, Object.freeze({ chainId, dstEid }))
  }
  return routes
}

function checkedIdentity (value) {
  const { origin, topic, id, method, fingerprint } = record(value, ['origin', 'topic', 'id', 'method', 'fingerprint'])
  if (typeof topic !== 'string' || !KEY.test(topic) || typeof fingerprint !== 'string' || !KEY.test(fingerprint) ||
      !METHODS.some(name => method === 'rgb_' + name)) fail()
  return Object.freeze({ origin: scopedOrigin(origin), topic, id: integer(id, 0, Number.MAX_SAFE_INTEGER), method, fingerprint })
}

function checkProof (proof, assetId, txid) {
  if (proof?.assetId !== assetId || proof.txid !== txid || proof.encoding !== 'base64' ||
      typeof proof.data !== 'string' || proof.data.length > Math.ceil(MAX_BURN_PROOF_BYTES / 3) * 4 ||
      proof.digest?.algorithm !== 'keccak256') fail('INTERNAL_ERROR')
  let bytes
  try { bytes = base64.decode(proof.data) } catch { fail('INTERNAL_ERROR') }
  if (bytes.length !== proof.byteLength || bytes.length <= PROOF_MAGIC.length || bytes.length > MAX_BURN_PROOF_BYTES ||
      !PROOF_MAGIC.every((value, index) => bytes[index] === value) || base64.encode(bytes) !== proof.data ||
      '0x' + hex.encode(keccak_256(bytes)) !== proof.digest.value) fail('INTERNAL_ERROR')
  return { assetId, txid, encoding: 'base64', byteLength: bytes.length, data: proof.data,
    digest: { algorithm: 'keccak256', value: proof.digest.value } }
}

function projectTransfer (row, assetId) {
  const { idx, status, kind, txid, requestedAssignment, assignments } = row
  const result = {
    assetId, transferId: nativeNumber(idx), status: text(status, 64, 'INTERNAL_ERROR'), kind: text(kind, 64, 'INTERNAL_ERROR')
  }
  if (txid != null) {
    if (typeof txid !== 'string' || !KEY.test(txid)) fail('INTERNAL_ERROR')
    result.txid = txid
  }
  let amount
  if (kind === 'Burn' || kind === 'Send') {
    if (requestedAssignment?.fungible !== undefined) amount = BigInt(exactAmount(requestedAssignment.fungible, { allowZero: true, code: 'INTERNAL_ERROR' }))
  } else {
    if (!Array.isArray(assignments)) fail('INTERNAL_ERROR')
    for (const assignment of assignments) {
      if (assignment?.fungible !== undefined) {
        amount = (amount ?? 0n) + BigInt(exactAmount(assignment.fungible, { allowZero: true, code: 'INTERNAL_ERROR' }))
      }
    }
  }
  if (amount !== undefined) {
    result.amountBaseUnits = exactAmount(amount.toString(), { allowZero: true, code: 'INTERNAL_ERROR' })
    if (amount <= BigInt(Number.MAX_SAFE_INTEGER)) result.amount = Number(amount)
  }
  return result
}

/**
 * An in-process WebRGB facade for one already authenticated transport request.
 * The host owns identity admission, the session grant, and durable transport
 * replay control for invoice allocation. Create a new facade per RPC.
 */
export class WebRgbProvider {
  #wallet
  #identity
  #scopeKey
  #network
  #authorized
  #granted
  #confirm
  #assets
  #burnAssets
  #routes
  #defaultFeeRate

  constructor (wallet, { scope, policy = {}, confirm } = {}) {
    if (typeof scope?.assertAuthorized !== 'function' || typeof confirm !== 'function' ||
        typeof wallet?.getInfo !== 'function' || !NETWORKS.has(scope.network) || !Array.isArray(scope.methods) ||
        scope.methods.length > METHODS.length || !scope.methods.every(name => METHODS.includes(name))) fail()
    this.#identity = checkedIdentity(scope.identity)
    this.#network = scope.network
    const walletId = text(scope.walletId, 256)
    if (!/^[!-~]+$/.test(walletId)) fail()
    this.#scopeKey = hash(['utexo-webrgb-scope-v1', walletId, this.#network, this.#identity.origin, this.#identity.topic])
    this.#authorized = scope.assertAuthorized
    this.#granted = new Set(scope.methods)
    this.#confirm = confirm
    this.#wallet = wallet
    const checked = record(policy, ['approvedAssetIds', 'approvedBurnAssetIds', 'burnDestinationRoutes', 'defaultBurnFeeRate'])
    this.#assets = assetSet(checked.approvedAssetIds)
    this.#burnAssets = assetSet(checked.approvedBurnAssetIds)
    if ([...this.#burnAssets].some(asset => !this.#assets.has(asset))) fail()
    this.#routes = checkedRoutes(checked.burnDestinationRoutes)
    this.#defaultFeeRate = integer(checked.defaultBurnFeeRate === undefined ? 2 : checked.defaultBurnFeeRate, 1, 1000)
  }

  #guard () {
    try {
      const result = this.#authorized()
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {})
      if (result !== undefined || this.#wallet.disposed === true) fail('NOT_ENABLED')
    } catch { fail('NOT_ENABLED') }
  }

  async #native (method, ...args) {
    this.#guard()
    const result = await this.#wallet[method](...args)
    this.#guard()
    return result
  }

  async #call (method, fn) {
    this.#guard()
    if (this.#identity.method !== 'rgb_' + method) fail()
    if (!this.#granted.has(method)) fail('METHOD_NOT_SUPPORTED')
    try {
      const info = await this.#native('getInfo')
      if (info?.network !== this.#network || info.protocol !== 'RGB_L1') fail('NOT_ENABLED')
      if (info.ready !== true && method !== 'getInfo') fail('NOT_ENABLED')
      const result = await fn(info)
      this.#guard()
      return result
    } catch (error) {
      this.#guard()
      if (error instanceof WebRgbError) throw error
      const code = error?.code
      if (code === 'AUTHORIZATION_DECLINED') fail('USER_REJECTED')
      if (code === 'WALLET_CLOSED' || code === 'NOT_ENABLED') fail('NOT_ENABLED')
      if (['ASSET_NOT_FOUND', 'INVALID_PARAMS', 'METHOD_NOT_SUPPORTED'].includes(code)) fail(code)
      fail('INTERNAL_ERROR')
    }
  }

  #burnRoutes (info) {
    if (!this.#burnAssets.size || info.burnDestinationVersion !== 1 || !Array.isArray(info.burnDestinationRoutes)) return []
    const served = checkedRoutes(info.burnDestinationRoutes)
    return [...this.#routes.values()].filter(route => served.get(route.chainId)?.dstEid === route.dstEid)
  }

  #supports (method, info) {
    if (!this.#granted.has(method)) return false
    if (method === 'enable' || method === 'getInfo') return true
    if (info.ready !== true || !this.#assets.size) return false
    if (method === 'getTransferStatus') return typeof this.#wallet.listTransfers === 'function' && typeof this.#wallet.refreshTransfers === 'function'
    if (method === 'blindReceive' || method === 'witnessReceive') {
      return typeof this.#wallet.receiveWebRgbInvoice === 'function' && Array.isArray(info.methods) && info.methods.includes(method)
    }
    if (typeof this.#wallet[method] !== 'function') return false
    if (method === 'getConsignment' || method === 'burnAsset') {
      if (!this.#burnAssets.size || !Array.isArray(info.methods) || !info.methods.includes(method)) return false
      if (method === 'burnAsset') {
        return this.#supports('getConsignment', info) && typeof this.#wallet.getOperation === 'function' &&
          typeof this.#wallet.recoverBurn === 'function' && this.#burnRoutes(info).length > 0
      }
    }
    return true
  }

  #require (method, info) {
    if (!this.#supports(method, info)) fail('METHOD_NOT_SUPPORTED')
  }

  #asset (id, burn = false) {
    if (!(burn ? this.#burnAssets : this.#assets).has(checkedAsset(id))) fail('ASSET_NOT_FOUND')
    return id
  }

  async #approve (method, params) {
    this.#guard()
    let accepted
    try { accepted = await this.#confirm(Object.freeze({ origin: this.#identity.origin, method, params })) } catch {}
    this.#guard()
    if (accepted !== true) fail('USER_REJECTED')
  }

  enable () { return this.#call('enable', () => undefined) }

  getInfo () {
    return this.#call('getInfo', info => {
      const methods = METHODS.filter(name => this.#supports(name, info))
      const routes = methods.includes('burnAsset') ? this.#burnRoutes(info) : []
      return {
        ready: info.ready === true, network: this.#network, protocol: 'RGB_L1', methods,
        ...(routes.length && {
          burnDestinationVersion: 1,
          burnDestinationRoutes: routes,
          burnRecipientNamespaces: [...new Set(routes.map(route => route.chainId.split(':')[0]))]
        })
      }
    })
  }

  getAddress () {
    return this.#call('getAddress', async info => {
      this.#require('getAddress', info)
      return { address: text(await this.#native('getAddress'), 90, 'INTERNAL_ERROR') }
    })
  }

  #receive (method, args) {
    return this.#call(method, async info => {
      this.#require(method, info)
      const input = record(args, ['assetId', 'amount', 'durationSeconds', 'minConfirmations'])
      const { assetId = this.#assets.size === 1 ? [...this.#assets][0] : undefined,
        durationSeconds = 7200, minConfirmations: minimum = 3 } = input
      this.#asset(assetId)
      const amount = input.amount === undefined ? undefined : integer(input.amount, 1, Number.MAX_SAFE_INTEGER)
      integer(durationSeconds, 3600, 604800)
      const minConfirmations = Math.max(3, integer(minimum, 0, 255))
      const request = Object.freeze({ assetId, amount, durationSeconds, minConfirmations })
      const operationId = 'webrgb-invoice-' + hash(['utexo-webrgb-rpc-v1', this.#scopeKey, this.#identity.id])
      const requestKey = hash([this.#identity.fingerprint, method, request])
      const result = await this.#native('receiveWebRgbInvoice', {
        method, operationId, requestKey,
        options: { assetId, ...(amount !== undefined && { amount: String(amount) }), expirationSeconds: durationSeconds, minConfirmations },
        assertAuthorized: () => this.#guard(),
        approve: () => this.#approve(method, request)
      })
      return {
        invoice: text(result?.invoice, 8192, 'INTERNAL_ERROR'),
        recipientId: text(result?.recipientId, 1024, 'INTERNAL_ERROR'),
        expirationTimestamp: nativeNumber(result?.expirationTimestamp), minConfirmations
      }
    })
  }

  blindReceive (args = {}) { return this.#receive('blindReceive', args) }
  witnessReceive (args = {}) { return this.#receive('witnessReceive', args) }

  listAssets () {
    return this.#call('listAssets', async info => {
      this.#require('listAssets', info)
      const assets = await this.#native('listAssets')
      if (!Array.isArray(assets)) fail('INTERNAL_ERROR')
      return assets.filter(asset => this.#assets.has(asset?.assetId)).map(asset => ({
        id: asset.assetId,
        name: text(asset.name, 256, 'INTERNAL_ERROR'),
        precision: integer(asset.precision, 0, 18, 'INTERNAL_ERROR'),
        ...(asset.ticker != null && { ticker: text(asset.ticker, 32, 'INTERNAL_ERROR') }),
        schema: text(asset.schema, 32, 'INTERNAL_ERROR').toLowerCase()
      }))
    })
  }

  getAssetBalance (id) {
    return this.#call('getAssetBalance', async info => {
      this.#require('getAssetBalance', info)
      const assetId = this.#asset(id)
      const balance = nativeNumber((await this.#native('getAssetBalance', assetId))?.spendable)
      return { assetId, balance, raw: { spendable: balance } }
    })
  }

  async #transfers (id, txid, recipientOrId) {
    const assets = id === undefined ? this.#assets : [this.#asset(id)]
    const result = []
    for (const assetId of assets) {
      const rows = await this.#native('listTransfers', { assetId, ...(txid && { txid }) })
      if (!Array.isArray(rows)) fail('INTERNAL_ERROR')
      for (const row of rows) {
        if (txid !== undefined && row?.txid !== txid) fail('INTERNAL_ERROR')
        if (recipientOrId !== undefined && String(row.idx) !== recipientOrId && row.recipientId !== recipientOrId) continue
        result.push(projectTransfer(row, assetId))
      }
    }
    return result
  }

  listTransfers (id) {
    return this.#call('listTransfers', info => {
      this.#require('listTransfers', info)
      return this.#transfers(id)
    })
  }

  getTransferStatus (id, asset) {
    return this.#call('getTransferStatus', async info => {
      this.#require('getTransferStatus', info)
      const transferId = typeof id === 'number' ? String(integer(id, 0, Number.MAX_SAFE_INTEGER)) : text(id, 512)
      const assets = asset === undefined ? this.#assets : [this.#asset(asset)]
      for (const assetId of assets) await this.#native('refreshTransfers', { assetId })
      const txid = /^[a-fA-F\d]{64}$/.test(transferId) ? transferId.toLowerCase() : undefined
      const rows = await this.#transfers(asset, txid, txid === undefined ? transferId : undefined)
      if (rows.length > 1) fail('INTERNAL_ERROR')
      const transfer = rows[0] ?? null
      return { found: transfer !== null, status: transfer?.status ?? null, transfer }
    })
  }

  decodeRgbInvoice (args) {
    return this.#call('decodeRgbInvoice', async info => {
      this.#require('decodeRgbInvoice', info)
      const invoice = text(typeof args === 'string' ? args : record(args, ['invoice']).invoice, 8192)
      if (!invoice.startsWith('rgb:') || /\s/.test(invoice)) fail()
      const result = await this.#native('decodeRgbInvoice', invoice)
      if (result?.network !== this.#network) fail()
      if (result.assetId != null) this.#asset(result.assetId)
      if (!Array.isArray(result.transportEndpoints)) fail('INTERNAL_ERROR')
      const amount = result.assignment?.fungible === undefined ? null : nativeNumber(result.assignment.fungible) || null
      return {
        ...(result.assetId != null && { assetId: result.assetId }),
        amount,
        recipientId: text(result.recipientId, 1024, 'INTERNAL_ERROR'),
        ...(result.expirationTimestamp != null && { expirationTimestamp: nativeNumber(result.expirationTimestamp) }),
        network: result.network,
        transportEndpoints: result.transportEndpoints.map(value => text(value, 2048, 'INTERNAL_ERROR'))
      }
    })
  }

  #burnRequest (args, info) {
    const input = record(args, ['network', 'assetId', 'amount', 'feeRate', 'minConfirmations', 'burnRecipient', 'burnDestination'])
    if (input.network !== this.#network) fail()
    const assetId = this.#asset(input.assetId, true)
    const amount = exactAmount(input.amount)
    const { feeRate = this.#defaultFeeRate, minConfirmations: minimum = 6 } = input
    integer(feeRate, 1, 1000)
    const minConfirmations = Math.max(6, integer(minimum, 1, 255))
    const { chainId, address } = record(input.burnRecipient, ['chainId', 'address'])
    let destination
    try {
      destination = burnDestinationFor({ chainId, address }, this.#burnRoutes(info))
      if (burnDestinationHash(destination) !== burnDestinationHash(validateBurnDestination(input.burnDestination))) fail()
    } catch { fail() }
    const recipient = Object.freeze({ chainId, address: chainId.startsWith('eip155:') ? address.toLowerCase() : address })
    const request = Object.freeze({ network: input.network, assetId, amount, feeRate, minConfirmations,
      burnRecipient: recipient, burnDestination: destination })
    const operationId = 'webrgb-burn-' + hash(['utexo-webrgb-rpc-v1', this.#scopeKey, this.#identity.id])
    const binding = Object.freeze({ scopeKey: this.#scopeKey, requestKey: hash([this.#identity.fingerprint, request]) })
    return { request, operationId, binding }
  }

  #sameBurn (saved, { operationId, binding, request }) {
    const { args } = saved
    if (saved.id !== operationId || saved.kind !== 'rgb-burn' ||
        saved.webRgbBinding?.scopeKey !== binding.scopeKey || saved.webRgbBinding.requestKey !== binding.requestKey ||
        args?.assetId !== request.assetId || args.amount !== request.amount || args.feeRate !== String(request.feeRate) ||
        args.minConfirmations !== request.minConfirmations || args.commitment !== burnDestinationHash(request.burnDestination) ||
        saved.burnRecipient?.chainId !== request.burnRecipient.chainId || saved.burnRecipient.address !== request.burnRecipient.address) fail()
  }

  #burnResponse (request, txid) {
    if (typeof txid !== 'string' || !KEY.test(txid)) fail('INTERNAL_ERROR')
    return { transferId: txid, txid, assetId: request.assetId, amount: request.amount,
      burnRecipient: request.burnRecipient, burnDestination: request.burnDestination,
      status: 'WaitingConfirmations', minConfirmations: request.minConfirmations }
  }

  burnAsset (args) {
    return this.#call('burnAsset', async info => {
      this.#require('burnAsset', info)
      const { request, operationId, binding } = this.#burnRequest(args, info)
      const saved = await this.#native('getOperation', operationId)
      if (saved !== undefined) {
        this.#sameBurn(saved, { operationId, binding, request })
        fail('INTERNAL_ERROR')
      }
      await this.#approve('burnAsset', request)
      const result = await this.#native('burnAsset', {
        operationId, assetId: request.assetId, amount: request.amount, feeRate: String(request.feeRate),
        minConfirmations: request.minConfirmations, burnRecipient: request.burnRecipient, burnDestination: request.burnDestination,
        webRgbBinding: binding, assertAuthorized: () => this.#guard()
      })
      if (result?.assetId !== request.assetId || result.amount !== request.amount ||
          result.minConfirmations !== request.minConfirmations || result.burnRecipient?.chainId !== request.burnRecipient.chainId ||
          result.burnRecipient.address !== request.burnRecipient.address ||
          burnDestinationHash(result.burnDestination) !== burnDestinationHash(request.burnDestination)) fail('INTERNAL_ERROR')
      return this.#burnResponse(request, result.txid)
    })
  }

  /** Explicit reconciliation of the original RPC. This path never invokes burnAsset. */
  recoverBurn (args) {
    return this.#call('burnAsset', async info => {
      this.#require('burnAsset', info)
      const { request, operationId, binding } = this.#burnRequest(args, info)
      const saved = await this.#native('getOperation', operationId)
      if (!saved) fail('INTERNAL_ERROR')
      this.#sameBurn(saved, { operationId, binding, request })
      if (!['submitting', 'submitted'].includes(saved.stage) || typeof saved.txid !== 'string' || !KEY.test(saved.txid)) fail('INTERNAL_ERROR')
      const result = await this.#native('recoverBurn', operationId)
      if (result?.txid !== saved.txid || result.assetId !== request.assetId ||
          burnDestinationHash(result.burnDestination) !== burnDestinationHash(request.burnDestination)) fail('INTERNAL_ERROR')
      checkProof(result.proof, request.assetId, saved.txid)
      return this.#burnResponse(request, saved.txid)
    })
  }

  getConsignment (args) {
    return this.#call('getConsignment', async info => {
      this.#require('getConsignment', info)
      const input = record(args, ['assetId', 'txid'])
      const assetId = this.#asset(input.assetId, true)
      if (typeof input.txid !== 'string' || !/^[a-fA-F\d]{64}$/.test(input.txid)) fail()
      const txid = input.txid.toLowerCase()
      await this.#approve('getConsignment', Object.freeze({ assetId, txid }))
      const result = await this.#native('getConsignment', { assetId, txid, webRgbScopeKey: this.#scopeKey })
      return checkProof(result, assetId, txid)
    })
  }
}
