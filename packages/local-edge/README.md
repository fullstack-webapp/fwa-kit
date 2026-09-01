# FWA Local Edge

FWA Local Edge is a browser-side runtime for atomic web app code releases, explicit request ownership, network-resilient startup, updates, and recovery.

It places a device-local edge in a Service Worker between the page and the network. It does not move application authentication, business authority, secrets, or backend data into the browser.

The package is in pre-release development. Public APIs and serialized contracts may change before the first stable release.

## Package surfaces

- `@fullstack-webapp/local-edge/vite` provides `createFwaViteIntegration()`.
- `@fullstack-webapp/local-edge/client` provides the framework-neutral document facade and types.
- `fwa-publish-release` builds the verified release descriptor and hosting metadata after the Vite bundles exist.

The loader and worker source files are included in the package and bundled by the consuming application's Vite version. Applications must not deep-import those source files.

## Install

```bash
pnpm add -D @fullstack-webapp/local-edge
```

The current public prerelease is [`0.1.0-beta.4`](https://www.npmjs.com/package/@fullstack-webapp/local-edge/v/0.1.0-beta.4).

## Demo

[`local-edge-demo`](../../apps/local-edge-demo/README.md) is this package's executable React integration and Chromium behavior matrix. It consumes the package's public Vite and client entries, rather than its source files.

## Configure

Create `fwa.config.json`:

```json
{
  "appId": "example-app",
  "localEdgeEnabled": true,
  "scopePath": "/",
  "workerPath": "/__fwa-sw.js",
  "descriptorPath": "/__fwa/release.json",
  "controlPrefix": "/__fwa",
  "appEntry": "/",
  "appRequestPrefixes": ["/api/"],
  "releaseAssetPrefixes": ["/assets/"],
  "supplementalAssetPaths": ["/favicon.svg"],
  "navigation": {
    "appPaths": ["/"],
    "appPathPrefixes": [],
    "notFound": { "strategy": "app-entry" }
  },
  "updateCheck": {
    "enabled": true,
    "intervalMinutes": 5
  }
}
```

`updateCheck` is optional. It defaults to an enabled five-minute check. The
document checks after becoming visible, while it remains visibly open, and
after the browser comes online. Scheduled checks prefetch a complete release
without changing the current document or publishing periodic activity and
failure messages.

Use the Vite integration in the app, loader, and worker configs:

```ts
import { createFwaViteIntegration } from '@fullstack-webapp/local-edge/vite'

const localEdge = createFwaViteIntegration(
  new URL('./fwa.config.json', import.meta.url),
)
```

The app config uses `localEdge.appPlugin()`. Separate Vite configs use `localEdge.loaderConfig()` and `localEdge.workerConfig()`. After all three builds complete, run:

```bash
fwa-publish-release
```

The publisher computes the Vite manifest closure, adds the same-origin loader and declared supplemental assets, verifies request ownership, writes `/__fwa/release.json`, and emits hosting headers.

## Client facade

The same-origin loader exposes `window.__fwa.localEdge`. Framework-neutral consumers can use the package entry:

```ts
import { getFwaLocalEdge } from '@fullstack-webapp/local-edge/client'

const localEdge = getFwaLocalEdge()
const unsubscribe = localEdge?.subscribe((state) => {
  console.log(state.phase, state.releaseId, state.availableReleaseId)
})

await localEdge?.revalidate()
localEdge?.setUpdateCheck({ intervalMinutes: 10 })
localEdge?.applyUpdate()
await localEdge?.reset()
unsubscribe?.()
```

`setUpdateCheck()` changes only the current document. It does not persist an
override or replace the build-time configuration for later documents.

The `window.__fwa` object and `__fwa` query namespace remain stable FWA protocol surfaces. The Local Edge facade and queue commands use the `localEdge` name.

## Guarantees

- A candidate release becomes active only after every declared asset passes origin, redirect, media type, size, and digest checks.
- A failed candidate does not replace the last known good release.
- The worker intercepts only declared control paths, release assets, and navigation ownership. Unknown, application API, and cross-origin requests retain browser network semantics.
- Existing documents stay pinned to the code release they loaded. A complete update becomes available for the next navigation or an explicit user action.
- Reset removes only Local Edge registration, metadata, and caches before entering network mode.
- `localEdgeEnabled: false` is a reversible network-only release policy, not an unregister operation.

## Documentation

- [Architecture](docs/architecture.md)
- [Build-time configuration and host ownership](docs/config-contract.md)
- [Loader and client facade](docs/loader-contract.md)
- [Navigation and request ownership](docs/navigation-contract.md)
- [Design boundaries](docs/design-lock.md)

## Current support boundary

The automated browser matrix targets Chromium. Firefox and Safari are not yet part of the public automated support claim. Registration and revalidation have no package-defined wall-clock timeout. Release assets are bounded to 16 MiB each and 64 MiB per release, but individual asset verification currently materializes one response in memory.

## License

[MIT](LICENSE) © 2026 Zou Guoqing
