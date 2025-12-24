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
     * Quotes the costs of a transfer operation.
     *
     * @param {TransferOptions} options - The transfer's options.
     * @returns {Promise<Omit<TransferResult, 'hash'>>} The transfer's quotes.
     */
    quoteTransfer(options: TransferOptions): Promise<Omit<TransferResult, "hash">>;
    /**
     * Returns a transaction's receipt.
     *
     * @param {string} hash - The transaction's hash.
     * @returns {Promise<RgbTransactionReceipt | null>} The receipt, or null if the transaction has not been created yet.
     */
    getTransactionReceipt(hash: string): Promise<RgbTransactionReceipt | null>;
    /**
     * Returns a transfer's receipt.
     *
     * @param {string} hash - The transfer's hash.
     * @returns {Promise<RgbTransferReceipt | null>} The receipt, or null if the transfer has not been created yet.
     */
    getTransferReceipt(hash: string): Promise<RgbTransferReceipt | null>;
}
export type TransactionResult = import("@tetherto/wdk-wallet").TransactionResult;
export type TransferResult = import("@tetherto/wdk-wallet").TransferResult;
export type RgbTransactionReceipt = import("rgb-sdk").Transaction;
export type RgbTransferReceipt = import("rgb-sdk").RgbTransfer;
export type Keys = import("rgb-sdk").GeneratedKeys;
export type WitnessData = {
    /**
     * - The amount in satoshis.
     */
    amountSat?: number | bigint;
    /**
     * - The blinding factor.
     */
    blinding?: number;
};
export type TransferOptions = {
    /**
     * - The RGB asset ID to transfer.
     */
    token: string;
    /**
     * - The recipient's invoice (from blindReceive).
     */
    recipient: string;
    /**
     * - The amount to transfer.
     */
    amount: number | bigint;
    /**
     * - The fee rate in sat/vbyte (default: 1).
     */
    feeRate?: number;
    /**
     * - Minimum confirmations (default: 1).
     */
    minConfirmations?: number;
    /**
     * - The witness data.
     */
    witnessData?: WitnessData;
};
export type RgbTransaction = {
    /**
     * - The transaction's recipient.
     */
    to: string;
    /**
     * - The amount of bitcoins to send to the recipient (in satoshis).
     */
    value: number | bigint;
    /**
     * - Fee rate in sat/vbyte (default: 1).
     */
    feeRate?: number;
};
export type RgbWalletConfig = {
    /**
     * - The network (required).
     */
    network: "mainnet" | "testnet" | "regtest";
    /**
     * - The RGB node endpoint (required).
     */
    rgbNodeEndpoint: string;
    /**
     * - The wallet keys from rgb-sdk.
     */
    keys?: Keys;
    /**
     * - The maximum fee amount for transfer operations.
     */
    transferMaxFee?: number | bigint;
};
import { WalletAccountReadOnly } from '@tetherto/wdk-wallet';
