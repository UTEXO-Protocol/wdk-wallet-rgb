// Copyright 2024 RGB OS Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
'use strict'

import WalletAccountReadOnlyRgb from './wallet-account-read-only-rgb.js'
import { BIP32_VERSIONS } from '@utexo/rgb-sdk-core'
import { BareRgbLibBinding } from './bare-binding.js'
import { BareSigner } from './bare-signer.js'
import rgblib from '@utexo/rgb-lib-bare'
// eslint-disable-next-line camelcase
import { sodium_memzero } from 'sodium-universal'
import { HDKey } from '@scure/bip32'
import { base58 } from '@scure/base'

/** @typedef {import('@tetherto/wdk-wallet').IWalletAccount} IWalletAccount */
/** @typedef {import('@tetherto/wdk-wallet').KeyPair} KeyPair */
/** @typedef {import('@tetherto/wdk-wallet').TransactionResult} TransactionResult */
/** @typedef {import('@tetherto/wdk-wallet').TransferResult} TransferResult */
/** @typedef {import('./wallet-account-read-only-rgb.js').TransferOptions} TransferOptions */

/**
 * Result returned by registerWallet method.
 *
 * @typedef {Object} RegisterWalletResult
 * @property {string} address - The wallet's Bitcoin address.
 * @property {BtcBalance} btcBalance - The wallet's Bitcoin balance.
 */
/** @typedef {import('@utexo/rgb-sdk-core').SendAssetEndRequestModel} SendAssetEndRequest */
/** @typedef {import('@utexo/rgb-sdk-core').SendResult} SendResult */
/** @typedef {import('@utexo/rgb-sdk-core').Unspent} Unspent */
/** @typedef {import('./wallet-account-read-only-rgb.js').RgbTransaction} RgbTransaction */
/** @typedef {import('./wallet-account-read-only-rgb.js').RgbWalletConfig} RgbWalletConfig */

/**
 * @typedef {Object} RgbKeyPair
 * @property {Uint8Array} publicKey - The public key.
 * @property {Uint8Array | null} privateKey - The private key (null if the account has been disposed).
 * @property {Uint8Array} [accountXpubVanilla] - The vanilla extended public key.
 * @property {Uint8Array} [accountXpubColored] - The colored extended public key.
 * @property {Uint8Array} [masterFingerprint] - The master fingerprint.
 */

/**
 * @typedef {Object} RgbRestoreParams
 * @property {string} password - The password to decrypt the backup.
 * @property {string} backupFilePath - The backup file path.
 * @property {string} dataDir - The restore directory.
 */

/**
 * @typedef {RgbWalletConfig & RgbRestoreParams} RgbRestoreConfig
 */

/** @implements {IWalletAccount} */
export default class WalletAccountRgb extends WalletAccountReadOnlyRgb {
  /** @package */
  constructor (walletOrBindings, config = {}) {
    super(undefined, config)

    // Accept either { binding, signer, seed } (new architecture) or a legacy wallet object
    if (walletOrBindings && walletOrBindings.binding) {
      this._wallet = walletOrBindings.binding
      this._signer = walletOrBindings.signer
      this._seed = walletOrBindings.seed || null
    } else {
      this._wallet = walletOrBindings
      this._signer = null
      this._seed = null
    }
    /** @private */
    this._index = 0 // always 0 for RGB
    /** @private */
    this._keyPair = null
  }

  /**
   * Creates a new RGB wallet account.
   *
   * @param {string | Uint8Array} seed - The wallet's [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) seed phrase.
   * @param {RgbWalletConfig} config - The configuration object (network and rgbNodeEndpoint are required).
   * @returns {Promise<WalletAccountRgb>} The wallet account.
   */
  static async at (seed, config = {}) {
    const keys = config.keys
    if (!keys) {
      throw new Error('Wallet keys are required')
    }
    if (!config.network) {
      throw new Error('Network is required')
    }
    if (!config.dataDir) {
      throw new Error('dataDir is required — pass a persistent, app-private path.')
    }

    const { network, indexerUrl, transportEndpoint, dataDir } = config
    const binding = new BareRgbLibBinding({
      xpubVan: keys.accountXpubVanilla,
      xpubCol: keys.accountXpubColored,
      masterFingerprint: keys.masterFingerprint,
      mnemonic: keys.mnemonic || null,
      network,
      indexerUrl,
      transportEndpoint,
      dataDir
    })
    const signer = new BareSigner(binding)

    // The binding creates the wallet in its constructor (synchronous in bare)
    // Go online to connect to the indexer
    binding.getOnline()

    const account = new WalletAccountRgb({ binding, signer, seed }, config)

    return account
  }

  /**
   * Restores an RGB wallet account from an encrypted backup.
   *
   * @param {string | Uint8Array} seed - The wallet's BIP-39 seed phrase.
   * @param {RgbRestoreConfig} config - The configuration object with backup data.
   * @returns {Promise<WalletAccountRgb>} The restored wallet account.
   */
  static async fromBackup (seed, config = {}) {
    const keys = config.keys
    if (!keys) {
      throw new Error('Wallet keys are required')
    }
    if (!config.network) {
      throw new Error('Network is required')
    }
    if (!config.backupFilePath) {
      throw new Error('Backup file is required')
    }
    if (!config.password) {
      throw new Error('Backup password is required')
    }

    if (!config.dataDir) {
      throw new Error('Restore directory is required')
    }

    const { dataDir, indexerUrl, transportEndpoint } = config
    rgblib.restoreBackup(config.backupFilePath, config.password, config.dataDir)

    const binding = new BareRgbLibBinding({
      xpubVan: keys.accountXpubVanilla,
      xpubCol: keys.accountXpubColored,
      masterFingerprint: keys.masterFingerprint,
      mnemonic: keys.mnemonic || null,
      dataDir,
      indexerUrl,
      transportEndpoint
    })
    const signer = new BareSigner(binding)
    binding.getOnline()

    const account = new WalletAccountRgb({ binding, signer, seed }, config)

    return account
  }

  /**
   * The derivation path's index of this account.
   *
   * @type {number}
   */
  get index () {
    return this._index
  }

  /**
   * The derivation path of this account.
   * Note: RGB SDK uses BIP-86 (Taproot) derivation, not BIP-44.
   * RGB SDK handles key derivation internally using:
   * - Vanilla (Bitcoin): m/86'/0'/0' (mainnet) or m/86'/1'/0' (testnet)
   * - Colored (RGB): m/86'/827166'/0' (mainnet) or m/86'/827167'/0' (testnet)
   * This getter returns a representation for WDK interface compatibility.
   *
   * @type {string}
   */
  get path () {
    // RGB SDK uses BIP-86 (Taproot) derivation: m/86'/coinType'/0'
    // For WDK interface compatibility, return a path representation
    // The actual derivation is handled by @utexo/rgb-sdk-core internally
    const network = this._config.network
    const isMainnet = network === 'mainnet'
    const coinType = isMainnet ? 0 : 1
    return `m/86'/${coinType}'/0'`
  }

  /**
   * The derivation path of the colored account.
   *
   * @type {string}
   */
  get coloredPath () {
    const network = this._config.network
    const isMainnet = network === 'mainnet'
    const coinType = isMainnet ? 827166 : 827167
    return `m/86'/${coinType}'/0'`
  }

  /**
   * The account's key pair.
   * Note: This derives keys using the same BIP-86 path that @utexo/rgb-sdk-core uses for WDK interface compatibility.
   * RGB SDK handles all actual operations internally.
   * Includes RGB-specific fields: accountXpubVanilla, accountXpubColored, masterFingerprint.
   *
   * @type {RgbKeyPair}
   */
  get keyPair () {
    if (this._keyPair) {
      return this._keyPair
    }

    const keys = this._config.keys
    const network = this._config.network
    const versions = BIP32_VERSIONS[network] || BIP32_VERSIONS.testnet
    const hdPriv = HDKey.fromExtendedKey(keys.xpriv, {
      private: versions.private,
      public: versions.public
    })
    this._keyPair = {
      // WDK KeyPair fields
      publicKey: hdPriv.publicKey,
      privateKey: hdPriv.privateKey,
      // RGB-specific fields
      accountXpubVanilla: new Uint8Array(base58.decode(keys.accountXpubVanilla)),
      accountXpubColored: new Uint8Array(base58.decode(keys.accountXpubColored)),
      masterFingerprint: new Uint8Array(Buffer.from(keys.masterFingerprint, 'hex'))
    }
    return this._keyPair
  }

  /**
   * Returns the account's address.
   *
   * @returns {Promise<string>} The account's address.
   */
  getAddress () {
    return this._wallet.getAddress()
  }

  /**
   * Signs a message using Bitcoin message signing.
   *
   * @param {string} message - The message to sign.
   * @returns {Promise<string>} The message's signature.
   */
  async sign (message) {
    if (this._signer) {
      return await this._signer.signMessage({ message, seed: this._seed, network: this._config.network })
    }
    return await this._wallet.signMessage(message)
  }

  // `verify(message, signature)` inherited from WalletAccountReadOnlyRgb.

  /**
   * Sends a Bitcoin transaction (for UTXO management).
   * Note: For RGB asset transfers, use transfer() instead.
   * This method uses the bare-binding's sendBtcBegin → external sign → sendBtcEnd
   * flow since the underlying rgb-lib wallet is watch-only.
   *
   * @param {RgbTransaction} tx - The transaction.
   * @returns {Promise<TransactionResult>} The transaction's result.
   */
  async sendTransaction (options) {
    try {
      // Use sendBtcBegin/End flow so we can sign externally (rgb-lib wallet is watch-only)
      const psbt = await this._wallet.sendBtcBegin({
        address: options.to,
        amount: options.value,
        feeRate: Math.max(1, Math.round(options.feeRate || 1))
      })
      const signedPsbt = await this.signPsbt(psbt)
      const fee = this._signer ? (await this._signer.estimateFee(signedPsbt)).fee : 0
      const result = await this._wallet.sendBtcEnd({ signedPsbt })
      return {
        hash: result?.txid || result || 'unknown',
        fee: BigInt(fee)
      }
    } catch (error) {
      throw new Error(`BTC send failed: ${error.message}`)
    }
  }

  /**
   * Transfers an RGB asset to another wallet.
   * This method implements the RGB transfer flow using sendBegin/sendEnd.
   *
   * @param {TransferOptions} options - The transfer's options.
   * @returns {Promise<TransferResult>} The transfer's result.
   */
  async transfer (options) {
    if (!options.token && !options.recipient) {
      throw new Error('token and recipient (invoice) are required for RGB asset transfers')
    }

    if (!options.recipient.trim().startsWith('rgb:')) {
      throw new Error('recipient must be a valid RGB invoice string (starting with "rgb:"), not a Bitcoin address. Use receiveAsset() to generate an invoice.')
    }

    // RGB SDK transfer flow (single sendBegin — do NOT pre-flight via quoteTransfer,
    // since sendBegin reserves UTXO allocations on the wallet):
    // 1. Recipient calls blindReceive to get an invoice
    // 2. Sender calls sendBegin with the invoice (reserves allocations)
    // 3. Sender signs the PSBT using signPsbt
    // 4. Sender enforces the transferMaxFee guard
    // 5. Sender calls sendEnd with the signed PSBT (broadcasts the tx)

    try {
      // Clamp to >= 1 sat/vB: rgb-lib's C-FFI expects a uint (ptr_to_num::<u32>),
      // so floats like 0.5 would break conversion, and a value of 0 would
      // produce an unbroadcastable tx (fee = 0 never confirms).
      const feeRate = Math.max(1, Math.round(options.feeRate || 1))
      const psbt = await this.sendBegin({
        invoice: options.recipient,
        assetId: options.token,
        witnessData: options.witnessData
          ? {
              amountSat: options.witnessData.amountSat,
              blinding: options.witnessData.blinding
            }
          : undefined,
        amount: options.amount,
        feeRate,
        minConfirmations: options.minConfirmations ?? 1
      })

      const signedPsbt = await this.signPsbt(psbt)

      // Estimate fee from the signed PSBT (same formula as bare-binding.estimateFee)
      // and enforce the transferMaxFee guard before broadcasting.
      const sizeBytes = signedPsbt.length * 3 / 4
      const estimatedVbytes = Math.ceil(sizeBytes * 0.4)
      const fee = BigInt(feeRate * estimatedVbytes)
      if (this._config.transferMaxFee !== undefined && fee >= BigInt(this._config.transferMaxFee)) {
        throw new Error('Exceeded maximum fee cost for transfer operation.')
      }

      const result = await this.sendEnd({
        signedPsbt
      })

      return {
        hash: result.txid || 'unknown',
        fee
      }
    } catch (error) {
      throw new Error(`RGB transfer failed: ${error.message}`)
    }
  }

  /**
   * Returns the transfer history of the account.
   *
   * @param {Object} [options] - The options.
   * @param {string} [options.assetId] - Optional asset ID to filter transfers.
   * @param {number} [options.limit] - The number of transfers to return (default: 10).
   * @param {number} [options.skip] - The number of transfers to skip (default: 0).
   * @returns {Array<RgbTransfer>} The transfers.
   */
  getTransfers (options = {}) {
    const { assetId, limit = 10, skip = 0 } = options

    let transfers = []
    try {
      if (assetId) {
        transfers = this._wallet.listTransfers(assetId)
      } else {
        transfers = this._wallet.listTransfers()
      }

      // Apply pagination
      const result = transfers.slice(skip, skip + limit)
      return result
    } catch (error) {
      return []
    }
  }

  /**
   * Returns a read-only copy of the account.
   *
   * @returns {Promise<WalletAccountReadOnlyRgb>} The read-only account.
   */
  toReadOnlyAccount () {
    const address = this.getAddress()
    const rgbReadOnlyAccount = new WalletAccountReadOnlyRgb(address, {
      ...this._config,
      keys: this._config.keys
    })

    return rgbReadOnlyAccount
  }

  /**
   * Disposes the wallet account, erasing its private keys from the memory.
   * Note: rgb-lib manages its own keys (via the watch-only xpub); we clear
   * our derived keyPair here.
   */
  dispose () {
    if (this._keyPair?.privateKey) {
      sodium_memzero(this._keyPair.privateKey)
      this._keyPair.privateKey = null
    }
    if (this._wallet) {
      this._wallet.dispose()
    }
    this._wallet = null
  }

  // ============================================================================
  // RGB-Specific Methods (beyond @tetherto/wdk-wallet interface)
  // ============================================================================

  /**
   * Gets the underlying BareRgbLibBinding instance.
   * Lets callers reach low-level binding methods that aren't yet
   * exposed on WalletAccountRgb.
   *
   * @returns {BareRgbLibBinding} The bare-binding instance.
   */
  getRgbWallet () {
    return this._wallet
  }

  /**
   * Lists all RGB assets in the wallet.
   *
   * @returns {Array<ListAssets>} Array of asset objects.
   */
  listAssets () {
    return this._wallet.listAssets()
  }

  /**
   * Issues a new NIA (Non-Inflatable Asset).
   *
   * @param {Object} options - Issue options.
   * @param {string} options.ticker - Asset ticker symbol.
   * @param {string} options.name - Asset name.
   * @param {Array<number>} options.amounts - Array of amounts to issue.
   * @param {number} options.precision - Decimal precision.
   * @returns {IssueAssetNIA} The issued asset.
   */
  issueAssetNia (options) {
    return this._wallet.issueAssetNia(options)
  }

  /**
   * Issues a new CFA (Collectible Fungible Asset).
   *
   * @param {Object} options - Issue options.
   * @param {string} options.name - Asset name.
   * @param {Array<number>} options.amounts - Array of amounts to issue.
   * @param {number} options.precision - Decimal precision.
   * @param {string} [options.details] - Optional asset details/description.
   * @param {string} [options.filePath] - Optional media file path.
   * @returns {IssueAssetCFA} The issued asset.
   */
  issueAssetCfa (options) {
    return this._wallet.issueAssetCfa(options)
  }

  /**
   * Issues a new UDA (Unique Digital Asset / NFT).
   *
   * @param {Object} options - Issue options.
   * @param {string} options.ticker - Asset ticker symbol.
   * @param {string} options.name - Asset name.
   * @param {number} options.precision - Decimal precision.
   * @param {string} [options.details] - Optional asset details/description.
   * @param {string} [options.mediaFilePath] - Optional primary media file.
   * @param {Array<string>} [options.attachmentsFilePaths] - Optional attachments.
   * @returns {IssueAssetUDA} The issued asset.
   */
  issueAssetUda (options) {
    return this._wallet.issueAssetUda(options)
  }

  /**
   * Issues a new IFA (Inflatable Fungible Asset).
   *
   * @param {Object} options - Issue options.
   * @param {string} options.ticker - Asset ticker symbol.
   * @param {string} options.name - Asset name.
   * @param {number} options.precision - Decimal precision.
   * @param {Array<number>} options.amounts - Initial amounts to issue.
   * @param {Array<number>} options.inflationAmounts - Amounts available for later inflation.
   * @param {string} [options.rejectListUrlOpt] - Optional reject-list URL.
   * @returns {IssueAssetIFA} The issued asset.
   */
  issueAssetIfa (options) {
    return this._wallet.issueAssetIfa(options)
  }

  // `getTokenBalance` is inherited from WalletAccountReadOnlyRgb — it
  // returns a BigInt of the settled balance, which pear-wrk-wdk's
  // safeStringify converts to a numeric string on the wire so WDK core's
  // balance validator accepts it. No override needed here.

  /**
   * Full balance breakdown: `{settled, future, spendable}`. Returned
   * as-is from rgb-lib for callers that need the three-component view.
   */
  getAssetBalance (assetId) {
    return this._wallet.getAssetBalance(assetId)
  }

  /**
   * Estimates the current fee rate for inclusion in `blocks`.
   *
   * @param {number} blocks - Target confirmation blocks.
   * @returns {Promise<number>} Fee rate in sat/vB (clamped ≥ 1).
   */
  estimateFeeRate (blocks) {
    return this._wallet.estimateFeeRate(blocks)
  }

  /**
   * Reads backup metadata (name, needsBackup, lastBackupTs, etc.).
   *
   * @returns {Promise<Object>}
   */
  backupInfo () {
    return this._wallet.backupInfo()
  }

  /**
   * Parses an RGB invoice string and returns its structured fields
   * (recipientId, assetId, amount, transportEndpoints, …).
   *
   * @param {{invoice: string}} options
   * @returns {Promise<Object>}
   */
  decodeRGBInvoice (options) {
    return this._wallet.decodeRGBInvoice(options)
  }

  /**
   * Creates a blind receive invoice for receiving RGB assets.
   *
   * @param {Object} options - Blind receive options.
   * @param {string} [options.assetId] - The asset ID to receive.
   * @param {number} options.amount - The amount to receive.
   * @param {boolean} options.witness - Create witness invoice, not require available utxos.
   * @returns {InvoiceReceiveData} Blind receive data including invoice.
   */
  receiveAsset (options) {
    if (options.witness) {
      return this._wallet.witnessReceive(options)
    } else {
      return this._wallet.blindReceive(options)
    }
  }

  /**
   * Begins a send operation (creates PSBT).
   *
   * @param {Object} options - Send options.
   * @param {string} options.invoice - The blind receive invoice.
   * @param {string} options.assetId - The RGB asset ID to transfer.
   * @param {Object} options.witnessData - The witness data.
   * @param {number} options.amount - The amount to transfer.
   * @param {number} [options.feeRate] - Fee rate in sat/vbyte (default: 1).
   * @param {number} [options.minConfirmations] - Minimum confirmations (default: 1).
   * @returns {string} The PSBT (base64 encoded).
   */
  sendBegin (options) {
    return this._wallet.sendBegin(options)
  }

  /**
   * Begin a BTC send operation — returns unsigned PSBT for external signing.
   * @param {Object} options - { address, amount, feeRate }
   * @returns {Promise<string>} Unsigned PSBT string.
   */
  sendBtcBegin (options) {
    return this._wallet.sendBtcBegin({
      address: options.to || options.address,
      amount: options.value || options.amount,
      feeRate: options.feeRate || 1
    })
  }

  /**
   * Finalize a BTC send operation with a signed PSBT.
   * @param {Object} options - { signedPsbt }
   * @returns {Promise<Object>} Send result { txid }.
   */
  sendBtcEnd (options) {
    return this._wallet.sendBtcEnd(options)
  }

  /**
   * Quotes the costs of a send transaction operation.
   *
   * @param {Omit<RgbTransaction, 'feeRate'>} tx - The transaction.
   * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quotes.
   */
  async quoteSendTransaction (tx) {
    const psbt = await this._wallet.sendBtcBegin({
      address: tx.to,
      amount: tx.value,
      feeRate: tx.feeRate || 1
    })
    let feeRate = 1
    try {
      // Clamp to >= 1: estimateFeeRate can return <1 sat/vB on low-activity
      // regtest / idle mainnet; Math.round(0.3) → 0 would produce a stuck tx.
      feeRate = Math.max(1, Math.round(await this._wallet.estimateFeeRate(1)))
    } catch (e) {
      feeRate = 1
    }
    const estimatedVbytes = 140
    const fee = BigInt(feeRate * estimatedVbytes)
    return { fee, psbt }
  }

  /**
   * Quotes the costs of a transfer operation.
   *
   * @param {TransferOptions} options - The transfer's options.
   * @returns {Promise<Omit<TransferResult, 'hash'>>} The transfer's quotes.
   */
  async quoteTransfer (options) {
    // Lightweight fee quote — does NOT call sendBegin (which reserves UTXO
    // allocations as a side effect). Conservative vbyte estimate for an RGB
    // transfer including witness data; actual fee is computed during transfer()
    // from the real signed PSBT and enforced against transferMaxFee there.
    let feeRate = options.feeRate
    if (!feeRate) {
      try {
        feeRate = await this._wallet.estimateFeeRate(1)
      } catch (_) {
        feeRate = 1
      }
    }
    // Clamp to >= 1 sat/vB (see comment in transfer() re: rgb-lib uint coercion).
    feeRate = Math.max(1, Math.round(feeRate))
    const estimatedVbytes = 200
    const fee = BigInt(feeRate * estimatedVbytes)
    return { fee }
  }

  /**
   * Signs a PSBT.
   *
   * @param {string} psbt - The PSBT to sign (base64 encoded).
   * @returns {Promise<string>} The signed PSBT (base64 encoded).
   */
  async signPsbt (psbt) {
    // rgb-lib wallet is watch-only (mnemonic: null), so we sign externally
    // using BareSigner which implements pure-JS Taproot signing via rgb-sdk.
    if (this._signer && this._seed) {
      return await this._signer.signPsbtWithSeed(this._seed, psbt, this._config.network)
    }
    // Fallback to rgb-lib's internal signer (only works if wallet has the keys)
    return await this._wallet.signPsbt(psbt)
  }

  /**
   * Brodcasts a send transaction.
   *
   * @param {Object} options - Send end options.
   * @param {string} options.signed_psbt - The signed PSBT (base64 encoded).
   * @returns {SendResult} The send result.
   */
  sendEnd (options) {
    return this._wallet.sendEnd(options)
  }

  /**
   * Creates UTXOs. Combines createUtxosBegin,signPsbt,createUtxosEnd.
   *
   * @param {Object} options - Create UTXOs options.
   * @param {boolean} [options.upTo] - Create up to specified number (default: true).
   * @param {number} [options.num] - Number of UTXOs to create.
   * @param {number} [options.size] - Size of each UTXO in satoshis.
   * @param {number} [options.feeRate] - Fee rate in sat/vbyte (default: 1).
   * @returns {Promise<number>} number of UTXOs created.
   */
  async createUtxos (options) {
    const psbt = await this._wallet.createUtxosBegin(options)
    const signedPsbt = await this.signPsbt(psbt)
    return this._wallet.createUtxosEnd({ signedPsbt })
  }

  /**
   * Begins UTXO creation operation.
   *
   * @param {Object} options - UTXO creation options.
   * @param {boolean} [options.upTo] - Create up to specified number (default: true).
   * @param {number} [options.num] - Number of UTXOs to create.
   * @param {number} [options.size] - Size of each UTXO in satoshis.
   * @param {number} [options.feeRate] - Fee rate in sat/vbyte (default: 1).
   * @returns {string} The PSBT (base64 encoded).
   */
  createUtxosBegin (options) {
    return this._wallet.createUtxosBegin(options)
  }

  /**
   * Finalizes UTXO creation operation.
   *
   * @param {Object} options - UTXO creation end options.
   * @param {string} options.signedPsbt - The signed PSBT (base64 encoded).
   * @returns {number} Number of UTXOs created.
   */
  createUtxosEnd (options) {
    return this._wallet.createUtxosEnd(options)
  }

  /**
   * Inflates an existing RGB IFA asset (combines inflateBegin, signPsbt, inflateEnd).
   *
   * @param {Object} options - Inflate options.
   * @param {string} options.assetId - The asset ID to inflate.
   * @param {number[]} options.amounts - Inflation amounts.
   * @param {number} [options.feeRate] - Fee rate in sat/vbyte (default: 1).
   * @param {number} [options.minConfirmations] - Minimum confirmations (default: 1).
   * @returns {Promise<Object>} Operation result with txid and batch transfer info.
   */
  async inflate (options) {
    const begin = await this._wallet.inflateBegin({
      assetId: options.assetId,
      amounts: options.amounts,
      feeRate: options.feeRate || 1,
      minConfirmations: options.minConfirmations || 1,
      dryRun: false
    })
    const signedPsbt = await this.signPsbt(begin.psbt)
    return this._wallet.inflateEnd({ signedPsbt })
  }

  /**
   * Drains all wallet funds to the given address (combines drainToBegin, signPsbt, drainToEnd).
   *
   * @param {Object} options - Drain options.
   * @param {string} options.address - The destination address.
   * @param {boolean} [options.destroyAssets] - If true, also drain UTXOs holding RGB allocations.
   * @param {number} [options.feeRate] - Fee rate in sat/vbyte (default: 1).
   * @returns {Promise<string>} The broadcast transaction ID.
   */
  async drainTo (options) {
    const psbt = await this._wallet.drainToBegin({
      address: options.address,
      destroyAssets: !!options.destroyAssets,
      feeRate: options.feeRate || 1
    })
    const signedPsbt = await this.signPsbt(psbt)
    return this._wallet.drainToEnd({ signedPsbt })
  }

  /**
   * Lists unspent transaction outputs (UTXOs).
   *
   * @returns {Array<Unspent>} Array of UTXO objects.
   */
  listUnspents () {
    return this._wallet.listUnspents()
  }

  /**
   * Lists Bitcoin transactions.
   *
   * @returns {Array<RgbTransactionReceipt>} Array of transaction objects.
   */
  listTransactions () {
    return this._wallet.listTransactions()
  }

  /**
   * Lists transfers
   *
   * @param {string} [assetId] - Optional asset ID to filter transfers.
   * @returns {Array<RgbTransfer>} Array of transfer objects.
   */
  listTransfers (assetId) {
    if (assetId) {
      return this._wallet.listTransfers(assetId)
    }
    return this._wallet.listTransfers()
  }

  /**
   * Fails a transfer
   *
   * @param {options} options - The options.
   * @param {number} options.batchTransferIdx - The batch transfer index.
   * @returns {boolean} True if the transfer was failed, false otherwise.
   */
  failTransfers (transferId) {
    return this._wallet.failTransfers(transferId)
  }

  /**
   * Creates an encrypted backup of the wallet.
   *
   * @param {options} options - The options.
   * @param {string} options.password - The password used to encrypt the backup file.
   * @param {string} options.backupPath - The backup path.
   * @returns {{success: boolean}} The backup response from the bare-binding.
   */
  createBackup (options) {
    return this._wallet.createBackup(options)
  }

  /**
   * Restores a wallet from a backup file.
   *
   * @param {RgbRestoreParams} params - Restore options.
   * @returns {{message: string}} The restore response from rgb-lib.
   */
  restoreFromBackup (params) {
    return rgblib.restoreBackup(params.backupFilePath, params.password, params.dataDir)
  }

  /**
   * VSS (Versioned Storage Service) cloud-backup config.
   *
   * @typedef {Object} VssBackupConfigParams
   * @property {string} serverUrl - VSS server base URL.
   * @property {string} storeId - Per-wallet store identifier.
   * @property {string} signingKeyHex - 64-char hex (32-byte secp256k1 secret key) used to auth + sign requests.
   * @property {boolean} [encryptionEnabled=true] - Client-side encrypt payloads before upload.
   * @property {boolean} [autoBackup=false] - Enable automatic backup on state-changing ops.
   * @property {'Async'|'Blocking'} [backupMode='Async'] - Auto-backup flush mode.
   */

  /**
   * VSS backup status returned by {@link vssBackupInfo}.
   *
   * @typedef {Object} VssBackupInfo
   * @property {boolean} backupExists - Whether a backup exists on the server.
   * @property {number|null} serverVersion - Latest version on the server, or null.
   * @property {boolean} backupRequired - Whether local state is ahead of the server.
   */

  /**
   * Configures automatic VSS cloud backup. Once configured with
   * `autoBackup: true`, rgb-lib flushes wallet state to the VSS server
   * after state-changing operations. Encryption is client-side; the
   * server never sees plaintext when `encryptionEnabled` is set.
   *
   * @param {VssBackupConfigParams} config - VSS backup configuration.
   * @returns {void}
   */
  configureVssBackup (config) {
    return this._wallet.configureVssBackup(config)
  }

  /**
   * Disables automatic VSS backup previously enabled via
   * {@link configureVssBackup}. Does not delete any existing remote
   * backup; only stops further automatic flushes.
   *
   * @returns {void}
   */
  disableVssAutoBackup () {
    return this._wallet.disableVssAutoBackup()
  }

  /**
   * Uploads a VSS cloud backup of the current wallet state immediately.
   * Use for app-controlled checkpoints rather than relying on the
   * automatic on-write flush.
   *
   * @param {VssBackupConfigParams} config - VSS backup configuration.
   * @returns {Promise<number>} The snapshot version persisted.
   */
  vssBackup (config) {
    return this._wallet.vssBackup(config)
  }

  /**
   * Queries the VSS server for this wallet's backup status without
   * mutating anything — whether a backup exists, the server's latest
   * version, and whether local state is ahead of the server.
   *
   * @param {VssBackupConfigParams} config - VSS backup configuration.
   * @returns {Promise<VssBackupInfo>} The backup status.
   */
  vssBackupInfo (config) {
    return this._wallet.vssBackupInfo(config)
  }

  /**
   * Refreshes the wallet state
   *
   * @returns {void}
   */
  refreshWallet () {
    return this._wallet.refreshWallet()
  }

  /**
   * Registers the wallet with the RGB node.
   * Returns the wallet's address and current Bitcoin balance.
   *
   * @returns {Promise<RegisterWalletResult>} The registration result containing the wallet address and BTC balance.
   */
  async registerWallet () {
    return await this._wallet.registerWallet()
  }

  /**
   * Syncs RGB wallet state with Bitcoin blockchain.
   *
   * @returns {void}
   */
  syncWallet () {
    return this._wallet.syncWallet()
  }
}
