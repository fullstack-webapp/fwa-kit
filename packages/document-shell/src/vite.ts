import { Buffer } from 'node:buffer'
import type { Plugin } from 'vite'

import {
  compileDocumentShell,
  locateSingleStylesheetLink,
  validateCompiledDocumentShell,
  validateDocumentShellTemplate,
  validateRuntimeHandoffDocument,
  type DocumentShellBuildContext,
  type DocumentShellComposition,
  type DocumentShellDocument,
} from './document-shell.ts'
import {
  documentShellRuntimeStylesheetId,
} from './client.ts'

export type DocumentShellPluginOptions = {
  render: (
    context: DocumentShellBuildContext,
  ) => DocumentShellComposition | Promise<DocumentShellComposition>
  validateFinalDocument?: (html: string, context: DocumentShellBuildContext) => void
  runtimeHandoff?: boolean
}

type IndexAsset = {
  type: 'asset'
  fileName: string
  source: string | Uint8Array
}

function readIndexAsset(bundle: Record<string, unknown>): IndexAsset {
  const indexAsset = Object.values(bundle).find(
    (entry): entry is IndexAsset =>
      typeof entry === 'object' &&
      entry !== null &&
      'type' in entry &&
      entry.type === 'asset' &&
      'fileName' in entry &&
      entry.fileName === 'index.html',
  )
  if (!indexAsset) throw new Error('Document shell could not find emitted index.html')
  return indexAsset
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function deferRuntimeStylesheet(): Plugin {
  return {
    name: 'document-shell:defer-runtime-stylesheet',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      const stylesheet = locateSingleStylesheetLink(html)
      const href = stylesheet.attributes.href
      if (!href) throw new Error('Emitted runtime stylesheet is missing an href')
      const replacedAttributes = new Set(['id', 'rel', 'as', 'href', 'onload', 'onerror'])
      const forwardedAttributes = Object.entries(stylesheet.attributes)
        .filter(([name]) => !replacedAttributes.has(name))
        .map(([name, value]) =>
          value === '' ? ` ${name}` : ` ${name}="${escapeHtmlAttribute(value)}"`,
        )
        .join('')
      const bootstrap = `<script data-document-shell-runtime-stylesheet="true">(()=>{const stylesheet=document.getElementById('${documentShellRuntimeStylesheetId}');if(!stylesheet)return;const emit=(state,detail)=>document.dispatchEvent(new CustomEvent('document-shell:runtime-stylesheet',{detail:{state,detail}}));const markFailure=(failure)=>{if(stylesheet.dataset.failure===failure)return;stylesheet.dataset.failure=failure;emit('failed',failure)};const deadline=Date.now()+3000;stylesheet.dataset.failureDeadline=String(deadline);const timer=window.setTimeout(()=>{if(stylesheet.dataset.loaded!=='true')markFailure('timeout')},Math.max(0,deadline-Date.now()));stylesheet.addEventListener('load',()=>{window.clearTimeout(timer);stylesheet.dataset.loaded='true';stylesheet.rel='stylesheet';emit('loaded')},{once:true});stylesheet.addEventListener('error',()=>{window.clearTimeout(timer);markFailure('error')},{once:true})})()</script>`
      const deferredLink = `<link id="${documentShellRuntimeStylesheetId}" rel="preload" as="style"${forwardedAttributes} href="${escapeHtmlAttribute(href)}">${bootstrap}`
      return `${html.slice(0, stylesheet.startOffset)}${deferredLink}${html.slice(stylesheet.endOffset)}`
    },
  }
}

export function documentShell(options: DocumentShellPluginOptions): Plugin[] {
  let resolvedDocument: DocumentShellDocument | undefined
  let command: DocumentShellBuildContext['command'] = 'build'
  let mode = 'production'

  const producer: Plugin = {
    name: 'document-shell:compile',
    enforce: 'pre',
    configResolved(config) {
      command = config.command
      mode = config.mode
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(template) {
        const buildContext = { command, mode }
        const composition = await options.render(buildContext)
        validateDocumentShellTemplate(template, composition.document.appEntry)
        resolvedDocument = composition.document
        return compileDocumentShell(composition)
      },
    },
  }

  const finalGate: Plugin = {
    name: 'document-shell:final-artifact-gate',
    apply: 'build',
    enforce: 'post',
    generateBundle(_outputOptions, bundle) {
      if (!resolvedDocument) {
        throw new Error('Document shell final gate ran before the document compiler')
      }
      const indexAsset = readIndexAsset(bundle)
      const html = typeof indexAsset.source === 'string'
        ? indexAsset.source
        : Buffer.from(indexAsset.source).toString('utf8')
      validateCompiledDocumentShell(html, resolvedDocument, { transformedAppEntry: true })
      if (options.runtimeHandoff) validateRuntimeHandoffDocument(html)
      options.validateFinalDocument?.(html, { command, mode })
    },
  }

  return options.runtimeHandoff
    ? [producer, deferRuntimeStylesheet(), finalGate]
    : [producer, finalGate]
}
