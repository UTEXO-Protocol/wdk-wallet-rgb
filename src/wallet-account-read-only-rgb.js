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

import { WalletAccountReadOnly } from '@tetherto/wdk-wallet'
import { WalletManager } from 'rgb-sdk'

/** @typedef {import('@tetherto/wdk-wallet').TransactionResult} TransactionResult */
/** @typedef {import('@tetherto/wdk-wallet').TransferResult} TransferResult */
/** @typedef {import('rgb-sdk').Transaction} RgbTransactionReceipt */
/** @typedef {import('rgb-sdk').RgbTransfer} RgbTransferReceipt */
/** @typedef {import('rgb-sdk').GeneratedKeys} Keys */

/**
 * @typedef {Object} WitnessData
 * @property {number | bigint} [amountSat] - The amount in satoshis.
 * @property {number} [blinding] - The blinding factor.
 */

/**
 * @typedef {Object} TransferOptions
 * @property {string} token - The RGB asset ID to transfer.
 * @property {string} recipient - The recipient's invoice (from blindReceive).
 * @property {number | bigint} amount - The amount to transfer.
 * @property {number} [feeRate] - The fee rate in sat/vbyte (default: 1).
 * @property {number} [minConfirmations] - Minimum confirmations (default: 1).
 * @property {WitnessData} [witnessData] - The witness data.
 */

/**
 * @typedef {Object} RgbTransaction
 * @property {string} to - The transaction's recipient.
 * @property {number | bigint} value - The amount of bitcoins to send to the recipient (in satoshis).
 * @property {number} [feeRate] - Fee rate in sat/vbyte (default: 1).
 */

/**
 * @typedef {Object} RgbWalletConfig
 * @property {'mainnet' | 'testnet' | 'regtest'} network - The network (required).
 * @property {string} rgbNodeEndpoint - The RGB node endpoint (required).
 * @property {Keys} [keys] - The wallet keys from rgb-sdk.
 * @property {number | bigint} [transferMaxFee] - The maximum fee amount for transfer operations.
 */

export default class WalletAccountReadOnlyRgb extends WalletAccountReadOnly {
  /**
   * Creates a new RGB read-only wallet account.
   *
   * @param {string} address - The account's address.
   * @param {RgbWalletConfig} config - The configuration object (network and rgbNodeEndpoint are required).
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

    if (!this._config.keys) {
      throw new Error('Wallet keys are required for read-only account')
    }

    if (!this._config.network) {
      throw new Error('Network configuration is required.')
    }

    if (!this._config.rgbNodeEndpoint) {
      throw new Error('RGB node endpoint configuration is required.')
    }

    const { keys } = this._config

    const network = this._config.network
    const rgbNodeEndpoint = this._config.rgbNodeEndpoint

    /** @private */
    this._wallet = new WalletManager({
      xpub_van: keys.account_xpub_vanilla,
      xpub_col: keys.account_xpub_colored,
      master_fingerprint: keys.master_fingerprint,
      network,
      rgb_node_endpoint: rgbNodeEndpoint
    })
  }

  /**
   * Returns the account's bitcoin balance.
   *
   * @returns {Promise<bigint>} The bitcoin balance (in satoshis).
   */
  async getBalance () {
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
    const balance = await this._wallet.getAssetBalance(tokenAddress)
    return BigInt(balance.settled || 0)
  }

  /**
   * Quotes the costs of a send transaction operation.
   *
   * @param {Omit<RgbTransaction, 'feeRate'>} tx - The transaction.
   * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quotes.
   */
  async quoteSendTransaction (tx) {
    throw new Error('quoteSendTransaction is not implemented for read-only accounts. Use WalletAccountRgb instead.')
  }

  /**
   * Quotes the costs of a transfer operation.
   *
   * @param {TransferOptions} options - The transfer's options.
   * @returns {Promise<Omit<TransferResult, 'hash'>>} The transfer's quotes.
   */
  async quoteTransfer (options) {
    throw new Error('quoteTransfer is not implemented for read-only accounts. Use WalletAccountRgb instead.')
  }

  /**
   * Returns a transaction's receipt.
   *
   * @param {string} hash - The transaction's hash.
   * @returns {Promise<RgbTransactionReceipt | null>} The receipt, or null if the transaction has not been created yet.
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
   * @returns {Promise<RgbTransferReceipt | null>} The receipt, or null if the transfer has not been created yet.
   */
  async getTransferReceipt (hash) {
    const transfers = await this._wallet.listTransfers()
    const transfer = transfers.find(t => t.txid === hash)
    return transfer || null
  }
}
