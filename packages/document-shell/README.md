# `@fullstack-webapp/document-shell`

Document Shell lets a Vite application emit a useful, parser-visible first
screen before its JavaScript framework and extracted stylesheet are ready. It
compiles a consumer-owned shell into the final `index.html`, then performs a
one-shot handoff after the real application has committed.

This is build-time document projection, not server-side rendering. It does not
render request data, route content, or a second interactive application, and
it has no framework runtime dependency.

## When to use it

Use Document Shell when the gap between browser or WebClip startup and the
first framework paint exposes a white frame, unstable application chrome, or
an empty mount point. The projected shell is best suited to stable first-frame
structure such as:

- the application background and core layout;
- brand, navigation, and a bottom tab bar;
- a route-aware active state derived from `location.pathname`; and
- lightweight content skeletons whose geometry matches the runtime surface.

It is not a fit when the first frame requires request-only data, authentication
results, or interactive state that cannot be known while building the HTML.

## Install

```sh
pnpm add -D @fullstack-webapp/document-shell@beta
```

Document Shell supports Vite 7 and 8. It emits standard ESM and declarations;
all public imports resolve from compiled package output.

## Minimal integration

The integration has four deliberate seams: an entry sentinel, a build-time
renderer, the Vite plugin, and a framework commit signal.

### 1. Reduce `index.html` to the Vite entry sentinel

```html
<!doctype html>
<script
  type="module"
  src="/src/main.tsx"
  data-document-shell-entry
></script>
```

The checked-in file exists for Vite dependency discovery. Document metadata,
shell markup, critical CSS, and startup effects belong in `render()` so there
is one source of truth for the emitted document.

### 2. Return one document composition

```ts
// document-shell.config.ts
import {
  cssText,
  htmlFragment,
  type DocumentShellBuildContext,
  type DocumentShellComposition,
} from '@fullstack-webapp/document-shell'

export function renderDocumentShell(
  _context: DocumentShellBuildContext,
): DocumentShellComposition {
  return {
    document: {
      lang: 'en',
      title: 'Example',
      head: [
        htmlFragment(
          '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
        ),
        htmlFragment('<link rel="manifest" href="/manifest.webmanifest">'),
        htmlFragment('<meta name="theme-color" content="#111827">'),
      ],
      appEntry: '/src/main.tsx',
      mountId: 'root',
    },
    shell: {
      html: htmlFragment(`
        <div data-document-shell-static="true" aria-hidden="true">
          <nav>Example</nav>
          <main class="document-shell__skeleton"></main>
        </div>
      `),
      criticalCss: [
        cssText(`
          html, body { margin: 0; min-height: 100%; background: #f8fafc; }
          [data-document-shell-static] { position: fixed; inset: 0; }
          .document-shell__skeleton { min-height: 60vh; }
        `),
      ],
    },
  }
}
```

`render(context)` is intentionally coarse. The consumer may produce its HTML
and CSS with plain strings, a template engine, or build-time React rendering.
The package does not define separate brand, navigation, route, manifest, or
skeleton schemas.

### 3. Add the Vite HTML pipeline

```ts
// vite.config.ts
import { documentShell } from '@fullstack-webapp/document-shell/vite'
import { defineConfig } from 'vite'

import { renderDocumentShell } from './document-shell.config.ts'

export default defineConfig({
  plugins: [
    ...documentShell({
      render: renderDocumentShell,
      runtimeHandoff: true,
    }),
  ],
})
```

The compiler runs before downstream `transformIndexHtml` hooks. A final build
gate reparses the emitted `index.html` and checks the document invariants after
all plugins have run.

### 4. Commit after the real shell is drawable

```tsx
// DocumentShellHandoff.tsx
import { commitDocumentShellRuntime } from '@fullstack-webapp/document-shell/client'
import { useLayoutEffect } from 'react'

export function DocumentShellHandoff() {
  useLayoutEffect(() => {
    void commitDocumentShellRuntime()
  }, [])

  return null
}
```

Mount this component inside the real application shell, after its persistent
navigation and route fallback are present. For another framework, call the
same function from the equivalent post-commit hook. Repeated calls return the
same document-level promise; do not undo the handoff during component cleanup.

With `runtimeHandoff: true`, Document Shell converts the single extracted
stylesheet into a preload and records its load, error, or absolute timeout.
The commit waits for that gate, marks `<html data-app-ready="true">`, removes
the element carrying `data-document-shell-static`, and always fails open so a
broken stylesheet cannot leave a permanent overlay.

For the full file-by-file procedure, safe-area effect example, verification
checklist, and failure guide, see [Integration guide](docs/integration.md).

## Public exports

| Import | Responsibility |
| --- | --- |
| `@fullstack-webapp/document-shell` | Typed HTML/CSS/script boundaries, document composition types, compiler, structural validation, and the shared-default safe-area bridge. |
| `@fullstack-webapp/document-shell/vite` | The Vite HTML producer, optional runtime-stylesheet gate, and final emitted-document validator. |
| `@fullstack-webapp/document-shell/client` | The framework-neutral, one-shot runtime handoff. |
| `@fullstack-webapp/document-shell/reference` | Reference-application safe-area rollout used to retain existing evidence while profiles mature; it is not a consumer profile selector. |

The current beta catalog projects all four accepted iOS standalone portrait
profiles through `sharedDefault`: `375×812@3x`, `393×852@3x`, `402×874@3x`, and
`430×932@3x`. Root consumers receive their `34px` startup bottom floor without
selecting or copying a profile. Maturity remains independent: `402×874@3x` is
`verified`, while the other three remain `provisional` and can be narrowed or
revised as production evidence arrives. Unsupported geometry remains a visible
no-op.

`./reference` is a pre-1.0 migration seam, not a second configuration model.
All current profiles are now shared defaults, so the subpath projects the same
catalog as the root entry. It remains temporarily for source compatibility with
the reference application and can be removed in a later beta breaking release
after that consumer switches to the root entry.

## Ownership boundary

Document Shell owns the document compiler, Vite transform order, structural
gates, stylesheet handoff, and the package-accepted safe-area profile catalog.
The consuming application owns:

- brand, navigation, active-route policy, shell markup, and critical CSS;
- manifest values, Apple WebClip metadata, icons, and splash assets;
- the framework commit point and the runtime shell's geometry;
- names of global CSS variables and data attributes changed by startup effects;
- diagnostic builds and device/video/trace evidence.

This keeps global side effects visible in the app's composition root. The
package compiles bounded data such as a `SafeAreaDomEffect`; it never serializes
an arbitrary callback with `Function#toString()`.

## Current constraints

- Runtime handoff supports one HTML entry and exactly one extracted stylesheet.
  Zero or multiple stylesheet links fail the production build. Keep shell CSS
  inline and let the application emit one runtime stylesheet.
- The projection is inert and carries `aria-hidden="true"`; accessibility and
  interaction belong to the real application.
- Document Shell validates exactly one viewport meta, manifest link, title,
  mount point, critical-shell style, static-shell marker, and module entry.
- The shared safe-area entry only emits profiles promoted to `sharedDefault`;
  the current catalog emits all four accepted portrait profiles while retaining
  their verified or provisional maturity. Consumers do not choose individual
  device profiles or rollout maturity.
- The current safe-area runtime matches observable browser geometry and
  platform signals, not marketing device names. Unsupported geometry fails
  open and receives no reserve.

## Development

From the FWA Kit repository root:

```sh
pnpm --filter @fullstack-webapp/document-shell build
pnpm --filter @fullstack-webapp/document-shell test
pnpm --filter @fullstack-webapp/document-shell typecheck
pnpm --filter @fullstack-webapp/document-shell pack:check
pnpm --filter @fullstack-webapp/document-shell test:packed-consumer
```

The packed-consumer check installs the generated tarball into an isolated Vite
application, builds its real `index.html`, and imports every public subpath.

## License

[MIT](LICENSE) © 2026 Zou Guoqing
