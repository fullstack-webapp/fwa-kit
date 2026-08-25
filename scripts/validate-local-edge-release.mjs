import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

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

export function assertNextReleaseVersion({ currentVersion, targetVersion }) {
  parseVersion(currentVersion)
  parseVersion(targetVersion)

  if (compareVersions(targetVersion, currentVersion) <= 0) {
    throw new Error(
      `Target version ${targetVersion} must be greater than the current ${currentVersion}.`,
    )
  }
}

async function main() {
  const [targetVersion] = process.argv.slice(2)
  if (!targetVersion) {
    throw new Error('Usage: node scripts/validate-local-edge-release.mjs <target-version>')
  }

  const packageJson = JSON.parse(
    await readFile(new URL('../packages/local-edge/package.json', import.meta.url), 'utf8'),
  )

  assertNextReleaseVersion({
    currentVersion: packageJson.version,
    targetVersion,
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
