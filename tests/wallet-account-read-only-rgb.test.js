import { beforeAll, describe, expect, jest, test } from '@jest/globals'

const mockKeys = {
  account_xpub_vanilla: 'tpubDDMTD6EJKKLP6Gx9JUnMpjf9NYyePJszmqBnNqULNmcgEuU1yQ3JsHhWZdRFecszWETnNsmhEe9vnaNibfzZkDDHycbR2rGFbXdHWRgBfu7',
  account_xpub_colored: 'tpubDDPLJfdVbDoGtnn6hSto3oCnm6hpfHe9uk2MxcANanxk87EuquhSVfSLQv7e5UykgzaFn41DUXaikjjVGcUSUTGNaJ9LcozfRwatKp1vTfC',
  master_fingerprint: 'a66bffef',
  mnemonic: 'test mnemonic',
  xpub: 'tpubD6NzVbkrYhZ4Wsc3NdduD3aW4k8LFd9VFkZnRUtcBtvfDmiydwioba8PWFrJRBQrSSHzfvR8Gz8sGvqV3vm5wEmgT1dcWDAaz2xRKRPaBok',
  xpriv: 'tprv8ZgxMBicQKsPdQaFUyyJodvPVicQ6HxagSy18xrJmd8GPHUD1YuDR5WXL9eUDiNnLfkufjL2EwzWpnkiyck5da731zevC4t34QyR69uTSSX'
}

// Mock rgb-sdk before importing anything that uses it
jest.unstable_mockModule('rgb-sdk', () => {
  const mockWalletManagerInstance = {
    getBtcBalance: jest.fn().mockResolvedValue({ vanilla: { settled: 1000000 } }),
    getAssetBalance: jest.fn().mockResolvedValue({ settled: 500000 }),
    sendBtcBegin: jest.fn().mockResolvedValue('psbt-bytes'),
    signPsbt: jest.fn().mockResolvedValue('signed-psbt'),
    estimateFee: jest.fn().mockResolvedValue({ fee: 1000 }),
    estimateFeeRate: jest.fn().mockResolvedValue(1),
    sendBegin: jest.fn().mockResolvedValue('psbt-bytes'),
    listTransactions: jest.fn().mockResolvedValue([]),
    listTransfers: jest.fn().mockResolvedValue([])
  }

  return {
    WalletManager: jest.fn().mockImplementation(() => mockWalletManagerInstance),
    BIP32_VERSIONS: {
      mainnet: { public: 76067358, private: 76066276 },
      testnet: { public: 70617039, private: 70615956 },
      signet: { public: 70617039, private: 70615956 },
      regtest: { public: 70617039, private: 70615956 }
    }
  }
})

let WalletAccountReadOnlyRgb

beforeAll(async () => {
  const module = await import('../src/wallet-account-read-only-rgb.js')
  WalletAccountReadOnlyRgb = module.default
})

describe('WalletAccountReadOnlyRgb', () => {
  describe('constructor', () => {
    test('should create a read-only account with address', async () => {
      const address = 'bc1p1234567890abcdefghijklmnopqrstuvwxyz'
      const account = new WalletAccountReadOnlyRgb(address, {
        keys: mockKeys,
        network: 'testnet',
        rgbNodeEndpoint: 'https://rgb-node.test.thunderstack.org'
      })
      expect(account).toBeInstanceOf(WalletAccountReadOnlyRgb)
      // The address is passed to the parent class constructor
      expect(account).toBeDefined()
    })

    test('should create a read-only account with default config', () => {
      const defaultAccount = new WalletAccountReadOnlyRgb('bc1p...', {
        keys: mockKeys,
        network: 'testnet',
        rgbNodeEndpoint: 'https://rgb-node.test.thunderstack.org'
      })
      expect(defaultAccount).toBeInstanceOf(WalletAccountReadOnlyRgb)
    })
  })

  describe('constructor validation', () => {
    test('should throw error if keys are not provided', () => {
      expect(() => {
        new WalletAccountReadOnlyRgb('bc1p...', {
          network: 'testnet',
          rgbNodeEndpoint: 'https://rgb-node.test.thunderstack.org'
        })
      }).toThrow('Wallet keys are required for read-only account')
    })

    test('should throw error if network is not provided', () => {
      expect(() => {
        new WalletAccountReadOnlyRgb('bc1p...', {
          keys: mockKeys,
          rgbNodeEndpoint: 'https://rgb-node.test.thunderstack.org'
        })
      }).toThrow('Network configuration is required.')
    })

    test('should throw error if rgbNodeEndpoint is not provided', () => {
      expect(() => {
        new WalletAccountReadOnlyRgb('bc1p...', {
          keys: mockKeys,
          network: 'testnet'
        })
      }).toThrow('RGB node endpoint configuration is required.')
    })
  })
})
