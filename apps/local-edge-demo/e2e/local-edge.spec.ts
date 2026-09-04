import { expect, test, type Page } from '@playwright/test'
import {
  startReleaseUpdateServer,
  type CandidateFault,
} from './release-update-server.ts'

interface TestFwaGlobal {
  q: {
    push(command: readonly [string, unknown?]): number
  }
  localEdge?: {
    debug: {
      getState(): { enabled: boolean }
      subscribe(listener: (state: { enabled: boolean }) => void): () => void
      setEnabled(enabled: boolean): void
    }
  }
}

const isRemoteRun = Boolean(process.env.E2E_BASE_URL)
const candidateFaults = [
  'html-200',
  'redirect',
  'cross-origin',
  'wrong-mime',
  'wrong-size',
  'wrong-digest',
] as const satisfies readonly CandidateFault[]

async function expectNetworkMode(
  page: Page,
  expected: {
    pathname?: string
    query?: Record<string, string>
    hash?: string
  } = {},
) {
  await expect
    .poll(() => {
      const pageUrl = new URL(page.url())
      return {
        hash: pageUrl.hash,
        mode: pageUrl.searchParams.get('__fwa'),
        pathname: pageUrl.pathname,
        query: Object.fromEntries(
          [...pageUrl.searchParams.entries()].filter(
            ([key]) => key !== '__fwa',
          ),
        ),
      }
    })
    .toEqual({
      hash: expected.hash ?? '',
      mode: 'network',
      pathname: expected.pathname ?? '/',
      query: expected.query ?? {},
    })
}

async function reloadAvailableUpdate(page: Page) {
  const reviewUpdate = page.getByRole('button', {
    name: 'Review available update',
  })
  await expect(reviewUpdate).toBeEnabled({ timeout: 20_000 })
  await reviewUpdate.click()

  const dialog = page.getByRole('dialog', { name: 'Reload to update?' })
  await expect(dialog).toBeVisible()
  await Promise.all([
    page.waitForNavigation(),
    dialog.getByRole('button', { name: 'Reload', exact: true }).click(),
  ])
}

test.describe('Local Edge v0', () => {
  test('opens a declared SPA deep link before and after Local Edge control', async ({
    page,
  }) => {
    await page.goto('/library/')

    const app = page.locator('[data-app-ready="true"]')
    await expect(app).toHaveAttribute(
      'data-navigation-disposition',
      'app-route',
    )
    await expect(page.locator('[data-app-not-found]')).toHaveCount(0)
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    await page.reload()
    await expect(app).toHaveAttribute(
      'data-navigation-disposition',
      'app-route',
    )
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
    )
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(0)
  })

  test('uses the public client facade for consumer-style app controls', async ({
    page,
  }) => {
    await page.goto('/?__fwa_debug=0#consumer')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    const releaseId = await page.evaluate(() =>
      fetch('/__fwa/release.json')
        .then((response) => response.json())
        .then((release: { releaseId: string }) => release.releaseId),
    )
    const versionRow = page.locator('[data-settings-entry="version"]')
    await expect(versionRow).toHaveAttribute('data-update-status', 'idle')
    const versionValue = versionRow.locator('[data-version-value]')
    await expect(versionValue).toHaveText(releaseId.slice(0, 8))
    await expect(versionValue).toHaveCSS('user-select', 'text')
    await expect(
      versionRow.getByRole('button', { name: 'No update available' }),
    ).toBeDisabled()

    const developerMode = page.getByRole('switch', {
      name: 'Developer mode',
    })
    await expect(developerMode).not.toBeChecked()
    const navigationCount = await page.evaluate(() => {
      Object.assign(window, { __fwaDemoSessionMarker: { alive: true } })
      return performance.getEntriesByType('navigation').length
    })

    await developerMode.click()
    await expect(developerMode).toBeChecked()
    await expect(
      page.getByRole('button', { name: /Open FWA diagnostics/ }),
    ).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('__fwa_debug'))).toBe(
      '1',
    )
    await expect(page).toHaveURL(/\/#consumer$/)

    await developerMode.click()
    await expect(developerMode).not.toBeChecked()
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(0)
    expect(
      await page.evaluate(() => ({
        marker: (
          window as typeof window & {
            __fwaDemoSessionMarker?: { alive: boolean }
          }
        ).__fwaDemoSessionMarker,
        navigationCount: performance.getEntriesByType('navigation').length,
      })),
    ).toEqual({ marker: { alive: true }, navigationCount })
  })

  test('shows opt-in diagnostics without changing app routing', async ({
    context,
    page,
  }) => {
    await page.goto('/library/?view=all&__fwa_debug=1')
    await expect(page.locator('[data-app-ready="true"]')).toHaveAttribute(
      'data-navigation-disposition',
      'app-route',
    )
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )
    expect(
      await page.evaluate(() => ({
        debug: new URL(window.location.href).searchParams.get('__fwa_debug'),
        view: new URL(window.location.href).searchParams.get('view'),
      })),
    ).toEqual({ debug: '1', view: 'all' })

    const trigger = page.getByRole('button', {
      name: 'Open FWA diagnostics',
    })
    await expect(trigger).toBeVisible()
    await expect(trigger).toHaveCSS('width', '36px')
    await expect(trigger).toHaveCSS('height', '36px')
    await expect(trigger).toHaveCSS('font-size', '8px')
    await expect(trigger).toHaveAttribute('data-installation', 'installed')
    await expect(trigger).not.toHaveAttribute('data-notice')
    await expect(trigger).toHaveAttribute(
      'aria-label',
      'Open FWA diagnostics (installed)',
    )
    await expect(page.locator('#__fwa-debug-root')).toHaveCSS(
      'z-index',
      '2147483000',
    )
    const triggerBox = await trigger.boundingBox()
    const viewport = page.viewportSize()
    expect(triggerBox).not.toBeNull()
    expect(viewport).not.toBeNull()
    expect(triggerBox!.x).toBeGreaterThanOrEqual(0)
    expect(triggerBox!.y).toBeGreaterThanOrEqual(0)
    expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(
      viewport!.width,
    )
    expect(triggerBox!.y + triggerBox!.height).toBeLessThanOrEqual(
      viewport!.height,
    )
    const stateAppearance = await trigger.evaluate((element) => {
      const triggerElement = element as HTMLElement
      const appearances: Record<
        string,
        {
          activityAnimationDuration: string
          activityAnimationName: string
          background: string
        }
      > = {}
      triggerElement.style.transition = 'none'
      for (const state of [
        'installed',
        'bypassed',
        'checking',
        'installing',
        'updating',
      ]) {
        triggerElement.dataset.installation = state
        void triggerElement.offsetWidth
        const style = getComputedStyle(triggerElement)
        const activityStyle = getComputedStyle(triggerElement, '::before')
        appearances[state] = {
          activityAnimationDuration: activityStyle.animationDuration,
          activityAnimationName: activityStyle.animationName,
          background: style.backgroundColor,
        }
      }
      triggerElement.dataset.installation = 'installed'
      triggerElement.style.removeProperty('transition')
      return appearances
    })
    expect(stateAppearance.installed.background).not.toBe(
      stateAppearance.bypassed.background,
    )
    expect(stateAppearance.checking).toMatchObject({
      activityAnimationDuration: '1.25s',
      activityAnimationName: 'fwa-debug-orbit',
    })
    expect(stateAppearance.installing).toMatchObject({
      activityAnimationDuration: '1.25s',
      activityAnimationName: 'fwa-debug-orbit',
    })
    expect(stateAppearance.updating).toMatchObject({
      activityAnimationDuration: '1.25s',
      activityAnimationName: 'fwa-debug-orbit',
    })
    expect(stateAppearance.updating.background).toBe(
      stateAppearance.installed.background,
    )
    await trigger.click()

    const dialog = page.getByRole('dialog', { name: 'FWA diagnostics' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('ready · controlled')
    await expect(dialog).toContainText('Installed ·')
    await expect(dialog).toContainText('offline ready')
    await expect(dialog).toContainText('1 release cache · complete')
    await expect(dialog.getByText('Local Edge · /')).toBeVisible()
    await expect(dialog.locator('.message')).toHaveText(
      '仅检查最新 release，不影响当前缓存与会话。',
    )
    await expect(dialog.locator('.message')).toHaveAttribute(
      'aria-live',
      'polite',
    )

    const footer = dialog.locator('footer')
    const actionLabels = await footer.getByRole('button').allTextContents()
    expect(actionLabels).toEqual([
      'Check again',
      'Use network',
      'Reload',
      'Hide',
      'Reset',
    ])
    expect(actionLabels.every((label) => !label.includes('…'))).toBe(true)
    const actionLayout = await footer.evaluate((element) => {
      const rows = [...element.querySelectorAll<HTMLElement>('.action-row')]
      return rows.map((row) =>
        [...row.querySelectorAll<HTMLElement>('button')].map((button) => {
          const box = button.getBoundingClientRect()
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            width: box.width,
          }
        }),
      )
    })
    const [primaryActions, secondaryActions] = actionLayout
    expect(primaryActions).toHaveLength(2)
    expect(secondaryActions).toHaveLength(3)
    expect(Math.abs(primaryActions[0].top - primaryActions[1].top)).toBeLessThan(1)
    expect(
      Math.max(...secondaryActions.map(({ top }) => top)) -
        Math.min(...secondaryActions.map(({ top }) => top)),
    ).toBeLessThan(1)
    expect(secondaryActions[0].top).toBeGreaterThan(primaryActions[0].top)
    expect(Math.abs(primaryActions[0].left - secondaryActions[0].left)).toBeLessThan(1)
    expect(Math.abs(primaryActions[1].right - secondaryActions[2].right)).toBeLessThan(1)
    expect(
      Math.max(...secondaryActions.map(({ width }) => width)) -
        Math.min(...secondaryActions.map(({ width }) => width)),
    ).toBeLessThan(1)

    await expect
      .poll(() =>
        page.evaluate(() => {
          const testWindow = window as typeof window & {
            __fwa?: { localEdge?: { getState(): { revalidating: boolean } } }
          }
          return testWindow.__fwa?.localEdge?.getState().revalidating
        }),
      )
      .toBe(false)
    const checkBaseline = await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __fwa?: { localEdge?: { getState(): { releaseId?: string } } }
        __fwaCheckSentinel?: { alive: boolean }
      }
      testWindow.__fwaCheckSentinel = { alive: true }
      return {
        navigationCount: performance.getEntriesByType('navigation').length,
        releaseId: testWindow.__fwa?.localEdge?.getState().releaseId,
        url: window.location.href,
      }
    })
    const releaseCheckRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/__fwa/revalidate' &&
        request.method() === 'POST',
    )
    await footer.getByRole('button', { name: 'Check again' }).click()
    await releaseCheckRequest
    await expect(footer.getByRole('button', { name: 'Check again' })).toBeEnabled()
    await expect(dialog.locator('.message')).toHaveText(
      '当前 release 已是最新版；当前缓存与会话保持可用。',
    )
    expect(
      await page.evaluate(() => {
        const testWindow = window as typeof window & {
          __fwa?: { localEdge?: { getState(): { releaseId?: string } } }
          __fwaCheckSentinel?: { alive: boolean }
        }
        return {
          navigationCount: performance.getEntriesByType('navigation').length,
          releaseId: testWindow.__fwa?.localEdge?.getState().releaseId,
          sentinel: testWindow.__fwaCheckSentinel,
          url: window.location.href,
        }
      }),
    ).toEqual({ ...checkBaseline, sentinel: { alive: true } })

    await dialog.getByText('Raw report').click()
    const rawReport = dialog.locator('pre')
    await expect(rawReport).toContainText('"complete": true')
    await expect(rawReport).toContainText('"pathname": "/library/"')
    await expect(rawReport).not.toContainText('view=all')

    await dialog.getByRole('button', { name: 'Reload', exact: true }).click()
    const reloadDialog = page.getByRole('alertdialog', {
      name: 'Reload FWA app',
    })
    await expect(reloadDialog).toContainText('Reload the app?')
    await expect(reloadDialog).toContainText('unsaved in-memory session state')
    await reloadDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(reloadDialog).toBeHidden()

    await page.mouse.click(24, 24)
    await expect(dialog).toBeHidden()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveCSS('outline-style', 'none')

    await trigger.click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await context.setOffline(true)
    try {
      await page.reload()
      await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
        'data-local-edge-status',
        'ready',
      )
      await page.getByRole('button', {
        name: 'Open FWA diagnostics',
      }).click()
      await expect(trigger).toHaveAttribute('data-installation', 'installed')
      await expect(dialog).toContainText('1 release cache · complete')
      await expect
        .poll(() =>
          page.evaluate(() => {
            const testWindow = window as typeof window & {
              __fwa?: { localEdge?: { getState(): { revalidating: boolean } } }
            }
            return testWindow.__fwa?.localEdge?.getState().revalidating
          }),
        )
        .toBe(false)
      await dialog.getByRole('button', { name: 'Check again' }).click()
      await expect(
        dialog.getByRole('button', { name: 'Check again' }),
      ).toBeEnabled()
      await expect(dialog.locator('.message')).toHaveText(
        '无法检查最新 release；当前缓存与会话保持可用。',
      )
      await expect(trigger).toHaveAttribute('data-installation', 'installed')
    } finally {
      await context.setOffline(false)
    }

    await page.goto(
      '/library/?view=all&__fwa=network&__fwa_debug=1',
    )
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'network-only',
    )
    await page.getByRole('button', {
      name: 'Open FWA diagnostics',
    }).click()
    await expect(trigger).toHaveAttribute('data-installation', 'installed')
    await expect(dialog).toContainText('network-only · controlled')
    await expect(dialog).toContainText(
      'cached while this page bypasses Local Edge',
    )
    await expect(dialog).toContainText('1 release cache · complete')

    await page.evaluate(async () => {
      const cacheName = (await caches.keys()).find((name) =>
        name.startsWith('fwa-local-edge:fwa-local-edge-demo:release:'),
      )
      if (!cacheName) {
        throw new Error('release cache is missing')
      }
      const releaseCache = await caches.open(cacheName)
      const asset = (await releaseCache.keys())[0]
      if (!asset || !(await releaseCache.delete(asset))) {
        throw new Error('failed to remove a release asset')
      }
    })
    await page.mouse.click(24, 24)
    await trigger.click()
    await expect(trigger).toHaveAttribute('data-installation', 'incomplete')
    await expect(dialog).toContainText('Incomplete ·')
    await expect(dialog).toContainText('1 missing')
  })

  test('keeps diagnostics chrome fixed while report content scrolls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 560 })
    await page.goto('/?__fwa_debug=1')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    await page
      .getByRole('button', { name: 'Open FWA diagnostics' })
      .click()
    const dialog = page.getByRole('dialog', { name: 'FWA diagnostics' })
    await expect(dialog).toBeVisible()
    await dialog.getByText('Raw report', { exact: true }).click()

    const header = dialog.locator('header')
    const content = dialog.locator('.content')
    const footer = dialog.locator('footer')
    const headerBefore = await header.boundingBox()
    const footerBefore = await footer.boundingBox()
    expect(headerBefore).not.toBeNull()
    expect(footerBefore).not.toBeNull()
    const compactFooterLayout = await footer.evaluate((element) =>
      [...element.querySelectorAll<HTMLElement>('.action-row')].map((row) => {
        const rowBox = row.getBoundingClientRect()
        return {
          buttonCount: row.querySelectorAll('button').length,
          left: rowBox.left,
          right: rowBox.right,
          top: rowBox.top,
        }
      }),
    )
    expect(compactFooterLayout.map(({ buttonCount }) => buttonCount)).toEqual([
      2,
      3,
    ])
    expect(
      Math.abs(compactFooterLayout[0].left - compactFooterLayout[1].left),
    ).toBeLessThan(1)
    expect(
      Math.abs(compactFooterLayout[0].right - compactFooterLayout[1].right),
    ).toBeLessThan(1)
    expect(compactFooterLayout[1].top).toBeGreaterThan(
      compactFooterLayout[0].top,
    )

    const scrollState = await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      }
    })
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight)
    expect(scrollState.scrollTop).toBeGreaterThan(0)

    const headerAfter = await header.boundingBox()
    const footerAfter = await footer.boundingBox()
    expect(Math.abs(headerAfter!.y - headerBefore!.y)).toBeLessThan(1)
    expect(Math.abs(footerAfter!.y - footerBefore!.y)).toBeLessThan(1)
    await footer.getByRole('button', { name: 'Check again' }).click()
    await expect(footer.getByRole('button', { name: 'Check again' })).toBeEnabled()
  })

  test('reloads the app from diagnostics only after confirmation', async ({
    page,
  }) => {
    await page.goto('/library/?view=all&__fwa_debug=1#session')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )
    await page.evaluate(() => {
      Object.assign(window, { __fwaReloadSentinel: { alive: true } })
    })

    await page
      .getByRole('button', { name: 'Open FWA diagnostics' })
      .click()
    await page.getByRole('button', { name: 'Reload', exact: true }).click()
    const reloadDialog = page.getByRole('alertdialog', {
      name: 'Reload FWA app',
    })
    await expect(reloadDialog).toBeVisible()

    const navigation = page.waitForEvent('framenavigated')
    await reloadDialog.getByRole('button', { name: 'Reload', exact: true }).click()
    await navigation
    await expect(page).toHaveURL('/library/?view=all&__fwa_debug=1#session')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
    )
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __fwaReloadSentinel?: unknown })
            .__fwaReloadSentinel,
      ),
    ).toBeUndefined()
  })

  test('treats intentional network-only diagnostics as a normal state', async ({
    page,
  }) => {
    await page.goto('/?__fwa=network&__fwa_debug=1')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'network-only',
    )

    const trigger = page.getByRole('button', {
      name: 'Open FWA diagnostics',
    })
    await expect(trigger).toHaveAttribute('data-installation', 'bypassed')
    await trigger.click()

    const dialog = page.getByRole('dialog', { name: 'FWA diagnostics' })
    await expect(dialog).toContainText(
      'Bypassed · This page intentionally uses the network baseline',
    )
    await expect(dialog).not.toContainText('Kernel state:')
  })

  test('persists and clears the debug preference across routes', async ({
    page,
  }) => {
    await page.goto('/?__fwa_debug=1')
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(1)
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    await page.goto('/library/')
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(1)
    expect(new URL(page.url()).searchParams.has('__fwa_debug')).toBe(false)

    await page.goto('/library/?__fwa_debug=0')
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(0)

    await page.goto('/')
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(0)
  })

  test('toggles diagnostics through the public API without navigation', async ({
    page,
  }) => {
    await page.goto('/library/?view=all&__fwa_debug=0#live')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    const initial = await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __fwa?: TestFwaGlobal
        __fwaDebugObserved?: boolean[]
        __fwaSessionSentinel?: object
      }
      const localEdge = testWindow.__fwa?.localEdge
      if (!localEdge) throw new Error('FWA Local Edge API is unavailable')

      testWindow.__fwaSessionSentinel = { alive: true }
      testWindow.__fwaDebugObserved = []
      localEdge.debug.subscribe(({ enabled }) => {
        testWindow.__fwaDebugObserved?.push(enabled)
      })
      return {
        debug: localEdge.debug.getState(),
        navigationCount: performance.getEntriesByType('navigation').length,
      }
    })
    expect(initial.debug).toEqual({ enabled: false })

    await page.evaluate(() => {
      const testWindow = window as typeof window & { __fwa?: TestFwaGlobal }
      testWindow.__fwa?.localEdge?.debug.setEnabled(true)
    })
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(1)
    await expect(page).toHaveURL('/library/?view=all#live')
    expect(await page.evaluate(() => localStorage.getItem('__fwa_debug'))).toBe('1')

    const trigger = page.getByRole('button', {
      name: /Open FWA diagnostics/,
    })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'FWA diagnostics' })
    await dialog.getByRole('button', { name: 'Hide', exact: true }).click()
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(0)
    expect(
      await page.evaluate(() => {
        const testWindow = window as typeof window & { __fwa?: TestFwaGlobal }
        return testWindow.__fwa?.localEdge?.debug.getState()
      }),
    ).toEqual({ enabled: false })

    await page.evaluate(() => {
      const testWindow = window as typeof window & { __fwa?: TestFwaGlobal }
      testWindow.__fwa?.q.push(['debug.setEnabled', true])
    })
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(1)
    await page.evaluate(() => {
      const testWindow = window as typeof window & { __fwa?: TestFwaGlobal }
      testWindow.__fwa?.q.push(['debug.setEnabled', false])
    })
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(0)

    expect(
      await page.evaluate(() => {
        const testWindow = window as typeof window & {
          __fwaDebugObserved?: boolean[]
          __fwaSessionSentinel?: { alive: boolean }
        }
        return {
          navigationCount: performance.getEntriesByType('navigation').length,
          observed: testWindow.__fwaDebugObserved,
          preference: localStorage.getItem('__fwa_debug'),
          sentinel: testWindow.__fwaSessionSentinel,
        }
      }),
    ).toEqual({
      navigationCount: initial.navigationCount,
      observed: [false, true, false, true, false],
      preference: null,
      sentinel: { alive: true },
    })
  })

  test('moves the debug trigger without opening it and restores its position', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/?__fwa_debug=1')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    const trigger = page.getByRole('button', {
      name: 'Open FWA diagnostics',
    })
    const initial = await trigger.boundingBox()
    if (!initial) {
      throw new Error('debug trigger is not measurable')
    }
    const target = { x: 80, y: 120 }
    await page.mouse.move(
      initial.x + initial.width / 2,
      initial.y + initial.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(
      target.x + initial.width / 2,
      target.y + initial.height / 2,
      { steps: 6 },
    )
    await page.mouse.up()
    await page.mouse.move(0, 0)

    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    const moved = await trigger.boundingBox()
    const viewport = page.viewportSize()
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('__fwa_debug_position') ?? 'null'),
    ) as { right: number; bottom: number } | null
    expect(stored).not.toBeNull()
    expect(
      Math.abs(stored!.right - (viewport!.width - moved!.x - moved!.width)),
    ).toBeLessThan(1)
    expect(
      Math.abs(stored!.bottom - (viewport!.height - moved!.y - moved!.height)),
    ).toBeLessThan(1)

    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'FWA diagnostics' })
    await expect(dialog).toBeVisible()
    await page.mouse.click(24, 24)
    await expect(dialog).toBeHidden()

    await page.reload()
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
    )
    const restored = await trigger.boundingBox()
    expect(Math.abs((restored?.x ?? 0) - target.x)).toBeLessThan(2)
    expect(Math.abs((restored?.y ?? 0) - target.y)).toBeLessThan(2)

    const expandedViewport = {
      width: viewport!.width + 160,
      height: viewport!.height + 120,
    }
    await page.setViewportSize(expandedViewport)
    const expanded = await trigger.boundingBox()
    expect(
      Math.abs((expanded?.x ?? 0) - (restored?.x ?? 0) - 160),
    ).toBeLessThan(1)
    expect(
      Math.abs((expanded?.y ?? 0) - (restored?.y ?? 0) - 120),
    ).toBeLessThan(1)

    await page.setViewportSize({ width: 320, height: 420 })
    await expect
      .poll(async () => (await trigger.boundingBox())?.x ?? -1)
      .toBeGreaterThanOrEqual(11.9)
    const compact = await trigger.boundingBox()
    expect(compact!.x).toBeGreaterThanOrEqual(11.9)
    expect(compact!.y).toBeGreaterThanOrEqual(11.9)
    expect(compact!.x + compact!.width).toBeLessThanOrEqual(308.1)
    expect(compact!.y + compact!.height).toBeLessThanOrEqual(408.1)

    await page.setViewportSize(expandedViewport)
    await expect
      .poll(async () => {
        const current = await trigger.boundingBox()
        return Math.abs((current?.x ?? 0) - (expanded?.x ?? 0)) < 1
      })
      .toBe(true)
    const expandedAgain = await trigger.boundingBox()
    expect(Math.abs((expandedAgain?.x ?? 0) - (expanded?.x ?? 0))).toBeLessThan(
      1,
    )
    expect(Math.abs((expandedAgain?.y ?? 0) - (expanded?.y ?? 0))).toBeLessThan(
      1,
    )

    await trigger.click()
    await expect(dialog).toBeVisible()
    const dialogBox = await dialog.boundingBox()
    expect(dialogBox).not.toBeNull()
    expect(dialogBox!.x).toBeGreaterThanOrEqual(12)
    expect(dialogBox!.y).toBeGreaterThanOrEqual(12)
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth - 12),
    )
  })

  test('moves the debug trigger with touch input', async ({ context, page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/?__fwa_debug=1')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    const trigger = page.getByRole('button', {
      name: 'Open FWA diagnostics',
    })
    const initial = await trigger.boundingBox()
    if (!initial) {
      throw new Error('debug trigger is not measurable')
    }
    const session = await context.newCDPSession(page)
    const start = {
      x: initial.x + initial.width / 2,
      y: initial.y + initial.height / 2,
    }
    const target = { x: 48, y: 240 }
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...start, id: 1 }],
    })
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: target.x + initial.width / 2,
          y: target.y + initial.height / 2,
          id: 1,
        },
      ],
    })
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })
    await session.detach()

    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('__fwa_debug_position')),
      )
      .not.toBeNull()
    const stored = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('__fwa_debug_position') ?? 'null') as {
          right: number
          bottom: number
        } | null,
    )
    const viewport = page.viewportSize()
    expect(
      Math.abs(
        (stored?.right ?? 0) -
          (viewport!.width - target.x - initial.width),
      ),
    ).toBeLessThan(2)
    expect(
      Math.abs(
        (stored?.bottom ?? 0) -
          (viewport!.height - target.y - initial.height),
      ),
    ).toBeLessThan(2)
  })

  test('switches network mode and clears diagnostics from panel controls', async ({
    page,
  }) => {
    await page.goto('/library/?view=all&__fwa_debug=1#recent')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    await page.getByRole('button', { name: 'Open FWA diagnostics' }).click()
    const dialog = page.getByRole('dialog', { name: 'FWA diagnostics' })
    await dialog.getByRole('button', { name: 'Use network' }).click()
    await expectNetworkMode(page, {
      pathname: '/library/',
      query: { view: 'all', __fwa_debug: '1' },
      hash: '#recent',
    })

    await page.getByRole('button', { name: 'Open FWA diagnostics' }).click()
    await dialog.getByRole('button', { name: 'Use Local Edge' }).click()
    await expect
      .poll(() => new URL(page.url()).searchParams.get('__fwa'))
      .toBeNull()
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
    )

    await page.getByRole('button', { name: 'Open FWA diagnostics' }).click()
    await page.evaluate(() => {
      localStorage.setItem(
        '__fwa_debug_position',
        JSON.stringify({ right: 300, bottom: 200 }),
      )
    })
    await dialog.getByRole('button', { name: 'Hide', exact: true }).click()
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(0)
    expect(
      await page.evaluate(() => ({
        preference: localStorage.getItem('__fwa_debug'),
        query: new URL(window.location.href).searchParams.get('__fwa_debug'),
      })),
    ).toEqual({ preference: null, query: null })

    await page.goto('/library/')
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(0)

    await page.goto('/library/?__fwa_debug=reset#recovered')
    await expect(page.locator('#__fwa-debug-root')).toHaveCount(1)
    await expect(page).toHaveURL('/library/#recovered')
    expect(
      await page.evaluate(() => ({
        position: localStorage.getItem('__fwa_debug_position'),
        preference: localStorage.getItem('__fwa_debug'),
        query: new URL(window.location.href).searchParams.get('__fwa_debug'),
      })),
    ).toEqual({ position: null, preference: '1', query: null })
  })

  test('renders the SPA-owned not-found route for unknown navigation', async ({
    page,
  }) => {
    await page.goto('/missing-route')

    await expect(page.locator('[data-app-ready="true"]')).toHaveAttribute(
      'data-navigation-disposition',
      'app-not-found',
    )
    await expect(page.locator('[data-app-not-found]')).toBeVisible()
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )
  })

  test('launches the committed release after the network goes offline', async ({
    context,
    page,
  }) => {
    await page.addInitScript(() => {
      const originalRegister = navigator.serviceWorker.register.bind(
        navigator.serviceWorker,
      )
      navigator.serviceWorker.register = (scriptURL, options) => {
        const count = Number(sessionStorage.getItem('fwa-register-count') ?? 0)
        sessionStorage.setItem('fwa-register-count', String(count + 1))
        return originalRegister(scriptURL, options)
      }
    })
    await page.goto('/')
    const runtime = page.locator('[data-local-edge-status]')
    await expect(runtime).toHaveAttribute('data-local-edge-status', 'ready', {
      timeout: 20_000,
    })
    const releaseId = await runtime.locator('dd').nth(1).textContent()

    const installedState = await page.evaluate(async () => {
      const cacheNames = await caches.keys()
      const cacheEntries = Object.fromEntries(
        await Promise.all(
          cacheNames.map(async (cacheName) => {
            const cache = await caches.open(cacheName)
            return [
              cacheName,
              (await cache.keys()).map((request) => new URL(request.url).pathname),
            ]
          }),
        ),
      )

      return {
        controlled: Boolean(navigator.serviceWorker.controller),
        cacheEntries,
        snapshot: await fetch('/__fwa/state').then((response) => response.json()),
      }
    })
    expect(installedState.controlled).toBe(true)
    expect(
      Object.values(installedState.cacheEntries).flat(),
    ).toContain('/')
    expect(
      Object.values(installedState.cacheEntries).flat(),
    ).toContain('/favicon.svg')
    expect(
      Object.values(installedState.cacheEntries).flat(),
    ).toContain('/__fwa/loader.js')
    expect(installedState.snapshot).toMatchObject({
      mode: 'active',
      release: { releaseId },
    })
    expect(
      await page.evaluate(() => sessionStorage.getItem('fwa-register-count')),
    ).toBe('1')

    const repeatedLoaderState = await page.evaluate(async () => {
      const testWindow = window as typeof window & {
        __fwa?: { localEdge?: unknown }
      }
      const initialLocalEdge = testWindow.__fwa?.localEdge
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = '/__fwa/loader.js'
        script.onload = () => resolve()
        script.onerror = () => reject(new Error('repeated loader failed'))
        document.head.append(script)
      })
      return {
        sameLocalEdge: initialLocalEdge === testWindow.__fwa?.localEdge,
        registerCount: sessionStorage.getItem('fwa-register-count'),
      }
    })
    expect(repeatedLoaderState).toEqual({
      sameLocalEdge: true,
      registerCount: '1',
    })

    await context.setOffline(true)
    await expect
      .poll(() => page.evaluate(() => fetch('/__fwa/state').then((response) => response.ok)))
      .toBe(true)
    await page.reload()

    await expect(page.locator('[data-app-ready="true"]')).toBeVisible()
    await expect(runtime).toHaveAttribute('data-local-edge-status', 'ready')
    await expect(runtime.locator('dd').nth(1)).toHaveText(releaseId ?? '')
    expect(
      await page.evaluate(() =>
        fetch('/favicon.svg').then((response) => ({
          contentType: response.headers.get('Content-Type'),
          status: response.status,
        })),
      ),
    ).toMatchObject({ contentType: 'image/svg+xml', status: 200 })
    expect(
      await page.evaluate(() => sessionStorage.getItem('fwa-register-count')),
    ).toBe('1')

    await context.setOffline(false)
  })

  test('keeps the host worker entry while composing the Local Edge kernel', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    const hostState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/')
      return {
        ping: await fetch('/__fwa/host-ping').then((response) =>
          response.json(),
        ),
        scriptPath: registration?.active
          ? new URL(registration.active.scriptURL).pathname
          : undefined,
      }
    })
    expect(hostState).toEqual({
      ping: { host: 'reference-worker', kernelComposed: true },
      scriptPath: '/__fwa-sw.js',
    })
  })

  test('keeps the app URL in uncontrolled and controlled network mode', async ({
    page,
  }) => {
    const networkUrl = '/library/?view=all&__fwa=network#recent'
    await page.goto(networkUrl)
    await expectNetworkMode(page, {
      pathname: '/library/',
      query: { view: 'all' },
      hash: '#recent',
    })
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'network-only',
    )
    await expect
      .poll(() =>
        page.evaluate(async () =>
          Boolean(await navigator.serviceWorker.getRegistration('/')),
        ),
      )
      .toBe(false)

    await page.goto('/library/?view=all')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    await page.goto(networkUrl)
    await expectNetworkMode(page, {
      pathname: '/library/',
      query: { view: 'all' },
      hash: '#recent',
    })
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'network-only',
    )
    await expect
      .poll(() =>
        page.evaluate(async () =>
          Boolean(await navigator.serviceWorker.getRegistration('/')),
        ),
      )
      .toBe(true)

    await page.goto('/library/?view=all')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )
    expect(new URL(page.url()).searchParams.has('__fwa')).toBe(false)
  })

  test('boots without React through a non-root loader scope', async ({
    context,
    page,
  }) => {
    test.skip(isRemoteRun, 'requires the local scoped build fixture')

    await page.goto('/scoped/')
    const fixture = page.locator('[data-scoped-fixture]')
    await expect(fixture).toBeVisible()
    await expect(fixture).toHaveAttribute('data-local-edge-phase', 'ready', {
      timeout: 20_000,
    })
    await expect(page.locator('[data-app-ready]')).toHaveCount(0)

    const fixtureState = await page.evaluate(async () => {
      const testWindow = window as typeof window & {
        __fwa?: {
          q: {
            push(command: readonly [string, (state: unknown) => void]): number
          }
          localEdge?: {
            getState(): { phase: string; controlled: boolean }
            paths: Record<string, string>
          }
        }
        __fwaQueuedState?: unknown
        __fwaObservedStates?: { phase: string }[]
      }
      testWindow.__fwa?.q.push([
        'localEdge.getState',
        (state) => {
          testWindow.__fwaQueuedState = state
        },
      ])
      const snapshot = await fetch('/scoped/__fwa/state').then((response) =>
        response.json(),
      )
      const registration = await navigator.serviceWorker.getRegistration(
        '/scoped/',
      )
      return {
        observedPhases: testWindow.__fwaObservedStates?.map(
          ({ phase }) => phase,
        ),
        paths: testWindow.__fwa?.localEdge?.paths,
        queuedState: testWindow.__fwaQueuedState,
        runtimeState: testWindow.__fwa?.localEdge?.getState(),
        scopePath: registration
          ? new URL(registration.scope).pathname
          : undefined,
        scriptPath: registration?.active
          ? new URL(registration.active.scriptURL).pathname
          : undefined,
        snapshot,
      }
    })
    expect(fixtureState).toMatchObject({
      paths: {
        controlPrefix: '/scoped/__fwa',
        descriptorPath: '/scoped/__fwa/release.json',
        loaderPath: '/scoped/__fwa/loader.js',
        scopePath: '/scoped/',
        workerPath: '/scoped/__fwa-sw.js',
      },
      queuedState: { controlled: true, phase: 'ready' },
      runtimeState: { controlled: true, phase: 'ready' },
      scopePath: '/scoped/',
      scriptPath: '/scoped/__fwa-sw.js',
      snapshot: {
        mode: 'active',
        release: { appId: 'fwa-scoped-fixture' },
      },
    })
    expect(fixtureState.observedPhases).toContain('ready')

    await context.setOffline(true)
    await page.reload()
    await expect(fixture).toHaveAttribute('data-local-edge-phase', 'ready', {
      timeout: 20_000,
    })
    await expect(page.locator('[data-app-ready]')).toHaveCount(0)
    await context.setOffline(false)
  })

  test('replaces a legacy worker without entering a reload loop', async ({
    page,
  }) => {
    test.skip(isRemoteRun, 'requires the local legacy worker fixture')

    await page.addInitScript(() => {
      const loadCount = Number(
        sessionStorage.getItem('fwa-document-load-count') ?? 0,
      )
      sessionStorage.setItem(
        'fwa-document-load-count',
        String(loadCount + 1),
      )
    })
    await page.goto('/?__fwa=network')
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register(
        '/legacy-worker.js',
        { scope: '/' },
      )
      if (!registration.active) {
        await new Promise<void>((resolve, reject) => {
          const worker = registration.installing ?? registration.waiting
          if (!worker) {
            reject(new Error('legacy worker did not start installing'))
            return
          }
          const handleStateChange = () => {
            if (worker.state === 'activated') {
              resolve()
            } else if (worker.state === 'redundant') {
              reject(new Error('legacy worker became redundant'))
            }
          }
          worker.addEventListener('statechange', handleStateChange)
          handleStateChange()
        })
      }
    })

    await page.goto('/')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    const migrationState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/')
      const stateResponse = await fetch('/__fwa/state')
      return {
        activePath: registration?.active
          ? new URL(registration.active.scriptURL).pathname
          : undefined,
        controlledPath: navigator.serviceWorker.controller
          ? new URL(navigator.serviceWorker.controller.scriptURL).pathname
          : undefined,
        loadCount: sessionStorage.getItem('fwa-document-load-count'),
        probe: stateResponse.headers.get('X-FWA-Kernel'),
        waitingPath: registration?.waiting
          ? new URL(registration.waiting.scriptURL).pathname
          : undefined,
      }
    })
    expect(migrationState).toEqual({
      activePath: '/__fwa-sw.js',
      controlledPath: '/__fwa-sw.js',
      loadCount: '3',
      probe: '/__fwa-sw.js',
      waitingPath: undefined,
    })
  })

  test('resets Local Edge-owned state and enters the network escape hatch', async ({
    page,
  }) => {
    await page.goto('/library/?view=all#recent')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    await page.getByRole('button', { name: 'Reset Local Edge' }).click()
    await expectNetworkMode(page, {
      pathname: '/library/',
      query: { view: 'all' },
      hash: '#recent',
    })

    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'network-only',
    )
    const localEdgeState = await page.evaluate(async () => ({
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      releaseCaches: (await caches.keys()).filter((cacheName) =>
        cacheName.startsWith('fwa-local-edge:fwa-local-edge-demo:release:'),
      ),
    }))
    expect(localEdgeState).toEqual({ registrations: 0, releaseCaches: [] })
  })

  test('shows a kernel fallback when a committed release loses an asset', async ({
    context,
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    await page.evaluate(async () => {
      const cacheName = (await caches.keys()).find((name) =>
        name.startsWith('fwa-local-edge:fwa-local-edge-demo:release:'),
      )
      if (!cacheName) {
        throw new Error('release cache is missing')
      }

      const releaseCache = await caches.open(cacheName)
      const assetRequest = (await releaseCache.keys()).find(({ url }) =>
        new URL(url).pathname.endsWith('.js'),
      )
      if (!assetRequest || !(await releaseCache.delete(assetRequest))) {
        throw new Error('failed to remove a release asset')
      }
    })

    await context.setOffline(true)
    await page.reload()

    const fallback = page.locator('[data-kernel-fallback]')
    await expect(fallback).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Local Edge could not start' }),
    ).toBeVisible()
    await expect(fallback).toHaveAttribute(
      'data-fallback-reason',
      'release-incomplete',
    )

    await context.setOffline(false)
    await page.getByRole('link', { name: 'Open network entry' }).click()
    await expectNetworkMode(page)
    await expect(page.locator('[data-app-ready="true"]')).toBeVisible()
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'network-only',
    )
  })

  test('keeps reset available without the React release UI', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    const untrustedResetStatus = await page.evaluate(() =>
      fetch('/?__fwa=reset', { method: 'POST' }).then(
        (response) => response.status,
      ),
    )
    expect(untrustedResetStatus).toBe(403)

    await page.goto('/library/?view=all&__fwa_debug=1')
    await page.getByRole('button', { name: 'Open FWA diagnostics' }).click()
    await page
      .getByRole('dialog', { name: 'FWA diagnostics' })
      .getByRole('button', { name: 'Reset', exact: true })
      .click()
    await expect(page.locator('[data-kernel-reset-confirmation]')).toBeVisible()
    await expect(
      page.getByText('Only FWA-owned state is removed.'),
    ).toBeVisible()
    await page.getByRole('link', { name: 'Cancel' }).click()
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
    )

    await page.getByRole('button', { name: 'Open FWA diagnostics' }).click()
    await page
      .getByRole('dialog', { name: 'FWA diagnostics' })
      .getByRole('button', { name: 'Reset', exact: true })
      .click()
    await page.setViewportSize({ width: 390, height: 844 })
    const resetButton = page.getByRole('button', { name: 'Reset Local Edge' })
    const cancelButton = page.getByRole('link', { name: 'Cancel' })
    const resetBox = await resetButton.boundingBox()
    const cancelBox = await cancelButton.boundingBox()
    expect(resetBox?.width).toBeGreaterThan(280)
    expect(cancelBox?.width).toBeGreaterThan(280)
    await page.getByRole('button', { name: 'Reset Local Edge' }).click()
    await expectNetworkMode(page, {
      pathname: '/library/',
      query: { view: 'all', __fwa_debug: '1' },
    })

    const localEdgeState = await page.evaluate(async () => ({
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      releaseCaches: (await caches.keys()).filter((cacheName) =>
        cacheName.startsWith('fwa-local-edge:fwa-local-edge-demo:release:'),
      ),
    }))
    expect(localEdgeState).toEqual({ registrations: 0, releaseCaches: [] })
  })

  test('falls back when release metadata cannot be opened', async ({
    context,
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )

    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('fwa-local-edge:fwa-local-edge-demo', 2)
          request.onsuccess = () => {
            request.result.close()
            resolve()
          }
          request.onerror = () => reject(request.error)
        }),
    )

    await context.setOffline(true)
    await page.reload()

    await expect(page.locator('[data-kernel-fallback]')).toHaveAttribute(
      'data-fallback-reason',
      'kernel-state-unavailable',
    )
    await context.setOffline(false)
  })

  test('revalidates an app-only release without changing the kernel', async ({
    browser,
  }) => {
    const releaseServer = await startReleaseUpdateServer()
    const context = await browser.newContext()
    const page = await context.newPage()

    try {
      await page.goto(releaseServer.baseUrl)
      const runtime = page.locator('[data-local-edge-status]')
      await expect(runtime).toHaveAttribute('data-local-edge-status', 'ready', {
        timeout: 20_000,
      })
      await expect(runtime.locator('dd').nth(1)).toHaveText(
        releaseServer.initialReleaseId,
      )
      const initialKernelDigest = await readKernelDigest(page)
      expect(
        await page.evaluate(() =>
          fetch('/__fwa/revalidate', { method: 'POST' }).then(
            (response) => response.status,
          ),
        ),
      ).toBe(403)

      const switchResponse = await page.evaluate(() =>
        fetch('/__test/switch-release', { method: 'POST' }).then((response) =>
          response.json(),
        ),
      )
      expect(switchResponse).toEqual({
        updatedReleaseId: releaseServer.updatedReleaseId,
      })

      await page.evaluate(() => {
        const testWindow = globalThis as typeof globalThis & {
          __fwa?: { localEdge?: { revalidate(): Promise<void> } }
        }
        return testWindow.__fwa?.localEdge?.revalidate()
      })
      await reloadAvailableUpdate(page)
      await expect(page.locator('meta[name="fwa-test-release"]')).toHaveAttribute(
        'content',
        'app-update',
        { timeout: 20_000 },
      )
      await expect(runtime).toHaveAttribute('data-local-edge-status', 'ready')
      await expect(runtime.locator('dd').nth(1)).toHaveText(
        releaseServer.updatedReleaseId,
      )
      expect(await readKernelDigest(page)).toBe(initialKernelDigest)
    } finally {
      await context.close()
      await releaseServer.close()
    }
  })

  test('fails open to network when the release flag disables Local Edge', async ({
    browser,
  }) => {
    const releaseServer = await startReleaseUpdateServer()
    const context = await browser.newContext()
    const page = await context.newPage()

    try {
      await page.goto(releaseServer.baseUrl)
      const runtime = page.locator('[data-local-edge-status]')
      await expect(runtime).toHaveAttribute('data-local-edge-status', 'ready', {
        timeout: 20_000,
      })

      expect(
        await page.evaluate(() =>
          fetch('/__test/disable-local-edge', { method: 'POST' }).then(
            (response) => response.json(),
          ),
        ),
      ).toEqual({ localEdgeEnabled: false })
      await page.evaluate(() => {
        const testWindow = window as typeof window & {
          __fwa?: { localEdge?: { revalidate(): Promise<void> } }
        }
        return testWindow.__fwa?.localEdge?.revalidate()
      })

      await expect(
        page.locator('meta[name="fwa-test-network-bypass"]'),
      ).toHaveAttribute('content', 'disabled', { timeout: 20_000 })
      await expect(runtime).toHaveAttribute(
        'data-local-edge-status',
        'network-only',
      )
      expect(
        await page.evaluate(() =>
          fetch('/__fwa/state').then((response) => response.json()),
        ),
      ).toMatchObject({
        localEdgeEnabled: false,
        mode: 'disabled',
        release: { releaseId: releaseServer.initialReleaseId },
      })

      expect(
        await page.evaluate(() =>
          fetch('/__test/enable-local-edge', { method: 'POST' }).then(
            (response) => response.json(),
          ),
        ),
      ).toEqual({ localEdgeEnabled: true })
      const enableResult = await page.evaluate(() =>
        fetch('/__fwa/revalidate', {
          method: 'POST',
          headers: { 'X-FWA-Control': 'revalidate' },
        }).then((response) => response.json()),
      )
      expect(enableResult).toMatchObject({
        localEdgeEnabled: true,
        status: 'enabled',
      })
      expect(
        await page.evaluate(() =>
          fetch('/__fwa/state').then((response) => response.json()),
        ),
      ).toMatchObject({
        localEdgeEnabled: true,
        mode: 'active',
        release: { releaseId: releaseServer.initialReleaseId },
      })

      await context.setOffline(true)
      await page.reload()
      await expect(page.locator('[data-app-ready="true"]')).toBeVisible()
      await expect(runtime).toHaveAttribute('data-local-edge-status', 'ready')
      await context.setOffline(false)
    } finally {
      await context.setOffline(false)
      await context.close()
      await releaseServer.close()
    }
  })

  test('opens stale, commits the complete update, and opens latest next time', async ({
    browser,
  }) => {
    const releaseServer = await startReleaseUpdateServer({
      candidateFault: 'slow-asset',
    })
    const context = await browser.newContext()
    const page = await context.newPage()

    try {
      await page.goto(`${releaseServer.baseUrl}/?__fwa_debug=1`)
      const runtime = page.locator('[data-local-edge-status]')
      await expect(runtime).toHaveAttribute('data-local-edge-status', 'ready', {
        timeout: 20_000,
      })
      await expect
        .poll(() =>
          page.evaluate(() => {
            const testWindow = globalThis as typeof globalThis & {
              __fwa?: {
                localEdge?: { getState(): { revalidating: boolean } }
              }
            }
            return testWindow.__fwa?.localEdge?.getState().revalidating
          }),
        )
        .toBe(false)
      const debugTrigger = page.getByRole('button', {
        name: 'Open FWA diagnostics',
      })
      await debugTrigger.click()
      const diagnostics = page.getByRole('dialog', {
        name: 'FWA diagnostics',
      })
      const checkButton = diagnostics.getByRole('button', {
        name: 'Check again',
      })
      await page.evaluate(() =>
        fetch('/__test/switch-release', { method: 'POST' }),
      )
      await page.evaluate(() => {
        const testWindow = globalThis as typeof globalThis & {
          sessionSentinel?: string
        }
        testWindow.sessionSentinel = 'preserved'
      })
      await checkButton.click()
      await releaseServer.waitForCandidateAssetRequest()
      await expect(runtime).toHaveAttribute('data-local-edge-status', 'ready')
      await expect(runtime.locator('dd').nth(1)).toHaveText(
        releaseServer.initialReleaseId,
      )
      await expect
        .poll(() =>
          page.evaluate(() => {
            const testWindow = globalThis as typeof globalThis & {
              __fwa?: {
                localEdge?: { getState(): { revalidating: boolean } }
              }
            }
            return testWindow.__fwa?.localEdge?.getState().revalidating
          }),
        )
        .toBe(true)
      await expect(debugTrigger).toHaveAttribute(
        'data-installation',
        'updating',
      )
      await expect(debugTrigger).toHaveAttribute(
        'aria-label',
        'Open FWA diagnostics (updating)',
      )

      releaseServer.releaseCandidateAsset()
      await expect(checkButton).toBeEnabled({ timeout: 20_000 })
      await expect
        .poll(() =>
          page.evaluate(() => {
            const testWindow = globalThis as typeof globalThis & {
              __fwa?: {
                localEdge?: {
                  getState(): {
                    availableReleaseId?: string
                    releaseId?: string
                    revalidating: boolean
                    updateAvailable: boolean
                  }
                }
              }
              sessionSentinel?: string
            }
            return {
              sentinel: testWindow.sessionSentinel,
              state: testWindow.__fwa?.localEdge?.getState(),
            }
          }),
        )
        .toMatchObject({
          sentinel: 'preserved',
          state: {
            availableReleaseId: releaseServer.updatedReleaseId,
            releaseId: releaseServer.initialReleaseId,
            revalidating: false,
            updateAvailable: true,
          },
        })
      await expect(diagnostics.locator('.message')).toHaveText(
        '新 release 已完整缓存。当前会话继续运行原版本；点击 Reload 后启用。',
      )
      await expect(debugTrigger).toHaveAttribute('data-notice', 'update')
      await expect(debugTrigger).toHaveAttribute(
        'aria-label',
        'Open FWA diagnostics (installed, update ready)',
      )
      const noticeGeometry = await debugTrigger.evaluate((element) => {
        const trigger = element as HTMLElement
        const triggerStyle = getComputedStyle(trigger)
        const notice = getComputedStyle(element, '::after')
        const borderWidth = Number.parseFloat(triggerStyle.borderTopWidth)
        const height = Number.parseFloat(notice.height)
        const right = Number.parseFloat(notice.right)
        const top = Number.parseFloat(notice.top)
        const width = Number.parseFloat(notice.width)
        const triggerCenter = trigger.offsetWidth / 2
        const noticeCenterX =
          trigger.offsetWidth - borderWidth - right - width / 2
        const noticeCenterY = borderWidth + top + height / 2
        return {
          borderCenterRadius: triggerCenter - borderWidth / 2,
          centerDistance: Math.hypot(
            noticeCenterX - triggerCenter,
            noticeCenterY - triggerCenter,
          ),
          height,
          right,
          top,
          width,
        }
      })
      expect(noticeGeometry).toMatchObject({
        height: 8,
        right: 0.5,
        top: 0.5,
        width: 8,
      })
      expect(
        Math.abs(
          noticeGeometry.centerDistance - noticeGeometry.borderCenterRadius,
        ),
      ).toBeLessThan(0.25)
      await expect(page.locator('meta[name="fwa-test-release"]')).toHaveCount(0)
      await page.evaluate(() => {
        const testWindow = globalThis as typeof globalThis & {
          __fwa?: { localEdge?: { revalidate(): Promise<void> } }
        }
        return testWindow.__fwa?.localEdge?.revalidate()
      })
      expect(
        await page.evaluate(async (assetPath) => {
          const releaseModule = (await import(assetPath)) as {
            releaseMarker: string
          }
          return releaseModule.releaseMarker
        }, releaseServer.initialLazyAssetPath),
      ).toBe('release-a')

      await page.close()
      await context.setOffline(true)
      const secondPage = await context.newPage()
      await secondPage.goto(releaseServer.baseUrl)
      await expect(
        secondPage.locator('meta[name="fwa-test-release"]'),
      ).toHaveAttribute('content', 'app-update')
      await expect(
        secondPage.locator('[data-local-edge-status] dd').nth(1),
      ).toHaveText(releaseServer.updatedReleaseId)

      const secondOpenRelease = await secondPage.evaluate(async () => {
        const snapshot = (await fetch('/__fwa/state').then((response) =>
          response.json(),
        )) as {
          release?: {
            assets?: { path: string }[]
            releaseId: string
          }
        }
        const release = snapshot.release
        if (!release?.assets) {
          throw new Error('verified active release is missing')
        }
        const cacheName = (await caches.keys()).find((name) =>
          name.endsWith(`:release:${release.releaseId}`),
        )
        if (!cacheName) {
          throw new Error('active release cache is missing')
        }
        const cache = await caches.open(cacheName)
        const cachedAssets = await Promise.all(
          release.assets.map(({ path }) => cache.match(path)),
        )
        return {
          assetCount: release.assets.length,
          cachedAssetCount: cachedAssets.filter(Boolean).length,
          releaseId: release.releaseId,
        }
      })
      expect(secondOpenRelease.releaseId).toBe(releaseServer.updatedReleaseId)
      expect(secondOpenRelease.assetCount).toBeGreaterThan(0)
      expect(secondOpenRelease.cachedAssetCount).toBe(
        secondOpenRelease.assetCount,
      )
    } finally {
      releaseServer.releaseCandidateAsset()
      await context.setOffline(false)
      await context.close()
      await releaseServer.close()
    }
  })

  test('applies a ready update only after an explicit user action', async ({
    browser,
  }) => {
    const releaseServer = await startReleaseUpdateServer()
    const context = await browser.newContext()
    const page = await context.newPage()

    try {
      await page.goto(`${releaseServer.baseUrl}/?view=all#session`)
      const runtime = page.locator('[data-local-edge-status]')
      await expect(runtime).toHaveAttribute('data-local-edge-status', 'ready', {
        timeout: 20_000,
      })
      await page.evaluate(() =>
        fetch('/__test/switch-release', { method: 'POST' }),
      )
      await page.evaluate(() => {
        const testWindow = globalThis as typeof globalThis & {
          __fwa?: { localEdge?: { revalidate(): Promise<void> } }
        }
        return testWindow.__fwa?.localEdge?.revalidate()
      })

      await expect(
        page.getByRole('button', { name: 'Review available update' }),
      ).toBeEnabled()
      await expect(runtime.locator('dd').nth(1)).toHaveText(
        releaseServer.initialReleaseId,
      )
      await expect(runtime.locator('dd').nth(2)).toHaveText(
        releaseServer.updatedReleaseId,
      )

      await reloadAvailableUpdate(page)
      await expect(page).toHaveURL(
        `${releaseServer.baseUrl}/?view=all#session`,
      )
      await expect(
        page.locator('meta[name="fwa-test-release"]'),
      ).toHaveAttribute('content', 'app-update')
      await expect(runtime.locator('dd').nth(1)).toHaveText(
        releaseServer.updatedReleaseId,
      )
      await expect(
        page.getByRole('button', { name: 'No update available' }),
      ).toBeDisabled()
    } finally {
      await context.close()
      await releaseServer.close()
    }
  })

  test('exposes kernel-level revalidation progress and commit broadcasts', async ({
    browser,
  }) => {
    const releaseServer = await startReleaseUpdateServer({
      candidateFault: 'slow-asset',
    })
    const context = await browser.newContext()
    const page = await context.newPage()

    try {
      await page.goto(`${releaseServer.baseUrl}/?__fwa_debug=1`)
      const runtime = page.locator('[data-local-edge-status]')
      await expect(runtime).toHaveAttribute('data-local-edge-status', 'ready', {
        timeout: 20_000,
      })
      await expect
        .poll(() =>
          page.evaluate(() => {
            const testWindow = globalThis as typeof globalThis & {
              __fwa?: {
                localEdge?: { getState(): { revalidating: boolean } }
              }
            }
            return testWindow.__fwa?.localEdge?.getState().revalidating
          }),
        )
        .toBe(false)

      await page.evaluate(() => {
        const testWindow = globalThis as typeof globalThis & {
          __fwaCommittedReleaseIds?: string[]
        }
        testWindow.__fwaCommittedReleaseIds = []
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (
            event.source instanceof ServiceWorker &&
            new URL(event.source.scriptURL).pathname === '/__fwa-sw.js' &&
            typeof event.data === 'object' &&
            event.data !== null &&
            (event.data as { type?: unknown }).type ===
              '__fwa:revalidation-committed'
          ) {
            const releaseId = (event.data as { releaseId?: unknown }).releaseId
            if (typeof releaseId === 'string') {
              testWindow.__fwaCommittedReleaseIds?.push(releaseId)
            }
          }
        })
      })
      // The committed listener above is registered from the document, which
      // also receives the loader's own broadcasts.
      const readCommittedMessages = () =>
        page.evaluate(() => {
          const testWindow = globalThis as typeof globalThis & {
            __fwaCommittedReleaseIds?: string[]
          }
          return testWindow.__fwaCommittedReleaseIds ?? []
        })

      await page.evaluate(() =>
        fetch('/__test/switch-release', { method: 'POST' }),
      )
      await page.evaluate(() => {
        const testWindow = globalThis as typeof globalThis & {
          pendingRevalidation?: Promise<number>
          __fwa?: { localEdge?: { revalidate(): Promise<unknown> } }
        }
        // Keep the POST pending while the slow candidate asset is gated so the
        // test can observe the in-flight kernel install.
        testWindow.pendingRevalidation = testWindow.__fwa?.localEdge
          ?.revalidate()
          .then(
            () => 200,
            () => 503,
          ) as Promise<number>
      })

      // While the slow asset is gated, the kernel reports an in-flight install.
      await releaseServer.waitForCandidateAssetRequest()
      const midInstallState = await page.evaluate(async () => {
        const snapshot = (await fetch('/__fwa/state').then((response) =>
          response.json(),
        )) as {
          revalidation?: {
            completedAssets: number
            releaseId: string
            totalAssets: number
          }
        }
        const revalidation = snapshot.revalidation
        if (!revalidation) {
          return undefined
        }
        return {
          completedAssets: revalidation.completedAssets,
          releaseId: revalidation.releaseId,
          totalAssets: revalidation.totalAssets,
        }
      })
      expect(midInstallState).toMatchObject({
        releaseId: releaseServer.updatedReleaseId,
      })
      expect(midInstallState?.completedAssets).toBeGreaterThanOrEqual(0)
      expect(midInstallState?.completedAssets).toBeLessThanOrEqual(
        midInstallState?.totalAssets ?? Number.MAX_SAFE_INTEGER,
      )
      expect(Number.isSafeInteger(midInstallState?.completedAssets)).toBe(true)
      expect(Number.isSafeInteger(midInstallState?.totalAssets)).toBe(true)

      releaseServer.releaseCandidateAsset()
      await expect
        .poll(readCommittedMessages)
        .toContain(releaseServer.updatedReleaseId)

      // After the commit, the kernel no longer reports an in-flight install.
      await expect
        .poll(async () => {
          const snapshot = await page.evaluate(() =>
            fetch('/__fwa/state').then((response) => response.json()),
          )
          return (snapshot as { revalidation?: unknown }).revalidation
        })
        .toBeUndefined()
    } finally {
      releaseServer.releaseCandidateAsset()
      await context.close()
      await releaseServer.close()
    }
  })

  test('reset aborts an in-flight candidate before clearing state', async ({
    browser,
  }) => {
    const releaseServer = await startReleaseUpdateServer({
      candidateFault: 'slow-asset',
    })
    const context = await browser.newContext()
    const page = await context.newPage()

    try {
      await page.goto(releaseServer.baseUrl)
      await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
        'data-local-edge-status',
        'ready',
        { timeout: 20_000 },
      )
      await page.evaluate(() =>
        fetch('/__test/switch-release', { method: 'POST' }),
      )
      await page.evaluate(() => {
        const testWindow = globalThis as typeof globalThis & {
          pendingRevalidation?: Promise<number>
        }
        testWindow.pendingRevalidation = fetch('/__fwa/revalidate', {
          method: 'POST',
          headers: { 'X-FWA-Control': 'revalidate' },
        }).then((response) => response.status)
      })

      await releaseServer.waitForCandidateAssetRequest()
      const resetStatus = await page.evaluate(() =>
        fetch('/?__fwa=reset', {
          method: 'POST',
          headers: { 'X-FWA-Control': 'reset' },
        }).then((response) => response.status),
      )
      releaseServer.releaseCandidateAsset()

      expect(resetStatus).toBe(200)
      expect(
        await page.evaluate(() => {
          const testWindow = globalThis as typeof globalThis & {
            pendingRevalidation?: Promise<number>
          }
          return testWindow.pendingRevalidation
        }),
      ).toBe(503)
      await expect
        .poll(() =>
          page.evaluate(async () => ({
            registrations: (await navigator.serviceWorker.getRegistrations())
              .length,
            releaseCaches: (await caches.keys()).filter((cacheName) =>
              cacheName.startsWith('fwa-local-edge:fwa-local-edge-demo:release:'),
            ),
            metadataDatabases: (await indexedDB.databases()).filter(
              ({ name }) => name === 'fwa-local-edge:fwa-local-edge-demo',
            ).length,
          })),
        )
        .toEqual({
          registrations: 0,
          releaseCaches: [],
          metadataDatabases: 0,
        })
    } finally {
      releaseServer.releaseCandidateAsset()
      await context.close()
      await releaseServer.close()
    }
  })

  test('retains an older release until its last client exits', async ({
    browser,
  }) => {
    const releaseServer = await startReleaseUpdateServer()
    const context = await browser.newContext()
    const previousPage = await context.newPage()
    const updatedPage = await context.newPage()

    try {
      await previousPage.goto(releaseServer.baseUrl)
      await expect(previousPage.locator('[data-local-edge-status]')).toHaveAttribute(
        'data-local-edge-status',
        'ready',
        { timeout: 20_000 },
      )
      await previousPage.evaluate(() =>
        fetch('/__test/switch-release', { method: 'POST' }),
      )

      await updatedPage.goto(releaseServer.baseUrl)
      const updatedRuntime = updatedPage.locator('[data-local-edge-status]')
      await reloadAvailableUpdate(updatedPage)
      await expect(
        updatedPage.locator('meta[name="fwa-test-release"]'),
      ).toHaveAttribute('content', 'app-update', { timeout: 20_000 })
      await expect(updatedRuntime).toHaveAttribute('data-local-edge-status', 'ready')

      const transitionState = await updatedPage.evaluate(() =>
        fetch('/__fwa/state').then((response) => response.json()),
      )
      expect(transitionState).toMatchObject({
        release: { releaseId: releaseServer.updatedReleaseId },
        retainedReleases: [
          { releaseId: releaseServer.initialReleaseId },
        ],
      })
      expect(
        await previousPage.evaluate(async (assetPath) => {
          const releaseModule = (await import(assetPath)) as {
            releaseMarker: string
          }
          return releaseModule.releaseMarker
        }, releaseServer.initialLazyAssetPath),
      ).toBe('release-a')

      await previousPage.close()
      const collectionResult = await updatedPage.evaluate(() =>
        fetch('/__fwa/revalidate', {
          method: 'POST',
          headers: { 'X-FWA-Control': 'revalidate' },
        }).then((response) => response.json()),
      )
      expect(collectionResult).toMatchObject({ status: 'current' })

      await expect
        .poll(() =>
          updatedPage.evaluate(async (previousReleaseId) => {
            const snapshot = await fetch('/__fwa/state').then((response) =>
              response.json(),
            )
            const cacheNames = await caches.keys()
            return {
              hasRetainedRelease: snapshot.retainedReleases.some(
                (release: { releaseId: string }) =>
                  release.releaseId === previousReleaseId,
              ),
              hasRetainedCache: cacheNames.includes(
                `fwa-local-edge:fwa-local-edge-demo:release:${previousReleaseId}`,
              ),
            }
          }, releaseServer.initialReleaseId),
        )
        .toEqual({ hasRetainedRelease: false, hasRetainedCache: false })
    } finally {
      await context.close()
      await releaseServer.close()
    }
  })

  test('installs a third release while older clients stay pinned', async ({
    browser,
  }) => {
    const releaseServer = await startReleaseUpdateServer()
    const context = await browser.newContext()
    const previousPage = await context.newPage()
    const activePage = await context.newPage()

    try {
      await previousPage.goto(releaseServer.baseUrl)
      await expect(previousPage.locator('[data-local-edge-status]')).toHaveAttribute(
        'data-local-edge-status',
        'ready',
        { timeout: 20_000 },
      )
      await activePage.goto(releaseServer.baseUrl)
      await expect(activePage.locator('[data-local-edge-status]')).toHaveAttribute(
        'data-local-edge-status',
        'ready',
        { timeout: 20_000 },
      )

      await activePage.evaluate(() =>
        fetch('/__test/switch-release', { method: 'POST' }),
      )
      await activePage.evaluate(() => {
        const testWindow = window as typeof window & {
          __fwa?: { localEdge?: { revalidate(): Promise<void> } }
        }
        return testWindow.__fwa?.localEdge?.revalidate()
      })
      await reloadAvailableUpdate(activePage)
      await expect(
        activePage.locator('meta[name="fwa-test-release"]'),
      ).toHaveAttribute('content', 'app-update', { timeout: 20_000 })

      await activePage.evaluate(() =>
        fetch('/__test/switch-third-release', { method: 'POST' }),
      )
      const updateResponse = activePage.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/__fwa/revalidate',
      )
      await activePage.evaluate(() => {
        const testWindow = window as typeof window & {
          __fwa?: { localEdge?: { revalidate(): Promise<void> } }
        }
        return testWindow.__fwa?.localEdge?.revalidate()
      })
      const update = await updateResponse
      expect(update.status()).toBe(200)
      expect(await update.json()).toMatchObject({
        status: 'updated',
        release: { releaseId: releaseServer.thirdReleaseId },
      })
      expect(
        await activePage.evaluate(() => {
          const testWindow = window as typeof window & {
            __fwa?: {
              localEdge?: {
                getState(): {
                  phase: string
                  releaseId?: string
                  updateAvailable: boolean
                }
              }
            }
          }
          return testWindow.__fwa?.localEdge?.getState()
        }),
      ).toMatchObject({
        phase: 'ready',
        releaseId: releaseServer.updatedReleaseId,
        availableReleaseId: releaseServer.thirdReleaseId,
        updateAvailable: true,
      })

      const threeGenerationState = await activePage.evaluate(() =>
        fetch('/__fwa/state').then((response) => response.json()),
      )
      expect(threeGenerationState).toMatchObject({
        release: { releaseId: releaseServer.thirdReleaseId },
        retainedReleases: [
          { releaseId: releaseServer.updatedReleaseId },
          { releaseId: releaseServer.initialReleaseId },
        ],
      })
      expect(
        await previousPage.evaluate(async (assetPath) => {
          const releaseModule = (await import(assetPath)) as {
            releaseMarker: string
          }
          return releaseModule.releaseMarker
        }, releaseServer.initialLazyAssetPath),
      ).toBe('release-a')
      expect(
        await activePage.evaluate(async (assetPath) => {
          const releaseModule = (await import(assetPath)) as {
            releaseMarker: string
          }
          return releaseModule.releaseMarker
        }, releaseServer.updatedLazyAssetPath),
      ).toBe('release-b')

      await previousPage.close()
      expect(
        await activePage.evaluate(() =>
          fetch('/__fwa/revalidate', {
            method: 'POST',
            headers: { 'X-FWA-Control': 'revalidate' },
          }).then((response) => response.json()),
        ),
      ).toMatchObject({ status: 'current' })
      const afterInitialClientExit = await activePage.evaluate(() =>
        fetch('/__fwa/state').then((response) => response.json()),
      )
      expect(afterInitialClientExit).toMatchObject({
        retainedReleases: [
          { releaseId: releaseServer.updatedReleaseId },
        ],
      })

      await reloadAvailableUpdate(activePage)
      await expect(
        activePage.locator('meta[name="fwa-test-release"]'),
      ).toHaveAttribute('content', 'app-third', { timeout: 20_000 })
      expect(
        await activePage.evaluate(() =>
          fetch('/__fwa/revalidate', {
            method: 'POST',
            headers: { 'X-FWA-Control': 'revalidate' },
          }).then((response) => response.json()),
        ),
      ).toMatchObject({ status: 'current' })

      await expect
        .poll(() =>
          activePage.evaluate(async (releaseIds) => {
            const snapshot = await fetch('/__fwa/state').then((response) =>
              response.json(),
            )
            const cacheNames = await caches.keys()
            return {
              retainedReleaseCount: snapshot.retainedReleases.length,
              oldCachesRemain: releaseIds.some((releaseId) =>
                cacheNames.includes(
                  `fwa-local-edge:fwa-local-edge-demo:release:${releaseId}`,
                ),
              ),
            }
          }, [releaseServer.initialReleaseId, releaseServer.updatedReleaseId]),
        )
        .toEqual({ retainedReleaseCount: 0, oldCachesRemain: false })
    } finally {
      await context.close()
      await releaseServer.close()
    }
  })

  test('recovers an abandoned candidate journal before revalidation', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
      'data-local-edge-status',
      'ready',
      { timeout: 20_000 },
    )
    const abandonedReleaseId = 'deadbeefdeadbeef'
    await page.evaluate(async (releaseId) => {
      const cache = await caches.open(
        `fwa-local-edge:fwa-local-edge-demo:release:${releaseId}`,
      )
      await cache.put('/abandoned.js', new Response('abandoned'))
      await new Promise<void>((resolve, reject) => {
        const openRequest = indexedDB.open('fwa-local-edge:fwa-local-edge-demo', 1)
        openRequest.onsuccess = () => {
          const database = openRequest.result
          const transaction = database.transaction('metadata', 'readwrite')
          transaction.objectStore('metadata').put(
            { phase: 'installing', releaseId },
            'candidateJournal',
          )
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () => reject(transaction.error)
        }
        openRequest.onerror = () => reject(openRequest.error)
      })
    }, abandonedReleaseId)

    const result = await page.evaluate(() =>
      fetch('/__fwa/revalidate', {
        method: 'POST',
        headers: { 'X-FWA-Control': 'revalidate' },
      }).then((response) => response.json()),
    )
    expect(result).toMatchObject({ status: 'current' })
    expect(await readCandidateJournal(page)).toBeUndefined()
    expect(
      await page.evaluate((releaseId) =>
        caches.has(`fwa-local-edge:fwa-local-edge-demo:release:${releaseId}`),
      abandonedReleaseId),
    ).toBe(false)
  })

  for (const candidateFault of candidateFaults) {
    test(`rejects a ${candidateFault} candidate without moving active`, async ({
      browser,
    }) => {
      const releaseServer = await startReleaseUpdateServer({ candidateFault })
      const context = await browser.newContext()
      const page = await context.newPage()

      try {
        await page.goto(releaseServer.baseUrl)
        const runtime = page.locator('[data-local-edge-status]')
        await expect(runtime).toHaveAttribute('data-local-edge-status', 'ready', {
          timeout: 20_000,
        })
        await expect(runtime.locator('dd').nth(1)).toHaveText(
          releaseServer.initialReleaseId,
        )
        expect(
          await page.evaluate(() =>
            fetch('/__test/switch-release', { method: 'POST' }).then(
              (response) => response.ok,
            ),
          ),
        ).toBe(true)

        const rejection = await page.evaluate(() =>
          fetch('/__fwa/revalidate', {
            method: 'POST',
            headers: { 'X-FWA-Control': 'revalidate' },
          }).then(async (response) => ({
            body: await response.json(),
            status: response.status,
          })),
        )
        expect(rejection.status).toBe(503)

        const retainedState = await page.evaluate(async (candidateReleaseId) => {
          const snapshot = await fetch('/__fwa/state').then((response) =>
            response.json(),
          )
          return {
            candidateCacheExists: (await caches.keys()).includes(
              `fwa-local-edge:fwa-local-edge-demo:release:${candidateReleaseId}`,
            ),
            snapshot,
          }
        }, releaseServer.updatedReleaseId)
        expect(retainedState).toMatchObject({
          candidateCacheExists: false,
          snapshot: {
            release: { releaseId: releaseServer.initialReleaseId },
          },
        })
        expect(retainedState.snapshot.retainedReleases).toEqual([])
        expect(await readCandidateJournal(page)).toBeUndefined()
      } finally {
        await context.close()
        await releaseServer.close()
      }
    })
  }
})

async function readKernelDigest(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const workerBytes = await fetch('/__fwa-sw.js', {
      cache: 'reload',
    }).then((response) => response.arrayBuffer())
    const digest = await crypto.subtle.digest('SHA-256', workerBytes)
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  })
}

async function readCandidateJournal(page: import('@playwright/test').Page) {
  return page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const openRequest = indexedDB.open('fwa-local-edge:fwa-local-edge-demo', 1)
        openRequest.onsuccess = () => {
          const database = openRequest.result
          const transaction = database.transaction('metadata', 'readonly')
          const journalRequest = transaction
            .objectStore('metadata')
            .get('candidateJournal')
          journalRequest.onsuccess = () => resolve(journalRequest.result)
          journalRequest.onerror = () => reject(journalRequest.error)
          transaction.oncomplete = () => database.close()
        }
        openRequest.onerror = () => reject(openRequest.error)
      }),
  )
}
