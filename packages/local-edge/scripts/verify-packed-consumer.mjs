import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const consumerRoot = await mkdtemp(join(tmpdir(), 'fwa-kit-packed-consumer-'))

try {
  run('pnpm', ['pack', '--pack-destination', consumerRoot], packageRoot)
  const tarballName = (await readdir(consumerRoot)).find((name) =>
    name.endsWith('.tgz'),
  )
  if (!tarballName) {
    throw new Error('pnpm pack did not produce a tarball')
  }

  await Promise.all([
    writeFile(
      join(consumerRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: 'local-edge-packed-consumer-smoke',
          private: true,
          type: 'module',
          dependencies: {
            '@fullstack-webapp/local-edge': `file:./${tarballName}`,
            vite: '^8.1.1',
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(consumerRoot, 'fwa.config.json'),
      `${JSON.stringify(
        {
          appId: 'packed-consumer-smoke',
          localEdgeEnabled: true,
          scopePath: '/',
          workerPath: '/__fwa-sw.js',
          descriptorPath: '/__fwa/release.json',
          controlPrefix: '/__fwa',
          appEntry: '/',
          appRequestPrefixes: ['/api/'],
          releaseAssetPrefixes: ['/assets/'],
          supplementalAssetPaths: [],
          navigation: {
            appPaths: ['/'],
            appPathPrefixes: [],
            notFound: { strategy: 'app-entry' },
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(consumerRoot, 'index.html'),
      '<!doctype html><html><head><meta charset="UTF-8"></head><body><script type="module" src="/src.js"></script></body></html>\n',
    ),
    writeFile(
      join(consumerRoot, 'src.js'),
      "import { getFwaLocalEdge } from '@fullstack-webapp/local-edge/client'\nvoid getFwaLocalEdge()\n",
    ),
    writeFile(
      join(consumerRoot, 'vite.config.js'),
      configSource('appPlugin'),
    ),
    writeFile(
      join(consumerRoot, 'vite.loader.config.js'),
      configSource('loaderConfig'),
    ),
    writeFile(
      join(consumerRoot, 'vite.worker.config.js'),
      configSource('workerConfig'),
    ),
  ])

  run('pnpm', ['install', '--prefer-offline', '--ignore-scripts'], consumerRoot)
  run('pnpm', ['exec', 'vite', 'build'], consumerRoot)
  run(
    'pnpm',
    ['exec', 'vite', 'build', '--config', 'vite.loader.config.js'],
    consumerRoot,
  )
  run(
    'pnpm',
    ['exec', 'vite', 'build', '--config', 'vite.worker.config.js'],
    consumerRoot,
  )
  run('pnpm', ['exec', 'fwa-publish-release'], consumerRoot)

  const descriptor = JSON.parse(
    await readFile(
      join(consumerRoot, 'dist', '__fwa', 'release.json'),
      'utf8',
    ),
  )
  const assetPaths = new Set(descriptor.assets.map((asset) => asset.path))
  for (const requiredPath of ['/', '/__fwa/loader.js']) {
    if (!assetPaths.has(requiredPath)) {
      throw new Error(`packed consumer descriptor omitted ${requiredPath}`)
    }
  }

  console.log(`Packed consumer verified from ${tarballName}`)
} finally {
  await rm(consumerRoot, { recursive: true, force: true })
}

function configSource(method) {
  if (method === 'appPlugin') {
    return `import { createFwaViteIntegration } from '@fullstack-webapp/local-edge/vite'\nimport { defineConfig } from 'vite'\n\nconst localEdge = createFwaViteIntegration(new URL('./fwa.config.json', import.meta.url))\n\nexport default defineConfig({ plugins: [localEdge.appPlugin()] })\n`
  }
  return `import { createFwaViteIntegration } from '@fullstack-webapp/local-edge/vite'\n\nconst localEdge = createFwaViteIntegration(new URL('./fwa.config.json', import.meta.url))\n\nexport default localEdge.${method}()\n`
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: 'pipe',
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout}${result.stderr}`,
    )
  }
}
