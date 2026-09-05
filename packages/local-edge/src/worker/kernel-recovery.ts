import {
  pathWithLocalEdgeNavigationMode,
  pathWithoutLocalEdgeNavigationMode,
  localEdgeConfig,
} from '../config.ts'

const worker = self as unknown as ServiceWorkerGlobalScope

export async function recoverUnhandledRequest(request: Request) {
  if (isNavigation(request)) {
    return networkEntryOrFallback(request, 'kernel-state-unavailable')
  }

  return fetch(request)
}

export async function networkEntryOrFallback(
  request: Request,
  reason: string,
) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      return response
    }
  } catch {
    // The embedded kernel fallback remains available without network or storage.
  }

  return kernelFallbackResponse(new URL(request.url), reason)
}

export function resetConfirmationResponse(requestUrl: URL) {
  const action = escapeHtml(
    pathWithLocalEdgeNavigationMode(requestUrl, 'reset'),
  )
  const cancelUrl = escapeHtml(
    pathWithoutLocalEdgeNavigationMode(requestUrl),
  )

  return kernelHtmlResponse(
    `
      <main class="card" data-kernel-reset-confirmation>
        <div class="mark danger-mark" aria-hidden="true">↺</div>
        <p class="eyebrow">FWA · Local Edge recovery</p>
        <h1>Reset Local Edge?</h1>
        <p class="lede">Use this escape hatch when a cached release or Service Worker prevents the app from starting normally.</p>
        <div class="notice">
          <strong>Only FWA-owned state is removed.</strong>
          <span>The current registration, Local Edge metadata, and release caches will be cleared. Application data, cookies, and accounts stay untouched.</span>
        </div>
        <form class="actions" method="post" action="${action}">
          <a class="button secondary" href="${cancelUrl}">Cancel</a>
          <button class="button danger" type="submit">Reset Local Edge</button>
        </form>
      </main>
    `,
    'Reset Local Edge',
  )
}

export function isTrustedResetPost(request: Request) {
  const origin = request.headers.get('Origin')
  const fetchSite = request.headers.get('Sec-Fetch-Site')
  if (fetchSite !== null && fetchSite !== 'same-origin') {
    return false
  }

  if (request.mode === 'navigate') {
    if (origin !== null) {
      return origin === worker.location.origin
    }
    if (fetchSite === 'same-origin') {
      return true
    }

    const referer = request.headers.get('Referer')
    if (referer === null) {
      return false
    }
    try {
      return new URL(referer).origin === worker.location.origin
    } catch {
      return false
    }
  }

  return isTrustedProgrammaticControlPost(request, 'reset')
}

export function isTrustedProgrammaticControlPost(
  request: Request,
  action: string,
) {
  const origin = request.headers.get('Origin')
  const fetchSite = request.headers.get('Sec-Fetch-Site')
  return (
    request.mode !== 'navigate' &&
    (fetchSite === null || fetchSite === 'same-origin') &&
    (origin === null || origin === worker.location.origin) &&
    request.headers.get('X-FWA-Control') === action
  )
}

function kernelFallbackResponse(requestUrl: URL, reason: string) {
  const returnUrl = safeReturnUrl(requestUrl)
  const retryUrl = escapeHtml(pathWithoutLocalEdgeNavigationMode(returnUrl))
  const openUrl = escapeHtml(
    pathWithLocalEdgeNavigationMode(returnUrl, 'network'),
  )
  const resetUrl = escapeHtml(
    pathWithLocalEdgeNavigationMode(returnUrl, 'reset'),
  )

  return kernelHtmlResponse(
    `
      <main class="card" data-kernel-fallback data-fallback-reason="${escapeHtml(reason)}">
        <div class="mark" aria-hidden="true">!</div>
        <p class="eyebrow">FWA · Local Edge recovery</p>
        <h1>Local Edge could not start</h1>
        <p class="lede">The local release is incomplete, and the normal network entry did not respond. Nothing outside FWA storage has been changed.</p>
        <p class="reason"><span>Diagnostic</span><code>${escapeHtml(reason)}</code></p>
        <nav class="actions" aria-label="Recovery actions">
          <a class="button primary" href="${retryUrl}">Retry</a>
          <a class="button secondary" href="${openUrl}">Open network entry</a>
          <a class="button quiet" href="${resetUrl}">Reset Local Edge…</a>
        </nav>
      </main>
    `,
    'Local Edge recovery',
    503,
  )
}

function kernelHtmlResponse(body: string, title: string, status = 200) {
  return new Response(
    `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta name="robots" content="noindex" />
          <title>${escapeHtml(title)}</title>
          <style>
            :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --bg:#f5f7fb; --card:rgba(255,255,255,.9); --text:#172033; --muted:#64748b; --line:rgba(30,41,59,.12); --soft:#eef2f7; --primary:#2563eb; --danger:#dc2626; }
            @media (prefers-color-scheme:dark) { :root { --bg:#080d18; --card:rgba(15,23,42,.92); --text:#f1f5f9; --muted:#94a3b8; --line:rgba(148,163,184,.2); --soft:rgba(148,163,184,.1); --primary:#60a5fa; --danger:#f87171; } }
            * { box-sizing:border-box; }
            body { margin:0; min-height:100vh; min-height:100svh; display:grid; place-items:center; padding:max(20px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left)); background:radial-gradient(circle at 50% 0,rgba(59,130,246,.11),transparent 42%),var(--bg); color:var(--text); }
            .card { width:min(100%,38rem); padding:clamp(24px,5vw,40px); border:1px solid var(--line); border-radius:22px; background:var(--card); box-shadow:0 24px 70px rgba(15,23,42,.15); }
            .mark { display:grid; place-items:center; width:42px; height:42px; margin-bottom:22px; border-radius:13px; background:rgba(245,158,11,.14); color:#d97706; font-size:22px; font-weight:800; }
            .danger-mark { background:rgba(220,38,38,.12); color:var(--danger); }
            .eyebrow { margin:0 0 9px; color:var(--muted); font-size:11px; font-weight:750; letter-spacing:.13em; text-transform:uppercase; }
            h1 { margin:0; font-size:clamp(25px,5vw,36px); line-height:1.12; letter-spacing:-.025em; }
            .lede { margin:15px 0 0; color:var(--muted); font-size:15px; line-height:1.65; }
            .notice,.reason { display:grid; gap:5px; margin:22px 0 0; border:1px solid var(--line); border-radius:14px; background:var(--soft); padding:14px 16px; font-size:13px; line-height:1.5; }
            .notice span,.reason span { color:var(--muted); }
            .reason code { overflow-wrap:anywhere; color:var(--text); font:600 12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
            .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:26px; align-items:center; }
            .button { display:inline-flex; min-height:42px; align-items:center; justify-content:center; border:1px solid transparent; border-radius:11px; padding:9px 14px; font:inherit; font-size:14px; font-weight:650; line-height:1.2; text-decoration:none; cursor:pointer; }
            .primary { background:var(--primary); color:white; }
            .secondary { border-color:var(--line); background:var(--card); color:var(--text); }
            .danger { border-color:color-mix(in srgb,var(--danger) 32%,transparent); background:color-mix(in srgb,var(--danger) 11%,transparent); color:var(--danger); }
            .quiet { color:var(--muted); }
            .button:hover { filter:brightness(.97); }
            @media (max-width:520px) { .card { border-radius:18px; } .actions { display:grid; grid-template-columns:1fr; } .button { width:100%; } }
          </style>
        </head>
        <body>${body}</body>
      </html>`,
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; navigate-to 'self'",
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  )
}

function safeReturnUrl(requestUrl: URL) {
  const returnUrl = new URL(requestUrl)
  if (isControlNamespacePath(requestUrl.pathname)) {
    returnUrl.pathname = localEdgeConfig.appEntry
    returnUrl.search = ''
    returnUrl.hash = ''
  }
  return returnUrl
}

function isControlNamespacePath(pathname: string) {
  return (
    pathname === localEdgeConfig.controlPrefix ||
    pathname.startsWith(`${localEdgeConfig.controlPrefix}/`)
  )
}

function isNavigation(request: Request) {
  return request.method === 'GET' && request.mode === 'navigate'
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  )
}
