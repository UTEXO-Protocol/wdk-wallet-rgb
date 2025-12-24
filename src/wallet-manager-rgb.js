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

import WalletManager from '@tetherto/wdk-wallet'
import { deriveKeysFromSeed } from 'rgb-sdk'
import WalletAccountRgb from './wallet-account-rgb.js'

const MEMPOOL_SPACE_URL = 'https://mempool.space'

/** @typedef {import('@tetherto/wdk-wallet').FeeRates} FeeRates */

/** @typedef {import('./wallet-account-read-only-rgb.js').RgbWalletConfig} RgbWalletConfig */
/** @typedef {import('./wallet-account-rgb.js').RgbRestoreConfig} RgbRestoreConfig */
/** @typedef {import('rgb-sdk').GeneratedKeys} GeneratedKeys */

export default class WalletManagerRgb extends WalletManager {
  /**
   * Creates a new wallet manager for the RGB.
   *
   * @param {string | Uint8Array} seed - The wallet's [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) seed phrase.
   * @param {RgbWalletConfig} config - The configuration object (network and rgbNodeEndpoint are required).
   */
  constructor (seed, config = {}) {
    super(seed, config)

    if (!config.network) {
      throw new Error('network configuration is required.')
    }
    if (!config.rgbNodeEndpoint) {
      throw new Error('rgbNodeEndpoint configuration is required.')
    }

    /** @private */
    this._network = config.network
    /** @private */
    this._rgbNodeEndpoint = config.rgbNodeEndpoint
    /** @private @type {GeneratedKeys | null} */
    this._keys = null
  }

  /**
   * Initializes the wallet keys from the seed phrase
   * @private
   */
  async _initializeKeys () {
    if (this._keys) {
      return this._keys
    }

    if (!this.seed) {
      throw new Error('RGB wallet requires a BIP-39 mnemonic seed phrase')
    }
    // Derive keys from mnemonic
    this._keys = await deriveKeysFromSeed(this._network, this.seed)
    return this._keys
  }

  /**
   * Returns the account always at index 0 RGB does not support multiple BIP-44
   *
   * @param {number} [index] - The account index (must be 0 for RGB).
   * @example
   * const account = await wallet.getAccount();
   * @returns {Promise<WalletAccountRgb>} The account.
   */
  async getAccount (index = 0) {
    if (index !== 0) {
      throw new Error('RGB wallets only support account index 0. Multiple accounts are not supported.')
    }
    if (!this._accounts[index]) {
      await this._initializeKeys()
      const account = await WalletAccountRgb.at(
        this.seed,
        {
          network: this._network,
          rgbNodeEndpoint: this._rgbNodeEndpoint,
          keys: this._keys
        }
      )

      this._accounts[index] = account
    }

    return this._accounts[index]
  }

  /**
   * Restores the account from a wallet backup.
   *
   * @param {RgbRestoreConfig} restoreConfig - Restore configuration containing backup details.
   * @returns {Promise<WalletAccountRgb>} The restored account.
   */
  async restoreAccountFromBackup (restoreConfig = {}) {
    const index = 0

    await this._initializeKeys()

    const config = {
      ...this._config,
      ...restoreConfig,
      network: this._network,
      rgbNodeEndpoint: this._rgbNodeEndpoint,
      keys: this._keys
    }

    const account = await WalletAccountRgb.fromBackup(this.seed, config)
    this._accounts[index] = account

    return account
  }

  /**
   * Returns the wallet account at a specific BIP-44 derivation path.
   *
   * @param {string} path - The derivation path (e.g. "0'/0/0").
   * @returns {Promise<never>} The account.
   */
  async getAccountByPath (path) {
    throw new Error('Method not supported on the RGB')
  }

  /**
   * Returns the current fee rates.
   *
   * @returns {Promise<FeeRates>} The fee rates (in satoshis).
   */
  async getFeeRates () {
    const response = await fetch(`${MEMPOOL_SPACE_URL}/api/v1/fees/recommended`)

    const { fastestFee, hourFee } = await response.json()

    return {
      normal: BigInt(hourFee),
      fast: BigInt(fastestFee)
    }
  }

  /**
   * Overrides the parent dispose() to explicitly clean up sensitive data in this._keys.
   */
  dispose () {
    if (this._keys) {
      if (this._keys.xpriv) {
        this._keys.xpriv = ''
      }
      if (this._keys.mnemonic) {
        this._keys.mnemonic = ''
      }
      this._keys = null
    }
    super.dispose()
  }
}
