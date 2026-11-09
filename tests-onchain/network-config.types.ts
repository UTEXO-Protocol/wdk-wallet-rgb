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
