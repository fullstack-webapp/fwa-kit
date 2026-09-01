import type { Plugin, UserConfig } from 'vite'

export interface FwaViteIntegration {
  appPlugin(): Plugin
  loaderConfig(): UserConfig
  workerConfig(): UserConfig
}

export interface FwaLocalEdgeConfig {
  appId: string
  localEdgeEnabled: boolean
  scopePath: string
  workerPath: string
  descriptorPath: string
  controlPrefix: string
  appEntry: string
  appRequestPrefixes: readonly string[]
  releaseAssetPrefixes: readonly string[]
  supplementalAssetPaths: readonly string[]
  navigation: {
    appPaths: readonly string[]
    appPathPrefixes: readonly string[]
    notFound:
      | { strategy: 'app-entry' }
      | { strategy: 'network' }
      | { strategy: 'redirect'; targetPath: string }
  }
  updateCheck?: {
    enabled?: boolean
    intervalMinutes?: number
  }
}

export declare function createFwaViteIntegration(
  configSource: URL | FwaLocalEdgeConfig,
): FwaViteIntegration
