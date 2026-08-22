# Navigation and request ownership

Navigation policy is build-time data shared by the publisher and Service Worker classifier. It states which layer owns a URL; it does not replace an application router.

```json
{
  "navigation": {
    "appPaths": ["/", "/library/"],
    "appPathPrefixes": ["/library/"],
    "notFound": { "strategy": "app-entry" }
  }
}
```

- `app-entry` serves the active app entry for an unknown navigation. The application owns its not-found UI.
- `network` leaves an unknown navigation to the browser and static host.
- `redirect` may target only a declared app route.

## Fetch ownership gate

The worker calls `respondWith()` only for declared ownership:

1. State and revalidate control endpoints.
2. Supported top-level network and reset navigation modes.
3. The loader, declared supplemental assets, and manifest-derived release assets.
4. Declared application navigation.

Application request prefixes, cross-origin requests, unknown paths, unsupported methods, and undeclared assets return from the event listener without interception. This gate is evaluated before cache lookup or runtime fallback.

## Classifier order

For an owned request, the pure classifier applies these rules in order:

1. Reserved controls use kernel responses.
2. Application request prefixes preserve normal HTTP network semantics.
3. Release assets require exact descriptor membership.
4. Owned navigation uses the active app entry, an explicit redirect, or browser network according to the navigation policy.

SPA fallback cannot consume an API, JavaScript, stylesheet, or third-party request merely because the request is same-origin.

## Static-host behavior

For `app-entry` and redirect policies, the publisher produces an app-bearing `404.html`. Static deep links may therefore be an HTTP 404 whose body starts the app; the app router still decides whether to render a route or its not-found boundary. Controlled navigation is served from the committed app entry while retaining the requested URL.

The project does not use a global 200 rewrite. Missing release assets must remain non-2xx responses and must not receive immutable caching.
