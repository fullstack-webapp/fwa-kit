# FWA Kit

FWA Kit is the open-source home for reusable Fullstack Web App building blocks. It currently provides a parser-visible startup shell for smooth first paint and a browser-side Local Edge for atomic code releases and network-resilient recovery.

Both packages stay below application policy. Document Shell does not own route content or interaction, and Local Edge does not move authentication, business authority, secrets, or backend data into the browser.

## Packages

| Package | Purpose | Executable demo |
| --- | --- | --- |
| [`@fullstack-webapp/document-shell`](packages/document-shell/README.md) | Build-time document projection and framework-neutral runtime handoff for a stable first screen | Isolated packed Vite consumer in CI; application demo remains a later package consumer |
| [`@fullstack-webapp/local-edge`](packages/local-edge/README.md) | Framework-neutral Local Edge integration for Vite applications | [`local-edge-demo`](apps/local-edge-demo/README.md) |

### FWA Document Shell

`@fullstack-webapp/document-shell` compiles an application-owned static shell
into Vite's final `index.html`, keeps it visible while framework resources load,
and removes it after the real application shell commits. It is build-time
projection rather than SSR: the consumer retains its renderer, markup, critical
CSS, manifest values, and framework lifecycle.

```sh
pnpm add -D @fullstack-webapp/document-shell@beta
```

Start with the [package README](packages/document-shell/README.md), then follow
the [file-by-file integration guide](packages/document-shell/docs/integration.md).

### FWA Local Edge

`@fullstack-webapp/local-edge` provides:

- a build integration that validates one application configuration and builds the app, loader, and Service Worker entries;
- a same-origin loader and client facade for update, recovery, and release-state UI;
- a Service Worker runtime that verifies a complete candidate release before activation; and
- a release publisher that writes the release descriptor and hosting metadata after the Vite bundles exist.

Install the current public prerelease:

```sh
pnpm add -D @fullstack-webapp/local-edge
```

The package README has the integration example, public API, configuration, guarantees, and version-specific npm link. Its [`local-edge-demo`](apps/local-edge-demo/README.md) is the executable React integration and Chromium behavior matrix.

## What it guarantees — and does not

- A candidate release becomes active only after every declared asset passes origin, redirect, media-type, size, and digest checks.
- A failed candidate does not replace the last known good release; existing documents remain pinned to the release they loaded.
- The runtime intercepts only declared control paths, release assets, and navigation ownership. Application APIs, unknown requests, and cross-origin requests retain browser network semantics.
- The network entry remains independently runnable. `localEdgeEnabled: false` is a reversible network-only release policy, not an unregister operation.
- Local Edge is not a complete application architecture. Authentication, domain rules, data authority, backend adapters, and production deployment policy remain with the consuming application.

The project is in pre-release development. Public APIs and serialized contracts may change before the first stable release. The automated browser support claim currently covers Chromium, not Firefox or Safari.

## Documentation and verification

| Need | Entry |
| --- | --- |
| Integrate Local Edge | [`@fullstack-webapp/local-edge`](packages/local-edge/README.md) |
| Remove startup white frames with a parser-visible shell | [`@fullstack-webapp/document-shell`](packages/document-shell/README.md) |
| Connect Document Shell file by file | [Document Shell integration guide](packages/document-shell/docs/integration.md) |
| Understand runtime owners and dependency direction | [Architecture](packages/local-edge/docs/architecture.md) |
| Configure build-time paths and host ownership | [Configuration contract](packages/local-edge/docs/config-contract.md) |
| Understand the loader, client facade, navigation, or request ownership | [Package documentation](packages/local-edge/README.md#documentation) |
| Run the executable integration | [`local-edge-demo`](apps/local-edge-demo/README.md) |
| Verify a local checkout | [`AGENTS.md`](AGENTS.md#validation) |
| Release a package | [Releasing](docs/releasing.md) |

Use Node.js 24 and pnpm 11.1.1 for a local checkout:

```sh
pnpm install --frozen-lockfile
pnpm run ci
```

`pnpm run ci` is the public verification matrix used by pull requests. It runs linting, type checks, package tests, Chromium lifecycle tests, hosting checks, package-content checks, and an isolated packed consumer. Repository CI has read-only permissions and does not publish packages or deploy the demo.

Packages use independent versions and tags in the form `<package-slug>@<version>`, currently `local-edge@<version>` and `document-shell@<version>`. Tag-driven npm trusted publishing is documented in [`docs/releasing.md`](docs/releasing.md).

## Contributing

FWA Kit is not yet accepting external pull requests. Questions, bug reports, and integration feedback are welcome through [GitHub Issues](https://github.com/fullstack-webapp/fwa-kit/issues). If an external contribution could help, open an Issue first; this guide will be updated when the project is ready to accept pull requests.

- Maintainer and agent source map: [`AGENTS.md`](AGENTS.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Source provenance: [`PROVENANCE.md`](PROVENANCE.md)
- License: [MIT](LICENSE)

## License

[MIT](LICENSE) © 2026 Zou Guoqing
