import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const packageMetadata = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)

export function verifyReleaseTag(tagName, metadata = packageMetadata) {
  const expectedTag = `local-edge@${metadata.version}`
  if (tagName !== expectedTag) {
    throw new Error(
      `release tag ${JSON.stringify(tagName)} does not match ${expectedTag}`,
    )
  }
  return expectedTag
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tagName = process.argv[2] ?? process.env.GITHUB_REF_NAME
  console.log(`Verified release tag ${verifyReleaseTag(tagName)}`)
}
