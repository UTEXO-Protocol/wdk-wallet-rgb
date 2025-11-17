// Copyright 2024 Tether Operations Limited
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
import { WalletManager } from './libs/rgb-sdk.js'
/** @typedef {import('@tetherto/wdk-wallet').IWalletAccount} IWalletAccount */
/** @typedef {import('@tetherto/wdk-wallet').KeyPair} KeyPair */
/** @typedef {import('@tetherto/wdk-wallet').TransactionResult} TransactionResult */
/** @typedef {import('@tetherto/wdk-wallet').TransferOptions} TransferOptions */
/** @typedef {import('@tetherto/wdk-wallet').TransferResult} TransferResult */
/** @typedef {import('rgb-sdk').Transaction} Transaction */
/** @typedef {import('rgb-sdk').RgbTransfer} RgbTransfer */
/** @typedef {import('rgb-sdk').IssueAssetNIAResponse} IssueAssetNIA */
/** @typedef {import('rgb-sdk').ListAssetsResponse} ListAssets */
/** @typedef {import('rgb-sdk').InvoiceReceiveData} InvoiceReceiveData */
/** @typedef {import('rgb-sdk').SendAssetEndRequestModel} SendAssetEndRequest */
/** @typedef {import('rgb-sdk').SendResult} SendResult */
/** @typedef {import('rgb-sdk').Unspent} Unspent */
/** @typedef {import('rgb-sdk').RgbTransfer} RgbTransfer */
/** @typedef {import('./wallet-account-read-only-rgb.js').RgbTransaction} RgbTransaction */
/** @typedef {import('./wallet-account-read-only-rgb.js').RgbWalletConfig} RgbWalletConfig */

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
   * @param {RgbWalletConfig} [config] - The configuration object.
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
    if (!config.rgb_node_endpoint) {
      throw new Error('RGB node endpoint is required')
    }

    const network = config.network
    const rgbNodeEndpoint = config.rgb_node_endpoint

    const wallet = new WalletManager({
      xpub_van: keys.account_xpub_vanilla,
      xpub_col: keys.account_xpub_colored,
      master_fingerprint: keys.master_fingerprint,
      rgb_node_endpoint: rgbNodeEndpoint,
      seed,
      network

    })

    // Register wallet with RGB node
    await wallet.registerWallet()

    const account = new WalletAccountRgb(wallet, config)

    return account
  }

  /**
   * Restores an RGB wallet account from an encrypted backup.
   *
   * @param {string | Uint8Array} seed - The wallet's BIP-39 seed phrase.
   * @param {RgbWalletConfig & { backup: Buffer | Uint8Array | ArrayBuffer | import('node:stream').Readable, password: string, filename?: string, xpub_van?: string, xpub_col?: string, master_fingerprint?: string }} config - The configuration object with backup data.
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
    if (!config.rgb_node_endpoint) {
      throw new Error('RGB node endpoint is required')
    }
    if (!config.backup) {
      throw new Error('Backup file is required')
    }
    if (!config.password) {
      throw new Error('Backup password is required')
    }

    const network = config.network
    const rgbNodeEndpoint = config.rgb_node_endpoint

    const wallet = new WalletManager({
      xpub_van: keys.account_xpub_vanilla,
      xpub_col: keys.account_xpub_colored,
      master_fingerprint: keys.master_fingerprint,
      network,
      rgb_node_endpoint: rgbNodeEndpoint
    })

    await wallet.restoreFromBackup({
      backup: config.backup,
      password: config.password,
      filename: config.filename,
      xpub_van: config.xpub_van ?? keys.account_xpub_vanilla,
      xpub_col: config.xpub_col ?? keys.account_xpub_colored,
      master_fingerprint: config.master_fingerprint ?? keys.master_fingerprint
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
    // The actual derivation is handled by rgb-sdk internally
    const network = this._config.network || 'regtest'
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
    const network = this._config.network || 'regtest'
    const isMainnet = network === 'mainnet'
    const coinType = isMainnet ? 827166 : 827167
    return `m/86'/${coinType}'/0'`
  }

  /**
   * The account's key pair.
   * Note: This derives keys using the same BIP-86 path that rgb-sdk uses for WDK interface compatibility.
   * RGB SDK handles all actual operations internally.
   * Includes RGB-specific fields: accountXpubVanilla, accountXpubColored, masterFingerprint.
   *
   * @type {KeyPair & { accountXpubVanilla?: string, accountXpubColored?: string, masterFingerprint?: string}}
   */
  get keyPair () {
    if (this._keyPair) {
      return this._keyPair
    }
    const keys = this._config.keys
    this._keyPair = {
      // WDK KeyPair fields
      publicKey: keys.xpriv,
      privateKey: keys.xpub,
      // RGB-specific fields
      accountXpubVanilla: keys.account_xpub_vanilla,
      accountXpubColored: keys.account_xpub_colored,
      masterFingerprint: keys.master_fingerprint
    }
    return this._keyPair
  }

  /**
   * Returns the account's address.
   *
   * @returns {Promise<string>} The account's address.
   */
  async getAddress () {
    return await this._wallet.getAddress()
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
   * @param {string} tx.to - Recipient Bitcoin address.
   * @param {number} tx.value - Amount in satoshis.
   * @param {number} [tx.fee_rate] - Fee rate in sat/vbyte (default: 1).
   * @returns {Promise<TransactionResult>} The transaction's result.
   */
  async sendTransaction (options) {
    try {
      const psbt = await this._wallet.sendBtcBegin({
        address: options.to,
        amount: options.value,
        fee_rate: options.fee_rate
      })
      const signedPsbt = await this.signPsbt(psbt)
      const result = await this._wallet.sendBtcEnd({ signed_psbt: signedPsbt })
      return {
        hash: result || 'unknown',
        fee: BigInt(0)
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
   * @property {string} options.asset_id - The RGB asset ID to transfer.
   * @property {string} options.to - The recipient's invoice (from blindReceive).
   * @property {number} options.value - The amount to transfer.
   * @property {Object} [options.witness_data] - The witness data.
   * @property {number} [options.witness_data.amount_sat] - The amount in satoshis.
   * @property {number} [options.witness_data.blinding] - The blinding factor.
   * @property {number} [options.fee_rate] - The fee rate in sat/vbyte (default: 1).
   * @property {number} [options.min_confirmations] - Minimum confirmations (default: 1).
   * @returns {Promise<TransferResult>} The transfer's result.
   */
  async transfer (options) {
    if (!options.asset_id && !options.to) {
      throw new Error('asset_id and to (invoice) are required for RGB asset transfers')
    }

    // RGB SDK transfer flow:
    // 1. Recipient calls blindReceive to get an invoice
    // 2. Sender calls sendBegin with the invoice
    // 3. Sender signs the PSBT using signPsbt
    // 4. Sender calls sendEnd with the signed PSBT

    try {
      const psbt = await this.sendBegin({
        invoice: options.to,
        asset_id: options.asset_id,
        witness_data: options.witness_data,
        amount: options.value,
        fee_rate: options.fee_rate,
        min_confirmations: options.min_confirmations
      })

      const signedPsbt = await this.signPsbt(psbt)

      const result = await this.sendEnd({
        signed_psbt: signedPsbt
      })

      // Return in the format expected by @tetherto/wdk-wallet
      return {
        hash: result.txid || 'unknown',
        fee: BigInt(result.fee || 0)
      }
    } catch (error) {
      throw new Error(`RGB transfer failed: ${error.message}`)
    }
  }

  /**
   * Returns the transfer history of the account.
   *
   * @param {string} [assetId] - Optional asset ID to filter transfers.
   * @returns {Promise<Array<RgbTransfer>>} The transfers.
   */
  async getTransfers (assetId) {
    let transfers = []
    try {
      if (assetId) {
        transfers = await this._wallet.listTransfers(assetId)
      } else {
        const assets = await this._wallet.listAssets()
        for (const asset of assets) {
          try {
            const assetTransfers = await this._wallet.listTransfers(asset.asset_id)
            transfers.push(...assetTransfers)
          } catch (error) {
            continue
          }
        }
      }

      return transfers
    } catch (error) {
      return []
    }
  }

  /**
   * Returns a read-only copy of the account.
   *
   * @returns {Promise<WalletAccountReadOnlyRgb>} The read-only account.
   */
  async toReadOnlyAccount () {
    const address = await this.getAddress()

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
      if (typeof this._keyPair.privateKey === 'string') {
        this._keyPair.privateKey = ''
      } else {
        this._keyPair.privateKey.fill(0)
      }
    }
    this._keyPair = null
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
   * @returns {Promise<Array<ListAssets>>} Array of asset objects.
   */
  async listAssets () {
    return await this._wallet.listAssets()
  }

  /**
   * Issues a new NIA (Non-Inflatable Asset).
   *
   * @param {Object} options - Issue options.
   * @param {string} options.ticker - Asset ticker symbol.
   * @param {string} options.name - Asset name.
   * @param {Array<number>} options.amounts - Array of amounts to issue.
   * @param {number} options.precision - Decimal precision.
   * @returns {Promise<IssueAssetNIA>} The issued asset.
   */
  async issueAssetNia (options) {
    return await this._wallet.issueAssetNia(options)
  }

  /**
   * Creates a blind receive invoice for receiving RGB assets.
   *
   * @param {Object} options - Blind receive options.
   * @param {string} [options.asset_id] - The asset ID to receive.
   * @param {number} options.amount - The amount to receive.
   * @param {boolean} options.witness - Create witness invoice, not require available utxos.
   * @returns {Promise<InvoiceReceiveData>} Blind receive data including invoice.
   */
  async receiveAsset (options) {
    if (options.witness) {
      return await this._wallet.witnessReceive(options)
    } else {
      return await this._wallet.blindReceive(options)
    }
  }

  /**
   * Begins a send operation (creates PSBT).
   *
   * @param {Object} options - Send options.
   * @param {string} options.invoice - The blind receive invoice.
   * @param {string} options.asset_id - The RGB asset ID to transfer.
   * @param {Object} options.witness_data - The witness data.
   * @param {number} options.amount - The amount to transfer.
   * @param {number} [options.fee_rate] - Fee rate in sat/vbyte (default: 1).
   * @param {number} [options.min_confirmations] - Minimum confirmations (default: 1).
   * @returns {Promise<string>} The PSBT (base64 encoded).
   */
  async sendBegin (options) {
    return await this._wallet.sendBegin(options)
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
   * @returns {Promise<SendResult>} The send result.
   */
  async sendEnd (options) {
    return await this._wallet.sendEnd(options)
  }

  /**
   * Creates UTXOs. Combines createUtxosBegin,signPsbt,createUtxosEnd.
   *
   * @param {Object} options - Create UTXOs options.
   * @param {boolean} [options.up_to] - Create up to specified number (default: true).
   * @param {number} [options.num] - Number of UTXOs to create.
   * @param {number} [options.size] - Size of each UTXO in satoshis.
   * @param {number} [options.fee_rate] - Fee rate in sat/vbyte (default: 1).
   * @returns {Promise<number>} number of UTXOs created.
   */
  async createUtxos (options) {
    return await this._wallet.createUtxos(options)
  }

  /**
   * Begins UTXO creation operation.
   *
   * @param {Object} options - UTXO creation options.
   * @param {boolean} [options.up_to] - Create up to specified number (default: true).
   * @param {number} [options.num] - Number of UTXOs to create.
   * @param {number} [options.size] - Size of each UTXO in satoshis.
   * @param {number} [options.fee_rate] - Fee rate in sat/vbyte (default: 1).
   * @returns {Promise<string>} The PSBT (base64 encoded).
   */
  async createUtxosBegin (options) {
    return await this._wallet.createUtxosBegin(options)
  }

  /**
   * Finalizes UTXO creation operation.
   *
   * @param {Object} options - UTXO creation end options.
   * @param {string} options.signed_psbt - The signed PSBT (base64 encoded).
   * @returns {Promise<number>} Number of UTXOs created.
   */
  async createUtxosEnd (options) {
    return await this._wallet.createUtxosEnd(options)
  }

  /**
   * Lists unspent transaction outputs (UTXOs).
   *
   * @returns {Promise<Array<Unspent>>} Array of UTXO objects.
   */
  async listUnspents () {
    return await this._wallet.listUnspents()
  }

  /**
   * Lists Bitcoin transactions.
   *
   * @returns {Promise<Array<Transaction>>} Array of transaction objects.
   */
  async listTransactions () {
    return await this._wallet.listTransactions()
  }

  /**
   * Lists transfers for a specific asset.
   *
   * @param {string} assetId - The asset ID.
   * @returns {Promise<Array<RgbTransfer>>} Array of transfer objects.
   */
  async listTransfers (assetId) {
    return await this._wallet.listTransfers(assetId)
  }

  /**
   * Creates an encrypted backup of the wallet.
   *
   * @param {string} password - The password used to encrypt the backup file.
   * @returns {Promise<{message: string, download_url: string}>} The backup response from rgb-sdk.
   */
  async createBackup (password) {
    return await this._wallet.createBackup(password)
  }

  /**
   * Restores a wallet from a backup file.
   *
   * @param {Object} params - Restore options.
   * @param {Buffer | Uint8Array | ArrayBuffer | import('node:stream').Readable} params.backup - The backup file data.
   * @param {string} params.password - The password used to encrypt the backup.
   * @param {string} [params.filename] - Optional filename metadata.
   * @param {string} [params.xpub_van] -  Vanilla xpub override.
   * @param {string} [params.xpub_col] - Colored xpub override.
   * @param {string} [params.master_fingerprint] - Optional master fingerprint override.
   * @returns {Promise<{message: string}>} The restore response from rgb-sdk.
   */
  async restoreFromBackup (params) {
    return await this._wallet.restoreFromBackup(params)
  }

  /**
   * Refreshes the wallet state
   *
   * @returns {Promise<void>}
   */
  async refreshWallet () {
    return await this._wallet.refreshWallet()
  }

  /**
   * Registers the wallet with the RGB node.
   *
   * @returns {Promise<void>}
   */
  async registerWallet () {
    return await this._wallet.registerWallet()
  }

  /**
   * Syncs RGB wallet state with Bitcoin blockchain.
   *
   * @returns {Promise<void>}
   */
  async syncWallet () {
    return await this._wallet.syncWallet()
  }
}
