import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals'

const SEED_PHRASE = 'cook voyage document eight skate token alien guide drink uncle term abuse'

const mockKeysBase = {
  accountXpubVanilla: 'tpubDDMTD6EJKKLP6Gx9JUnMpjf9NYyePJszmqBnNqULNmcgEuU1yQ3JsHhWZdRFecszWETnNsmhEe9vnaNibfzZkDDHycbR2rGFbXdHWRgBfu7',
  accountXpubColored: 'tpubDDPLJfdVbDoGtnn6hSto3oCnm6hpfHe9uk2MxcANanxk87EuquhSVfSLQv7e5UykgzaFn41DUXaikjjVGcUSUTGNaJ9LcozfRwatKp1vTfC',
  masterFingerprint: 'a66bffef',
  mnemonic: SEED_PHRASE,
  xpriv: "tprv8ZgxMBicQKsPdQaFUyyJodvPVicQ6HxagSy18xrJmd8GPHUD1YuDR5WXL9eUDiNnLfkufjL2EwzWpnkiyck5da731zevC4t34QyR69uTSSX",
  xpub: "tpubD6NzVbkrYhZ4Wsc3NdduD3aW4k8LFd9VFkZnRUtcBtvfDmiydwioba8PWFrJRBQrSSHzfvR8Gz8sGvqV3vm5wEmgT1dcWDAaz2xRKRPaBok"
}

const createMockWallet = () => ({
  registerWallet: jest.fn().mockResolvedValue(undefined),
  getAddress: jest.fn().mockResolvedValue('bc1p-test-address'),
  getBtcBalance: jest.fn().mockResolvedValue({ vanilla: { settled: 1500000 } }),
  getAssetBalance: jest.fn().mockResolvedValue({ settled: 750000 }),
  dispose: jest.fn(),
  listAssets: jest.fn().mockResolvedValue({
    nia: [{ asset_id: 'asset-1' }],
    uda: null,
    cfa: null
  }),
  listTransfers: jest.fn().mockReturnValue([{ txid: 'tx-1', direction: 'incoming' }]),
  sendBegin: jest.fn().mockResolvedValue('psbt-bytes'),
  signPsbt: jest.fn().mockImplementation(psbt => `signed:${psbt}`),
  sendEnd: jest.fn().mockResolvedValue({ txid: 'abc123', fee: 210 }),
  estimateFeeRate: jest.fn().mockResolvedValue(1),
  estimateFee: jest.fn().mockResolvedValue({ fee: 210 }),
  send: jest.fn().mockResolvedValue({ txid: 'abc123', fee: 210 }),
  signMessage: jest.fn().mockResolvedValue('signed-message'),
  verifyMessage: jest.fn().mockResolvedValue(true),
  blindReceive: jest.fn().mockReturnValue({ invoice: 'rgb1-invoice' }), // synchronous in v2
  witnessReceive: jest.fn().mockReturnValue({ invoice: 'rgb1-witness' }), // synchronous in v2
  issueAssetNia: jest.fn().mockReturnValue({ // synchronous in v2
    asset: {
      assetId: 'rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd',
      assetIface: 'RGB20',
      ticker: 'RGB',
      name: 'RGB Asset',
      precision: 0,
      issuedSupply: 100,
      timestamp: 1691160565,
      addedAt: 1691161979
    }
  }),
  createUtxosBegin: jest.fn().mockResolvedValue('psbt-utxo'),
  createUtxosEnd: jest.fn().mockResolvedValue(2),
  listUnspents: jest.fn().mockResolvedValue([{ txid: 'utxo-1' }]),
  listTransactions: jest.fn().mockResolvedValue([{ txid: 'tx-1' }]),
  refreshWallet: jest.fn().mockResolvedValue(undefined),
  createBackup: jest.fn().mockResolvedValue({
    message: 'Backup created successfully',
    download_url: '/wallet/backup/tpubDDMTD6EJKKLP6Gx9JUnMpjf9NYyePJszmqBnNqULNmcgEuU1yQ3JsHhWZdRFecszWETnNsmhEe9vnaNibfzZkDDHycbR2rGFbXdHWRgBfu7'
  }),
  downloadBackup: jest.fn().mockResolvedValue(Buffer.from('backup')),
  restoreFromBackup: jest.fn().mockResolvedValue({ message: 'Wallet restored successfully' })
})

let WalletAccountRgb
let WalletManagerMock

beforeAll(async () => {
  jest.unstable_mockModule('@utexo/rgb-sdk', () => {
    WalletManagerMock = jest.fn().mockImplementation(() => createMockWallet())

    return {
      WalletManager: WalletManagerMock,
      deriveKeysFromMnemonic: jest.fn(),
      deriveKeysFromSeed: jest.fn(),
      createWallet: jest.fn(),
      restoreFromBackup: jest.fn().mockReturnValue({ message: 'Wallet restored successfully' }),
      BIP32_VERSIONS: {
        mainnet: { public: 76067358, private: 76066276 },
        testnet: { public: 70617039, private: 70615956 },
        signet: { public: 70617039, private: 70615956 },
        regtest: { public: 70617039, private: 70615956 }
      }
    }
  })

  const module = await import('../index.js')
  WalletAccountRgb = module.WalletAccountRgb
})

const createAccountConfig = (configOverrides = {}, keysOverrides = {}) => ({
  network: 'regtest',
  transportEndpoint: 'http://127.0.0.1:8000',
  keys: {
    ...mockKeysBase,
    ...keysOverrides
  },
  ...configOverrides
})

const createAccount = async (configOverrides = {}, keysOverrides = {}) => {
  const config = createAccountConfig(configOverrides, keysOverrides)
  const wallet = createMockWallet()
  const account = new WalletAccountRgb(wallet, config)

  return { account, wallet, config }
}

beforeEach(async () => {
  jest.clearAllMocks()
  // Reset restoreFromBackup mock to default success response
  const { restoreFromBackup: restoreFromBackupMock } = await import('@utexo/rgb-sdk')
  restoreFromBackupMock.mockReturnValue({ message: 'Wallet restored successfully' })
})

describe('WalletAccountRgb', () => {
  describe('static at validation', () => {
    test('should throw error if mnemonic is not provided and keys missing', async () => {
      await expect(WalletAccountRgb.at(Buffer.from('seed'), {}))
        .rejects.toThrow('Wallet keys are required')
    })

    test('should throw error if keys are not provided', async () => {
      await expect(WalletAccountRgb.at(SEED_PHRASE, {})).rejects.toThrow('Wallet keys are required')
    })
  })

  describe('account creation', () => {
    test('creates wallet manager with provided configuration', async () => {
      const { account, config } = await createAccount({ network: 'testnet' })

      expect(account).toBeInstanceOf(WalletAccountRgb)
      expect(account._config.network).toBe(config.network)
      expect(account._config.transportEndpoint).toBe(config.transportEndpoint)
      expect(account.index).toBe(0)
    })
  })

  describe('path', () => {
    test('returns BIP-86 path for mainnet', async () => {
      const { account } = await createAccount({ network: 'mainnet' })
      expect(account.path).toBe("m/86'/0'/0'")
    })

    test('returns BIP-86 path for testnet/regtest', async () => {
      const { account } = await createAccount({ network: 'regtest' })
      expect(account.path).toBe("m/86'/1'/0'")
    })
  })


  describe('delegated wallet methods', () => {
    test('getAddress returns wallet address', async () => {
      const { account, wallet } = await createAccount()
      const address = await account.getAddress()
      expect(address).toBe('bc1p-test-address')
      expect(wallet.getAddress).toHaveBeenCalled()
    })

    test('getBalance returns BTC balance as bigint', async () => {
      const { account, wallet } = await createAccount()
      const balance = await account.getBalance()
      expect(balance).toBe(BigInt(1500000))
      expect(wallet.getBtcBalance).toHaveBeenCalled()
    })

    test('getTokenBalance returns asset balance as bigint', async () => {
      const { account, wallet } = await createAccount()
      const balance = await account.getTokenBalance('asset-1')
      expect(balance).toBe(BigInt(750000))
      expect(wallet.getAssetBalance).toHaveBeenCalledWith('asset-1')
    })

    test('transfer performs RGB send flow', async () => {
      const { account, wallet } = await createAccount()
      // Mock sendBegin to return a promise that resolves to psbt
      wallet.sendBegin.mockReturnValue('psbt-bytes') // synchronous in v2
      // signPsbt needs to handle the promise and resolve it
      wallet.signPsbt.mockImplementation(async (psbt) => {
        const resolvedPsbt = await psbt
        return `signed:${resolvedPsbt}`
      })
      wallet.sendEnd.mockReturnValue({ txid: 'abc123' }) // synchronous in v2, returns txid
      const result = await account.transfer({ token: 'asset-1', recipient: 'rgb:invoice-123', amount: 100 })

      expect(wallet.sendBegin).toHaveBeenCalledWith({
        invoice: 'rgb:invoice-123',
        assetId: 'asset-1',
        witnessData: undefined,
        amount: 100,
        feeRate: 1,
        minConfirmations: undefined
      })
      // signPsbt will be called with the promise
      expect(wallet.signPsbt).toHaveBeenCalled()
      expect(wallet.sendEnd).toHaveBeenCalledWith({ signedPsbt: 'signed:psbt-bytes' })
      expect(result).toEqual({ hash: 'abc123', fee: BigInt(210) })
    })

    test('getTransfers returns transfers without asset filter', async () => {
      const { account, wallet } = await createAccount()
      wallet.listTransfers.mockReturnValue([
        { txid: 'tx-1', direction: 'incoming' },
        { txid: 'tx-2', direction: 'outgoing' }
      ])

      const transfers = account.getTransfers()

      expect(wallet.listTransfers).toHaveBeenCalledWith()
      expect(transfers).toEqual([
        { txid: 'tx-1', direction: 'incoming' },
        { txid: 'tx-2', direction: 'outgoing' }
      ])
    })

    test('getTransfers with assetId filters by asset', async () => {
      const { account, wallet } = await createAccount()
      wallet.listTransfers.mockReturnValue([{ txid: 'tx-1', direction: 'incoming' }])

      const transfers = account.getTransfers({ assetId: 'asset-alpha' })

      expect(wallet.listTransfers).toHaveBeenCalledWith('asset-alpha')
      expect(transfers).toEqual([{ txid: 'tx-1', direction: 'incoming' }])
    })

    test('getTransfers applies pagination', async () => {
      const { account, wallet } = await createAccount()
      wallet.listTransfers.mockReturnValue([
        { txid: 'tx-1' },
        { txid: 'tx-2' },
        { txid: 'tx-3' },
        { txid: 'tx-4' },
        { txid: 'tx-5' }
      ])

      const transfers = account.getTransfers({ limit: 2, skip: 1 })

      expect(wallet.listTransfers).toHaveBeenCalledWith()
      expect(transfers).toEqual([{ txid: 'tx-2' }, { txid: 'tx-3' }])
    })

    test('listAssets proxies to wallet manager', async () => {
      const { account, wallet } = await createAccount()
      const mockAssetsResponse = {
        nia: [{ asset_id: 'asset-1' }],
        uda: null,
        cfa: null
      }
      wallet.listAssets.mockResolvedValueOnce(mockAssetsResponse)
      const assets = await account.listAssets()
      expect(assets).toEqual(mockAssetsResponse)
      expect(wallet.listAssets).toHaveBeenCalled()
    })

    test('issueAssetNia proxies to wallet manager', async () => {
      const { account, wallet } = await createAccount()
      wallet.issueAssetNia.mockReturnValue({ // synchronous in v2
        asset: {
          assetId: 'rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd',
          assetIface: 'RGB20',
          ticker: 'RGB',
          name: 'RGB Asset',
          precision: 0,
          issuedSupply: 100,
          timestamp: 1691160565,
          addedAt: 1691161979
        }
      })
      const result = account.issueAssetNia({ ticker: 'RGB', name: 'RGB Asset', amounts: [100], precision: 0 })
      expect(result).toEqual({
        asset: {
          assetId: 'rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd',
          assetIface: 'RGB20',
          ticker: 'RGB',
          name: 'RGB Asset',
          precision: 0,
          issuedSupply: 100,
          timestamp: 1691160565,
          addedAt: 1691161979
        }
      })
      expect(wallet.issueAssetNia).toHaveBeenCalledWith({
        ticker: 'RGB',
        name: 'RGB Asset',
        amounts: [100],
        precision: 0
      })
    })

    test('receiveAsset uses blind receive by default', async () => {
      const { account, wallet } = await createAccount()
      wallet.blindReceive.mockReturnValue({ invoice: 'rgb1-invoice' }) // synchronous in v2
      const invoice = account.receiveAsset({ assetId: 'asset-1', amount: 10 }) // camelCase in v2
      expect(invoice).toEqual({ invoice: 'rgb1-invoice' })
      expect(wallet.blindReceive).toHaveBeenCalled()
    })

    test('receiveAsset uses witness receive when requested', async () => {
      const { account, wallet } = await createAccount()
      wallet.witnessReceive.mockReturnValue({ invoice: 'rgb1-witness' }) // synchronous in v2
      const invoice = account.receiveAsset({ assetId: 'asset-1', amount: 10, witness: true }) // camelCase in v2
      expect(invoice).toEqual({ invoice: 'rgb1-witness' })
      expect(wallet.witnessReceive).toHaveBeenCalled()
      expect(wallet.blindReceive).not.toHaveBeenCalled()
    })

    test('sign delegates to wallet manager', async () => {
      const { account, wallet } = await createAccount()
      const signature = await account.sign('hello rgb')
      expect(signature).toBe('signed-message')
      expect(wallet.signMessage).toHaveBeenCalledWith('hello rgb')
    })

    test('verify delegates to wallet manager', async () => {
      const { account, wallet } = await createAccount()
      const isValid = await account.verify('hello rgb', 'signed-message')
      expect(isValid).toBe(true)
      expect(wallet.verifyMessage).toHaveBeenCalledWith('hello rgb', 'signed-message')
    })

    test('createBackup delegates to wallet manager and returns success response', async () => {
      const { account, wallet } = await createAccount()
      const mockResponse = {
        message: 'Backup created successfully',
        download_url: '/wallet/backup/tpubDDMTD6EJKKLP6Gx9JUnMpjf9NYyePJszmqBnNqULNmcgEuU1yQ3JsHhWZdRFecszWETnNsmhEe9vnaNibfzZkDDHycbR2rGFbXdHWRgBfu7'
      }
      wallet.createBackup.mockResolvedValue(mockResponse)

      const result = await account.createBackup('secure-password')
      expect(result).toEqual(mockResponse)
      expect(wallet.createBackup).toHaveBeenCalledWith('secure-password')
    })

    test('createBackup throws error when network error occurs (node down)', async () => {
      const { account, wallet } = await createAccount()
      const networkError = new Error('Network error: connect ECONNREFUSED 127.0.0.1:8000')
      networkError.name = '_NetworkError'
      networkError.code = 'NETWORK_ERROR'
      networkError.statusCode = undefined
      wallet.createBackup.mockRejectedValue(networkError)

      await expect(account.createBackup('secure-password'))
        .rejects.toThrow('Network error: connect ECONNREFUSED 127.0.0.1:8000')
      expect(wallet.createBackup).toHaveBeenCalledWith('secure-password')
    })

    test('createBackup throws error when backup creation fails (500)', async () => {
      const { account, wallet } = await createAccount()
      // @utexo/rgb-sdk throws _RgbNodeError with statusCode 500 when backup file was not created
      const backupError = new Error('Backup file was not created')
      backupError.name = '_RgbNodeError'
      backupError.code = 'RGB_NODE_ERROR'
      backupError.statusCode = 500
      const axiosError = new Error('Request failed with status code 500')
      axiosError.code = 'ERR_BAD_RESPONSE'
      axiosError.response = {
        status: 500,
        statusText: 'Internal Server Error',
        data: { detail: 'Backup file was not created' }
      }
      backupError.cause = axiosError
      wallet.createBackup.mockRejectedValue(backupError)

      await expect(account.createBackup('secure-password'))
        .rejects.toThrow('Backup file was not created')
      expect(wallet.createBackup).toHaveBeenCalledWith('secure-password')
    })

    test('restoreFromBackup delegates to top-level function and returns success response', async () => {
      const { account } = await createAccount()
      const { restoreFromBackup: restoreFromBackupMock } = await import('@utexo/rgb-sdk')
      const mockResponse = { message: 'Wallet restored successfully' }
      restoreFromBackupMock.mockReturnValue(mockResponse)

      const params = {
        backupFilePath: './backups/wallet.backup',
        password: 'secure-password',
        dataDir: './restored-wallet'
      }

      const result = account.restoreFromBackup(params)
      expect(result).toEqual(mockResponse)
      expect(restoreFromBackupMock).toHaveBeenCalledWith({
        backupFilePath: params.backupFilePath,
        password: params.password,
        dataDir: params.dataDir
      })
    })

    test('restoreFromBackup throws error when network error occurs (node down)', async () => {
      const { account } = await createAccount()
      const { restoreFromBackup: restoreFromBackupMock } = await import('@utexo/rgb-sdk')
      const networkError = new Error('Network error: connect ECONNREFUSED 127.0.0.1:8000')
      networkError.name = '_NetworkError'
      networkError.code = 'NETWORK_ERROR'
      networkError.statusCode = undefined
      restoreFromBackupMock.mockImplementation(() => {
        throw networkError
      })

      const params = {
        backupFilePath: './backups/wallet.backup',
        password: 'secure-password',
        dataDir: './restored-wallet'
      }

      expect(() => account.restoreFromBackup(params))
        .toThrow('Network error: connect ECONNREFUSED 127.0.0.1:8000')
      expect(restoreFromBackupMock).toHaveBeenCalled()
    })

    test('restoreFromBackup throws error when wallet state already exists (409)', async () => {
      const { account } = await createAccount()
      const { restoreFromBackup: restoreFromBackupMock } = await import('@utexo/rgb-sdk')
      const conflictError = new Error('Wallet state already exists. Restoring over an existing state is not allowed because it can corrupt RGB state.')
      conflictError.name = '_ConflictError'
      conflictError.code = 'CONFLICT'
      conflictError.statusCode = 409
      restoreFromBackupMock.mockImplementation(() => {
        throw conflictError
      })

      const params = {
        backupFilePath: './backups/wallet.backup',
        password: 'secure-password',
        dataDir: './restored-wallet'
      }

      expect(() => account.restoreFromBackup(params))
        .toThrow('Wallet state already exists. Restoring over an existing state is not allowed because it can corrupt RGB state.')
      expect(restoreFromBackupMock).toHaveBeenCalled()
    })

    test('restoreFromBackup throws error when backup is invalid (400)', async () => {
      const { account } = await createAccount()
      const { restoreFromBackup: restoreFromBackupMock } = await import('@utexo/rgb-sdk')
      const backupError = new Error('Failed to restore wallet: WrongPassword')
      backupError.name = '_BadRequestError'
      backupError.code = 'BAD_REQUEST'
      backupError.statusCode = 400
      restoreFromBackupMock.mockImplementation(() => {
        throw backupError
      })

      const params = {
        backupFilePath: './backups/invalid.backup',
        password: 'wrong-password',
        dataDir: './restored-wallet'
      }

      expect(() => account.restoreFromBackup(params))
        .toThrow('Failed to restore wallet: WrongPassword')
      expect(restoreFromBackupMock).toHaveBeenCalled()
    })
  })

  describe('read-only conversion', () => {
    test('toReadOnlyAccount preserves configuration keys', async () => {
      const { account, config } = await createAccount()
      const readOnly = await account.toReadOnlyAccount()

      expect(readOnly._config.keys).toEqual(config.keys)
      expect(readOnly._config.network).toBe(config.network)
      expect(readOnly._config.transportEndpoint).toBe(config.transportEndpoint)
    })
  })

  describe('fromBackup', () => {
    test('restores wallet from backup without registering', async () => {
      const walletInstance = createMockWallet()
      walletInstance.registerWallet = jest.fn()

      WalletManagerMock.mockImplementationOnce(() => walletInstance)

      // Get the restoreFromBackup mock - it's already reset in beforeEach
      const { restoreFromBackup: restoreFromBackupMock } = await import('@utexo/rgb-sdk')

      const config = createAccountConfig({
        backupFilePath: './backups/wallet.backup',
        password: 'secure-password',
        dataDir: './restored-wallet'
      })

      const account = await WalletAccountRgb.fromBackup(SEED_PHRASE, config)

      expect(restoreFromBackupMock).toHaveBeenCalledWith({
        backupFilePath: config.backupFilePath,
        password: config.password,
        dataDir: config.dataDir
      })

      expect(WalletManagerMock).toHaveBeenCalledWith({
        xpubVan: config.keys.accountXpubVanilla,
        xpubCol: config.keys.accountXpubColored,
        masterFingerprint: config.keys.masterFingerprint,
        dataDir: config.dataDir,
        indexerUrl: config.indexerUrl,
        transportEndpoint: config.transportEndpoint
      })

      expect(walletInstance.registerWallet).not.toHaveBeenCalled()
      expect(account).toBeInstanceOf(WalletAccountRgb)
    })
  })

  describe('dispose', () => {
    test('clears wallet references and key material', async () => {
      const { account } = await createAccount()
      const keyPair = account.keyPair
      expect(keyPair).toBeDefined()
      expect(keyPair.publicKey).toBeDefined()
      expect(keyPair.privateKey).toBeDefined()

      account.dispose()

      expect(account._wallet).toBeNull()
      expect(account._keyPair?.privateKey).toBeNull()
    })
  })
})
