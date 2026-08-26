import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileDocumentShell,
  cssText,
  documentShellEntryMarker,
  htmlFragment,
  inlineScript,
  locateSingleStylesheetLink,
  validateCompiledDocumentShell,
  validateDocumentShellTemplate,
} from '../src/document-shell.ts'

const document = {
  lang: 'en',
  title: 'A <shell>',
  head: [htmlFragment(`    <meta content="width=device-width, viewport-fit=cover" name="viewport" />
    <link href="/manifest.webmanifest" rel="preload manifest" />`)],
  appEntry: '/src/main.tsx',
  mountId: 'root',
}

const shell = {
  html: htmlFragment(
    '    <div id="document-shell" data-document-shell-static="true" aria-hidden="true">Loading</div>',
  ),
  criticalCss: [cssText('#document-shell { position: fixed; inset: 0; }')],
}

test('compiles the complete document around a dynamic shell projection', () => {
  const html = compileDocumentShell({
    document,
    shell,
    startupEffects: {
      beforePaint: [
        {
          marker: 'data-before-paint',
          script: inlineScript('document.documentElement.dataset.ready = "true"'),
        },
      ],
    },
  })

  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<title>A &lt;shell&gt;<\/title>/)
  assert.match(html, /data-before-paint="true"/)
  assert.match(html, /<style data-document-shell="true">/)
  assert.match(html, /<div id="root"><\/div>/)
  assert.match(html, /<script type="module" src="\/src\/main\.tsx"><\/script>/)
  assert.doesNotMatch(html, new RegExp(documentShellEntryMarker))
})

test('accepts only the module-entry sentinel as the checked-in template', () => {
  const template = '<!doctype html><script type="module" src="/src/main.tsx" data-document-shell-entry></script>'

  assert.doesNotThrow(() => validateDocumentShellTemplate(template, '/src/main.tsx'))
  assert.throws(
    () => validateDocumentShellTemplate(
      template.replace('<script', '<meta name="theme-color" content="black"><script'),
      '/src/main.tsx',
    ),
    /must contain only its module-entry sentinel/,
  )
})

test('rejects structural drift in the emitted document', () => {
  const html = compileDocumentShell({ document, shell })

  assert.throws(
    () => validateCompiledDocumentShell(html.replace('</head>', '<meta name="viewport" /></head>'), document),
    /exactly one viewport meta; found 2/,
  )
  assert.throws(
    () => validateCompiledDocumentShell(
      html.replace('<div id="root"></div>', `<div id="root"></div><i ${documentShellEntryMarker}></i>`),
      document,
    ),
    /emitted its template marker/,
  )
})

test('validates parsed structure instead of marker-shaped text', () => {
  const html = compileDocumentShell({
    document,
    shell: {
      ...shell,
      html: htmlFragment(
        `<div id="document-shell" data-document-shell-static="true" aria-hidden="true">${documentShellEntryMarker}</div>`,
      ),
    },
  })

  assert.doesNotThrow(() => validateCompiledDocumentShell(html, document))
})

test('keeps typed inline effects inside their script element', () => {
  const html = compileDocumentShell({
    document,
    shell,
    startupEffects: {
      beforePaint: [
        {
          marker: 'data-test-effect',
          script: inlineScript('window.value = "</SCRIPT><i data-breakout>"'),
        },
      ],
    },
  })

  assert.match(html, /<\\\/script><i data-breakout>/)
  assert.throws(
    () =>
      compileDocumentShell({
        document,
        shell,
        startupEffects: {
          beforePaint: [
            {
              marker: 'data-test-effect onload',
              script: inlineScript('window.value = true'),
            },
          ],
        },
      }),
    /marker must be a data-\* attribute name/,
  )
})

test('includes template contents in structural uniqueness checks', () => {
  const html = compileDocumentShell({ document, shell }).replace(
    '</body>',
    '<template><meta name="viewport" content="width=device-width" /></template></body>',
  )

  assert.throws(
    () => validateCompiledDocumentShell(html, document),
    /exactly one viewport meta; found 2/,
  )
})

test('requires a cover viewport when a safe-area bridge is present', () => {
  const unsafeDocument = {
    ...document,
    head: [htmlFragment(`    <meta content="width=device-width, initial-scale=1" name="viewport" />
    <link href="/manifest.webmanifest" rel="manifest" />`)],
  }

  assert.throws(
    () => compileDocumentShell({
      document: unsafeDocument,
      shell,
      startupEffects: {
        beforePaint: [{
          marker: 'data-document-shell-safe-area-bridge',
          script: inlineScript('void 0'),
        }],
      },
    }),
    /requires viewport content: viewport-fit=cover/,
  )
})

test('locates one stylesheet independent of attribute order and preserves its source range', () => {
  const link = '<link media="print" href="/app.css" crossorigin rel="alternate stylesheet">'
  const html = `<!doctype html><html><head>${link}</head><body></body></html>`
  const located = locateSingleStylesheetLink(html)

  assert.equal(html.slice(located.startOffset, located.endOffset), link)
  assert.deepEqual(located.attributes, {
    media: 'print',
    href: '/app.css',
    crossorigin: '',
    rel: 'alternate stylesheet',
  })
  assert.throws(
    () => locateSingleStylesheetLink(html.replace('</body>', `<template>${link}</template></body>`)),
    /exactly one stylesheet link; found 2/,
  )
})
