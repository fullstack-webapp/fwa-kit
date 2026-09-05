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
X-FWA-Kernel-Protocol: 2
```

The protocol number is a monotonic kernel capability level. The level-2 loader keeps level 1 as its minimum safe kernel: under a valid level-1 controller it preserves the installed offline release and level-1 update behavior but omits ordered percentage progress. Missing, invalid, or below-minimum identity follows the guarded Service Worker replacement path; a capability upgrade alone never unregisters a valid controller.

Workers must preserve the loader-facing behavior of protocol levels they already implement. This lets a loader cached in an older committed release continue with a newer worker while a newer loader safely degrades under an older compatible worker.

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

An `updated` result never announces from the response payload: every successful level-2 revalidation response pulls the kernel's state endpoint through the same ordered chain as terminal-message pulls, so the projection reflects the kernel's current active release and a commit that landed in another tab while the response was pending cannot be overwritten by the older release the result carries. If every bounded pull attempt is overtaken by a newer accepted observation, the loader preserves that newer state and defers release projection instead of reporting a false failure; a later terminal event or scheduled pull retries recovery. The silent first-install (`installed`/`enabled`) claim derives from the same ordered fresh-snapshot read. All kernel-observation reads — startup, controller-change, response-driven, and terminal-message pulls — share this ordering, so an older fetch can never overwrite a newer observation. A transient startup snapshot failure may publish an error, but it does not disable scheduled, visibility, or online recovery checks for the document.

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
| snapshot `revalidation` | Only while a level-2 kernel instance has an in-memory install running; omitted otherwise | Public fields plus internal `{ kernelInstanceId, observationRevision, attemptId }` ordering identity |

The public progress field is optional and additive. A level-1 kernel does not supply ordered observations, so the level-2 loader deliberately omits percentage progress rather than reconstructing it with arrival-time heuristics.

The kernel emits three message types to controlled window clients via `postMessage`:

- `__fwa:revalidation-progress` with `{ type, kernelInstanceId, observationRevision, attemptId, releaseId, completedAssets, totalAssets }`, at most one message every 250 ms while assets complete, always ending with `completedAssets === totalAssets` (including when the final asset completes in the same millisecond as a previous broadcast).
- `__fwa:revalidation-committed` with `{ type, kernelInstanceId, observationRevision, attemptId, releaseId }` after a verified candidate is committed.
- `__fwa:revalidation-failed` with the same identity fields when an install attempt does not commit — including an install aborted by a reset takeover, so remaining controlled windows drop a stale progress value. After a reset the worker answers `/__fwa/state` from memory with valid instance/revision identity and network-only mode, then passes remaining app requests through to the network without re-creating deleted metadata.

`revalidationProgress` is kernel-level and independent of the document's own `revalidating` flag: any tab's revalidation install broadcasts to every controlled window client, while `revalidating` continues to reflect only the current document's own `revalidate()` calls. Messages, snapshots, and successful install responses share a kernel-instance revision domain; the loader discards superseded lower revisions without starting another pull, accepts compatible same-revision snapshot enrichment, and uses authoritative pulls for malformed, conflicting, or foreign-instance observations and to heal missed terminal events. An awaited `revalidate()` that installs an update resolves only after the ordered announcement pull has published, so callers reading state right after the promise see the announcement. The committed pull preserves the document's loaded `releaseId` and only surfaces a differing kernel active release as an available update; a document opened through an explicit network open (`?__fwa=network`) stays on the network baseline and never projects kernel progress. Both message channels are best-effort and in-memory; a failed committed notification never rolls back the committed release, a worker restart changes kernel instance and clears progress, and the progress UI should fall back to a spinner rather than assuming a percentage is always available. Cross-channel ordering and compatibility behavior are specified in [Revalidation observation ordering](revalidation-observation.md).
