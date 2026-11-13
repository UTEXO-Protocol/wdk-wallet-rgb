import WDK, { type WdkAccount } from '@tetherto/wdk'
import type WalletManager from '@tetherto/wdk-wallet'
import WalletManagerRgb, {
  type CandidateConfig, type WalletAccountRgb
} from '../onchain.js'

const seed = new Uint8Array(64)
const core = new WDK(seed)
const config: CandidateConfig = {
  network: 'regtest', mode: 'btc-only', dataDir: '/private/qualification-wallet',
  indexerUrl: 'tcp://127.0.0.1:50001', nativeExecutable: '/private/native-worker',
  nativeSha256: '0'.repeat(64), maxFeeSats: '5000', authorize: () => false
}

// Core constrains a manager constructor to the base's optional WalletConfig.
// The actual registration passes its supplied config to our required constructor.
// Keep the RGB signature last so Core still checks the complete CandidateConfig.
const RgbManagerForCore = WalletManagerRgb as typeof WalletManager & typeof WalletManagerRgb
type CoreConfig = ConstructorParameters<typeof RgbManagerForCore>[1]
type Exact<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false
const preservesConfig: Exact<CoreConfig, CandidateConfig> = true
const registered: WDK = core.registerWallet('rgb', RgbManagerForCore, config)

// The assertion is scoped to registration, not the public SDK constructor.
// @ts-expect-error The SDK constructor still requires its configuration.
new WalletManagerRgb(seed)
// @ts-expect-error Core registration must receive its configuration argument.
core.registerWallet('rgb', RgbManagerForCore)
// @ts-expect-error Core must not admit an undefined configuration.
core.registerWallet('rgb', RgbManagerForCore, undefined)
// @ts-expect-error Unsupported Bitcoin networks remain rejected.
core.registerWallet('rgb', RgbManagerForCore, { ...config, network: 'testnet' })
// @ts-expect-error Money limits must use exact base units, not floating-point numbers.
core.registerWallet('rgb', RgbManagerForCore, { ...config, maxFeeSats: 5000 })
const { authorize, ...withoutApproval } = config
// @ts-expect-error The application must provide spend authorization.
core.registerWallet('rgb', RgbManagerForCore, withoutApproval)

// Core's result type is the common wallet interface. This application knows it
// registered the RGB manager and has not replaced it with an incompatible middleware.
const account = await registered.getAccountByPath('rgb', "0'/0/0") as WdkAccount & WalletAccountRgb
const balance: bigint = await account.getBalance()
const operation = await account.sendBtc({
  operationId: 'typed-send', address: 'bcrt1p-address', amount: 1000n, feeRate: 2n
})
const txid: string = operation.txid
const status = await account.recoverSend('typed-send')
const signingAddress: string = await account.getMessageSigningAddress()
const signature: string = await account.signMessageBip322('qualification', signingAddress)
const valid: boolean = await account.verifyMessageBip322('qualification', signingAddress, signature)
const readOnly = await account.toReadOnlyAccount()
const readBalance: bigint = await readOnly.getBalance()
// @ts-expect-error The read-only view must not gain send authority through Core.
readOnly.sendBtc({ operationId: 'read-only-send', address: 'bcrt1p-address', amount: 1n, feeRate: 2n })
// @ts-expect-error The read-only view must not gain message-signing authority.
readOnly.signMessageBip322('qualification', signingAddress)
// @ts-expect-error RGB sends still need their stable application operation ID.
account.sendBtc({ address: 'bcrt1p-address', amount: 1000n, feeRate: 2n })
await account.shutdown()
registered.dispose()
void [preservesConfig, authorize, balance, txid, status, valid, readBalance]
