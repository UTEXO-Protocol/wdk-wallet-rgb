export type BaseUnits = `${bigint}` | bigint
export type V1Chain = 'eip155:42161' | 'eip155:1' | 'eip155:137' | 'eip155:9745' | 'tron:728126428'
export type BurnRecipient = { chainId: V1Chain; address: string }
export type BurnRoute = { chainId: V1Chain; dstEid: number }
export type BurnDestination = Readonly<{ version: 1; destinationChainId: number; dstEid: number; recipient: string }>
export type Proof = {
  assetId: string
  txid: string
  encoding: 'base64'
  byteLength: number
  data: string
  digest: { algorithm: 'keccak256'; value: string }
}
export type Review = Readonly<{
  operationId: string
  burnDestination?: BurnDestination
  burnRecipient?: BurnRecipient
  assetId?: string
  amount?: string
  commitment?: string
  count?: number
  size?: string
  feeRate: string
  minConfirmations?: number
  plan: Readonly<{
    kind: 'rgb-output' | 'rgb-burn'
    txid: string
    psbtSha256: string
    feeSats: string
    vsize: number
    inputs: readonly Readonly<{ outpoint: string; amountSats: string; role: string }>[]
    outputs: readonly Readonly<{ index: number; scriptHex: string; amountSats: string; role: string }>[]
  }>
}>
type SharedCandidateConfig = {
  network: 'regtest'
  dataDir: string
  transportEndpoint: string
  maxFeeSats: BaseUnits
  evmRpcUrls?: Record<string, string>
  proxyAuthKeys?: Record<string, string>
  burnDestinationRoutes?: readonly BurnRoute[]
  authorize(review: Review): boolean | Promise<boolean>
}
export type CandidateConfig = SharedCandidateConfig & ({
  nativeExecutable: string
  nativeSha256: string
  indexerUrl: string
  bitcoindAuth?: { username: string; password: string }
} | {
  nativeExecutable?: never
  androidNativeLibraryDir?: string
  nativeSha256?: string
  indexerUrl: `${'tcp' | 'ssl'}://${string}`
  bitcoindAuth?: never
})
type Balance = { settled: string; future: string; spendable: string }
type Operation = { txid: string; batchTransferIdx?: number; created?: number }
export type BurnRequest = {
  operationId: string
  assetId: string
  amount: BaseUnits
  feeRate: BaseUnits
  minConfirmations?: number
  burnRecipient: BurnRecipient
  burnDestination: BurnDestination
}
export class WalletAccountRgb {
  private constructor()
  readonly disposed: boolean
  dispose(): Promise<void>
  getInfo(): {
    ready: boolean
    network: 'regtest'
    protocol: 'RGB_L1'
    methods: string[]
    burnDestinationVersion?: 1
    burnDestinationRoutes?: BurnRoute[]
    burnRecipientNamespaces?: string[]
  }
  getAddress(): Promise<string>
  getBtcBalance(): Promise<{ vanilla: Balance; colored: Balance }>
  getAssetBalance(assetId: string): Promise<Balance>
  getReceivedMint(recipientId: string): Promise<{
    opid: string; amount: string; beforeBlock: string; evmChainId: string; bridgeContract: string
  } | null>
  listUnspents(): Promise<unknown[]>
  listTransfers(filter?: { assetId?: string; txid?: string }): Promise<unknown[]>
  refresh(assetId?: string): Promise<unknown>
  registerAssetContract(options: { contract: Uint8Array; assetId: string; sha256: string }): Promise<{ assetId: string }>
  blindReceive(options?: { assetId?: string; amount?: BaseUnits; expirationSeconds?: number; minConfirmations?: number }): Promise<{
    invoice: string; recipientId: string; expirationTimestamp: string; batchTransferIdx: number; publicKey?: string
  }>
  createUtxos(options: { operationId: string; count: number; size: BaseUnits; feeRate: BaseUnits }): Promise<Operation>
  burnAsset(options: BurnRequest): Promise<Operation & {
    assetId: string; amount: string; minConfirmations: number; burnRecipient: BurnRecipient; burnDestination: BurnDestination
  }>
  getOperation(operationId: string): Promise<unknown>
  getConsignment(options: { assetId: string; txid: string }): Promise<Proof>
  recoverBurn(operationId: string): Promise<{ txid: string; assetId: string; burnDestination: BurnDestination; proof: Proof }>
}
export class WalletManagerRgb {
  constructor(seed: string | Uint8Array, options: CandidateConfig)
  readonly disposed: boolean
  getAccount(index?: 0): Promise<WalletAccountRgb>
  dispose(): Promise<void>
  static getRandomSeedPhrase(wordCount?: 12 | 24): string
  static isValidSeedPhrase(seedPhrase: string): boolean
}
export default WalletManagerRgb
export class WalletRuntimeError extends Error {
  readonly code: string
}
export function burnDestinationFor(payout: BurnRecipient, routes: readonly BurnRoute[]): BurnDestination
export function burnDestinationHash(value: BurnDestination): string
export function createBurnPackage(proof: Uint8Array, value: BurnDestination): string
