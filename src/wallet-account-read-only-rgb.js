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

import { WalletAccountReadOnly } from '@tetherto/wdk-wallet'
import { WalletManager } from './libs/rgb-sdk.js'

/** @typedef {import('@tetherto/wdk-wallet').TransactionResult} TransactionResult */
/** @typedef {import('@tetherto/wdk-wallet').TransferOptions} TransferOptions */
/** @typedef {import('@tetherto/wdk-wallet').TransferResult} TransferResult */
/** @typedef {import('rgb-sdk').Transaction} Transaction */

/**
 * @typedef {Object} RgbTransaction
 * @property {string} to - The transaction's recipient.
 * @property {number} value - The amount of bitcoins to send to the recipient (in satoshis).
 */

/**
 * @typedef {Object} RgbWalletConfig
 * @property {string} [network] - The network (default: "regtest").
 * @property {string} [rgb_node_endpoint] - The RGB node endpoint (default: "http://127.0.0.1:8000").
 * @property {Object} [keys] - The wallet keys from rgb-sdk.
 */

export default class WalletAccountReadOnlyRgb extends WalletAccountReadOnly {
  /**
   * Creates a new RGB read-only wallet account.
   *
   * @param {string} address - The account's address.
   * @param {RgbWalletConfig} [config] - The configuration object.
   */
  constructor (address, config = {}) {
    super(address)

    /**
     * The read-only wallet account configuration.
     *
     * @protected
     * @type {RgbWalletConfig}
     */
    this._config = config
    /** @private */
    this._wallet = null
  }

  /**
   * Initializes the RGB wallet manager for read-only operations
   * @private
   */
  async _initializeWallet () {
    if (this._wallet) {
      return this._wallet
    }

    if (!this._config.keys) {
      throw new Error('Wallet keys are required for read-only account')
    }

    const { keys } = this._config
    const network = this._config.network || 'regtest'
    const rgbNodeEndpoint = this._config.rgb_node_endpoint || 'http://127.0.0.1:8000'

    this._wallet = new WalletManager({
      xpub_van: keys.account_xpub_vanilla,
      xpub_col: keys.account_xpub_colored,
      master_fingerprint: keys.master_fingerprint,
      network,
      rgb_node_endpoint: rgbNodeEndpoint
    })

    return this._wallet
  }

  /**
   * Returns the account's bitcoin balance.
   *
   * @returns {Promise<bigint>} The bitcoin balance (in satoshis).
   */
  async getBalance () {
    await this._initializeWallet()
    const balance = await this._wallet.getBtcBalance()
    return BigInt(balance.vanilla.settled || 0)
  }

  /**
   * Returns the account balance for a specific token.
   *
   * @param {string} tokenAddress - The asset ID of the token.
   * @returns {Promise<bigint>} The token balance (in base unit).
   */
  async getTokenBalance (tokenAddress) {
    await this._initializeWallet()
    const balance = await this._wallet.getAssetBalance(tokenAddress)
    return BigInt(balance || 0)
  }

  /**
   * Quotes the costs of a send transaction operation.
   *
   * @param {Transaction} tx - The transaction.
   * @param {string} tx.to - The transaction's recipient.
   * @param {number} tx.value - The amount of bitcoins to send to the recipient (in satoshis).
   * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quotes.
   */
  async quoteSendTransaction ({ to, value }) {
    const feeRate = await this._wallet.estimateFeeRate(1)
    const psbt = await this._wallet.sendBtcBegin({
      address: to,
      amount: value,
      fee_rate: Math.round(feeRate)
    })
    const signedPsbt = await this._wallet.signPsbt(psbt)
    const { fee } = await this._wallet.estimateFee(signedPsbt)
    return { fee: BigInt(fee) }
  }

  /**
   * Quotes the costs of a transfer operation.
   *
   * @param {TransferOptions} options - The transfer's options.
   * @property {string} options.assetId - The RGB asset ID to transfer.
   * @property {string} options.to - The recipient's invoice (from blindReceive).
   * @property {number} options.value - The amount to transfer.
   * @property {number} [options.feeRate] - The fee rate in sat/vbyte (default: 1).
   * @property {number} [options.minConfirmations] - Minimum confirmations (default: 1).
   * @returns {Promise<Omit<TransferResult, 'hash'>>} The transfer's quotes.
   *
   */
  async quoteTransfer (options) {
    const feeRate = await this._wallet.estimateFeeRate(1)
    const { to: invoice, assetId, value: amount, witnessData, minConfirmations } = options
    const psbt = await this._wallet.sendBegin({
      invoice,
      asset_id: assetId,
      witness_data: witnessData,
      amount,
      fee_rate: Math.round(feeRate),
      min_confirmations: minConfirmations
    })
    const signedPsbt = await this._wallet.signPsbt(psbt)
    const { fee } = await this._wallet.estimateFee(signedPsbt)
    return { fee: BigInt(fee) }
  }

  /**
   * Returns a transaction's receipt.
   *
   * @param {string} hash - The transaction's hash.
   * @returns {Promise<Transaction | null>} The receipt, or null if the transaction has not been created yet.
   */
  async getTransactionReceipt (hash) {
    const transactions = await this._wallet.listTransactions()
    const tx = transactions.find(t => t.txid === hash)
    return tx || null
  }

  /**
   * Returns a transfer's receipt.
   *
   * @param {string} hash - The transfer's hash.
   * @returns {Promise<RgbTransfer | null>} The receipt, or null if the transfer has not been created yet.
   */
  async getTransferReceipt (hash) {
    const transfers = await this._wallet.listTransfers()
    const transfer = transfers.find(t => t.txid === hash)
    return transfer || null
  }
}
