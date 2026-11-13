import type { CandidateConfig } from '../onchain.js'

type DevRoutes = Extract<CandidateConfig, { profile: 'dev' }>['burnDestinationRoutes']
type StagingRoutes = Extract<CandidateConfig, { profile: 'staging' }>['burnDestinationRoutes']

const routes = [
  { chainId: 'eip155:42161', dstEid: 0 },
  { chainId: 'eip155:1', dstEid: 30101 },
  { chainId: 'eip155:137', dstEid: 30109 },
  { chainId: 'eip155:9745', dstEid: 30383 },
  { chainId: 'tron:728126428', dstEid: 30420 }
] as const satisfies DevRoutes

const stagingRoutes = [routes[0]] as const satisfies StagingRoutes
// @ts-expect-error Staging still admits direct Arbitrum only.
const stagingEthereum = [routes[1]] as const satisfies StagingRoutes
// @ts-expect-error Ethereum's LayerZero endpoint cannot be paired with Polygon.
const mismatchedDevRoute = [{ chainId: 'eip155:137', dstEid: 30101 }] as const satisfies DevRoutes

declare const shared: Pick<CandidateConfig, 'dataDir' | 'maxFeeSats' | 'authorize'>
const ordinary = {
  ...shared, mode: 'rgb', transportEndpoint: 'rpcs://rgb.example.com/json-rpc'
} as const
const mainnet = { ...ordinary, network: 'mainnet', indexerUrl: 'ssl://electrum.iriswallet.com:50003' } as const satisfies CandidateConfig
const publicSignet = {
  ...ordinary, network: 'signet', profile: 'public', indexerUrl: 'ssl://electrum.iriswallet.com:50033'
} as const satisfies CandidateConfig
// @ts-expect-error Mainnet RGB does not admit a bridge route.
const mainnetBurn = { ...mainnet, burnDestinationRoutes: [routes[0]] } satisfies CandidateConfig
// @ts-expect-error Public Signet RGB requires its own explicit profile.
const implicitPublicSignet = { ...publicSignet, profile: undefined } satisfies CandidateConfig
// @ts-expect-error Public RGB never admits a plaintext proxy.
const insecurePublicSignet = { ...publicSignet, transportEndpoint: 'rpc://rgb.example.com/json-rpc' } satisfies CandidateConfig
