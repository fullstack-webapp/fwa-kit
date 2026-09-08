export const documentShellReadyAttribute = 'data-app-ready'
export const documentShellStaticAttribute = 'data-document-shell-static'
export const documentShellRuntimeStylesheetId = 'runtime-stylesheet'
/**
 * Runtime-declared reveal-not-before deadline. The consumer's parser startup
 * effect writes an absolute epoch-millisecond deadline into this attribute on
 * the element carrying {@link documentShellStaticAttribute} at the moment the
 * projection's delayed content actually becomes visible. A loaded stylesheet
 * handoff waits until that deadline before writing `data-app-ready` and
 * removing the projection; absent, invalid, or expired deadlines leave the
 * loaded handoff immediate, and `error`/`timeout`/`absent` always fail open.
 */
export const documentShellRevealNotBeforeAttribute = 'data-document-shell-reveal-not-before'

export type DocumentShellHandoffResult = Readonly<{
  status: 'revealed'
  stylesheet: 'loaded' | 'error' | 'timeout' | 'absent'
}>

const handoffs = new WeakMap<Document, Promise<DocumentShellHandoffResult>>()

/**
 * Maximum wall-clock horizon accepted for an optional reveal hold. The
 * stylesheet bootstrap normally supplies the same three-second gate, while
 * this independent bound also survives wall-clock adjustments between the
 * declaration and the loaded handoff.
 */
const revealHoldHorizonMs = 3_000

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
  const pending: {
    holdTimer?: number
    revealFrame?: number
    fallbackTimer?: number
  } = {}

  root.setAttribute('data-document-shell-runtime-committed', 'true')

  const cleanup = () => {
    if (pending.holdTimer !== undefined) {
      window.clearTimeout(pending.holdTimer)
      pending.holdTimer = undefined
    }
    if (pending.fallbackTimer !== undefined) window.clearTimeout(pending.fallbackTimer)
    if (pending.revealFrame !== undefined) window.cancelAnimationFrame(pending.revealFrame)
    stylesheet?.removeEventListener('load', handleLoad)
    stylesheet?.removeEventListener('error', handleError)
  }
  const commitReveal = (stylesheetStatus: DocumentShellHandoffResult['stylesheet']) => {
    if (finished) return
    finished = true
    cleanup()
    root.setAttribute(documentShellReadyAttribute, 'true')
    document.querySelector(`[${documentShellStaticAttribute}]`)?.remove()
    resolveHandoff({ status: 'revealed', stylesheet: stylesheetStatus })
  }
  const reveal = (stylesheetStatus: DocumentShellHandoffResult['stylesheet']) => {
    if (finished) return
    if (stylesheetStatus === 'loaded') {
      const holdUntil = readRevealNotBeforeDeadline()
      if (holdUntil !== null) {
        scheduleRevealHold(holdUntil)
        return
      }
    }
    commitReveal(stylesheetStatus)
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

  /**
   * Reads the reveal-not-before declaration at the moment the loaded handoff
   * is about to reveal, so a deadline declared while the stylesheet was still
   * loading is honored. Only a finite absolute deadline that is strictly in
   * the future and still inside the runtime stylesheet gate's recorded
   * fail-open deadline is honored; every other value is treated as absent or
   * expired, keeping the loaded handoff immediate and guaranteeing that the
   * projection can never outlive the stylesheet gate.
   */
  function readRevealNotBeforeDeadline(): number | null {
    const projection = document.querySelector(`[${documentShellStaticAttribute}]`)
    const raw = projection?.getAttribute(documentShellRevealNotBeforeAttribute)
    if (!raw) return null
    const deadline = Number(raw)
    const now = Date.now()
    if (!Number.isFinite(deadline) || deadline <= now) return null
    const gateDeadline = Number(stylesheet?.dataset.failureDeadline)
    const ceiling = Math.min(
      now + revealHoldHorizonMs,
      Number.isFinite(gateDeadline) ? gateDeadline : Number.POSITIVE_INFINITY,
    )
    return deadline <= ceiling ? deadline : null
  }

  /**
   * Defers the loaded reveal until the declared deadline. Wall-clock time
   * preserves the absolute deadline during normal operation, while a monotonic
   * ceiling limits the wait to the delay accepted when it was scheduled. The
   * fired timer is cleared before re-evaluation so an early fire reschedules;
   * a backward wall-clock adjustment cannot extend the inert projection beyond
   * the original bounded delay. The timer shares the handoff cleanup lifecycle.
   */
  function scheduleRevealHold(deadline: number) {
    if (pending.holdTimer !== undefined) return
    const maximumDelay = Math.min(
      revealHoldHorizonMs,
      Math.max(0, deadline - Date.now()),
    )
    const monotonicDeadline = window.performance.now() + maximumDelay
    const wait = () => {
      pending.holdTimer = undefined
      const remaining = Math.min(
        deadline - Date.now(),
        monotonicDeadline - window.performance.now(),
      )
      if (remaining > 0) {
        pending.holdTimer = window.setTimeout(wait, remaining)
        return
      }
      commitReveal('loaded')
    }
    pending.holdTimer = window.setTimeout(wait, maximumDelay)
  }
}
