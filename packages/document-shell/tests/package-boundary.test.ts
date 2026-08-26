import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const packageRoot = path.resolve(import.meta.dirname, '..')

test('package source stays framework-neutral and independent from consumer hosts', async () => {
  const sourceFiles = (await readdir(path.join(packageRoot, 'src'))).filter((file) =>
    file.endsWith('.ts'),
  )
  const source = await Promise.all(
    sourceFiles.map((file) =>
      readFile(path.join(packageRoot, 'src', file), 'utf8'),
    ),
  )
  const imports = source.join('\n')

  assert.doesNotMatch(imports, /from ['"](?:react|react-dom|@tanstack)\b/)
  assert.doesNotMatch(imports, /(?:\.\.\/){2,}(?:src|public)\//)
  assert.doesNotMatch(imports, /@\//)
})
