import { access, readFile } from 'node:fs/promises'
import { createFwaViteIntegration } from '../dist-sdk/vite.js'
import {
  fwaGlobalReadyEventName,
  getFwaLocalEdge,
} from '../dist-sdk/client.js'

const publicTypes = await readFile(
  new URL('../dist-sdk/vite.d.ts', import.meta.url),
  'utf8',
)
if (!publicTypes.includes('createFwaViteIntegration')) {
  throw new Error('FWA SDK public types are missing the Vite integration')
}
const clientTypes = await readFile(
  new URL('../dist-sdk/client.d.ts', import.meta.url),
  'utf8',
)
if (
  !clientTypes.includes('updateAvailable') ||
  !clientTypes.includes('applyUpdate') ||
  !clientTypes.includes('FwaDebugApi') ||
  !clientTypes.includes('setEnabled')
) {
  throw new Error('FWA SDK public client types are incomplete')
}
if (fwaGlobalReadyEventName !== '__fwa:ready' || getFwaLocalEdge() !== undefined) {
  throw new Error('FWA SDK client entry has an invalid server fallback')
}

const localEdge = createFwaViteIntegration({
  appId: 'sdk-smoke',
  localEdgeEnabled: true,
  scopePath: '/',
  workerPath: '/__fwa-sw.js',
  descriptorPath: '/__fwa/release.json',
  controlPrefix: '/__fwa',
  appEntry: '/',
  appRequestPrefixes: [],
  releaseAssetPrefixes: ['/assets/'],
  supplementalAssetPaths: [],
  navigation: {
    appPaths: ['/'],
    appPathPrefixes: [],
    notFound: { strategy: 'app-entry' },
  },
})

for (const config of [localEdge.loaderConfig(), localEdge.workerConfig()]) {
  const entry = config.build?.lib && 'entry' in config.build.lib
    ? config.build.lib.entry
    : undefined
  if (typeof entry !== 'string') {
    throw new Error('FWA SDK build config is missing its source entry')
  }
  await access(entry)
}
