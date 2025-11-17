import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals'

const SEED_PHRASE = 'cook voyage document eight skate token alien guide drink uncle term abuse'

const mockKeysBase = {
  account_xpub_vanilla: 'xpub6BGG5MockVanilla',
  account_xpub_colored: 'xpub6BGG5MockColored',
  master_fingerprint: '12345678',
  mnemonic: SEED_PHRASE,
  xpriv: "tprv8ZgxMBicQKsPdQaFUyyJodvPVicQ6HxagSy18xrJmd8GPHUD1YuDR5WXL9eUDiNnLfkufjL2EwzWpnkiyck5da731zevC4t34QyR69uTSSX",
  xpub: "tpubD6NzVbkrYhZ4Wsc3NdduD3aW4k8LFd9VFkZnRUtcBtvfDmiydwioba8PWFrJRBQrSSHzfvR8Gz8sGvqV3vm5wEmgT1dcWDAaz2xRKRPaBok"
}

const createMockWallet = () => ({
  registerWallet: jest.fn().mockResolvedValue(undefined),
  getAddress: jest.fn().mockResolvedValue('bc1p-test-address'),
  getBtcBalance: jest.fn().mockResolvedValue({ vanilla: { settled: 1500000 } }),
  getAssetBalance: jest.fn().mockResolvedValue(750000),
  listAssets: jest.fn().mockResolvedValue([{ assetId: 'asset-1' }]),
  listTransfers: jest.fn().mockResolvedValue([{ txid: 'tx-1', direction: 'incoming' }]),
  sendBegin: jest.fn().mockResolvedValue('psbt-bytes'),
  signPsbt: jest.fn().mockImplementation(psbt => `signed:${psbt}`),
  sendEnd: jest.fn().mockResolvedValue({ txid: 'abc123', fee: 210 }),
  send: jest.fn().mockResolvedValue({ txid: 'abc123', fee: 210 }),
  signMessage: jest.fn().mockResolvedValue('signed-message'),
  verifyMessage: jest.fn().mockResolvedValue(true),
  blindReceive: jest.fn().mockResolvedValue({ invoice: 'rgb1-invoice' }),
  witnessReceive: jest.fn().mockResolvedValue({ invoice: 'rgb1-witness' }),
  issueAssetNia: jest.fn().mockResolvedValue({
    asset: {
      asset_id: 'rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd',
      assetIface: 'RGB20',
      ticker: 'RGB',
      name: 'RGB Asset',
      precision: 0,
      issued_supply: 100,
      timestamp: 1691160565,
      added_at: 1691161979
    }
  }),
  createUtxosBegin: jest.fn().mockResolvedValue('psbt-utxo'),
  createUtxosEnd: jest.fn().mockResolvedValue(2),
  listUnspents: jest.fn().mockResolvedValue([{ txid: 'utxo-1' }]),
  listTransactions: jest.fn().mockResolvedValue([{ txid: 'tx-1' }]),
  refreshWallet: jest.fn().mockResolvedValue(undefined),
  createBackup: jest.fn().mockResolvedValue({ id: 'backup-123' }),
  downloadBackup: jest.fn().mockResolvedValue(Buffer.from('backup')),
  restoreFromBackup: jest.fn().mockResolvedValue({ restored: true })
})

let WalletAccountRgb
let WalletManagerMock

beforeAll(async () => {
  jest.unstable_mockModule('../src/libs/rgb-sdk.js', () => {
    WalletManagerMock = jest.fn().mockImplementation(() => createMockWallet())

    return {
      WalletManager: WalletManagerMock,
      deriveKeysFromMnemonic: jest.fn(),
      deriveKeysFromSeed: jest.fn(),
      createWallet: jest.fn()
    }
  })

  const module = await import('../index.js')
  WalletAccountRgb = module.WalletAccountRgb
})

const createAccountConfig = (configOverrides = {}, keysOverrides = {}) => ({
  network: 'regtest',
  rgb_node_endpoint: 'http://127.0.0.1:8000',
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

beforeEach(() => {
  jest.clearAllMocks()
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
      expect(account._config.rgb_node_endpoint).toBe(config.rgb_node_endpoint)
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
      const result = await account.transfer({ asset_id: 'asset-1', to: 'rgb1-invoice', value: 100 })

      expect(wallet.sendBegin).toHaveBeenCalledWith({
        invoice: 'rgb1-invoice',
        asset_id: 'asset-1',
        witness_data: undefined,
        amount: 100,
        fee_rate: undefined,
        min_confirmations: undefined
      })
      expect(wallet.signPsbt).toHaveBeenCalledWith('psbt-bytes')
      expect(wallet.sendEnd).toHaveBeenCalledWith({ signed_psbt: 'signed:psbt-bytes' })
      expect(result).toEqual({ hash: 'abc123', fee: BigInt(210) })
    })

    test('getTransfers aggregates transfers across assets', async () => {
      const { account, wallet } = await createAccount()
      wallet.listAssets.mockResolvedValueOnce([
        { asset_id: 'asset-alpha' },
        { asset_id: 'asset-beta' }
      ])
      wallet.listTransfers.mockResolvedValue([{ txid: 'tx-1', direction: 'incoming' }])

      const transfers = await account.getTransfers()

      expect(wallet.listAssets).toHaveBeenCalled()
      expect(wallet.listTransfers).toHaveBeenCalledTimes(2)
      expect(transfers).toEqual([{ txid: 'tx-1', direction: 'incoming' }, { txid: 'tx-1', direction: 'incoming' }])
    })

    test('listAssets proxies to wallet manager', async () => {
      const { account, wallet } = await createAccount()
      const assets = await account.listAssets()
      expect(assets).toEqual([{ assetId: 'asset-1' }])
      expect(wallet.listAssets).toHaveBeenCalled()
    })

    test('issueAssetNia proxies to wallet manager', async () => {
      const { account, wallet } = await createAccount()
      const result = await account.issueAssetNia({ ticker: 'RGB', name: 'RGB Asset', amounts: [100], precision: 0 })
      expect(result).toEqual({
        asset: {
          asset_id: 'rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd',
          assetIface: 'RGB20',
          ticker: 'RGB',
          name: 'RGB Asset',
          precision: 0,
          issued_supply: 100,
          timestamp: 1691160565,
          added_at: 1691161979
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
      const invoice = await account.receiveAsset({ asset_id: 'asset-1', amount: 10 })
      expect(invoice).toEqual({ invoice: 'rgb1-invoice' })
      expect(wallet.blindReceive).toHaveBeenCalled()
    })

    test('receiveAsset uses witness receive when requested', async () => {
      const { account, wallet } = await createAccount()
      const invoice = await account.receiveAsset({ asset_id: 'asset-1', amount: 10, witness: true })
      expect(invoice).toEqual({ invoice: 'rgb1-witness' })
      expect(wallet.witnessReceive).toHaveBeenCalled()
      expect(wallet.blindReceive).not.toHaveBeenCalledWith(expect.objectContaining({ witness: true }))
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

    test('createBackup delegates to wallet manager', async () => {
      const { account, wallet } = await createAccount()
      const result = await account.createBackup('secure-password')
      expect(result).toEqual({ id: 'backup-123' })
      expect(wallet.createBackup).toHaveBeenCalledWith('secure-password')
    })


    test('restoreFromBackup delegates to wallet manager', async () => {
      const { account, wallet } = await createAccount()
      const params = {
        backup: Buffer.from('backup-data'),
        password: 'secure-password',
        filename: 'backup.rgb',
        xpub_van: 'custom-xpub-van',
        xpub_col: 'custom-xpub-col',
        master_fingerprint: 'deadbeef'
      }

      const result = await account.restoreFromBackup(params)
      expect(result).toEqual({ restored: true })
      expect(wallet.restoreFromBackup).toHaveBeenCalledWith(params)
    })
  })

  describe('read-only conversion', () => {
    test('toReadOnlyAccount preserves configuration keys', async () => {
      const { account, config } = await createAccount()
      const readOnly = await account.toReadOnlyAccount()

      expect(readOnly._config.keys).toEqual(config.keys)
      expect(readOnly._config.network).toBe(config.network)
      expect(readOnly._config.rgb_node_endpoint).toBe(config.rgb_node_endpoint)
    })
  })

  describe('fromBackup', () => {
    test('restores wallet from backup without registering', async () => {
      const walletInstance = createMockWallet()
      walletInstance.restoreFromBackup.mockResolvedValue({ restored: true })
      walletInstance.registerWallet = jest.fn()

      WalletManagerMock.mockImplementationOnce(() => walletInstance)

      const config = createAccountConfig({
        backup: Buffer.from('backup-data'),
        password: 'secure-password',
        filename: 'wallet.rgb'
      })

      const account = await WalletAccountRgb.fromBackup(SEED_PHRASE, config)

      expect(WalletManagerMock).toHaveBeenCalledWith({
        xpub_van: config.keys.account_xpub_vanilla,
        xpub_col: config.keys.account_xpub_colored,
        master_fingerprint: config.keys.master_fingerprint,
        network: config.network,
        rgb_node_endpoint: config.rgb_node_endpoint
      })

      expect(walletInstance.restoreFromBackup).toHaveBeenCalledWith({
        backup: config.backup,
        password: config.password,
        filename: config.filename,
        xpub_van: config.keys.account_xpub_vanilla,
        xpub_col: config.keys.account_xpub_colored,
        master_fingerprint: config.keys.master_fingerprint
      })

      expect(walletInstance.registerWallet).not.toHaveBeenCalled()
      expect(account).toBeInstanceOf(WalletAccountRgb)
    })
  })

  describe('dispose', () => {
    test('clears wallet references and key material', async () => {
      const { account } = await createAccount()
      const keyPair = account.keyPair
      // Verify keyPair exists before dispose
      expect(keyPair).toBeDefined()
      expect(keyPair.publicKey).toBeDefined()
      expect(keyPair.privateKey).toBeDefined()

      account.dispose()

      expect(account._wallet).toBeNull()
      expect(account._keyPair).toBeNull()
    })
  })
})

