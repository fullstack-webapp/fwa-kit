# Releasing

FWA Kit packages use independent versions. Each package has its own tag prefix and package directory:

| Package | Tag prefix | Directory |
| --- | --- | --- |
| `@fullstack-webapp/local-edge` | `local-edge@` | `packages/local-edge` |
| `@fullstack-webapp/document-shell` | `document-shell@` | `packages/document-shell` |

Tags use the form `<prefix>@<version>`, for example [`local-edge@0.1.0-beta.1`](https://github.com/fullstack-webapp/fwa-kit/releases/tag/local-edge%400.1.0-beta.1). The prefix is the allowlisted package key used by the prepare and publish workflows and by `scripts/validate-release.mjs`. Both packages publish with `--tag beta` and public npm access with provenance.

Publishing is tag-driven through `.github/workflows/publish.yml` and the protected GitHub Environment `npm-publish`. The workflow accepts only the `local-edge@*` and `document-shell@*` tag prefixes, maps the tag to exactly one allowlisted package, grants only `contents: read` and `id-token: write`, requires a maintainer environment approval, verifies the tag against the package version and the current `main` revision, reruns the complete public matrix (`pnpm run ci`), and publishes only the mapped package directory.

Releases authenticate only through the npm trusted publisher for `fullstack-webapp/fwa-kit`, workflow `publish.yml`, environment `npm-publish`, and the `npm publish` action. Publishing access requires two-factor authentication and disallows traditional tokens. GitHub Packages credentials, npm tokens, and package publishing from the general CI workflow remain out of scope. The release lane does not broaden credentials, permissions, environments, or publication authority: both packages share the existing `npm-publish` environment and the existing full `pnpm run ci` gate.

Local Edge's first publish established both `beta` and `latest` at `0.1.0-beta.1`. Each package owns its npm dist-tags independently. A first publish through this workflow establishes `beta`; moving `latest` is a separate explicit release decision and must not be inferred from `--tag beta`.

Before a release is enabled:

1. Confirm the package version and tag agree.
2. Run `pnpm run ci` from the tagged source revision.
3. Verify the actual package tarball and an isolated consumer built from that tarball.
4. Publish only the mapped package directory with public npm access.
5. Confirm npm provenance and anonymous installation, then record the published version, tag, package URL, and workflow evidence in the GitHub release.

## Prepare a release

Start from the protected default branch with the **Prepare release** workflow. Choose the package (`local-edge` or `document-shell`) and the exact next version. The workflow uses the repository-scoped release bot to reject an invalid or non-incrementing claim, an existing branch or tag, and a version already present in npm. It then creates a release branch and pull request containing only the package version claim:

- Branch: `release/<prefix>-<version>`, for example `release/local-edge-0.1.0-beta.4` or `release/document-shell-0.1.0-beta.2`
- Tag: `<prefix>@<version>`, for example `local-edge@0.1.0-beta.4` or `document-shell@0.1.0-beta.2`

The release PR triggers the normal repository CI and still needs its normal review and approval; it does not publish, tag, or update consumers.

After the release PR has merged, create a release tag only from the current protected `main` revision:

```bash
git tag -a local-edge@<version> -m "Release @fullstack-webapp/local-edge <version>"
git push origin local-edge@<version>
```

```bash
git tag -a document-shell@<version> -m "Release @fullstack-webapp/document-shell <version>"
git push origin document-shell@<version>
```

The tag push starts the publish workflow. Do not create the GitHub release until npm publication and anonymous installation have both succeeded.

The source on the default branch remains the release authority. Generated SDK bundles are package artifacts and are not committed to the repository.
