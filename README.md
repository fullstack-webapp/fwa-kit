# FWA Kit

FWA Kit is the open-source home for reusable Fullstack Web App building blocks. Its first package, **FWA Local Edge**, lets a static web application prepare and activate complete browser-side code releases while keeping request ownership explicit and recovery network-resilient.

Local Edge places a device-local edge between the document and the network. It does not move application authentication, business authority, secrets, or backend data into the browser.

## Packages

| Package | Purpose | Executable demo |
| --- | --- | --- |
| [`@fullstack-webapp/local-edge`](packages/local-edge/README.md) | Framework-neutral Local Edge integration for Vite applications | [`local-edge-demo`](apps/local-edge-demo/README.md) |

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
| Integrate the package | [`@fullstack-webapp/local-edge`](packages/local-edge/README.md) |
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

Packages use independent versions and tags in the form `local-edge@<version>`. Tag-driven npm trusted publishing is documented in [`docs/releasing.md`](docs/releasing.md).

## Contributing

FWA Kit is not yet accepting external pull requests. Questions, bug reports, and integration feedback are welcome through [GitHub Issues](https://github.com/fullstack-webapp/fwa-kit/issues). If an external contribution could help, open an Issue first; this guide will be updated when the project is ready to accept pull requests.

- Maintainer and agent source map: [`AGENTS.md`](AGENTS.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Source provenance: [`PROVENANCE.md`](PROVENANCE.md)
- License: [MIT](LICENSE)

## License

[MIT](LICENSE) © 2026 Zou Guoqing
