import { parse, type DefaultTreeAdapterMap } from 'parse5'

import {
  documentShellReadyAttribute,
  documentShellRuntimeStylesheetId,
  documentShellStaticAttribute,
} from './client.ts'

export const documentShellEntryMarker = 'data-document-shell-entry'

declare const htmlFragmentBrand: unique symbol
declare const cssTextBrand: unique symbol
declare const inlineScriptBrand: unique symbol

export type HtmlFragment = string & { readonly [htmlFragmentBrand]: true }
export type CssText = string & { readonly [cssTextBrand]: true }
export type InlineScript = string & { readonly [inlineScriptBrand]: true }

export function htmlFragment(value: string): HtmlFragment {
  return value as HtmlFragment
}

export function cssText(value: string): CssText {
  return value as CssText
}

export function inlineScript(value: string): InlineScript {
  return value as InlineScript
}

export type DocumentShellBuildContext = {
  command: 'build' | 'serve'
  mode: string
}

export type DocumentShellDocument = {
  lang: string
  title: string
  head: readonly HtmlFragment[]
  appEntry: string
  mountId: string
}

export type DocumentShellProjection = {
  html: HtmlFragment
  criticalCss: readonly CssText[]
}

export type DocumentShellInlineEffect = {
  marker: string
  script: InlineScript
}

export type DocumentShellStartupEffects = {
  beforePaint?: readonly DocumentShellInlineEffect[]
  afterShell?: readonly HtmlFragment[]
}

export type DocumentShellComposition = {
  document: DocumentShellDocument
  shell: DocumentShellProjection
  startupEffects?: DocumentShellStartupEffects
}

export type {
  CreateSafeAreaBridgeOptions,
  SafeAreaBridgeProjection,
  SafeAreaDomEffect,
  SafeAreaDomUpdate,
} from './safe-area-bridge.ts'
export { createSafeAreaBridge } from './safe-area-bridge.ts'

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function renderInlineEffect(effect: DocumentShellInlineEffect): string {
  if (!/^data-[a-z0-9.-]+$/.test(effect.marker)) {
    throw new Error('Document shell inline effect marker must be a data-* attribute name')
  }
  const script = effect.script.replace(/<\/script/gi, '<\\/script')
  return `    <script ${escapeAttribute(effect.marker)}="true">${script}</script>`
}

export function compileDocumentShell({
  document,
  shell,
  startupEffects,
}: DocumentShellComposition): string {
  if (!document.lang.trim()) throw new Error('Document shell requires a non-empty lang')
  if (!document.title.trim()) throw new Error('Document shell requires a non-empty title')
  if (!document.appEntry.startsWith('/')) {
    throw new Error('Document shell appEntry must be an absolute browser path')
  }
  if (!document.mountId.trim()) throw new Error('Document shell requires a mountId')
  if (!shell.html.trim()) throw new Error('Document shell renderer returned empty HTML')
  if (shell.criticalCss.length === 0 || shell.criticalCss.some((css) => !css.trim())) {
    throw new Error('Document shell renderer returned empty critical CSS')
  }

  const head = document.head.map((fragment) => fragment.trim()).join('\n')
  const beforePaint = startupEffects?.beforePaint?.map(renderInlineEffect).join('\n') ?? ''
  const criticalCss = shell.criticalCss.join('\n').replace(/<\/style/gi, '<\\/style')
  const afterShell = startupEffects?.afterShell?.map((fragment) => fragment.trim()).join('\n') ?? ''

  const html = `<!doctype html>
<html lang="${escapeAttribute(document.lang)}">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeText(document.title)}</title>
${head}
${beforePaint}
    <style data-document-shell="true">${criticalCss}</style>
  </head>
  <body>
${shell.html}
${afterShell}
    <div id="${escapeAttribute(document.mountId)}"></div>
    <script type="module" src="${escapeAttribute(document.appEntry)}"></script>
  </body>
</html>
`

  validateCompiledDocumentShell(html, document)
  return html
}

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

function isElement(node: Node): node is Element {
  return 'tagName' in node
}

function findElements(node: Node, predicate: (element: Element) => boolean): Element[] {
  const matches: Element[] = []
  if (isElement(node) && predicate(node)) matches.push(node)
  if ('childNodes' in node) {
    for (const child of node.childNodes) matches.push(...findElements(child, predicate))
  }
  if (isElement(node) && node.tagName === 'template' && 'content' in node) {
    matches.push(...findElements(node.content, predicate))
  }
  return matches
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((item) => item.name === name)?.value
}

function assertSingleElement(elements: readonly Element[], label: string): void {
  if (elements.length !== 1) {
    throw new Error(`Document shell requires exactly one ${label}; found ${elements.length}`)
  }
}

export function validateDocumentShellTemplate(html: string, appEntry: string): void {
  const parsed = parse(html)
  const markerElements = findElements(parsed, (element) =>
    element.attrs.some((item) => item.name === documentShellEntryMarker),
  )
  assertSingleElement(markerElements, 'document shell template marker')
  const marker = markerElements[0]
  if (
    marker.tagName !== 'script' ||
    attribute(marker, 'type') !== 'module' ||
    attribute(marker, 'src') !== appEntry
  ) {
    throw new Error(
      `Document shell template marker must be the module entry ${appEntry}`,
    )
  }
  const contributions = findElements(parsed, (element) =>
    !['html', 'head', 'body'].includes(element.tagName) && element !== marker,
  )
  if (contributions.length > 0) {
    throw new Error(
      'Document shell template must contain only its module-entry sentinel; move document contributions into render()',
    )
  }
}

export type LocatedHtmlElement = {
  attributes: Readonly<Record<string, string>>
  startOffset: number
  endOffset: number
}

export function locateSingleStylesheetLink(html: string): LocatedHtmlElement {
  const parsed = parse(html, { sourceCodeLocationInfo: true })
  const stylesheets = findElements(
    parsed,
    (element) =>
      element.tagName === 'link' &&
      (attribute(element, 'rel')?.toLowerCase().split(/\s+/).includes('stylesheet') ?? false),
  )
  if (stylesheets.length !== 1) {
    throw new Error(`Document shell requires exactly one stylesheet link; found ${stylesheets.length}`)
  }
  const stylesheet = stylesheets[0]
  const location = stylesheet.sourceCodeLocation?.startTag ?? stylesheet.sourceCodeLocation
  if (!location) throw new Error('Document shell stylesheet link is missing a source location')
  return {
    attributes: Object.fromEntries(stylesheet.attrs.map((item) => [item.name, item.value])),
    startOffset: location.startOffset,
    endOffset: location.endOffset,
  }
}

export function validateCompiledDocumentShell(
  html: string,
  document: Pick<DocumentShellDocument, 'mountId' | 'appEntry'>,
  options: { transformedAppEntry?: boolean } = {},
): void {
  const parsed = parse(html)
  const doctypes = parsed.childNodes.filter((node) => node.nodeName === '#documentType')
  if (doctypes.length !== 1) {
    throw new Error(`Document shell requires exactly one doctype; found ${doctypes.length}`)
  }

  const markerElements = findElements(parsed, (element) =>
    element.attrs.some((item) => item.name === documentShellEntryMarker),
  )
  if (markerElements.length > 0) {
    throw new Error(`Document shell emitted its template marker: ${documentShellEntryMarker}`)
  }

  assertSingleElement(
    findElements(parsed, (element) =>
      element.tagName === 'meta' && attribute(element, 'name')?.toLowerCase() === 'viewport',
    ),
    'viewport meta',
  )
  assertSingleElement(
    findElements(parsed, (element) =>
      element.tagName === 'link' &&
      (attribute(element, 'rel')?.toLowerCase().split(/\s+/).includes('manifest') ?? false),
    ),
    'manifest link',
  )
  assertSingleElement(findElements(parsed, (element) => element.tagName === 'title'), 'document title')
  assertSingleElement(
    findElements(parsed, (element) => attribute(element, 'id') === document.mountId),
    `#${document.mountId} mount point`,
  )
  assertSingleElement(
    findElements(parsed, (element) =>
      element.tagName === 'style' && attribute(element, 'data-document-shell') === 'true',
    ),
    'critical shell style',
  )
  assertSingleElement(
    findElements(parsed, (element) =>
      element.attrs.some((item) => item.name === documentShellStaticAttribute),
    ),
    'static document shell marker',
  )
  assertSingleElement(
    findElements(parsed, (element) =>
      element.tagName === 'script' &&
      attribute(element, 'type') === 'module' &&
      (options.transformedAppEntry
        ? Boolean(attribute(element, 'src'))
        : attribute(element, 'src') === document.appEntry),
    ),
    options.transformedAppEntry ? 'transformed module entry' : `module entry ${document.appEntry}`,
  )

  const safeAreaBridge = findElements(parsed, (element) =>
    element.tagName === 'script' &&
    attribute(element, 'data-document-shell-safe-area-bridge') === 'true',
  )
  if (safeAreaBridge.length > 0) {
    const viewport = findElements(parsed, (element) =>
      element.tagName === 'meta' && attribute(element, 'name')?.toLowerCase() === 'viewport',
    )[0]
    const viewportContent = attribute(viewport, 'content')
      ?.toLowerCase()
      .split(',')
      .map((part) => part.trim()) ?? []
    const requiredViewportParts = [
      'width=device-width',
      'initial-scale=1',
      'viewport-fit=cover',
    ]
    const missingViewportParts = requiredViewportParts.filter(
      (part) => !viewportContent.includes(part),
    )
    if (missingViewportParts.length > 0) {
      throw new Error(
        `Document shell safe-area bridge requires viewport content: ${missingViewportParts.join(', ')}`,
      )
    }
  }
}

export function validateRuntimeHandoffDocument(html: string): void {
  const parsed = parse(html)
  assertSingleElement(
    findElements(parsed, (element) =>
      element.tagName === 'link' &&
      attribute(element, 'id') === documentShellRuntimeStylesheetId &&
      attribute(element, 'rel') === 'preload' &&
      attribute(element, 'as') === 'style' &&
      attribute(element, 'onload') === undefined &&
      attribute(element, 'onerror') === undefined,
    ),
    'deferred runtime stylesheet',
  )
  assertSingleElement(
    findElements(parsed, (element) =>
      element.tagName === 'script' &&
      attribute(element, 'data-document-shell-runtime-stylesheet') === 'true',
    ),
    'runtime stylesheet bootstrap',
  )
  const initiallyReady = findElements(parsed, (element) =>
    element.tagName === 'html' && attribute(element, documentShellReadyAttribute) !== undefined,
  )
  if (initiallyReady.length > 0) {
    throw new Error(`Document shell cannot emit ${documentShellReadyAttribute} before runtime commit`)
  }
}
