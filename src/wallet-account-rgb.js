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
import { WalletManager, BIP32_VERSIONS, restoreFromBackup } from '@utexo/rgb-sdk'
// eslint-disable-next-line camelcase
import { sodium_memzero } from 'sodium-universal'
import { HDKey } from '@scure/bip32'
import { base58 } from '@scure/base'

/** @typedef {import('@tetherto/wdk-wallet').IWalletAccount} IWalletAccount */
/** @typedef {import('@tetherto/wdk-wallet').KeyPair} KeyPair */
/** @typedef {import('@tetherto/wdk-wallet').TransactionResult} TransactionResult */
/** @typedef {import('@tetherto/wdk-wallet').TransferResult} TransferResult */
/** @typedef {import('./wallet-account-read-only-rgb.js').TransferOptions} TransferOptions */
/** @typedef {import('@utexo/rgb-sdk').Transaction} RgbTransactionReceipt */
/** @typedef {import('@utexo/rgb-sdk').RgbTransfer} RgbTransferReceipt */
/** @typedef {import('@utexo/rgb-sdk').IssueAssetNIAResponse} IssueAssetNIA */
/** @typedef {import('@utexo/rgb-sdk').ListAssetsResponse} ListAssets */
/** @typedef {import('@utexo/rgb-sdk').InvoiceReceiveData} InvoiceReceiveData */
/** @typedef {import('@utexo/rgb-sdk').BtcBalance} BtcBalance */

/**
 * Result returned by registerWallet method.
 *
 * @typedef {Object} RegisterWalletResult
 * @property {string} address - The wallet's Bitcoin address.
 * @property {BtcBalance} btcBalance - The wallet's Bitcoin balance.
 */
/** @typedef {import('@utexo/rgb-sdk').SendAssetEndRequestModel} SendAssetEndRequest */
/** @typedef {import('@utexo/rgb-sdk').SendResult} SendResult */
/** @typedef {import('@utexo/rgb-sdk').Unspent} Unspent */
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
  constructor (wallet, config = {}) {
    super(undefined, config)

    /** @private */
    this._wallet = wallet
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

    const { network, indexerUrl, transportEndpoint, dataDir } = config
    const wallet = new WalletManager({
      xpubVan: keys.accountXpubVanilla,
      xpubCol: keys.accountXpubColored,
      masterFingerprint: keys.masterFingerprint,
      seed,
      network,
      indexerUrl,
      transportEndpoint,
      dataDir
    })

    const account = new WalletAccountRgb(wallet, config)

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
    restoreFromBackup({
      backupFilePath: config.backupFilePath,
      password: config.password,
      dataDir: config.dataDir
    })
    const wallet = new WalletManager({
      xpubVan: keys.accountXpubVanilla,
      xpubCol: keys.accountXpubColored,
      masterFingerprint: keys.masterFingerprint,
      dataDir,
      indexerUrl,
      transportEndpoint
    })

    const account = new WalletAccountRgb(wallet, config)

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
    // The actual derivation is handled by @utexo/rgb-sdk internally
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
   * Note: This derives keys using the same BIP-86 path that @utexo/rgb-sdk uses for WDK interface compatibility.
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
    return await this._wallet.signMessage(message)
  }

  /**
   * Verifies a message's signature.
   *
   * @param {string} message - The original message.
   * @param {string} signature - The signature to verify.
   * @returns {Promise<boolean>} True if the signature is valid.
   */
  async verify (message, signature) {
    return await this._wallet.verifyMessage(message, signature)
  }

  /**
   * Sends a Bitcoin transaction (for UTXO management).
   * Note: For RGB asset transfers, use transfer() instead.
   * This method uses the RGB SDK's sendBegin/sendEnd flow for Bitcoin transactions.
   *
   * @param {RgbTransaction} tx - The transaction.
   * @returns {Promise<TransactionResult>} The transaction's result.
   */
  async sendTransaction (options) {
    try {
      const { fee } = await this.quoteSendTransaction(options)
      const psbt = this._wallet.sendBtcBegin({
        address: options.to,
        amount: options.value,
        feeRate: options.feeRate || 1
      })
      const signedPsbt = await this.signPsbt(psbt)
      const result = this._wallet.sendBtcEnd({ signedPsbt })
      return {
        hash: result || 'unknown',
        fee
      }
    } catch (error) {
      throw new Error(`RGB transfer failed: ${error.message}`)
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

    // RGB SDK transfer flow:
    // 1. Recipient calls blindReceive to get an invoice
    // 2. Sender calls sendBegin with the invoice
    // 3. Sender signs the PSBT using signPsbt
    // 4. Sender calls sendEnd with the signed PSBT

    // Quote the transfer and validate fee before attempting the transfer
    const { fee } = await this.quoteTransfer(options)
    if (this._config.transferMaxFee !== undefined && fee >= this._config.transferMaxFee) {
      throw new Error('Exceeded maximum fee cost for transfer operation.')
    }

    try {
      const psbt = this.sendBegin({
        invoice: options.recipient,
        assetId: options.token,
        witnessData: options.witnessData
          ? {
              amountSat: options.witnessData.amountSat,
              blinding: options.witnessData.blinding
            }
          : undefined,
        amount: options.amount,
        feeRate: options.feeRate || 1,
        minConfirmations: options.minConfirmations
      })

      const signedPsbt = await this.signPsbt(psbt)
      const result = this.sendEnd({
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
   * Note: RGB SDK manages keys internally, but we clear our derived keyPair.
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
   * Gets the underlying RGB SDK WalletManager instance.
   * This allows direct access to all RGB SDK methods.
   *
   * @returns {WalletManager} The RGB SDK WalletManager instance.
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
   * Quotes the costs of a send transaction operation.
   *
   * @param {Omit<RgbTransaction, 'feeRate'>} tx - The transaction.
   * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quotes.
   */
  async quoteSendTransaction (tx) {
    const feeRate = this._wallet.estimateFeeRate(1)
    const psbt = this._wallet.sendBtcBegin({
      address: tx.to,
      amount: tx.value,
      feeRate: Math.round(feeRate)
    })
    const signedPsbt = await this.signPsbt(psbt)
    const { fee } = await this._wallet.estimateFee(signedPsbt)
    return { fee: BigInt(fee) }
  }

  /**
   * Quotes the costs of a transfer operation.
   *
   * @param {TransferOptions} options - The transfer's options.
   * @returns {Promise<Omit<TransferResult, 'hash'>>} The transfer's quotes.
   */
  async quoteTransfer (options) {
    const estimatedFeeRate = this._wallet.estimateFeeRate(1)
    const feeRate = options.feeRate || estimatedFeeRate
    const psbt = this._wallet.sendBegin({
      invoice: options.recipient,
      assetId: options.token,
      witnessData: options.witnessData
        ? {
            amountSat: options.witnessData.amountSat,
            blinding: options.witnessData.blinding
          }
        : undefined,
      amount: options.amount,
      feeRate: Math.round(feeRate),
      minConfirmations: options.minConfirmations
    })
    const signedPsbt = await this.signPsbt(psbt)
    const { fee } = await this._wallet.estimateFee(signedPsbt)
    return { fee: BigInt(fee) }
  }

  /**
   * Signs a PSBT.
   *
   * @param {string} psbt - The PSBT to sign (base64 encoded).
   * @returns {Promise<string>} The signed PSBT (base64 encoded).
   */
  async signPsbt (psbt) {
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
    return await this._wallet.createUtxos(options)
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
   * @returns {{message: string, downloadUrl: string}} The backup response from @utexo/rgb-sdk.
   */
  createBackup (options) {
    return this._wallet.createBackup(options)
  }

  /**
   * Restores a wallet from a backup file.
   *
   * @param {RgbRestoreParams} params - Restore options.
   * @returns {{message: string}} The restore response from @utexo/rgb-sdk.
   */
  restoreFromBackup (params) {
    return restoreFromBackup(params)
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
