# FWA Kit · Agent Guide

FWA Kit is the public home for reusable Fullstack Web App building blocks. The root README is the technical-product entry; this file is the engineering entry for maintainers and coding agents.

## Start here

- Package purpose, installation, support boundary, and repository verification: [`README.md`](README.md)
- Document Shell positioning, API, integration, and limits: [`packages/document-shell/README.md`](packages/document-shell/README.md) and [`packages/document-shell/docs/integration.md`](packages/document-shell/docs/integration.md)
- Local Edge API, configuration, guarantees, and package-specific documents: [`packages/local-edge/README.md`](packages/local-edge/README.md)
- Runtime owners and dependency direction: [`packages/local-edge/docs/architecture.md`](packages/local-edge/docs/architecture.md)
- Release authority, tag policy, and trusted publishing boundary: [`docs/releasing.md`](docs/releasing.md)
- Demo behavior, local use, and browser evidence: [`apps/local-edge-demo/README.md`](apps/local-edge-demo/README.md)

## Repository map

| Path | Scope |
| --- | --- |
| `packages/document-shell/` | The publishable Document Shell package: parser-visible document compiler, Vite HTML pipeline, runtime handoff, package-owned safe-area catalog, tests, and onboarding documentation. |
| `packages/local-edge/` | The publishable Local Edge package: Vite integration, loader and client facade, Service Worker kernel, release publisher, contracts, package tests, and package contents. |
| `apps/local-edge-demo/` | The executable demo for `@fullstack-webapp/local-edge`: React integration, Pages hosting contract, and Chromium end-to-end evidence. |
| `docs/releasing.md` | Tag-driven trusted publishing procedure and release evidence boundary. |
| Root files | Workspace orchestration, CI, public policy, provenance, and repository-level documentation. |

## Boundary rules

- Document Shell consumers use only its declared root, `./vite`, and `./client` exports. `./reference` preserves the reference application's accepted safe-area rollout during extraction; it is not a general consumer selector.
- Document Shell owns compilation, transform ordering, final structural gates, runtime handoff, and profile acceptance. The consumer owns shell markup, critical CSS, global DOM-effect names, framework commit timing, manifest values, splash assets, and diagnostics.
- Keep the public root's safe-area projection restricted to `sharedDefault`. A physical migration must not promote `referenceProduction` profiles or expose maturity/rollout choice as application configuration.
- Applications consume only `@fullstack-webapp/local-edge/vite` and `@fullstack-webapp/local-edge/client`. The package's loader and worker sources are bundled for consumers but are not deep-import APIs.
- The package owns release verification, request interception, and Local Edge storage. A consuming application owns its business routes, APIs, authentication, data authority, and enablement policy.
- The demo must consume published package exports; it must not use relative or deep imports into `packages/local-edge/src/`.
- Serialized configuration, loader, navigation, and release contracts are public compatibility surfaces. Update their canonical documents and focused tests with any intentional change.
- Do not add publishing tokens or other credentials. Publishing is tag-driven, uses npm trusted publishing, and requires the protected `npm-publish` environment.
- Generated `dist/` and `dist-sdk/` outputs are package artifacts and are not committed.

## Validation

Use Node.js 24 and pnpm 11.1.1.

```sh
pnpm install --frozen-lockfile
pnpm run ci
```

Choose the smallest sufficient verification while working, then run the relevant broader check before handoff:

- Package logic or public contracts: `pnpm test` and `pnpm typecheck`.
- Document Shell package boundary: `pnpm --filter @fullstack-webapp/document-shell build`, `test`, `pack:check`, and `test:packed-consumer`.
- Built assets, package exports, or tarball contents: `pnpm pack:check` and `pnpm test:packed-consumer`.
- Loader, Service Worker, navigation, or document lifecycle: `pnpm e2e`.
- Generated assets, headers, navigation fallback, or Pages configuration: `pnpm test:hosting`.
- Public API, serialized contract, release, or publishing changes: `pnpm run ci`.

## Documentation and feedback

Keep the root README as the product and integration entry. Keep durable runtime boundaries in the package documents; do not turn this file into a second architecture or release guide.

The repository is not yet accepting external pull requests. GitHub Issues are the current channel for questions, bugs, and integration feedback.
