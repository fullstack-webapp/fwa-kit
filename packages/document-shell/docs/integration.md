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
pnpm add -D @fullstack-webapp/document-shell
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

### Declare a reveal-not-before deadline (optional)

A projection may reveal part of its content only after a short race with the
runtime, then keep that delayed content visible for a minimum duration. CSS can
delay the delayed content's appearance, but it cannot stop the loaded handoff
from removing the whole projection mid-duration. For that surface the consumer
declares an absolute reveal-not-before deadline on the static projection at the
moment the delayed content actually becomes visible; the loaded handoff then
waits until that deadline before writing the readiness attribute and removing
the projection.

The deadline is a package-owned DOM contract, not a hand-written attribute:

```ts
import {
  commitDocumentShellRuntime,
  documentShellRevealNotBeforeAttribute,
} from '@fullstack-webapp/document-shell/client'
```

The consumer's parser startup effect writes an absolute epoch-millisecond
deadline (`Date.now() + minimumVisibleMs`) into
`documentShellRevealNotBeforeAttribute` on the element carrying
`data-document-shell-static`. Declare it only when the delayed content is
actually visible: when the runtime won the race and the projection was already
revealed, there is nothing to hold, and a later declaration is simply too late.
A minimal runtime effect, composed by the renderer, can look like this:

```ts
import {
  cssText,
  htmlFragment,
  inlineScript,
  type DocumentShellComposition,
} from '@fullstack-webapp/document-shell'
import { documentShellRevealNotBeforeAttribute } from '@fullstack-webapp/document-shell/client'

const revealDelayMs = 150        // surface policy, chosen by the consumer
const minimumVisibleMs = 250     // surface policy, chosen by the consumer

const composition: DocumentShellComposition = {
  // ...
  startupEffects: {
    beforePaint: [
      {
        marker: 'data-reveal-declarer',
        script: inlineScript(`
          (() => {
            const revealDelay = ${revealDelayMs}
            const minimumVisible = ${minimumVisibleMs}
            const selector = '[data-document-shell-static]'
            setTimeout(() => {
              const projection = document.querySelector(selector)
              // Still projected at the reveal-delay boundary means the delayed
              // content is becoming visible now: keep it for its minimum
              // visible duration before the handoff may reveal.
              if (projection) {
                projection.setAttribute(
                  '${documentShellRevealNotBeforeAttribute}',
                  String(Date.now() + minimumVisible),
                )
              }
            }, revealDelay)
          })()
        `),
      },
    ],
  },
}
```

The values shown are examples; the delay and the minimum visible duration are
consumer surface policy and belong to the surface that owns the pending
experience, not to Document Shell.

Semantics:

- Only a normal stylesheet `loaded` handoff can wait for a deadline.
  Stylesheet `error`, `timeout`, and absence keep their immediate fail-open
  reveal and are never blocked by a declaration.
- The package honors a declaration only when it is a finite absolute timestamp,
  strictly after the current time, within the package's three-second defensive
  hold horizon, and no later than the runtime stylesheet gate's recorded
  fail-open deadline (the same absolute deadline that already bounds the whole
  handoff). Every other value — absent, non-numeric, zero,
  negative, `Infinity`, expired, or too far in the future — is treated as
  expired, and the loaded handoff reveals immediately exactly as without a
  declaration.
- The deadline is sampled when the loaded reveal is about to run. A
  declaration that lands while the stylesheet is still loading or between the
  load event and the apply frame is honored; a declaration that lands after the
  reveal already ran cannot resurrect the projection.
- The wait is a package timer with the same cleanup lifecycle as the rest of
  the handoff. Repeated `commitDocumentShellRuntime()` calls return the same
  document-level promise and never create a second timer, and the projection is
  still removed exactly once. The absolute wall-clock deadline is also bounded
  by the monotonic delay accepted when scheduling, so moving the system clock
  backward cannot extend the hold indefinitely.

The bounded rule keeps the existing fail-open guarantee intact: an inert
projection can never outlive the runtime stylesheet gate, so a malformed or
mistaken declaration cannot pin the overlay past the point the package would
otherwise have released it.

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
`sharedDefault`. The current beta includes all four accepted iOS standalone
portrait profiles. Their maturity remains distinct: one is verified and three
are provisional, but all receive the same bounded production rollout because a
wrong startup floor has a low and reversible visual consequence. Unsupported
signatures still fail open. Consumers cannot pass a model name, reserve value,
maturity, or rollout policy; narrowing or promotion happens in the package
after evidence review.

`@fullstack-webapp/document-shell/reference` is a temporary source-compatibility
entry for the reference application. The current catalog has no
`referenceProduction`-only profile, so this subpath projects the same profiles
as the root entry. New applications should not import it; it exits after the
reference application migrates to the root entry.

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

### A delayed projection disappears before its minimum visible duration ends

The delayed content's appearance is timed with CSS, but the loaded handoff
still removes the projection as soon as the stylesheet applied. Declare a
reveal-not-before deadline (see the optional seam above) at the moment the
delayed content becomes visible instead of adding a competing timer in the
framework hook.

### A declared reveal-not-before deadline never seems to hold

The declaration must live on the element carrying `data-document-shell-static`
as `documentShellRevealNotBeforeAttribute`, hold an absolute epoch-millisecond
timestamp inside both the bounded hold horizon and the runtime stylesheet gate,
and land before the loaded reveal runs. A static far-future value in the emitted
HTML is ignored by design so it cannot pin the overlay; declare it from the startup effect when
the delayed content is actually visible.

### Icons, labels, active state, or tab-bar height still move

The static and runtime shells do not share all geometry inputs. Compare font
metrics, SVG boxes, padding, colors, responsive regime, and safe-area variables
rather than adding delay to the handoff.

### Safe-area reserve is inactive

No `sharedDefault` profile matched the observable runtime signature, or the
runtime platform/version/display-mode tuple did not qualify. This is the safe
failure mode. Capture evidence before proposing a package profile; do not
hard-code an application-side model table.

### A diagnostics marker appears in production

Make probe inclusion mode-dependent and add a `validateFinalDocument` rejection
for its unique markers. Diagnostics are a consumer build, not part of the
Document Shell production runtime.
