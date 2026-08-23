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

The loader accepts a controlling worker only when both identities match. A missing or mismatched protocol follows the same guarded Service Worker replacement path as any incompatible controller.

The kernel protocol version changes only when the document loader and worker can no longer communicate safely. It is independent of package versions and the release descriptor `schemaVersion`.

## Global facade

The loader exposes `window.__fwa.localEdge`:

```ts
const localEdge = window.__fwa?.localEdge

const unsubscribe = localEdge?.subscribe((state) => {
  console.log(state.phase, state.releaseId, state.availableReleaseId)
})

await localEdge?.revalidate()
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

Supported Local Edge commands mirror the facade methods: `localEdge.getState`, `localEdge.subscribe`, `localEdge.revalidate`, `localEdge.applyUpdate`, `localEdge.reset`, and `localEdge.openNetwork`. Diagnostics commands remain under `debug.*`.

## Update state

`releaseId` identifies the release running in the current document. `availableReleaseId` identifies a newer complete release. `updateAvailable` becomes true only after candidate verification and commit. Revalidation never refreshes the current document implicitly.
