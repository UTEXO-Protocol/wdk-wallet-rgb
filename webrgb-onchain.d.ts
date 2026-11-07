import type { AssetView, BurnDestination, BurnRecipient, DecodedInvoice, Proof, Transfer, WalletAccountRgb } from './onchain.js'

export type { BurnDestination, BurnRecipient }
export type BurnDestinationRoute = Readonly<{ chainId: string; dstEid: number }>
export { burnDestinationFor, burnDestinationHash, createBurnPackage } from './onchain.js'
export function validateBurnDestination(value: unknown): BurnDestination
export const MAX_BURN_PROOF_BYTES: number

export type WebRgbMethod =
  | 'enable' | 'getInfo' | 'getAddress' | 'blindReceive' | 'witnessReceive'
  | 'listAssets' | 'getAssetBalance' | 'listTransfers' | 'getTransferStatus'
  | 'decodeRgbInvoice' | 'burnAsset' | 'getConsignment'

export type WebRgbErrorCode =
  | 'USER_REJECTED' | 'NOT_ENABLED' | 'METHOD_NOT_SUPPORTED'
  | 'INVALID_PARAMS' | 'ASSET_NOT_FOUND' | 'INTERNAL_ERROR'

export class WebRgbError extends Error {
  constructor(code: WebRgbErrorCode, message?: string)
  readonly code: WebRgbErrorCode
  toJSON(): { name: string; code: WebRgbErrorCode; message: string }
}

export type WebRgbNetwork = 'mainnet' | 'testnet' | 'testnet4' | 'signet' | 'regtest'

/** Verified by the trusted transport. Never populate this from RPC arguments. */
export type WebRgbRequestScope = Readonly<{
  identity: Readonly<{
    origin: string
    topic: string
    id: number
    method: `rgb_${WebRgbMethod}`
    fingerprint: string
  }>
  walletId: string
  network: WebRgbNetwork
  methods: readonly WebRgbMethod[]
  assertAuthorized(): void
}>

export type WebRgbPolicy = Readonly<{
  approvedAssetIds?: readonly string[]
  approvedBurnAssetIds?: readonly string[]
  burnDestinationRoutes?: readonly BurnDestinationRoute[]
  defaultBurnFeeRate?: number
}>

export type WebRgbReceiveArgs = {
  assetId?: string
  amount?: number
  durationSeconds?: number
  minConfirmations?: number
}

export type WebRgbReceiveResult = {
  invoice: string
  recipientId: string
  expirationTimestamp: number
  minConfirmations: number
}

export type WebRgbBurnArgs = Readonly<{
  network: WebRgbNetwork
  assetId: string
  amount: string
  burnRecipient: Readonly<BurnRecipient>
  burnDestination: BurnDestination
  feeRate?: number
  minConfirmations?: number
}>

export type WebRgbBurnResult = Omit<WebRgbBurnArgs, 'network' | 'feeRate' | 'minConfirmations'> & {
  transferId: string
  txid: string
  status: 'WaitingConfirmations'
  minConfirmations: number
}

export type WebRgbConsignmentArgs = Readonly<{ assetId: string; txid: string }>
export type WebRgbApproval = Readonly<{ origin: string } & (
  | { method: 'blindReceive' | 'witnessReceive'; params: Readonly<WebRgbReceiveArgs> }
  | { method: 'burnAsset'; params: WebRgbBurnArgs }
  | { method: 'getConsignment'; params: WebRgbConsignmentArgs }
)>

export type WebRgbTransfer = {
  assetId: string
  transferId: number
  status: string
  kind: string
  txid?: string
  amount?: number
  amountBaseUnits?: string
}

export type WebRgbWallet = {
  readonly disposed: boolean
  getInfo(): { ready: boolean; network: WebRgbNetwork; protocol: string; methods: readonly string[] }
  getAddress(): Promise<string>
  listAssets(): Promise<Pick<AssetView, 'assetId' | 'name' | 'ticker' | 'precision' | 'schema'>[]>
  getAssetBalance(assetId: string): Promise<{ spendable: string | number }>
  listTransfers(filter: { assetId: string; txid?: string }): Promise<Pick<Transfer,
    'idx' | 'status' | 'kind' | 'txid' | 'recipientId' | 'requestedAssignment' | 'assignments'>[]>
  refreshTransfers(filter: { assetId: string }): Promise<unknown>
  decodeRgbInvoice(invoice: string): Promise<Pick<DecodedInvoice,
    'assetId' | 'assignment' | 'recipientId' | 'expirationTimestamp' | 'network' | 'transportEndpoints'>>
} & Partial<Pick<WalletAccountRgb, 'receiveWebRgbInvoice' | 'burnAsset' | 'getConsignment' | 'getOperation' | 'recoverBurn'>>

/** An already-authorized, host-only facade. Create one per authenticated RPC. */
export class WebRgbProvider {
  constructor(wallet: WebRgbWallet, options: {
    scope: WebRgbRequestScope
    policy?: WebRgbPolicy
    confirm(approval: WebRgbApproval): boolean | Promise<boolean>
  })
  enable(): Promise<void>
  getInfo(): Promise<{
    ready: boolean
    network: WebRgbNetwork
    protocol: 'RGB_L1'
    methods: WebRgbMethod[]
    burnDestinationVersion?: 1
    burnDestinationRoutes?: BurnDestinationRoute[]
    burnRecipientNamespaces?: string[]
  }>
  getAddress(): Promise<{ address: string }>
  blindReceive(args?: WebRgbReceiveArgs): Promise<WebRgbReceiveResult>
  witnessReceive(args?: WebRgbReceiveArgs): Promise<WebRgbReceiveResult>
  listAssets(): Promise<{ id: string; name: string; ticker?: string; precision: number; schema: string }[]>
  getAssetBalance(assetId: string): Promise<{ assetId: string; balance: number; raw: { spendable: number } }>
  listTransfers(assetId?: string): Promise<WebRgbTransfer[]>
  getTransferStatus(id: string | number, assetId?: string): Promise<{
    found: boolean
    status: string | null
    transfer: WebRgbTransfer | null
  }>
  decodeRgbInvoice(args: string | { invoice: string }): Promise<{
    assetId?: string
    amount: number | null
    recipientId: string
    expirationTimestamp?: number
    network: WebRgbNetwork
    transportEndpoints: string[]
  }>
  burnAsset(args: WebRgbBurnArgs): Promise<WebRgbBurnResult>
  /** Reconcile a known burn RPC identity with its durable proof. Never reissues a mutation. */
  recoverBurn(args: WebRgbBurnArgs): Promise<WebRgbBurnResult>
  getConsignment(args: WebRgbConsignmentArgs): Promise<Proof>
}
