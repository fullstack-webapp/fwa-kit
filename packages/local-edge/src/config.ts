import { localEdgeControlPathsFor, defineLocalEdgeConfig } from './config-contract.ts'

export * from './config-contract.ts'

declare const __FWA_LOCAL_EDGE_CONFIG__: unknown
export const localEdgeConfig = defineLocalEdgeConfig(__FWA_LOCAL_EDGE_CONFIG__)
export const localEdgeControlPaths = localEdgeControlPathsFor(localEdgeConfig)
