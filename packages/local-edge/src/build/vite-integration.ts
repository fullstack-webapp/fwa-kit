import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin, UserConfig } from 'vite'
import {
  defineLocalEdgeConfig,
  loaderPathFor,
  type LocalEdgeConfig,
} from '../config-contract.ts'
import { deriveFwaLoaderPaths } from '../loader/loader-paths.ts'

export interface FwaViteIntegration {
  appPlugin(): Plugin
  loaderConfig(): UserConfig
  workerConfig(): UserConfig
}

export function createFwaViteIntegration(
  configSource: URL | LocalEdgeConfig,
): FwaViteIntegration {
  const localEdgeConfig = readLocalEdgeConfig(configSource)
  assertDefaultLoaderProfile(localEdgeConfig)

  return {
    appPlugin: () => createAppPlugin(localEdgeConfig),
    loaderConfig: () => createLoaderConfig(localEdgeConfig),
    workerConfig: () => createWorkerConfig(localEdgeConfig),
  }
}

function readLocalEdgeConfig(configSource: URL | LocalEdgeConfig) {
  return defineLocalEdgeConfig(
    configSource instanceof URL
      ? (JSON.parse(readFileSync(configSource, 'utf8')) as unknown)
      : configSource,
  )
}

function assertDefaultLoaderProfile(localEdgeConfig: LocalEdgeConfig) {
  const loaderPath = loaderPathFor(localEdgeConfig)
  const paths = deriveFwaLoaderPaths(
    new URL(loaderPath, 'https://fwa-build.invalid'),
  )

  if (
    paths.scopePath !== localEdgeConfig.scopePath ||
    paths.workerPath !== localEdgeConfig.workerPath ||
    paths.descriptorPath !== localEdgeConfig.descriptorPath ||
    paths.controlPrefix !== localEdgeConfig.controlPrefix
  ) {
    throw new Error(
      'FWA config does not match the same-origin loader path convention',
    )
  }
}

function createAppPlugin(localEdgeConfig: LocalEdgeConfig): Plugin {
  const loaderPath = loaderPathFor(localEdgeConfig)
  let isBuild = false

  return {
    name: 'fwa-local-edge',
    config(_config, environment) {
      isBuild = environment.command === 'build'
      return {
        define: {
          __FWA_LOCAL_EDGE_CONFIG__: JSON.stringify(localEdgeConfig),
        },
        build: isBuild ? { manifest: true } : undefined,
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return isBuild ? injectLoaderElement(html, loaderPath) : html
      },
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: '.vite/fwa.config.json',
        source: `${JSON.stringify(localEdgeConfig, null, 2)}\n`,
      })
    },
  }
}

function createLoaderConfig(localEdgeConfig: LocalEdgeConfig): UserConfig {
  const loaderPath = loaderPathFor(localEdgeConfig)

  return {
    publicDir: false,
    define: {
      __FWA_LOCAL_EDGE_CONFIG__: JSON.stringify(localEdgeConfig),
    },
    build: {
      emptyOutDir: false,
      lib: {
        entry: fileURLToPath(sourceEntryUrl('loader/loader-entry.ts')),
        formats: ['iife'],
        name: 'FwaLoader',
        fileName: () => loaderPath.slice(1),
      },
    },
  }
}

function createWorkerConfig(localEdgeConfig: LocalEdgeConfig): UserConfig {
  return {
    publicDir: false,
    define: {
      __FWA_LOCAL_EDGE_CONFIG__: JSON.stringify(localEdgeConfig),
    },
    build: {
      emptyOutDir: false,
      lib: {
        entry: fileURLToPath(sourceEntryUrl('worker/worker-entry.ts')),
        formats: ['es'],
        fileName: () => localEdgeConfig.workerPath.slice(1),
      },
    },
  }
}

function sourceEntryUrl(relativePath: string) {
  const sourceModuleSuffix = '/src/build/vite-integration.ts'
  return new URL(
    import.meta.url.endsWith(sourceModuleSuffix)
      ? `../${relativePath}`
      : `../src/${relativePath}`,
    import.meta.url,
  )
}

function injectLoaderElement(html: string, loaderPath: string) {
  const headEndIndex = html.indexOf('</head>')
  if (headEndIndex < 0) {
    throw new Error('FWA app entry must contain a closing head element')
  }

  const firstScriptIndex = html.indexOf('<script')
  const insertIndex =
    firstScriptIndex >= 0 && firstScriptIndex < headEndIndex
      ? firstScriptIndex
      : headEndIndex
  const lineStartIndex = html.lastIndexOf('\n', insertIndex) + 1
  const existingIndent = html.slice(lineStartIndex, insertIndex)
  const loaderIndent =
    firstScriptIndex === insertIndex ? existingIndent : `${existingIndent}  `
  const loaderElement = `<script defer src="${loaderPath}"></script>`

  return `${html.slice(0, lineStartIndex)}${loaderIndent}${loaderElement}\n${html.slice(lineStartIndex)}`
}
