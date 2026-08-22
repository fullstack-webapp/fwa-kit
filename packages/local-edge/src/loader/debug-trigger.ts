import {
  clampFwaDebugAnchor,
  clampFwaDebugPosition,
  fwaDebugAnchorForPosition,
  fwaDebugTriggerSize,
  fwaDebugTriggerViewportInset,
  readFwaDebugPositionPreference,
  writeFwaDebugAnchor,
  type FwaDebugAnchor,
  type FwaDebugPosition,
} from './debug-position.ts'

const panelGap = 12
const dragThreshold = 4

interface TriggerDragState {
  moved: boolean
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
}

export function installFwaDebugTrigger(
  host: HTMLElement,
  trigger: HTMLButtonElement,
  panel: HTMLElement,
) {
  let dragState: TriggerDragState | undefined
  let explicitAnchor: FwaDebugAnchor | undefined
  let suppressNextClick = false
  let clearSuppressedClickFrame: number | undefined

  const clearSuppressedClick = () => {
    if (clearSuppressedClickFrame !== undefined) {
      window.cancelAnimationFrame(clearSuppressedClickFrame)
      clearSuppressedClickFrame = undefined
    }
    suppressNextClick = false
  }

  const viewportBounds = () => ({
    height: window.visualViewport?.height ?? window.innerHeight,
    width: window.visualViewport?.width ?? window.innerWidth,
  })

  const alignPanel = () => {
    if (panel.hidden) {
      return
    }
    const viewport = viewportBounds()
    const triggerRect = trigger.getBoundingClientRect()
    const panelWidth = panel.offsetWidth
    const panelHeight = panel.offsetHeight
    const alignLeft = triggerRect.left + triggerRect.width / 2 <= viewport.width / 2
    const preferredLeft = alignLeft
      ? triggerRect.left
      : triggerRect.right - panelWidth
    const spaceAbove =
      triggerRect.top - panelGap - fwaDebugTriggerViewportInset
    const spaceBelow =
      viewport.height -
      triggerRect.bottom -
      panelGap -
      fwaDebugTriggerViewportInset
    const preferredTop =
      spaceAbove >= panelHeight || spaceAbove >= spaceBelow
        ? triggerRect.top - panelGap - panelHeight
        : triggerRect.bottom + panelGap
    const position = clampFwaDebugPosition(
      { x: preferredLeft, y: preferredTop },
      {
        height: viewport.height,
        inset: fwaDebugTriggerViewportInset,
        itemHeight: panelHeight,
        itemWidth: panelWidth,
        width: viewport.width,
      },
    )
    panel.style.left = `${position.x}px`
    panel.style.top = `${position.y}px`
  }

  const triggerBounds = () => {
    const viewport = viewportBounds()
    return {
      height: viewport.height,
      inset: fwaDebugTriggerViewportInset,
      itemHeight: trigger.offsetHeight || fwaDebugTriggerSize,
      itemWidth: trigger.offsetWidth || fwaDebugTriggerSize,
      width: viewport.width,
    }
  }

  const applyAnchor = (anchor: FwaDebugAnchor, persist = false) => {
    const clamped = clampFwaDebugAnchor(anchor, triggerBounds())
    host.style.left = 'auto'
    host.style.top = 'auto'
    host.style.right = `${clamped.right}px`
    host.style.bottom = `${clamped.bottom}px`
    explicitAnchor = persist ? clamped : anchor
    if (persist) {
      writeFwaDebugAnchor(clamped)
    }
    alignPanel()
  }

  const applyPosition = (position: FwaDebugPosition) => {
    applyAnchor(fwaDebugAnchorForPosition(position, triggerBounds()))
  }

  const storedPosition = readFwaDebugPositionPreference()
  if (storedPosition?.kind === 'bottom-right') {
    applyAnchor(storedPosition.anchor)
  } else if (storedPosition?.kind === 'legacy-top-left') {
    applyAnchor(
      fwaDebugAnchorForPosition(storedPosition.position, triggerBounds()),
      true,
    )
  }

  const finishDrag = (event: PointerEvent) => {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }
    const moved = dragState.moved
    dragState = undefined
    trigger.classList.remove('dragging')
    if (trigger.hasPointerCapture(event.pointerId)) {
      trigger.releasePointerCapture(event.pointerId)
    }
    if (moved && explicitAnchor) {
      applyAnchor(explicitAnchor, true)
      suppressNextClick = true
      clearSuppressedClickFrame = window.requestAnimationFrame(() => {
        clearSuppressedClickFrame = undefined
        suppressNextClick = false
      })
    }
  }

  const handlePointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
      return
    }
    // Some touch browsers suppress the click that normally follows a prevented
    // pointerdown. A drag's stale suppression must not consume the next tap.
    clearSuppressedClick()
    const hostRect = host.getBoundingClientRect()
    dragState = {
      moved: false,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: hostRect.left,
      startY: hostRect.top,
    }
    trigger.setPointerCapture(event.pointerId)
    trigger.classList.add('dragging')
    event.preventDefault()
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }
    const deltaX = event.clientX - dragState.startClientX
    const deltaY = event.clientY - dragState.startClientY
    if (!dragState.moved && Math.hypot(deltaX, deltaY) < dragThreshold) {
      return
    }
    dragState.moved = true
    applyPosition({
      x: dragState.startX + deltaX,
      y: dragState.startY + deltaY,
    })
  }

  const handleViewportChange = () => {
    if (explicitAnchor) {
      applyAnchor(explicitAnchor)
    } else {
      alignPanel()
    }
  }

  trigger.addEventListener('pointerdown', handlePointerDown)
  trigger.addEventListener('pointermove', handlePointerMove)
  trigger.addEventListener('pointerup', finishDrag)
  trigger.addEventListener('pointercancel', finishDrag)
  window.addEventListener('resize', handleViewportChange)
  window.visualViewport?.addEventListener('resize', handleViewportChange)

  return {
    alignPanel,
    consumeSuppressedClick() {
      const suppressed = suppressNextClick
      clearSuppressedClick()
      return suppressed
    },
    destroy() {
      trigger.removeEventListener('pointerdown', handlePointerDown)
      trigger.removeEventListener('pointermove', handlePointerMove)
      trigger.removeEventListener('pointerup', finishDrag)
      trigger.removeEventListener('pointercancel', finishDrag)
      clearSuppressedClick()
      window.removeEventListener('resize', handleViewportChange)
      window.visualViewport?.removeEventListener('resize', handleViewportChange)
    },
  }
}
