# Build-time configuration and host ownership

`fwa.config.json` is the single build-time source for paths, release ownership, and navigation ownership. Configuration is fixed during the build and is not replaced by remote runtime input.

## Fields

| Field | Contract |
| --- | --- |
| `appId` | Stable lowercase identifier used in storage namespaces and release identity |
| `localEdgeEnabled` | Release policy; `false` enters reversible network-only mode |
| `scopePath` | Canonical absolute Service Worker scope ending in `/` |
| `workerPath` | Worker script inside the scope and outside the control namespace |
| `descriptorPath` | Release descriptor inside the scope |
| `controlPrefix` | Prefix for state and revalidate endpoints |
| `appEntry` | App document included in every complete release |
| `appRequestPrefixes` | Application-owned request namespaces that keep normal HTTP semantics |
| `releaseAssetPrefixes` | Build-owned subtrees allowed to contain manifest-derived release assets |
| `supplementalAssetPaths` | Exact paths added to the release closure outside the Vite manifest graph |
| `navigation.appPaths` | Exact app-owned navigation paths; must include `appEntry` |
| `navigation.appPathPrefixes` | App-owned navigation subtrees ending in `/` |
| `navigation.notFound` | `app-entry`, `network`, or a redirect to a declared app route |

`supplementalAssetPaths` is intended for stable files such as a favicon or Web App Manifest. Each path must be unique, remain inside the scope, avoid control and application-request namespaces, and exist in the build output.

## Build closure

`createFwaViteIntegration()` accepts a config URL or an already parsed object. The app plugin validates and normalizes the config, writes it to `dist/.vite/fwa.config.json`, injects the loader, and enables a Vite manifest.

The publisher walks `imports` and `dynamicImports`, adds the loader and supplemental assets, and verifies every path against the declared ownership policy. Content-hashed assets receive immutable caching. Stable loader and supplemental paths revalidate. The app entry uses `no-cache, no-transform`; the descriptor and 404 document use `no-store`.

The publisher runs after application, loader, and worker builds:

```bash
fwa-publish-release
```

## Runtime controls

The `__fwa` query parameter is a transport namespace:

- `__fwa=network` preserves the application URL and bypasses Local Edge for the navigation.
- `__fwa=reset` opens a confirmation flow and clears only Local Edge-owned registration, metadata, and caches.
- `__fwa_debug=1`, `0`, or `reset` manages same-origin diagnostics without changing request ownership.

Unknown or repeated values do not change the active mode. Application routers and query parsers should treat these names as transport parameters rather than domain input.

## Remote disable

`localEdgeEnabled: false` can stand alone as a minimal descriptor policy. Revalidation persists network-only mode while retaining the last complete release for recovery. Re-enabling requires a complete, valid descriptor. A failed re-enable attempt leaves network-only mode active.
