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
    constructor(seed: string | Uint8Array, config?: RgbWalletConfig);
    /** @private */
    private _network;
    /** @private */
    private _rgbNodeEndpoint;
    /** @private @type {GeneratedKeys | null} */
    private _keys;
    /**
     * Initializes the wallet keys from the seed phrase
     * @private
     */
    private _initializeKeys;
    /**
     * Returns the account always at index 0 RGB does not support multiple BIP-44
     *
     * @param {number} [index] - The account index (must be 0 for RGB).
     * @example
     * const account = await wallet.getAccount();
     * @returns {Promise<WalletAccountRgb>} The account.
     */
    getAccount(index?: number): Promise<WalletAccountRgb>;
    /**
     * Restores the account from a wallet backup.
     *
     * @param {RgbRestoreConfig} restoreConfig - Restore configuration containing backup details.
     * @returns {Promise<WalletAccountRgb>} The restored account.
     */
    restoreAccountFromBackup(restoreConfig?: RgbRestoreConfig): Promise<WalletAccountRgb>;
    /**
     * Returns the wallet account at a specific BIP-44 derivation path.
     *
     * @param {string} path - The derivation path (e.g. "0'/0/0").
     * @returns {Promise<never>} The account.
     */
    getAccountByPath(path: string): Promise<never>;
}
export type FeeRates = import("@tetherto/wdk-wallet").FeeRates;
export type RgbWalletConfig = import("./wallet-account-read-only-rgb.js").RgbWalletConfig;
export type RgbRestoreConfig = import("./wallet-account-rgb.js").RgbRestoreConfig;
export type GeneratedKeys = import("rgb-sdk").GeneratedKeys;
import WalletManager from '@tetherto/wdk-wallet';
import WalletAccountRgb from './wallet-account-rgb.js';
