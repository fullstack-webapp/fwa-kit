import { defineConfig } from 'vitest/config'

const testConfig = {
  appId: 'local-edge-package-test',
  localEdgeEnabled: true,
  scopePath: '/',
  workerPath: '/__fwa-sw.js',
  descriptorPath: '/__fwa/release.json',
  controlPrefix: '/__fwa',
  appEntry: '/',
  appRequestPrefixes: ['/api/'],
  releaseAssetPrefixes: ['/assets/'],
  supplementalAssetPaths: ['/favicon.svg'],
  navigation: {
    appPaths: ['/'],
    appPathPrefixes: [],
    notFound: { strategy: 'app-entry' },
  },
  updateCheck: {
    enabled: true,
    intervalMinutes: 5,
  },
}

export default defineConfig({
  define: {
    __FWA_LOCAL_EDGE_CONFIG__: JSON.stringify(testConfig),
  },
})
