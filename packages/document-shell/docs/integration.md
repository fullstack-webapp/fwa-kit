# Document Shell integration guide

This guide connects Document Shell to a Vite single-page application without
making the package the owner of application markup or framework lifecycle.

## Result

A correct integration has one continuous visual container:

1. the browser parses and paints the static document shell;
2. the application module and its extracted stylesheet load behind it;
3. the application commits a drawable runtime shell;
4. Document Shell reveals the runtime and removes the static projection once;
5. stylesheet failure or timeout still releases the static overlay.

The static and runtime shells must use the same geometry sources. The package
coordinates lifecycle; it cannot make two independently styled tab bars match.

## 1. Install and create the sentinel

```sh
pnpm add -D @fullstack-webapp/document-shell@beta
```

Replace the checked-in `index.html` with only the Vite module entry and the
`data-document-shell-entry` marker:

```html
<!doctype html>
<script type="module" src="/src/main.tsx" data-document-shell-entry></script>
```

The plugin rejects additional elements in this template. Move all head and
body contributions into the renderer instead of depending on placeholder
replacement or transform order between two document owners.

## 2. Build the composition

Create a build-only module such as `document-shell.config.ts`. Its one
`render(context)` function returns:

- `document`: language, title, head fragments, application entry, and mount ID;
- `shell`: inert HTML plus all CSS needed for the first paint; and
- optional `startupEffects`: parser-inline scripts before paint and inert HTML
  probes after the static shell.

Use the branded constructors at trust boundaries:

```ts
import {
  cssText,
  htmlFragment,
  inlineScript,
  type DocumentShellComposition,
} from '@fullstack-webapp/document-shell'

const composition: DocumentShellComposition = {
  document: {
    lang: 'en',
    title: 'Example',
    head: [
      htmlFragment(
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      ),
      htmlFragment('<link rel="manifest" href="/manifest.webmanifest">'),
    ],
    appEntry: '/src/main.tsx',
    mountId: 'root',
  },
  shell: {
    html: htmlFragment(
      '<div data-document-shell-static="true" aria-hidden="true">Loading</div>',
    ),
    criticalCss: [cssText('[data-document-shell-static] { position: fixed; inset: 0; }')],
  },
  startupEffects: {
    beforePaint: [
      {
        marker: 'data-example-theme-bootstrap',
        script: inlineScript(
          "document.documentElement.dataset.theme = localStorage.getItem('theme') ?? 'light'",
        ),
      },
    ],
  },
}
```

Keep scripts small and deterministic. A `beforePaint` effect is parser-blocking
by design; it must not fetch, import a runtime module, or wait for the framework.
The marker must be a `data-*` attribute and is included in final HTML for audit.

The package escapes attributes, text, closing `style` tags, and closing
`script` tags at the compiler boundary. The branded constructors identify
trusted build output; they are not HTML sanitizers for untrusted user content.

## 3. Render consumer-owned structure

The renderer may call any build-time tool. For example, a React application can
use `renderToStaticMarkup()` for the projection while the package remains
React-free:

```tsx
const shellHtml = htmlFragment(
  renderToStaticMarkup(
    <AppChrome inertForDocumentShell activePath="/notes" />,
  ),
)
```

Prefer shared inputs over copied output:

- read navigation from the same route model used by the runtime;
- render the same simple SVG brand mark inline;
- compile critical colors and metrics from the active design recipe;
- derive active navigation from `location.pathname` in a tiny before-paint
  effect, or render no active item when a stable answer is unavailable; and
- keep content route-neutral unless the route can be inferred without request
  data.

The projection should be non-interactive and `aria-hidden="true"`. It exists to
cover startup, not to create a second application that needs hydration.

## 4. Configure Vite

```ts
import { documentShell } from '@fullstack-webapp/document-shell/vite'
import { defineConfig } from 'vite'

import { renderDocumentShell } from './document-shell.config.ts'

export default defineConfig({
  plugins: [
    ...documentShell({
      render: renderDocumentShell,
      runtimeHandoff: true,
      validateFinalDocument(html, context) {
        if (context.mode === 'production' && html.includes('data-startup-probe')) {
          throw new Error('Production document contains a diagnostics marker')
        }
      },
    }),
  ],
})
```

Keep the returned plugin array together. The first plugin replaces the
sentinel before downstream HTML transforms; the optional handoff plugin defers
the runtime stylesheet; the final plugin validates the emitted `index.html`.

`validateFinalDocument` is the consumer's final policy gate. Use it for
application-specific invariants such as keeping probe code out of production.
It receives the final HTML and `{ command, mode }` after Vite transforms.

## 5. Place the framework commit hook

Call `commitDocumentShellRuntime()` only after the real, persistent application
chrome and its route fallback have committed. In React, a component mounted
inside that chrome can use `useLayoutEffect`:

```tsx
import { commitDocumentShellRuntime } from '@fullstack-webapp/document-shell/client'
import { useLayoutEffect } from 'react'

export function DocumentShellHandoff() {
  useLayoutEffect(() => {
    void commitDocumentShellRuntime()
  }, [])

  return null
}
```

The function is document-scoped and idempotent. Strict Mode remounts receive
the same promise. Do not add cleanup that restores the static shell, and do not
duplicate stylesheet listeners, readiness attributes, or timers in the app.

The resolved result records whether the runtime stylesheet was `loaded`,
`error`, `timeout`, or `absent`. Every result is a revealed state. Error and
timeout are fail-open outcomes, not thrown errors.

## 6. Keep static and runtime geometry identical

The most common integration defect is not lifecycle; it is two shells using
slightly different metrics. Share the inputs that affect first-frame geometry:

- font family, font size, weight, line height, and text color;
- icon SVG, view box, stroke width, and icon slot dimensions;
- navigation padding, border, background, active surface, and active color;
- tab-bar height and safe-area expression;
- desktop rail/sidebar widths and responsive breakpoint; and
- brand SVG and its rendered box.

Critical CSS must be fully inline. With `runtimeHandoff: true`, the application
may emit exactly one extracted stylesheet. A second `<link rel="stylesheet">`
is ambiguous and fails the build rather than risking an incorrectly ordered
handoff.

## 7. Optional safe-area bridge

Some standalone iOS launches expose `env(safe-area-inset-bottom)` later than
the first parser paint. The bridge can reserve package-accepted geometry before
paint and release it after the native inset and viewport tuple stabilize.

The application declares only its DOM effect:

```ts
import { createSafeAreaBridge } from '@fullstack-webapp/document-shell'

const safeAreaBridge = createSafeAreaBridge({
  domEffect: {
    reserveBottomCssVariable: '--startup-safe-area-bottom',
    profileAttribute: 'data-startup-safe-area-profile',
    orientationAttribute: 'data-startup-safe-area-orientation',
    reserveAttribute: 'data-startup-safe-area-reserve',
  },
})

// Inside the returned DocumentShellComposition:
startupEffects: {
  beforePaint: [
    {
      marker: 'data-document-shell-safe-area-bridge',
      script: safeAreaBridge.beforePaint,
    },
  ],
  afterShell: [safeAreaBridge.probeHtml],
}
```

Keep the marker name exactly `data-document-shell-safe-area-bridge`. The final
document gate uses that reserved marker to require `viewport-fit=cover`; a
different marker describes an unrelated startup effect and receives no
safe-area structural validation.

Then consume the variable from both shell implementations:

```css
:root {
  --app-safe-area-bottom: max(
    env(safe-area-inset-bottom),
    var(--startup-safe-area-bottom, 0px)
  );
}

.app-tabbar,
.document-shell__tabbar {
  padding-bottom: var(--app-safe-area-bottom);
}
```

The root entry projects only profiles whose package-owned rollout is
`sharedDefault`. The current beta may therefore emit an empty catalog on an
ordinary consumer. This is intentional fail-open behavior, not a configuration
error. Consumers cannot pass a model name, reserve value, maturity, or rollout
policy. Promotion happens in the package after evidence review.

`@fullstack-webapp/document-shell/reference` temporarily contains the source
application's `referenceProduction` profiles so migration can preserve its
already verified behavior without silently enabling those provisional values
for every consumer. New applications should not import that subpath. It exits
after those profiles are promoted or retired and the source application can use
the root entry.

When a reserve matches, the bridge writes the declared CSS variable before
paint. It removes the reserve after the native inset reaches the profile floor
and remains stable with the viewport for two frames. Sampling ends after three
seconds; unresolved reserve remains to avoid a late downward jump, while a
lightweight orientation watcher can still release stale portrait state.

## 8. Verify the integration

Run package and application checks:

```sh
pnpm build
pnpm test
pnpm typecheck
```

Inspect the built `dist/index.html` rather than only the source template. It
must contain:

- the static shell and inline critical style;
- no `data-document-shell-entry` sentinel;
- one link with `id="runtime-stylesheet"`, `rel="preload"`, and `as="style"`;
- one `data-document-shell-runtime-stylesheet="true"` bootstrap; and
- the transformed application module entry.

Test the resource gate by delaying or blocking the application module and
stylesheet. The static shell must paint first. Then restore resources and
confirm the runtime replaces it without geometry or color movement. Separately
force stylesheet error and timeout paths; neither may leave an overlay.

Browser automation can verify HTML structure, resource ordering, DOM handoff,
and geometry. It cannot prove the iOS splash-screen boundary or the timing of a
real `env()` transition. Any safe-area profile promotion should retain a real
device launch recording plus a page trace on one aligned timeline.

## Common failures

### `template must contain only its module-entry sentinel`

The checked-in `index.html` still contains metadata or body content. Move it to
the composition renderer.

### `requires exactly one viewport meta` or `manifest link`

The renderer omitted a required node or another Vite plugin injected a second
one. Keep one document owner and inspect the final plugin pipeline.

### `requires exactly one stylesheet link`

Runtime handoff found zero or multiple extracted stylesheets. Import one main
application stylesheet, keep startup CSS inline, and avoid external stylesheet
links in `document.head` while this beta limitation applies.

### The shell disappears into an unstyled application

The commit hook is mounted too early, or a consumer reimplemented the handoff.
Place it inside the persistent runtime shell and call only
`commitDocumentShellRuntime()`.

### Icons, labels, active state, or tab-bar height still move

The static and runtime shells do not share all geometry inputs. Compare font
metrics, SVG boxes, padding, colors, responsive regime, and safe-area variables
rather than adding delay to the handoff.

### Safe-area reserve is inactive

No `sharedDefault` profile matched the observable runtime signature. This is
the safe failure mode. Capture evidence before proposing a package profile; do
not hard-code an application-side model table.

### A diagnostics marker appears in production

Make probe inclusion mode-dependent and add a `validateFinalDocument` rejection
for its unique markers. Diagnostics are a consumer build, not part of the
Document Shell production runtime.
