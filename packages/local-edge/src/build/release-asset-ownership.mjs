export function assertReleaseAssetOwnership(
  assetPaths,
  { appEntry, appRequestPrefixes, loaderPath, releaseAssetPrefixes, supplementalAssetPaths },
) {
  for (const assetPath of assetPaths) {
    if (appRequestPrefixes.some((prefix) => assetPath.startsWith(prefix))) {
      throw new Error(
        `Release asset ${assetPath} overlaps an app request prefix`,
      )
    }
    if (
      assetPath !== appEntry &&
      assetPath !== loaderPath &&
      !supplementalAssetPaths.includes(assetPath) &&
      !releaseAssetPrefixes.some((prefix) => assetPath.startsWith(prefix))
    ) {
      throw new Error(
        `Release asset ${assetPath} is outside the worker interception allowlist`,
      )
    }
  }
}
