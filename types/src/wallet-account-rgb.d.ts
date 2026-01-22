/** @typedef {import('@tetherto/wdk-wallet').IWalletAccount} IWalletAccount */
/** @typedef {import('@tetherto/wdk-wallet').KeyPair} KeyPair */
/** @typedef {import('@tetherto/wdk-wallet').TransactionResult} TransactionResult */
/** @typedef {import('@tetherto/wdk-wallet').TransferResult} TransferResult */
/** @typedef {import('./wallet-account-read-only-rgb.js').TransferOptions} TransferOptions */
/** @typedef {import('rgb-sdk').Transaction} RgbTransactionReceipt */
/** @typedef {import('rgb-sdk').RgbTransfer} RgbTransferReceipt */
/** @typedef {import('rgb-sdk').IssueAssetNIAResponse} IssueAssetNIA */
/** @typedef {import('rgb-sdk').ListAssetsResponse} ListAssets */
/** @typedef {import('rgb-sdk').InvoiceReceiveData} InvoiceReceiveData */
/** @typedef {import('rgb-sdk').BtcBalance} BtcBalance */
/**
 * Result returned by registerWallet method.
 *
 * @typedef {Object} RegisterWalletResult
 * @property {string} address - The wallet's Bitcoin address.
 * @property {BtcBalance} btcBalance - The wallet's Bitcoin balance.
 */
/** @typedef {import('rgb-sdk').SendAssetEndRequestModel} SendAssetEndRequest */
/** @typedef {import('rgb-sdk').SendResult} SendResult */
/** @typedef {import('rgb-sdk').Unspent} Unspent */
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
export default class WalletAccountRgb extends WalletAccountReadOnlyRgb implements IWalletAccount {
    /**
     * Creates a new RGB wallet account.
     *
     * @param {string | Uint8Array} seed - The wallet's [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) seed phrase.
     * @param {RgbWalletConfig} config - The configuration object (network and rgbNodeEndpoint are required).
     * @returns {Promise<WalletAccountRgb>} The wallet account.
     */
    static at(seed: string | Uint8Array, config?: RgbWalletConfig): Promise<WalletAccountRgb>;
    /**
     * Restores an RGB wallet account from an encrypted backup.
     *
     * @param {string | Uint8Array} seed - The wallet's BIP-39 seed phrase.
     * @param {RgbRestoreConfig} config - The configuration object with backup data.
     * @returns {Promise<WalletAccountRgb>} The restored wallet account.
     */
    static fromBackup(seed: string | Uint8Array, config?: RgbRestoreConfig): Promise<WalletAccountRgb>;
    /** @package */
    constructor(wallet: any, config?: {});
    /** @private */
    private _wallet;
    /** @private */
    private _index;
    /** @private */
    private _keyPair;
    /**
     * The derivation path's index of this account.
     *
     * @type {number}
     */
    get index(): number;
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
    get path(): string;
    /**
     * The derivation path of the colored account.
     *
     * @type {string}
     */
    get coloredPath(): string;
    /**
     * The account's key pair.
     * Note: This derives keys using the same BIP-86 path that rgb-sdk uses for WDK interface compatibility.
     * RGB SDK handles all actual operations internally.
     * Includes RGB-specific fields: accountXpubVanilla, accountXpubColored, masterFingerprint.
     *
     * @type {RgbKeyPair}
     */
    get keyPair(): RgbKeyPair;
    /**
     * Signs a message using Bitcoin message signing.
     *
     * @param {string} message - The message to sign.
     * @returns {Promise<string>} The message's signature.
     */
    sign(message: string): Promise<string>;
    /**
     * Verifies a message's signature.
     *
     * @param {string} message - The original message.
     * @param {string} signature - The signature to verify.
     * @returns {Promise<boolean>} True if the signature is valid.
     */
    verify(message: string, signature: string): Promise<boolean>;
    /**
     * Sends a Bitcoin transaction (for UTXO management).
     * Note: For RGB asset transfers, use transfer() instead.
     * This method uses the RGB SDK's sendBegin/sendEnd flow for Bitcoin transactions.
     *
     * @param {RgbTransaction} tx - The transaction.
     * @returns {Promise<TransactionResult>} The transaction's result.
     */
    sendTransaction(options: any): Promise<TransactionResult>;
    /**
     * Transfers an RGB asset to another wallet.
     * This method implements the RGB transfer flow using sendBegin/sendEnd.
     *
     * @param {TransferOptions} options - The transfer's options.
     * @returns {Promise<TransferResult>} The transfer's result.
     */
    transfer(options: TransferOptions): Promise<TransferResult>;
    /**
     * Returns the transfer history of the account.
     *
     * @param {Object} [options] - The options.
     * @param {string} [options.assetId] - Optional asset ID to filter transfers.
     * @param {number} [options.limit] - The number of transfers to return (default: 10).
     * @param {number} [options.skip] - The number of transfers to skip (default: 0).
     * @returns {Array<RgbTransfer>} The transfers.
     */
    getTransfers(options?: {
        assetId?: string;
        limit?: number;
        skip?: number;
    }): Array<RgbTransfer>;
    /**
     * Returns a read-only copy of the account.
     *
     * @returns {Promise<WalletAccountReadOnlyRgb>} The read-only account.
     */
    toReadOnlyAccount(): Promise<WalletAccountReadOnlyRgb>;
    /**
     * Disposes the wallet account, erasing its private keys from the memory.
     * Note: RGB SDK manages keys internally, but we clear our derived keyPair.
     */
    dispose(): void;
    /**
     * Gets the underlying RGB SDK WalletManager instance.
     * This allows direct access to all RGB SDK methods.
     *
     * @returns {WalletManager} The RGB SDK WalletManager instance.
     */
    getRgbWallet(): WalletManager;
    /**
     * Lists all RGB assets in the wallet.
     *
     * @returns {Array<ListAssets>} Array of asset objects.
     */
    listAssets(): Array<ListAssets>;
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
    issueAssetNia(options: {
        ticker: string;
        name: string;
        amounts: Array<number>;
        precision: number;
    }): IssueAssetNIA;
    /**
     * Creates a blind receive invoice for receiving RGB assets.
     *
     * @param {Object} options - Blind receive options.
     * @param {string} [options.assetId] - The asset ID to receive.
     * @param {number} options.amount - The amount to receive.
     * @param {boolean} options.witness - Create witness invoice, not require available utxos.
     * @returns {InvoiceReceiveData} Blind receive data including invoice.
     */
    receiveAsset(options: {
        assetId?: string;
        amount: number;
        witness: boolean;
    }): InvoiceReceiveData;
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
    sendBegin(options: {
        invoice: string;
        assetId: string;
        witnessData: any;
        amount: number;
        feeRate?: number;
        minConfirmations?: number;
    }): string;
    /**
     * Signs a PSBT.
     *
     * @param {string} psbt - The PSBT to sign (base64 encoded).
     * @returns {Promise<string>} The signed PSBT (base64 encoded).
     */
    signPsbt(psbt: string): Promise<string>;
    /**
     * Brodcasts a send transaction.
     *
     * @param {Object} options - Send end options.
     * @param {string} options.signed_psbt - The signed PSBT (base64 encoded).
     * @returns {SendResult} The send result.
     */
    sendEnd(options: {
        signed_psbt: string;
    }): SendResult;
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
    createUtxos(options: {
        upTo?: boolean;
        num?: number;
        size?: number;
        feeRate?: number;
    }): Promise<number>;
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
    createUtxosBegin(options: {
        upTo?: boolean;
        num?: number;
        size?: number;
        feeRate?: number;
    }): string;
    /**
     * Finalizes UTXO creation operation.
     *
     * @param {Object} options - UTXO creation end options.
     * @param {string} options.signedPsbt - The signed PSBT (base64 encoded).
     * @returns {number} Number of UTXOs created.
     */
    createUtxosEnd(options: {
        signedPsbt: string;
    }): number;
    /**
     * Lists unspent transaction outputs (UTXOs).
     *
     * @returns {Array<Unspent>} Array of UTXO objects.
     */
    listUnspents(): Array<Unspent>;
    /**
     * Lists Bitcoin transactions.
     *
     * @returns {Array<RgbTransactionReceipt>} Array of transaction objects.
     */
    listTransactions(): Array<RgbTransactionReceipt>;
    /**
     * Lists transfers
     *
     * @param {string} [assetId] - Optional asset ID to filter transfers.
     * @returns {Array<RgbTransfer>} Array of transfer objects.
     */
    listTransfers(assetId?: string): Array<RgbTransfer>;
    /**
     * Fails a transfer
     *
     * @param {options} options - The options.
     * @param {number} options.batchTransferIdx - The batch transfer index.
     * @returns {boolean} True if the transfer was failed, false otherwise.
     */
    failTransfers(transferId: any): boolean;
    /**
     * Creates an encrypted backup of the wallet.
     *
     * @param {options} options - The options.
     * @param {string} options.password - The password used to encrypt the backup file.
     * @param {string} options.backupPath - The backup path.
     * @returns {{message: string, downloadUrl: string}} The backup response from rgb-sdk.
     */
    createBackup(options: any): {
        message: string;
        downloadUrl: string;
    };
    /**
     * Restores a wallet from a backup file.
     *
     * @param {RgbRestoreParams} params - Restore options.
     * @returns {{message: string}} The restore response from rgb-sdk.
     */
    restoreFromBackup(params: RgbRestoreParams): {
        message: string;
    };
    /**
     * Refreshes the wallet state
     *
     * @returns {void}
     */
    refreshWallet(): void;
    /**
     * Registers the wallet with the RGB node.
     * Returns the wallet's address and current Bitcoin balance.
     *
     * @returns {Promise<RegisterWalletResult>} The registration result containing the wallet address and BTC balance.
     */
    registerWallet(): Promise<RegisterWalletResult>;
    /**
     * Syncs RGB wallet state with Bitcoin blockchain.
     *
     * @returns {void}
     */
    syncWallet(): void;
}
export type IWalletAccount = import("@tetherto/wdk-wallet").IWalletAccount;
export type KeyPair = import("@tetherto/wdk-wallet").KeyPair;
export type TransactionResult = import("@tetherto/wdk-wallet").TransactionResult;
export type TransferResult = import("@tetherto/wdk-wallet").TransferResult;
export type TransferOptions = import("./wallet-account-read-only-rgb.js").TransferOptions;
export type RgbTransactionReceipt = import("rgb-sdk").Transaction;
export type RgbTransferReceipt = import("rgb-sdk").RgbTransfer;
export type IssueAssetNIA = import("rgb-sdk").IssueAssetNIAResponse;
export type ListAssets = import("rgb-sdk").ListAssetsResponse;
export type InvoiceReceiveData = import("rgb-sdk").InvoiceReceiveData;
export type BtcBalance = import("rgb-sdk").BtcBalance;
/**
 * Result returned by registerWallet method.
 */
export type RegisterWalletResult = {
    /**
     * - The wallet's Bitcoin address.
     */
    address: string;
    /**
     * - The wallet's Bitcoin balance.
     */
    btcBalance: BtcBalance;
};
export type SendAssetEndRequest = import("rgb-sdk").SendAssetEndRequestModel;
export type SendResult = import("rgb-sdk").SendResult;
export type Unspent = import("rgb-sdk").Unspent;
export type RgbTransaction = import("./wallet-account-read-only-rgb.js").RgbTransaction;
export type RgbWalletConfig = import("./wallet-account-read-only-rgb.js").RgbWalletConfig;
export type RgbKeyPair = {
    /**
     * - The public key.
     */
    publicKey: Uint8Array;
    /**
     * - The private key (null if the account has been disposed).
     */
    privateKey: Uint8Array | null;
    /**
     * - The vanilla extended public key.
     */
    accountXpubVanilla?: Uint8Array;
    /**
     * - The colored extended public key.
     */
    accountXpubColored?: Uint8Array;
    /**
     * - The master fingerprint.
     */
    masterFingerprint?: Uint8Array;
};
export type RgbRestoreParams = {
    /**
     * - The password to decrypt the backup.
     */
    password: string;
    /**
     * - The backup file path.
     */
    backupFilePath: string;
    /**
     * - The restore directory.
     */
    dataDir: string;
};
export type RgbRestoreConfig = RgbWalletConfig & RgbRestoreParams;
import WalletAccountReadOnlyRgb from './wallet-account-read-only-rgb.js';
import { WalletManager } from 'rgb-sdk';
