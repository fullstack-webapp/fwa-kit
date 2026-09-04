# Same-origin loader and client facade

The default document integration is one same-origin script:

```html
<script defer src="/__fwa/loader.js"></script>
```

The loader derives the scope, worker, descriptor, and control paths from its own URL. A root loader at `/__fwa/loader.js` uses `/__fwa-sw.js`, `/__fwa/release.json`, `/__fwa/state`, and `/__fwa/revalidate`. A loader under `/app/__fwa/loader.js` derives the equivalent `/app/` paths.

Repeated execution does not create a second document runtime. The loader verifies that the controller exposes the expected Local Edge state endpoint before allowing it to manage releases.

## Kernel compatibility

The state response identifies both the worker path and the kernel protocol:

```http
X-FWA-Kernel: /__fwa-sw.js
X-FWA-Kernel-Protocol: 1
```

The protocol number is a monotonic kernel capability level. The loader treats its bundled value as the minimum level it requires and accepts a controlling worker whose level is equal or newer. A missing, invalid, or older level follows the same guarded Service Worker replacement path as any incompatible controller.

Workers must preserve the loader-facing behavior of protocol levels they already implement. This lets a loader cached in an older committed release continue with a newer worker while a newer loader can still replace an older worker that lacks required capabilities.

The kernel protocol level is independent of package versions and the release descriptor `schemaVersion`. Removing support for an older loader protocol requires a loader update channel outside the active release; incrementing this number alone is not a safe breaking-change mechanism.

## Global facade

The loader exposes `window.__fwa.localEdge`:

```ts
const localEdge = window.__fwa?.localEdge

const unsubscribe = localEdge?.subscribe((state) => {
  console.log(state.phase, state.releaseId, state.availableReleaseId)
})

await localEdge?.revalidate()
localEdge?.setUpdateCheck({ enabled: true, intervalMinutes: 10 })
localEdge?.applyUpdate()
await localEdge?.reset()
localEdge?.openNetwork()
localEdge?.debug.setEnabled(true)
unsubscribe?.()
```

| API | Behavior |
| --- | --- |
| `getState()` | Read the current document state |
| `subscribe(listener)` | Emit immediately and on later state changes |
| `revalidate()` | Check and install a candidate; return `current`, `updated`, `failed`, or `disabled` |
| `setUpdateCheck(config)` | Change the enabled state or interval (1–35,791 minutes) for the current document without persistence |
| `applyUpdate()` | Reload only when a complete update is available |
| `reset()` | Clear Local Edge-owned state and enter network mode |
| `networkUrl(url?)` | Preserve the URL while adding `__fwa=network` |
| `openNetwork()` | Navigate to `networkUrl()` |
| `paths` | Read the derived scope, worker, descriptor, and control paths |
| `debug.*` | Read, subscribe to, and change diagnostics state without navigation |

The package client entry exports the same facade through `getFwaLocalEdge()` without adding framework state or lifecycle ownership.

## Command queue

Commands may be queued before the loader executes:

```html
<script>
  window.__fwa = window.__fwa || { q: [] }
  window.__fwa.q.push([
    'localEdge.subscribe',
    function (state) {
      document.documentElement.dataset.fwaPhase = state.phase
    },
  ])
</script>
```

Supported Local Edge commands mirror the facade methods: `localEdge.getState`, `localEdge.subscribe`, `localEdge.revalidate`, `localEdge.setUpdateCheck`, `localEdge.applyUpdate`, `localEdge.reset`, and `localEdge.openNetwork`. Diagnostics commands remain under `debug.*`.

## Update state

`releaseId` identifies the release running in the current document. `availableReleaseId` identifies a newer complete release. `updateAvailable` becomes true only after candidate verification and commit. Revalidation never refreshes the current document implicitly. Scheduled revalidation leaves `revalidating` and `message` unchanged; explicit `revalidate()` retains its visible activity and error behavior.

## Revalidation visibility

While the kernel installs a candidate release it broadcasts progress to controlled window clients and exposes the same progress through the state endpoint:

| Field | Presence | Shape |
| --- | --- | --- |
| `LocalEdgeClientState.revalidationProgress` | Only while a kernel-level install is running; omitted otherwise | `{ releaseId, completedAssets, totalAssets }` |
| snapshot `revalidation` | Only while a kernel-level install is running; omitted otherwise | `{ releaseId, completedAssets, totalAssets }` |

Both are optional and additive: older loaders and consumers ignore them, and a kernel that predates the fields never sends or reports them.

The kernel emits three message types to controlled window clients via `postMessage`:

- `__fwa:revalidation-progress` with `{ type, releaseId, completedAssets, totalAssets }`, at most one message every 250 ms while assets complete, always ending with `completedAssets === totalAssets` (including when the final asset completes in the same millisecond as a previous broadcast).
- `__fwa:revalidation-committed` with `{ type, releaseId }` after a verified candidate is committed.
- `__fwa:revalidation-failed` with `{ type, releaseId }` when an install attempt fails or is aborted, so clients can drop a stale progress value and re-pull the state endpoint.

`revalidationProgress` is kernel-level and independent of the document's own `revalidating` flag: any tab's revalidation install broadcasts to every controlled window client, while `revalidating` continues to reflect only the current document's own `revalidate()` calls. A loader that sees a `__fwa:revalidation-committed` or `__fwa:revalidation-failed` message pulls the state endpoint again (event-then-pull), which naturally drops a stale progress value once the kernel has finished. The committed pull preserves the document's loaded `releaseId` and only surfaces a differing kernel active release as an available update; an explicitly network-opened document (`?__fwa=network`) stays on the network baseline and only drops stale progress — it is never relabeled by a settle broadcast. Both message channels are best-effort and in-memory; a worker restart clears progress, and the progress UI should fall back to a spinner rather than assuming a percentage is always available.
