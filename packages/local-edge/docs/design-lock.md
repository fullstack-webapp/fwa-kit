# Design boundaries

FWA Local Edge closes one code-delivery loop:

```text
network entry
→ build-time release descriptor
→ document-triggered revalidation
→ verified candidate cache
→ active release pointer
→ cache-backed navigation
→ explicit network and reset recovery
```

## Fixed boundaries

- The normal HTTPS app entry remains a runnable network baseline.
- React belongs to the demo, not the package runtime.
- The host owns business routing, APIs, authentication, data, and deployment policy.
- One Service Worker entry may compose host-owned routes with the Local Edge kernel.
- Request interception is allowlisted by declared ownership and fails open to browser networking.
- Release commitment is pointer-last: incomplete or invalid candidates never become active.
- Existing clients remain pinned to their loaded release while newer clients may use a newer active release.
- Reset removes only Local Edge-owned browser state.

## Storage

- Cache Storage: `fwa-local-edge:<appId>:release:<releaseId>`
- IndexedDB: `fwa-local-edge:<appId>`
- Service Worker: the configured origin and scope

The public cut does not migrate or read the earlier private beta namespace. No compatibility alias or dual-read path is included in public v0.

IndexedDB stores active and retained release metadata, window-client release pins, and a short-lived candidate journal. Cache cleanup follows live client pins rather than a fixed generation count. Reset aborts candidate work before deleting the package namespace and registration.

## Non-goals

- Business-data offline sync, outbox, or conflict resolution
- Backend or edge-compute authority in the browser
- Authentication, authorization, or secret storage
- RTC, TURN, WebTransport, or multi-path networking
- Archive-backed release encoding before measured installation pressure exists
- A complete FWA reference application

## Verification boundary

Package tests cover config validation, route priority, release verification, metadata, recovery, and public SDK entries. The demo's Chromium matrix covers install, offline startup, updates, client pinning, invalid candidates, reset, worker takeover, diagnostics, non-root scope, and hosting behavior. Browser support outside the automated matrix remains unclaimed until equivalent evidence exists.
