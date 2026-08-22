import { describe, expect, it } from 'vitest'
import { cloneReplaySafeRequest } from './request-recovery.ts'

describe('cloneReplaySafeRequest', () => {
  it.each(['GET', 'HEAD'])('clones replay-safe %s requests', (method) => {
    const request = new Request('https://app.test/resource', { method })
    const recoveryRequest = cloneReplaySafeRequest(request)

    expect(recoveryRequest).not.toBe(request)
    expect(recoveryRequest?.method).toBe(method)
    expect(request.bodyUsed).toBe(false)
  })

  it('does not retain a replay copy for a body-bearing POST', async () => {
    const request = new Request('https://app.test/cdn-cgi/rum', {
      method: 'POST',
      body: 'analytics payload',
    })

    expect(cloneReplaySafeRequest(request)).toBeNull()
    expect(await request.text()).toBe('analytics payload')
  })
})
