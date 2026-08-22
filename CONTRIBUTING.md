# Contributing

FWA Kit accepts focused issues and pull requests against the current public contracts.

## Local verification

Use Node.js 24 and pnpm 11.1.1, then run:

```bash
pnpm install --frozen-lockfile
pnpm run ci
```

For a faster package-only loop:

```bash
pnpm --filter @fullstack-webapp/local-edge typecheck
pnpm --filter @fullstack-webapp/local-edge test
```

For browser behavior changes, run `pnpm e2e` with the existing Playwright parallelism. Use `pnpm test:hosting` for changes to generated assets, headers, navigation fallback, or Pages configuration.

## Repository boundaries

- Root files own workspace orchestration, repository policy, and CI.
- `packages/local-edge/` owns the public package, runtime contracts, package tests, and tarball contents.
- `apps/local-edge-demo/` owns the React demo, hosting contract, and end-to-end tests.
- The demo must consume package exports. Relative imports or deep imports into `packages/local-edge/src/` are not accepted.
- Generated `dist/` and `dist-sdk/` output is not committed.

`pnpm test:packed-consumer` packs the actual package tarball and builds an isolated temporary consumer. Package export and tarball changes should not be accepted from workspace-only evidence.

Pull requests should describe the behavior change, preserved behavior, risk boundary, and commands used for verification. Public API, serialized contract, security-boundary, or release-process changes require maintainer review.
