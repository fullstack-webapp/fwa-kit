export const documentShellReadyAttribute = 'data-app-ready'
export const documentShellStaticAttribute = 'data-document-shell-static'
export const documentShellRuntimeStylesheetId = 'runtime-stylesheet'

export type DocumentShellHandoffResult = Readonly<{
  status: 'revealed'
  stylesheet: 'loaded' | 'error' | 'timeout' | 'absent'
}>

const handoffs = new WeakMap<Document, Promise<DocumentShellHandoffResult>>()

export function commitDocumentShellRuntime(): Promise<DocumentShellHandoffResult> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('Document shell runtime handoff requires a browser document'))
  }

  const existing = handoffs.get(document)
  if (existing) return existing

  let resolveHandoff!: (result: DocumentShellHandoffResult) => void
  const handoff = new Promise<DocumentShellHandoffResult>((resolve) => {
    resolveHandoff = resolve
  })
  handoffs.set(document, handoff)

  const root = document.documentElement
  const stylesheet = document.getElementById(
    documentShellRuntimeStylesheetId,
  ) as HTMLLinkElement | null
  let finished = false
  const pending: { revealFrame?: number; fallbackTimer?: number } = {}

  root.setAttribute('data-document-shell-runtime-committed', 'true')

  const cleanup = () => {
    if (pending.fallbackTimer !== undefined) window.clearTimeout(pending.fallbackTimer)
    if (pending.revealFrame !== undefined) window.cancelAnimationFrame(pending.revealFrame)
    stylesheet?.removeEventListener('load', handleLoad)
    stylesheet?.removeEventListener('error', handleError)
  }
  const reveal = (stylesheetStatus: DocumentShellHandoffResult['stylesheet']) => {
    if (finished) return
    finished = true
    cleanup()
    root.setAttribute(documentShellReadyAttribute, 'true')
    document.querySelector(`[${documentShellStaticAttribute}]`)?.remove()
    resolveHandoff({ status: 'revealed', stylesheet: stylesheetStatus })
  }
  const revealAfterStylesApply = () => {
    if (finished || pending.revealFrame !== undefined) return
    if (pending.fallbackTimer !== undefined) {
      window.clearTimeout(pending.fallbackTimer)
      pending.fallbackTimer = undefined
    }
    pending.revealFrame = window.requestAnimationFrame(() => reveal('loaded'))
  }
  function handleLoad() {
    revealAfterStylesApply()
  }
  function handleError() {
    reveal('error')
  }

  if (!stylesheet) {
    reveal('absent')
    return handoff
  }
  if (stylesheet.dataset.loaded === 'true') {
    reveal('loaded')
    return handoff
  }
  if (stylesheet.dataset.failure === 'error') {
    reveal('error')
    return handoff
  }
  if (stylesheet.dataset.failure === 'timeout') {
    reveal('timeout')
    return handoff
  }

  stylesheet.addEventListener('load', handleLoad, { once: true })
  stylesheet.addEventListener('error', handleError, { once: true })
  const failureDeadline = Number(stylesheet.dataset.failureDeadline)
  const fallbackDelay = Number.isFinite(failureDeadline)
    ? Math.max(0, failureDeadline - Date.now())
    : 0
  pending.fallbackTimer = window.setTimeout(() => reveal('timeout'), fallbackDelay)

  return handoff
}
