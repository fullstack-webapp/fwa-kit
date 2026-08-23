# Releasing

FWA Kit packages use independent versions. The Local Edge tag format is:

```text
local-edge@<version>
```

The first public beta is [`local-edge@0.1.0-beta.1`](https://github.com/fullstack-webapp/fwa-kit/releases/tag/local-edge%400.1.0-beta.1).

Publishing is tag-driven through `.github/workflows/publish.yml` and the protected GitHub Environment `npm-publish`. The workflow grants only `contents: read` and `id-token: write`, requires a maintainer environment approval, verifies the tag against the package version and the current `main` revision, reruns the complete public matrix, and publishes only `packages/local-edge/`.

Releases authenticate only through the npm trusted publisher for `fullstack-webapp/fwa-kit`, workflow `publish.yml`, environment `npm-publish`, and the `npm publish` action. Publishing access requires two-factor authentication and disallows traditional tokens. GitHub Packages credentials, npm tokens, and package publishing from the general CI workflow remain out of scope.

The first publish established both `beta` and `latest` at `0.1.0-beta.1`. A later prerelease must decide explicitly whether the default-install `latest` tag moves with `beta`; publishing with `--tag beta` must not be assumed to update both tags.

Before a release is enabled:

1. Confirm the package version and tag agree.
2. Run `pnpm run ci` from the tagged source revision.
3. Verify the actual package tarball and an isolated consumer built from that tarball.
4. Publish only `packages/local-edge/` with public npm access.
5. Confirm npm provenance and anonymous installation, then record the published version, tag, package URL, and workflow evidence in the GitHub release.

Create a release tag only from the current protected `main` revision:

```bash
git tag -a local-edge@<version> -m "Release @fullstack-webapp/local-edge <version>"
git push origin local-edge@<version>
```

The tag push starts the publish workflow. Do not create the GitHub release until npm publication and anonymous installation have both succeeded.

The source on the default branch remains the release authority. Generated SDK bundles are package artifacts and are not committed to the repository.
