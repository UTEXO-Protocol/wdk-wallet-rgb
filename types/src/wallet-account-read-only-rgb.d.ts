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
    constructor(address: string, config?: RgbWalletConfig);
    /**
     * The read-only wallet account configuration.
     *
     * @protected
     * @type {RgbWalletConfig}
     */
    protected _config: RgbWalletConfig;
    /** @private */
    private _wallet;
    /**
     * Initializes the RGB wallet manager for read-only operations
     * @private
     */
    private _initializeWallet;
    /**
     * Quotes the costs of a send transaction operation.
     *
     * @param {Transaction} options - The transaction.
     * @param {string} options.to - The transaction's recipient.
     * @param {number} options.value - The amount of bitcoins to send to the recipient (in satoshis).
     * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quotes.
     */
    quoteSendTransaction(options: Transaction): Promise<Omit<TransactionResult, "hash">>;
    /**
     * Returns a transaction's receipt.
     *
     * @param {string} hash - The transaction's hash.
     * @returns {Promise<Transaction | null>} The receipt, or null if the transaction has not been created yet.
     */
    getTransactionReceipt(hash: string): Promise<Transaction | null>;
    /**
     * Returns a transfer's receipt.
     *
     * @param {string} hash - The transfer's hash.
     * @returns {Promise<RgbTransfer | null>} The receipt, or null if the transfer has not been created yet.
     */
    getTransferReceipt(hash: string): Promise<RgbTransfer | null>;
}
export type TransactionResult = import("@tetherto/wdk-wallet").TransactionResult;
export type TransferOptions = import("@tetherto/wdk-wallet").TransferOptions;
export type TransferResult = import("@tetherto/wdk-wallet").TransferResult;
export type Transaction = import("rgb-sdk").Transaction;
export type RgbTransaction = {
    /**
     * - The transaction's recipient.
     */
    to: string;
    /**
     * - The amount of bitcoins to send to the recipient (in satoshis).
     */
    value: number;
};
export type RgbWalletConfig = {
    /**
     * - The network (default: "regtest").
     */
    network?: string;
    /**
     * - The RGB node endpoint (default: "http://127.0.0.1:8000").
     */
    rgb_node_endpoint?: string;
    /**
     * - The wallet keys from rgb-sdk.
     */
    keys?: any;
};
import { WalletAccountReadOnly } from '@tetherto/wdk-wallet';
