import { expect, test } from '@playwright/test'
import { startReleaseUpdateServer } from './release-update-server.ts'

test.describe('Offline Local Edge lifecycle', () => {
  test('installs the first release without reloading the network document', async ({
    browser,
  }) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    try {
      await page.addInitScript(() => {
        const loadCount = Number(
          sessionStorage.getItem('fwa-document-load-count') ?? 0,
        )
        sessionStorage.setItem(
          'fwa-document-load-count',
          String(loadCount + 1),
        )
      })
      await page.goto('/')
      await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
        'data-local-edge-status',
        'ready',
        { timeout: 20_000 },
      )

      expect(
        await page.evaluate(() => ({
          controlled: Boolean(navigator.serviceWorker.controller),
          loadCount: sessionStorage.getItem('fwa-document-load-count'),
        })),
      ).toEqual({ controlled: true, loadCount: '1' })
    } finally {
      await context.close()
    }
  })

  test('opens a downloaded release after one same-tab reload', async ({
    browser,
  }) => {
    const releaseServer = await startReleaseUpdateServer()
    const context = await browser.newContext()
    const page = await context.newPage()

    try {
      await page.goto(releaseServer.baseUrl)
      await expect(page.locator('[data-local-edge-status]')).toHaveAttribute(
        'data-local-edge-status',
        'ready',
        { timeout: 20_000 },
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
        .toBe(false)

      await page.evaluate(() =>
        fetch('/__test/switch-release', { method: 'POST' }),
      )
      await page.evaluate(() => {
        const testWindow = globalThis as typeof globalThis & {
          __fwa?: { localEdge?: { revalidate(): Promise<void> } }
        }
        return testWindow.__fwa?.localEdge?.revalidate()
      })
      await expect
        .poll(() =>
          page.evaluate(() => {
            const testWindow = globalThis as typeof globalThis & {
              __fwa?: {
                localEdge?: {
                  getState(): {
                    availableReleaseId?: string
                    updateAvailable: boolean
                  }
                }
              }
            }
            return testWindow.__fwa?.localEdge?.getState()
          }),
        )
        .toMatchObject({
          availableReleaseId: releaseServer.updatedReleaseId,
          updateAvailable: true,
        })

      await context.setOffline(true)
      await page.reload()
      await expect(
        page.locator('meta[name="fwa-test-release"]'),
      ).toHaveAttribute('content', 'app-update')
      await expect(
        page.locator('[data-local-edge-status] dd').nth(1),
      ).toHaveText(releaseServer.updatedReleaseId)
      expect(
        await page.evaluate(async (assetPath) => {
          const releaseModule = (await import(assetPath)) as {
            releaseMarker: string
          }
          return releaseModule.releaseMarker
        }, releaseServer.updatedLazyAssetPath),
      ).toBe('release-b')
    } finally {
      await context.setOffline(false)
      await context.close()
      await releaseServer.close()
    }
  })
})
