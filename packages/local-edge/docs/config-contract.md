# Build-time configuration and host ownership

`fwa.config.json` is the single build-time source for paths, release ownership, navigation ownership, and scheduled update defaults. Configuration is fixed during the build and is not replaced by remote runtime input. A document may adjust its own update-check schedule through the client facade, but that override is neither persisted nor shared with later documents.

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
| `updateCheck.enabled` | Enables document-side scheduled release checks; defaults to `true` |
| `updateCheck.intervalMinutes` | Positive integer minimum interval between checks; defaults to `5` and must fit the browser timer range (at most `35791`) |

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

## Scheduled update checks

The loader bundles the normalized `updateCheck` configuration. When enabled,
the document checks for a release after returning to visible state, at the
configured interval while visible, and after an `online` event. The minimum
interval also applies after failures, which prevents visibility or network
events from creating a retry loop. Intervals are capped by contract at 35,791
minutes so the document never passes an overflowing delay to browser timers.

Scheduled checks do not publish `revalidating` activity, and failures keep the
last committed release without a warning. A normal candidate preserves the
current message while setting `updateAvailable` and `availableReleaseId`. If a
check installs the first release or re-enables an existing release, the loader
publishes the material runtime transition out of network-only mode. Switching
from an already active release remains owned by the next navigation or
`applyUpdate()`.

`window.__fwa.localEdge.setUpdateCheck()` can enable, disable, or change the
interval for the current document. This override is not written to browser
storage and does not change `fwa.config.json`.

## Remote disable

`localEdgeEnabled: false` can stand alone as a minimal descriptor policy. Revalidation persists network-only mode while retaining the last complete release for recovery. Re-enabling requires a complete, valid descriptor. A failed re-enable attempt leaves network-only mode active.
