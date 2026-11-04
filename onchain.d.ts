import type { IWalletAccountReadOnly, TransactionReceipt, WaitForTransactionOptions } from '@tetherto/wdk-wallet'

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
  address?: string
  invoice?: string
  recipientId?: string
  witnessAmountSat?: string
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
    kind: 'rgb-output' | 'rgb-burn' | 'btc-send' | 'rgb-send'
    txid: string
    psbtSha256: string
    feeSats: string
    vsize: number
    inputs: readonly Readonly<{ outpoint: string; amountSats: string; role: string }>[]
    outputs: readonly Readonly<{ index: number; scriptHex: string; amountSats: string; role: string }>[]
  }>
}>
type SharedCandidateConfig = {
  startupMode?: 'online' | 'offline'
  dataDir: string
  maxFeeSats: BaseUnits
  authorize(review: Review): boolean | Promise<boolean>
  authorizeMessage?(review: MessageReview): boolean | Promise<boolean>
}
type RgbModeConfig = {
  profile?: never
  mode?: 'rgb'
  transportEndpoint: string
  evmRpcUrls?: Record<string, string>
  proxyAuthKeys?: Record<string, string>
  burnDestinationRoutes?: readonly BurnRoute[]
}
type BtcOnlyModeConfig = {
  profile?: never
  /** Choose for seed-only imports. The selected mode is bound to the wallet directory. */
  mode: 'btc-only'
  transportEndpoint?: never
  evmRpcUrls?: never
  proxyAuthKeys?: never
  burnDestinationRoutes?: never
}
type HostedRgbModeConfig = {
  mode: 'rgb'
  evmRpcUrls: { readonly '42161': 'https://arb1.arbitrum.io/rpc' }
  proxyAuthKeys?: never
  burnDestinationRoutes?: readonly [] | readonly [{ chainId: 'eip155:42161'; dstEid: 0 }]
}
type StagingRgbModeConfig = HostedRgbModeConfig & {
  profile: 'staging'
  transportEndpoint: 'rpcs://staging.rgb-proxy.utexo.com/json-rpc'
}
type DevRgbModeConfig = HostedRgbModeConfig & {
  /** Hosted access is gated by the reviewed package configuration. */
  profile: 'dev'
  transportEndpoint: 'rpcs://dev.rgb-proxy.utexo.com/json-rpc'
}
type CandidateNetwork = 'regtest' | 'signet'
type NetworkConfig = ({
  network: 'regtest'
  indexerUrl: `${'tcp' | 'ssl'}://${string}`
} & (RgbModeConfig | BtcOnlyModeConfig)) | ({
  network: 'signet'
  indexerUrl: `ssl://electrum.iriswallet.com:50033${'' | '/'}`
} & (BtcOnlyModeConfig | StagingRgbModeConfig)) | ({
  network: 'signet'
  indexerUrl: `https://dev.esplora-01.mint.utexo.com${'' | '/'}`
} & DevRgbModeConfig)
export type CandidateConfig = SharedCandidateConfig & NetworkConfig & ({
  nativeExecutable: string
  nativeSha256: string
  androidNativeLibraryDir?: never
} | {
  nativeExecutable?: never
  androidNativeLibraryDir?: string
  nativeSha256?: string
})
export type MessageReview = Readonly<{ kind: 'bip322'; message: string; address: string; messageSha256: string }>
export type Balance = { settled: string; future: string; spendable: string }
export type AssetView = {
  assetId: string
  schema: 'Nia' | 'Uda' | 'Cfa' | 'Ifa' | 'Bfa'
  name: string
  ticker: string | null
  precision: number
  balance: Balance
}
export type WalletTransaction = {
  type: 'RgbSend' | 'Drain' | 'CreateUtxos' | 'SendBtc' | 'Incoming'
  txid: string
  received: string
  sent: string
  fee: string
  confirmationTime: { height: number; timestamp: string } | null
}
export type Transfer = {
  idx: number
  batchTransferIdx: number
  status: string
  kind: string
  txid: string | null
  recipientId: string | null
  requestedAssignment: Record<string, string | true> | null
  assignments: Record<string, string | true>[]
}
export type RefreshResult = { transfers: {
  batchTransferIdx: number
  status: string | null
  failure: { code: string; message: string } | null
}[] }
export type ReceiveRequest = { assetId?: string; amount?: BaseUnits; expirationSeconds?: number; minConfirmations?: number }
export type ReceiveInvoice = {
  invoice: string; recipientId: string; expirationTimestamp: string; batchTransferIdx: number; publicKey?: string
}
export type DecodedInvoice = {
  recipientId: string; assetId: string | null; network: string; schema: string | null;
  assignment: Record<string, string | true>; expirationTimestamp: string | null;
  transportEndpoints: string[]; publicKey: string | null;
  recipientType: 'Blind' | 'Witness'; witnessScriptHex: string | null
}
type Operation = { txid: string; batchTransferIdx?: number; created?: number }
export type OperationRecord = {
  id: string
  kind: Review['plan']['kind']
  stage: 'starting' | 'prepared' | 'submitting' | 'declined' | 'submitted' | 'failed'
  txid?: string
  psbtSha256?: string
  batchTransferIdx?: number
}
export type OutputRequest = { operationId: string; count: number; size: BaseUnits; feeRate: BaseUnits }
export type PreparedOutputIdentity = { operationId: string; psbtSha256: string }
export type BtcSendRequest = { operationId: string; address: string; amount: BaseUnits; feeRate: BaseUnits }
export type RgbSendRequest = {
  operationId: string; invoice: string; assetId: string; amount: BaseUnits; feeRate: BaseUnits;
  minConfirmations?: number; witnessAmountSats?: BaseUnits
}
export type SendStatus = { state: 'submitted' | 'failed' | 'unresolved'; txid: string; batchTransferIdx?: number }
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
  readonly path: "0'/0/0"
  readonly keyPair: null
  dispose(): Promise<void>
  shutdown(): Promise<void>
  isDisposed(): boolean
  getNetwork(): CandidateNetwork
  /** Tracks whether an indexer session was established. Call getNetworkInfo for current reachability. */
  getConnectionStatus(): 'offline' | 'connected' | 'unavailable'
  connect(): Promise<void>
  getNetworkInfo(): Promise<{ network: CandidateNetwork; height: number; blockHash: string }>
  checkIndexerUrl(url?: string): Promise<{ ok: true; indexerProtocol: 'Electrum' | 'Esplora' }>
  checkProxyEndpoint(url?: string): Promise<{ ok: true }>
  getInfo(): {
    ready: boolean
    network: CandidateNetwork
    protocol: 'RGB_L1'
    methods: string[]
    burnDestinationVersion?: 1
    burnDestinationRoutes?: BurnRoute[]
    burnRecipientNamespaces?: string[]
  } | {
    ready: boolean
    network: CandidateNetwork
    protocol: 'BTC_L1'
    methods: []
  }
  getAddress(): Promise<string>
  getNewAddress(): Promise<string>
  getCapabilities(): { bip322: { signing: true; verification: true; protocol: 'bip322-simple'; specVersion: '2.0.0'; addressTypes: readonly string[]; verificationAddressTypes: readonly string[] } | { status: 'unavailable'; reason: string } }
  getMessageSigningAddress(): Promise<string>
  signMessageBip322(message: string, address: string): Promise<string>
  verifyMessageBip322(message: string, address: string, signature: string): Promise<boolean>
  getBalance(): Promise<bigint>
  getTokenBalance(assetId: string): Promise<bigint>
  getBalanceDetails(): Promise<{ vanilla: Balance; colored: Balance }>
  listAssets(): Promise<AssetView[]>
  getTransactions(): Promise<WalletTransaction[]>
  getTransaction(hash: string): Promise<TransactionReceipt>
  getTransactionReceipt(hash: string): Promise<WalletTransaction | null>
  waitForTransaction(hash: string, options?: WaitForTransactionOptions): Promise<TransactionReceipt>
  toReadOnlyAccount(): Promise<IWalletAccountReadOnly>
  getAssetMetadata(assetId: string): Promise<unknown>
  estimateFeeResult(blocks?: number): Promise<{ feeRate: string }>
  decodeRgbInvoice(invoice: string): Promise<DecodedInvoice>
  sendBtc(request: BtcSendRequest): Promise<Operation>
  sendRgbInvoice(request: RgbSendRequest): Promise<Operation>
  recoverSend(operationId: string): Promise<SendStatus>
  getBtcBalance(): Promise<{ vanilla: Balance; colored: Balance }>
  getAssetBalance(assetId: string): Promise<Balance>
  getReceivedMint(recipientId: string): Promise<{
    opid: string; amount: string; beforeBlock: string; evmChainId: string; bridgeContract: string
  } | null>
  listUnspents(): Promise<unknown[]>
  listTransfers(filter?: { assetId?: string; txid?: string }): Promise<Transfer[]>
  refresh(assetId?: string): Promise<RefreshResult>
  refreshTransfers(options?: { assetId?: string }): Promise<RefreshResult>
  sync(): Promise<RefreshResult>
  registerAssetContract(options: { contract: Uint8Array; assetId: string; sha256: string }): Promise<{ assetId: string }>
  importRgbContract(options: { contract: Uint8Array; assetId: string; sha256: string }): Promise<{ assetId: string }>
  blindReceive(options?: ReceiveRequest): Promise<ReceiveInvoice>
  witnessReceive(options?: ReceiveRequest): Promise<ReceiveInvoice>
  createRgbInvoice(options?: ReceiveRequest & { mode?: 'blind' | 'witness' }): Promise<ReceiveInvoice>
  /** Trusted transport entry point. approve() must reject if the user declines. */
  receiveWebRgbInvoice(request: {
    method: 'blindReceive' | 'witnessReceive'; operationId: string; requestKey: string;
    options: ReceiveRequest; assertAuthorized(): void; approve(): Promise<void>
  }): Promise<Pick<ReceiveInvoice, 'invoice' | 'recipientId' | 'expirationTimestamp'>>
  getInvoiceStatus(recipientId: string): Promise<Transfer | null>
  createUtxos(options: OutputRequest): Promise<Operation>
  prepareCreateUtxos(options: OutputRequest): Promise<Review>
  commitPreparedCreateUtxos(options: PreparedOutputIdentity): Promise<Operation>
  cancelCreateUtxosPlan(options: PreparedOutputIdentity): Promise<void>
  getCreateUtxosOperation(operationId: string): Promise<OperationRecord | undefined>
  listCreateUtxosOperations(): Promise<OperationRecord[]>
  recoverCreateUtxos(operationId: string): Promise<OperationRecord>
  burnAsset(options: BurnRequest): Promise<Operation & {
    assetId: string; amount: string; minConfirmations: number; burnRecipient: BurnRecipient; burnDestination: BurnDestination
  }>
  getOperation(operationId: string): Promise<OperationRecord | undefined>
  listUnresolvedOperations(): Promise<OperationRecord[]>
  recoverUnsubmittedOperation(operationId: string): Promise<OperationRecord>
  getConsignment(options: { assetId: string; txid: string }): Promise<Proof>
  recoverBurn(operationId: string): Promise<{ txid: string; assetId: string; burnDestination: BurnDestination; proof: Proof }>
}
export class WalletManagerRgb {
  constructor(seed: string | Uint8Array, options: CandidateConfig)
  readonly disposed: boolean
  getAccount(index?: 0): Promise<WalletAccountRgb>
  getAccountByPath(path: "0'/0/0"): Promise<WalletAccountRgb>
  getFeeRates(): Promise<{ normal: bigint; fast: bigint }>
  shutdown(): Promise<void>
  dispose(): Promise<void>
  static getRandomSeedPhrase(wordCount?: 12 | 24): string
  static isValidSeedPhrase(seedPhrase: string): boolean
}
export default WalletManagerRgb
export class WalletRuntimeError extends Error {
  readonly code: string
}
export function burnDestinationFor(payout: { chainId: string; address: string }, routes: readonly { chainId: string; dstEid: number }[]): BurnDestination
export function burnDestinationHash(value: BurnDestination): string
export function createBurnPackage(proof: Uint8Array, value: BurnDestination): string

export type ApprovalTicket = Readonly<{ generation: string; token: string; digest: string }>
export function createWorkletApproval(options: {
  generation: string
  timeoutMs?: number
  onRequest(request: ApprovalTicket & { readonly review: Review | MessageReview }): void | Promise<void>
}): Readonly<{
  authorize(review: Review): Promise<boolean>
  authorizeMessage(review: MessageReview): Promise<boolean>
  respond(decision: ApprovalTicket & { approved: boolean }): boolean
  close(): void
}>
