# Local Edge demo

This application demonstrates and verifies FWA Local Edge with React and Vite. It covers code-release installation, weak-network startup, updates, recovery, explicit request ownership, diagnostics, hosting behavior, and browser lifecycle tests.

It is not a reference application for the complete Fullstack Web App architecture. Authentication, business domains, data authority, backend adapters, and production deployment policy remain outside this demo.

## Run locally

From the repository root:

```bash
pnpm dev
```

The Service Worker integration is only enabled in a production build:

```bash
pnpm build
pnpm --filter @fullstack-webapp/local-edge-demo preview
```

Run the browser and hosting contracts with:

```bash
pnpm e2e
pnpm test:hosting
```

The app consumes `@fullstack-webapp/local-edge/vite` and `@fullstack-webapp/local-edge/client`. It must not import package source files directly.
