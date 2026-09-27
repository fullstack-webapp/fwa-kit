import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./debug-panel.ts', () => ({
  installFwaDebugPanel: () => () => undefined,
}))

const { createFwaDebugRuntime } = await import('./debug-runtime.ts')

function installWindow(href: string) {
  const location = new URL(href)
  const replaceState = vi.fn((_state: unknown, _unused: string, url: string) => {
    const next = new URL(url, location.href)
    location.pathname = next.pathname
    location.search = next.search
    location.hash = next.hash
  })
  const storage = new Map<string, string>()
  vi.stubGlobal('window', {
    location,
    history: { state: { owned: true }, replaceState },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  })
  return { location, replaceState, storage }
}

function runtime() {
  return createFwaDebugRuntime(() => ({}) as never)
}

describe('debug seed removal', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes history directly when the host registers no URL writer', () => {
    const { replaceState } = installWindow(
      'https://app.test/settings?view=all&__fwa_debug=0#developer',
    )
    const debug = runtime()

    debug.setEnabled(true)

    expect(replaceState).toHaveBeenCalledOnce()
    expect(replaceState).toHaveBeenCalledWith(
      { owned: true },
      '',
      '/settings?view=all#developer',
    )
    expect(debug.getState()).toEqual({ enabled: true })
  })

  it('hands the cleaned URL to the host writer and never writes history itself', () => {
    const { replaceState } = installWindow(
      'https://app.test/settings?view=all&__fwa_debug=0#developer',
    )
    const writer = vi.fn()
    const debug = runtime()
    debug.setUrlWriter(writer)

    debug.setEnabled(true)

    expect(writer).toHaveBeenCalledWith('/settings?view=all#developer')
    expect(replaceState).not.toHaveBeenCalled()
    expect(debug.getState()).toEqual({ enabled: true })
  })

  it('keeps the diagnostics state when the host writer throws', () => {
    installWindow('https://app.test/?__fwa_debug=1')
    const debug = runtime()
    debug.setUrlWriter(() => {
      throw new Error('router refused')
    })

    expect(() => debug.setEnabled(false)).not.toThrow()
    expect(debug.getState()).toEqual({ enabled: false })
  })

  it('calls no writer when the URL carries no debug seed', () => {
    const { replaceState } = installWindow('https://app.test/library/')
    const writer = vi.fn()
    const debug = runtime()
    debug.setUrlWriter(writer)

    debug.setEnabled(true)

    expect(writer).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('restores the direct write when the writer is cleared', () => {
    const { replaceState } = installWindow('https://app.test/?__fwa_debug=1')
    const writer = vi.fn()
    const debug = runtime()
    debug.setUrlWriter(writer)
    debug.setUrlWriter(null)

    debug.setEnabled(false)

    expect(writer).not.toHaveBeenCalled()
    expect(replaceState).toHaveBeenCalledWith({ owned: true }, '', '/')
  })
})

describe('debug URL writer registration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the registered writer when given anything but a function or null', () => {
    installWindow('https://app.test/?__fwa_debug=1')
    const writer = vi.fn()
    const debug = runtime()
    debug.setUrlWriter(writer)
    debug.setUrlWriter(undefined as never)
    debug.setUrlWriter('replace' as never)

    debug.setEnabled(false)

    expect(writer).toHaveBeenCalledWith('/')
  })

  it('absorbs a rejected promise from an async writer', async () => {
    installWindow('https://app.test/?__fwa_debug=1')
    const debug = runtime()
    debug.setUrlWriter(() => Promise.reject(new Error('router refused')) as never)

    debug.setEnabled(false)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(debug.getState()).toEqual({ enabled: false })
  })

  it('consumes a reset seed at startup with a direct write, before any writer exists', () => {
    const { replaceState } = installWindow('https://app.test/library/?__fwa_debug=reset#x')
    const debug = runtime()

    debug.start()

    expect(replaceState).toHaveBeenCalledWith({ owned: true }, '', '/library/#x')
    expect(debug.getState()).toEqual({ enabled: true })
  })

  it('leaves enable and disable seeds in the URL at startup', () => {
    for (const seed of ['1', '0']) {
      const { replaceState } = installWindow(`https://app.test/?__fwa_debug=${seed}`)
      runtime().start()
      expect(replaceState).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    }
  })
})
