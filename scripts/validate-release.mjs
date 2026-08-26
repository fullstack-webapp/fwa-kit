import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const releasePackages = Object.freeze({
  'local-edge': Object.freeze({
    packageName: '@fullstack-webapp/local-edge',
    directory: 'packages/local-edge',
  }),
  'document-shell': Object.freeze({
    packageName: '@fullstack-webapp/document-shell',
    directory: 'packages/document-shell',
  }),
})

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/

function parseVersion(version) {
  const match = versionPattern.exec(version)

  if (!match) {
    throw new Error(`Expected a SemVer version without build metadata, got ${JSON.stringify(version)}.`)
  }

  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4]?.split('.') ?? [],
  }
}

function compareIdentifier(left, right) {
  const leftNumber = /^\d+$/.test(left)
  const rightNumber = /^\d+$/.test(right)

  if (leftNumber && rightNumber) {
    if (left.length !== right.length) {
      return left.length - right.length
    }

    return left.localeCompare(right)
  }

  if (leftNumber) {
    return -1
  }

  if (rightNumber) {
    return 1
  }

  return left.localeCompare(right)
}

export function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion)
  const right = parseVersion(rightVersion)

  for (const key of ['major', 'minor', 'patch']) {
    const comparison = compareIdentifier(left[key], right[key])
    if (comparison !== 0) {
      return comparison
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0
  }

  if (left.prerelease.length === 0) {
    return 1
  }

  if (right.prerelease.length === 0) {
    return -1
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]

    if (leftIdentifier === undefined) {
      return -1
    }

    if (rightIdentifier === undefined) {
      return 1
    }

    const comparison = compareIdentifier(leftIdentifier, rightIdentifier)
    if (comparison !== 0) {
      return comparison
    }
  }

  return 0
}

export function resolveReleasePackage(selection) {
  const releasePackage = releasePackages[selection]

  if (!releasePackage) {
    const known = Object.keys(releasePackages).join(', ')
    throw new Error(
      `Unknown release package ${JSON.stringify(selection)}. Expected one of: ${known}.`,
    )
  }

  return releasePackage
}

export function releaseTag(packageKey, version) {
  resolveReleasePackage(packageKey)
  return `${packageKey}@${version}`
}

export function releaseBranch(packageKey, version) {
  resolveReleasePackage(packageKey)
  return `release/${packageKey}-${version}`
}

export function verifyReleaseTag(tagName, packageKey, metadata) {
  const releasePackage = resolveReleasePackage(packageKey)
  if (!metadata?.version) {
    throw new Error(`Missing package metadata for ${releasePackage.packageName}.`)
  }
  const packageVersion = metadata.version
  const expectedTag = `${packageKey}@${packageVersion}`

  if (tagName !== expectedTag) {
    throw new Error(
      `release tag ${JSON.stringify(tagName)} does not match ${expectedTag} for ${releasePackage.packageName}`,
    )
  }

  return expectedTag
}

export function assertNextReleaseVersion({ currentVersion, targetVersion }) {
  parseVersion(currentVersion)
  parseVersion(targetVersion)

  if (compareVersions(targetVersion, currentVersion) <= 0) {
    throw new Error(
      `Target version ${targetVersion} must be greater than the current ${currentVersion}.`,
    )
  }
}

async function readPackageVersion(releasePackage) {
  const packageJsonPath = fileURLToPath(
    new URL(`../${releasePackage.directory}/package.json`, import.meta.url),
  )
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))

  if (packageJson.name !== releasePackage.packageName) {
    throw new Error(
      `Package directory ${releasePackage.directory} declares ${JSON.stringify(packageJson.name)}, expected ${releasePackage.packageName}.`,
    )
  }

  return packageJson.version
}

async function main() {
  const [mode, ...args] = process.argv.slice(2)

  if (mode === 'verify') {
    const [tagName, selection] = args
    if (!tagName || !selection) {
      throw new Error('Usage: node scripts/validate-release.mjs verify <tag> <local-edge|document-shell>')
    }

    const releasePackage = resolveReleasePackage(selection)
    const packageVersion = await readPackageVersion(releasePackage)
    console.log(`Verified release tag ${verifyReleaseTag(tagName, selection, { version: packageVersion })}`)
    return
  }

  const [selection, targetVersion] = [mode, ...args]
  if (!selection || !targetVersion) {
    throw new Error('Usage: node scripts/validate-release.mjs <local-edge|document-shell> <target-version>')
  }

  const releasePackage = resolveReleasePackage(selection)
  const currentVersion = await readPackageVersion(releasePackage)
  assertNextReleaseVersion({
    currentVersion,
    targetVersion,
  })

  console.log(
    `Verified ${releasePackage.packageName} ${targetVersion} is greater than current ${currentVersion}`,
  )
  console.log(`Release branch: ${releaseBranch(selection, targetVersion)}`)
  console.log(`Release tag: ${releaseTag(selection, targetVersion)}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
