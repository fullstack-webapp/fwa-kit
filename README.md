# FWA Kit

FWA Kit is the open-source home for reusable Fullstack Web App building blocks.

The first package is **FWA Local Edge**: a browser-side runtime for atomic web app code releases, explicit request ownership, network-resilient startup, updates, and recovery. It places a device-local edge between the page and the network without moving business authority, secrets, or backend responsibilities into the browser.

This repository is in pre-release development. Public APIs and serialized contracts may change before the first stable release.

## Workspaces

| Workspace | Purpose |
| --- | --- |
| [`@fullstack-webapp/local-edge`](packages/local-edge/README.md) | Framework-neutral Vite integration, loader, Service Worker runtime, release publisher, and client facade |
| [`local-edge-demo`](apps/local-edge-demo/README.md) | Executable React demo, hosting contract, and Chromium behavior matrix |

The demo validates Local Edge integration. It is not a reference architecture for a complete FWA application and does not prescribe authentication, domain, data, or backend boundaries.

## Development

Requirements: Node.js 24 and pnpm 11.1.1.

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
pnpm test:hosting
pnpm pack:check
pnpm test:packed-consumer
```

`pnpm run ci` runs the public verification matrix used by pull requests. The explicit `run` is required because `pnpm ci` is pnpm's clean-install alias. Repository CI has read-only permissions and does not publish packages or deploy the demo.

Package releases use independent versions and tags in the form `local-edge@<version>`. Publishing is intentionally outside the current bootstrap and is documented in [`docs/releasing.md`](docs/releasing.md).

## Project policy

- Contribution workflow: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Source provenance: [`PROVENANCE.md`](PROVENANCE.md)
- License: [MIT](LICENSE)

## License

[MIT](LICENSE) © 2026 Zou Guoqing
