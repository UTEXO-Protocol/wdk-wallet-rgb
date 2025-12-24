import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'

const SEED_PHRASE = 'poem twice question inch happy capital grain quality laptop dry chaos what';
const mockKeys = {
  mnemonic: SEED_PHRASE,
  xpub: 'tpubD6NzVbkrYhZ4XCaTDersU6277zvyyV6uCCeEgx1jfv7bUYMrbTt8Vem1MBt5Gmp7eMwjv4rB54s2kjqNNtTLYpwFsVX7H2H93pJ8SpZFRRi',
  account_xpub_vanilla: 'tpubDDMTD6EJKKLP6Gx9JUnMpjf9NYyePJszmqBnNqULNmcgEuU1yQ3JsHhWZdRFecszWETnNsmhEe9vnaNibfzZkDDHycbR2rGFbXdHWRgBfu7',
  account_xpub_colored: 'tpubDDPLJfdVbDoGtnn6hSto3oCnm6hpfHe9uk2MxcANanxk87EuquhSVfSLQv7e5UykgzaFn41DUXaikjjVGcUSUTGNaJ9LcozfRwatKp1vTfC',
  master_fingerprint: 'a66bffef',
};
// Mock rgb-sdk before importing anything that uses it
jest.unstable_mockModule('rgb-sdk', () => {


  const mockWalletManagerInstance = {
    registerWallet: jest.fn().mockResolvedValue(undefined),
    getAddress: jest.fn().mockResolvedValue('bc1p...'),
    getBtcBalance: jest.fn().mockResolvedValue(1000000),
    getAssetBalance: jest.fn().mockResolvedValue(500000),
    listAssets: jest.fn().mockResolvedValue([]),
    listTransfers: jest.fn().mockResolvedValue([]),
    sendBegin: jest.fn().mockResolvedValue('cHNidP8BA...'),
    signPsbt: jest.fn().mockReturnValue('cHNidP8BA...'),
    sendEnd: jest.fn().mockResolvedValue({ txid: 'abc123' }),
    send: jest.fn().mockResolvedValue({ txid: 'abc123' }),
    blindReceive: jest.fn().mockResolvedValue({ invoice: 'rgb1...' }),
    issueAssetNia: jest.fn().mockResolvedValue({
      asset: {
        asset_id: 'rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd',
        assetIface: 'RGB20',
        ticker: 'TEST',
        name: 'Test Asset',
        precision: 0,
        issued_supply: 500,
        timestamp: 1691160565,
        added_at: 1691161979
      }
    }),
    createUtxosBegin: jest.fn().mockResolvedValue('cHNidP8BA...'),
    createUtxosEnd: jest.fn().mockResolvedValue(5),
    listUnspents: jest.fn().mockResolvedValue([]),
    listTransactions: jest.fn().mockResolvedValue([]),
    refreshWallet: jest.fn().mockResolvedValue(undefined)
  }

  const deriveKeysFromSeedMock = jest.fn().mockResolvedValue(mockKeys)

  return {
    WalletManager: jest.fn().mockImplementation(() => mockWalletManagerInstance),
    deriveKeysFromMnemonic: jest.fn().mockResolvedValue(mockKeys),
    deriveKeysFromSeed: deriveKeysFromSeedMock,
    createWallet: jest.fn().mockResolvedValue({}),
    BIP32_VERSIONS: {
      mainnet: { public: 76067358, private: 76066276 },
      testnet: { public: 70617039, private: 70615956 },
      signet: { public: 70617039, private: 70615956 },
      regtest: { public: 70617039, private: 70615956 }
    }
  }
})

const { default: WalletManagerRgb, WalletAccountRgb } = await import('../index.js')


describe('WalletManagerRgb', () => {
  let wallet

  beforeEach(() => {
    wallet = new WalletManagerRgb(SEED_PHRASE, {
      network: 'regtest',
      rgbNodeEndpoint: 'http://127.0.0.1:8000'
    })
  })

  afterEach(() => {
    wallet.dispose()
  })

  describe('constructor', () => {
    test('should throw error if network is not provided', () => {
      expect(() => {
        new WalletManagerRgb(SEED_PHRASE)
      }).toThrow('network configuration is required.')
    })

    test('should throw error if rgbNodeEndpoint is not provided', () => {
      expect(() => {
        new WalletManagerRgb(SEED_PHRASE, {
          network: 'testnet'
        })
      }).toThrow('rgbNodeEndpoint configuration is required.')
    })

    test('should create a wallet manager with custom config', () => {
      const customWallet = new WalletManagerRgb(SEED_PHRASE, {
        network: 'testnet',
        rgbNodeEndpoint: 'http://localhost:8000'
      })
      expect(customWallet).toBeInstanceOf(WalletManagerRgb)
      customWallet.dispose()
    })
  })

  describe('getAccountByPath', () => {
    test('should throw an unsupported operation error', async () => {
      await expect(wallet.getAccountByPath("0'/0/0"))
        .rejects.toThrow('Method not supported on the RGB')
    })
  })

  describe('getFeeRates', () => {
    test('should return the correct fee rates', async () => {
      // Mock fetch to avoid real network calls
      global.fetch = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue({
          fastestFee: 2,
          hourFee: 1
        })
      })

      const feeRates = await wallet.getFeeRates()

      expect(feeRates.normal).toBe(1n)
      expect(feeRates.fast).toBe(2n)

      // Clean up
      global.fetch.mockClear()
    })
  })

  describe('restoreAccountFromBackup', () => {
    test('restores account from provided backup data', async () => {
      const backupData = Buffer.from('backup-data')
      const restoredAccount = { restored: true, dispose: jest.fn() }
      const fromBackupSpy = jest.spyOn(WalletAccountRgb, 'fromBackup').mockResolvedValue(restoredAccount)

      const result = await wallet.restoreAccountFromBackup({
        backup: backupData,
        password: 'secure-password',
        filename: 'wallet.rgb',
        keys: mockKeys
      })

      expect(fromBackupSpy).toHaveBeenCalledWith(wallet.seed, expect.objectContaining({
        backup: backupData,
        password: 'secure-password',
        filename: 'wallet.rgb',
        keys: mockKeys,
        network: 'regtest',
        rgbNodeEndpoint: 'http://127.0.0.1:8000'
      }))
      expect(result).toBe(restoredAccount)

      wallet._accounts = []
      fromBackupSpy.mockRestore()
    })

    test('throws error when restore fails due to network error (node down)', async () => {
      const backupData = Buffer.from('backup-data')
      const networkError = new Error('Network error: connect ECONNREFUSED 127.0.0.1:8000')
      networkError.name = 'NetworkError'
      networkError.code = 'ECONNREFUSED'

      const fromBackupSpy = jest.spyOn(WalletAccountRgb, 'fromBackup').mockRejectedValue(networkError)

      await expect(wallet.restoreAccountFromBackup({
        backup: backupData,
        password: 'secure-password',
        filename: 'wallet.rgb',
        keys: mockKeys
      })).rejects.toThrow('Network error: connect ECONNREFUSED 127.0.0.1:8000')

      expect(fromBackupSpy).toHaveBeenCalled()
      fromBackupSpy.mockRestore()
    })

    test('throws error when restore fails due to invalid backup', async () => {
      const backupData = Buffer.from('invalid-backup-data')
      const backupError = new Error('Failed to restore wallet: WrongPassword')
      backupError.name = '_BadRequestError'
      backupError.code = 'BAD_REQUEST'
      backupError.statusCode = 400
      const axiosError = new Error('Request failed with status code 400')
      axiosError.code = 'ERR_BAD_REQUEST'
      axiosError.response = {
        status: 400,
        statusText: 'Bad Request',
        data: { detail: 'Failed to restore wallet: WrongPassword' }
      }
      backupError.cause = axiosError

      const fromBackupSpy = jest.spyOn(WalletAccountRgb, 'fromBackup').mockRejectedValue(backupError)

      await expect(wallet.restoreAccountFromBackup({
        backup: backupData,
        password: 'wrong-password',
        filename: 'wallet.rgb',
        keys: mockKeys
      })).rejects.toThrow('Failed to restore wallet: WrongPassword')

      expect(fromBackupSpy).toHaveBeenCalled()
      fromBackupSpy.mockRestore()
    })

    test('throws error when restore fails due to missing required fields', async () => {
      const fromBackupSpy = jest.spyOn(WalletAccountRgb, 'fromBackup').mockRejectedValue(
        new Error('Backup file is required')
      )

      await expect(wallet.restoreAccountFromBackup({
        password: 'secure-password',
        filename: 'wallet.rgb',
        keys: mockKeys
      })).rejects.toThrow('Backup file is required')

      expect(fromBackupSpy).toHaveBeenCalled()
      fromBackupSpy.mockRestore()
    })
  })

  describe('getAccount', () => {
    test('throws error when account creation fails due to network error (node down)', async () => {
      const networkError = new Error('Network error: connect ECONNREFUSED 127.0.0.1:8000')
      networkError.name = 'NetworkError'
      networkError.code = 'ECONNREFUSED'

      const fromBackupSpy = jest.spyOn(WalletAccountRgb, 'at').mockRejectedValue(networkError)

      await expect(wallet.getAccount()).rejects.toThrow('Network error: connect ECONNREFUSED 127.0.0.1:8000')

      expect(fromBackupSpy).toHaveBeenCalled()
      fromBackupSpy.mockRestore()
    })
  })
})
