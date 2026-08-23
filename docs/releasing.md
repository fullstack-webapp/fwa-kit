# Releasing

FWA Kit packages use independent versions. The Local Edge tag format is:

```text
local-edge@<version>
```

The first public beta is `local-edge@0.1.0-beta.1`.

Publishing is tag-driven through `.github/workflows/publish.yml` and the protected GitHub Environment `npm-publish`. The workflow grants only `contents: read` and `id-token: write`, requires a maintainer environment approval, verifies the tag against the package version and the current `main` revision, reruns the complete public matrix, and publishes only `packages/local-edge/`.

The package does not exist in the npm registry before the first beta, so npm cannot yet attach a trusted publisher through package settings. The first publish uses a short-lived granular token stored only as the `NPM_TOKEN` environment secret. After that publish:

1. Configure the package trusted publisher for `fullstack-webapp/fwa-kit`, `publish.yml`, environment `npm-publish`, and the `npm publish` action.
2. Set publishing access to require two-factor authentication and disallow traditional tokens.
3. Delete the `NPM_TOKEN` environment secret and remove its workflow fallback.

Subsequent releases authenticate only through npm trusted publishing. GitHub Packages credentials, repository-level npm tokens, and package publishing from the general CI workflow remain out of scope.

Before a release is enabled:

1. Confirm the package version and tag agree.
2. Run `pnpm run ci` from the tagged source revision.
3. Verify the actual package tarball and an isolated consumer built from that tarball.
4. Publish only `packages/local-edge/` with public npm access.
5. Confirm npm provenance and anonymous installation, then record the published version, tag, package URL, and workflow evidence in the GitHub release.

Create a release tag only from the current protected `main` revision:

```bash
git tag local-edge@0.1.0-beta.1
git push origin local-edge@0.1.0-beta.1
```

The tag push starts the publish workflow. Do not create the GitHub release until npm publication and anonymous installation have both succeeded.

The source on the default branch remains the release authority. Generated SDK bundles are package artifacts and are not committed to the repository.
