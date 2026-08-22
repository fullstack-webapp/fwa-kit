# Releasing

FWA Kit packages use independent versions. The Local Edge tag format is:

```text
local-edge@<version>
```

For example: `local-edge@0.1.0-beta.1`.

Publishing is not enabled during the repository bootstrap. The first public beta must add npm trusted publishing through a protected GitHub Environment with a maintainer review gate. Long-lived npm tokens, GitHub Packages credentials, and package publishing from the general CI workflow are out of scope.

Before a release is enabled:

1. Confirm the package version and tag agree.
2. Run `pnpm ci` from the tagged source revision.
3. Verify the actual package tarball and an isolated consumer built from that tarball.
4. Publish only `packages/local-edge/` with public npm access.
5. Record the published version, tag, and CI evidence in the GitHub release.

The source on the default branch remains the release authority. Generated SDK bundles are package artifacts and are not committed to the repository.
