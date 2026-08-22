import { useEffect, useRef, useState } from 'react'
import './App.css'
import {
  formatReleaseId,
  useLocalEdgeClient,
} from './demo/useLocalEdgeClient.ts'

const appEntry = '/'

function App() {
  const {
    applyUpdate,
    debugState,
    reset,
    setDebugEnabled,
    localEdgeState,
  } = useLocalEdgeClient()
  const navigationDisposition = demoNavigationDisposition(
    window.location.pathname,
  )
  const [updateConfirmationOpen, setUpdateConfirmationOpen] = useState(false)
  const [resetError, setResetError] = useState<string>()
  const [isResetting, setIsResetting] = useState(false)

  const handleReset = async () => {
    setIsResetting(true)
    setResetError(undefined)
    try {
      await reset()
    } catch (error) {
      setResetError(error instanceof Error ? error.message : 'Reset failed')
      setIsResetting(false)
    }
  }

  const networkUrl = new URL(window.location.href)
  networkUrl.searchParams.set('__fwa', 'network')
  const updateReady =
    localEdgeState.updateAvailable && Boolean(localEdgeState.availableReleaseId)
  const updateStatus = updateReady
    ? 'ready'
    : localEdgeState.revalidating
      ? 'updating'
      : 'idle'

  return (
    <main
      className="page-shell"
      data-app-ready="true"
      data-navigation-disposition={navigationDisposition}
    >
      <header className="hero">
        <p className="eyebrow">FWA · Local Edge</p>
        <div className="hero-title-row">
          <div>
            <h1>可靠本地启动，普通 Web 仍是逃生舱</h1>
            <p className="hero-copy">
              React + Vite 承载 demo host；Local Edge core 只依赖 Web
              Platform 的 Request / Response、Cache Storage 与 IndexedDB。
            </p>
          </div>
          <span className={`phase-badge phase-${localEdgeState.phase}`}>
            v0 · {localEdgeState.phase}
          </span>
        </div>
      </header>

      {navigationDisposition === 'app-not-found' ? (
        <section className="route-not-found" data-app-not-found>
          <p className="section-kicker">App-owned route fallback</p>
          <h2>Route not found</h2>
          <p>当前 navigation 由应用自身接管，并由 SPA route policy 呈现 404。</p>
          <a href={appEntry}>Return to app entry</a>
        </section>
      ) : null}

      <section className="runtime-panel" aria-labelledby="runtime-title">
        <div className="section-heading">
          <p className="section-kicker">Live runtime</p>
          <h2 id="runtime-title">当前启动路径</h2>
        </div>
        <div
          className="runtime-card"
          data-local-edge-status={localEdgeState.phase}
        >
          <div className="runtime-summary">
            <span className="status-dot" aria-hidden="true" />
            <div>
              <strong>
                {localEdgeState.controlled ? 'Local Edge' : 'Network baseline'}
              </strong>
              <p>{localEdgeState.message}</p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Controlled</dt>
              <dd>{localEdgeState.controlled ? 'yes' : 'no'}</dd>
            </div>
            <div>
              <dt>Current release</dt>
              <dd>{localEdgeState.releaseId ?? '—'}</dd>
            </div>
            <div>
              <dt>Available release</dt>
              <dd>{localEdgeState.availableReleaseId ?? '—'}</dd>
            </div>
          </dl>
          <div className="runtime-actions">
            <a href={networkUrl.toString()}>Open network</a>
            <button
              type="button"
              onClick={handleReset}
              disabled={!localEdgeState.controlled || isResetting}
            >
              {isResetting ? 'Resetting…' : 'Reset Local Edge'}
            </button>
          </div>
          {resetError ? <p className="runtime-error">{resetError}</p> : null}
        </div>
      </section>

      <section className="consumer-panel" aria-labelledby="consumer-title">
        <div className="section-heading">
          <p className="section-kicker">Public client facade</p>
          <h2 id="consumer-title">与真实应用同形接入</h2>
          <p>
            页面只订阅公开 client contract；React adapter 留在 demo，不进入 SDK
            runtime。
          </p>
        </div>
        <div>
          <div className="consumer-card" aria-label="Application settings">
            <div
              className="consumer-row version-row"
              data-settings-entry="version"
              data-update-status={updateStatus}
            >
              <button
                type="button"
                className="consumer-row-action"
                aria-label={
                  updateReady
                    ? 'Review available update'
                    : localEdgeState.revalidating
                      ? 'Update in progress'
                      : 'No update available'
                }
                aria-haspopup={updateReady ? 'dialog' : undefined}
                disabled={!updateReady}
                onClick={() => setUpdateConfirmationOpen(true)}
              />
              <span className="consumer-icon" aria-hidden="true">
                V
              </span>
              <span className="consumer-label">Version</span>
              <code data-version-value>
                {formatReleaseId(localEdgeState.releaseId)}
              </code>
              <span className="consumer-status-slot" aria-live="polite">
                {updateStatus === 'updating' ? (
                  <span
                    className="consumer-spinner"
                    aria-label="Checking for update"
                  />
                ) : null}
                {updateStatus === 'ready' ? (
                  <span
                    className="consumer-update-indicator"
                    aria-label="Update ready"
                  />
                ) : null}
              </span>
            </div>
            <label className="consumer-row developer-row">
              <span className="consumer-icon" aria-hidden="true">
                D
              </span>
              <span className="consumer-label">Developer mode</span>
              <input
                type="checkbox"
                role="switch"
                className="consumer-switch"
                checked={debugState.enabled}
                disabled={!debugState.available}
                onChange={(event) => setDebugEnabled(event.target.checked)}
              />
            </label>
          </div>
          <p className="consumer-note">
            Version 只在完整 release 已就绪时请求确认；Developer mode
            原位启停 diagnostics，不刷新当前页面。
          </p>
        </div>
      </section>

      <section className="principles" aria-labelledby="principles-title">
        <div className="section-heading">
          <p className="section-kicker">Minimum viable model</p>
          <h2 id="principles-title">v0 的三个不变量</h2>
        </div>
        <div className="principle-grid">
          <article>
            <span>01</span>
            <h3>Network path first</h3>
            <p>Worker 不可用或被 reset 后，页面仍能从正常 HTTPS entry 启动。</p>
          </article>
          <article>
            <span>02</span>
            <h3>Release pointer last</h3>
            <p>完整缓存并复读 candidate 后，才提交 active release metadata。</p>
          </article>
          <article>
            <span>03</span>
            <h3>Explicit escape hatch</h3>
            <p>Open 强制走网络；reset 只删除 SDK 自有 cache、metadata 与 registration。</p>
          </article>
        </div>
      </section>

      <footer>
        ASAR / archive-backed release 保留为 Cache Storage 基线后的 encoding
        实验，不进入 v0 前置。
      </footer>

      {updateConfirmationOpen && localEdgeState.availableReleaseId ? (
        <UpdateConfirmation
          releaseId={localEdgeState.availableReleaseId}
          onCancel={() => setUpdateConfirmationOpen(false)}
          onReload={() => {
            if (!applyUpdate()) {
              setUpdateConfirmationOpen(false)
            }
          }}
        />
      ) : null}
    </main>
  )
}

function UpdateConfirmation({
  releaseId,
  onCancel,
  onReload,
}: {
  releaseId: string
  onCancel: () => void
  onReload: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog?.open) dialog?.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="update-dialog"
      aria-labelledby="update-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div className="update-dialog-card">
        <p className="section-kicker">Release ready</p>
        <h2 id="update-dialog-title">Reload to update?</h2>
        <p>
          Release <code>{formatReleaseId(releaseId)}</code>{' '}
          已完整缓存。刷新会结束当前页面的内存会话。
        </p>
        <div className="update-dialog-actions">
          <button type="button" onClick={onCancel} autoFocus>
            Not now
          </button>
          <button type="button" className="primary" onClick={onReload}>
            Reload
          </button>
        </div>
      </div>
    </dialog>
  )
}

function demoNavigationDisposition(pathname: string) {
  return pathname === appEntry || pathname.startsWith('/library/')
    ? 'app-route'
    : 'app-not-found'
}

export default App
