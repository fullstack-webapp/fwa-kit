import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const packageRoot = path.resolve(import.meta.dirname, '..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const node = process.platform === 'win32' ? 'node.exe' : 'node'
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'document-shell-packed-consumer-'))

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options?.cwd ?? packageRoot,
    stdio: 'pipe',
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`[document-shell] command failed: ${command} ${args.join(' ')}`)
  }
  return result.stdout.trim()
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[document-shell] packed consumer assertion failed: ${message}`)
  }
}

async function resolveTarball() {
  run(
    pnpm,
    ['pack', '--pack-destination', temporaryRoot],
    { cwd: packageRoot },
  )
  const tarballs = (await readdir(temporaryRoot)).filter((name) => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`[document-shell] pnpm pack produced ${tarballs.length} tarballs`)
  }
  return path.resolve(temporaryRoot, tarballs[0])
}

try {
  const tarball = await resolveTarball()
  const consumerRoot = path.join(temporaryRoot, 'consumer')
  await mkdir(path.join(consumerRoot, 'src'), { recursive: true })

  await writeFile(
    path.join(consumerRoot, 'package.json'),
    JSON.stringify({
      name: 'document-shell-packed-consumer',
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: {
        '@fullstack-webapp/document-shell': `file:${tarball}`,
        vite: '^8.0.12',
      },
    }, null, 2),
  )

  await writeFile(
    path.join(consumerRoot, 'index.html'),
    '<!doctype html><script type="module" src="/src/main.ts" data-document-shell-entry></script>',
  )

  const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />'
  const manifest = '<link rel="manifest" href="/manifest.webmanifest" />'
  const criticalCss = '#document-shell { position: fixed; inset: 0; }'
  const viewportLink = '<link rel="preload" href="/apple-touch-icon.png" as="image" />'

  await writeFile(
    path.join(consumerRoot, 'vite.config.mjs'),
    `import { documentShell } from '@fullstack-webapp/document-shell/vite'\n` +
    `import { htmlFragment, cssText } from '@fullstack-webapp/document-shell'\n` +
    `import { createSafeAreaBridge } from '@fullstack-webapp/document-shell'\n` +
    `import { defineConfig } from 'vite'\n` +
    `\n` +
    `export default defineConfig({\n` +
    `  plugins: [\n` +
    `    ...documentShell({\n` +
    `      runtimeHandoff: true,\n` +
    `      render() {\n` +
    `        return {\n` +
    `          document: {\n` +
    `            lang: 'en',\n` +
    `            title: 'Packed Document Shell Consumer',\n` +
    `            head: [\n` +
    `              htmlFragment(${JSON.stringify(viewport)}),\n` +
    `              htmlFragment(${JSON.stringify(manifest)}),\n` +
    `              htmlFragment(${JSON.stringify(viewportLink)}),\n` +
    `            ],\n` +
    `            appEntry: '/src/main.ts',\n` +
    `            mountId: 'app-root',\n` +
    `          },\n` +
    `          shell: {\n` +
    `            html: htmlFragment('<div id="document-shell" data-document-shell-static="true" aria-hidden="true">Loading</div>'),\n` +
    `            criticalCss: [cssText(${JSON.stringify(criticalCss)})],\n` +
    `          },\n` +
    `          startupEffects: {\n` +
    `            beforePaint: [\n` +
    `              { marker: 'data-document-shell-safe-area-bridge', script: createSafeAreaBridge({\n` +
    `                domEffect: {\n` +
    `                  reserveBottomCssVariable: '--consumer-safe-area-bottom',\n` +
    `                  reserveAttribute: 'data-consumer-safe-area-reserve',\n` +
    `                },\n` +
    `              }).beforePaint },\n` +
    `            ],\n` +
    `          },\n` +
    `        }\n` +
    `      },\n` +
    `    }),\n` +
    `  ],\n` +
    `})\n` +
    `\n`
  )

  await writeFile(
    path.join(consumerRoot, 'src', 'main.ts'),
    `import { commitDocumentShellRuntime } from '@fullstack-webapp/document-shell/client'\n` +
    `import './styles.css'\n` +
    `\n` +
    `document.querySelector('#app-root')?.setAttribute('data-mounted', 'true')\n` +
    `void commitDocumentShellRuntime()\n` +
    `\n`
  )
  await writeFile(
    path.join(consumerRoot, 'src', 'styles.css'),
    '#app-root { color: rgb(1 2 3); }\n',
  )

  run(pnpm, ['install', '--prefer-offline', '--ignore-scripts', '--ignore-workspace'], {
    cwd: consumerRoot,
  })
  run(pnpm, ['exec', 'vite', 'build'], { cwd: consumerRoot })

  const indexAsset = path.join(consumerRoot, 'dist', 'index.html')
  const rebuiltIndex = await readFile(indexAsset, 'utf8')
  assert(rebuiltIndex.includes('id="runtime-stylesheet"'), 'final index lacks the deferred runtime stylesheet id')
  assert(rebuiltIndex.includes('data-document-shell-runtime-stylesheet="true"'), 'final index lacks the runtime stylesheet bootstrap')
  assert(rebuiltIndex.includes('data-document-shell-static="true"'), 'final index lacks the static shell marker')
  assert(!rebuiltIndex.includes('data-document-shell-entry'), 'final index still contains the template marker')

  run(node, ['--input-type=module', '-e', packedNodeImportCheck()], { cwd: consumerRoot })
  console.log('[document-shell] packed consumer smoke passed')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

function packedNodeImportCheck() {
  return `
import assert from 'node:assert/strict'
import * as root from '@fullstack-webapp/document-shell'
import * as client from '@fullstack-webapp/document-shell/client'
import * as reference from '@fullstack-webapp/document-shell/reference'
import * as vite from '@fullstack-webapp/document-shell/vite'
assert.equal(typeof root.compileDocumentShell, 'function')
assert.equal(typeof root.createSafeAreaBridge, 'function')
assert.equal(typeof client.commitDocumentShellRuntime, 'function')
assert.equal(typeof reference.createReferenceSafeAreaBridge, 'function')
assert.equal(typeof vite.documentShell, 'function')
console.log('[document-shell] packed node import smoke passed')
`
}
