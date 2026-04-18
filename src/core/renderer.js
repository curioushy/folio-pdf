/**
 * PDF.js-based page renderer — used for thumbnails only.
 * Kept separate from pdf.js (pdf-lib) so the two libraries don't mix.
 *
 * Worker setup:
 *   Production build : esbuild injects __PDFJS_WORKER_SRC__ as a string constant.
 *                      We create a Blob URL from it so the file stays self-contained.
 *   Dev (Vite)       : __PDFJS_WORKER_SRC__ is undefined; we fall back to URL resolution
 *                      which Vite handles automatically via import.meta.url.
 */

import * as pdfjsLib from 'pdfjs-dist'
import { PDFDocument } from '@cantoo/pdf-lib'

// Declare the injected global so JS engines don't complain in strict mode.
// esbuild replaces this with the real string at build time; in dev it stays undefined.
/* global __PDFJS_WORKER_SRC__ */

function setupWorker() {
  if (typeof __PDFJS_WORKER_SRC__ === 'string') {
    // Production: inline the worker as a blob URL.
    // pdf.worker.min.mjs is a proper ES module; PDF.js v5 always loads workerSrc
    // with { type:'module' }, so the export{} statement is valid and the worker
    // initialises correctly in all modern browsers (Chrome 80+, Firefox 114+,
    // Safari 15+).
    // We do NOT share a PDFWorker instance — PDF.js creates and owns one per
    // getDocument() call, which means destroy() on a document never kills a
    // worker that other documents still need.
    const blob = new Blob([__PDFJS_WORKER_SRC__], { type: 'text/javascript' })
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob)
  } else {
    // Dev (Vite): resolve from node_modules via import.meta.url
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).href
  }
}
setupWorker()

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load PDF bytes with PDF.js for rendering.
 * Caller is responsible for calling .destroy() when done.
 *
 * @param {ArrayBuffer} bytes
 * @param {string|null} [password]
 * @returns {Promise<import('pdfjs-dist').PDFDocumentProxy>}
 */
/**
 * Load PDF bytes with PDF.js for rendering.
 * PDF.js handles ALL standard encryption types — unlike pdf-lib which cannot decrypt.
 * Throws { code: 'ENCRYPTED' } if password needed, { code: 'WRONG_PASSWORD' } if wrong.
 *
 * @param {ArrayBuffer} bytes
 * @param {string|null} [password]
 * @returns {Promise<import('pdfjs-dist').PDFDocumentProxy>}
 */
export async function loadForRender(bytes, password = null) {
  const opts = { data: new Uint8Array(bytes) }
  if (password) opts.password = password
  try {
    return await pdfjsLib.getDocument(opts).promise
  } catch (err) {
    if (err.name === 'PasswordException') {
      // PDF.js error codes: 1 = need password, 2 = wrong password
      const code = err.code === 2 ? 'WRONG_PASSWORD' : 'ENCRYPTED'
      throw Object.assign(new Error(err.message), { code })
    }
    throw err
  }
}

/**
 * Decrypt a password-protected PDF by rendering each page to JPEG and repacking.
 *
 * WHY: pdf-lib v1.x cannot decrypt any PDF (the password option is unimplemented).
 *      PDF.js fully handles all standard encryption (RC4-40, RC4-128, AES-128, AES-256).
 *      We use PDF.js to decrypt + render, then pdf-lib to produce a clean unlocked PDF.
 *
 * TRADE-OFF: output is image-based (pages are JPEGs). Text is not selectable/searchable.
 *            This is the same result as "Print → Save as PDF" in any PDF viewer.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} renderDoc  already-loaded PDF.js document
 * @param {{ scale?: number, quality?: number, onProgress?: (n,total)=>void }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function renderToUnencryptedPdf(renderDoc, {
  scale      = 2.0,   // 2× gives ~144 dpi — good balance of quality vs file size
  quality    = 0.92,
  onProgress = null,
} = {}) {
  const out       = await PDFDocument.create()
  const numPages  = renderDoc.numPages

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    onProgress?.(pageNum, numPages)

    const page     = await renderDoc.getPage(pageNum)
    const viewport = page.getViewport({ scale })
    const w        = Math.round(viewport.width)
    const h        = Math.round(viewport.height)

    const canvas       = document.createElement('canvas')
    canvas.width       = w
    canvas.height      = h

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    page.cleanup()

    // Canvas → JPEG bytes (avoids large PNG files)
    const dataUrl  = canvas.toDataURL('image/jpeg', quality)
    const b64      = dataUrl.split(',')[1]
    const imgBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))

    const img     = await out.embedJpg(imgBytes)
    const pdfPage = out.addPage([w, h])
    pdfPage.drawImage(img, { x: 0, y: 0, width: w, height: h })
  }

  return out.save()
}

/**
 * Render one page to a new <canvas> element.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 * @param {number} pageNumber  1-based
 * @param {number} [thumbWidth]  desired canvas CSS width in px
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderPage(pdfDoc, pageNumber, thumbWidth = 120) {
  const page     = await pdfDoc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const scale    = thumbWidth / viewport.width
  const scaled   = page.getViewport({ scale })

  const canvas       = document.createElement('canvas')
  const ctx          = canvas.getContext('2d')
  canvas.width       = Math.round(scaled.width)
  canvas.height      = Math.round(scaled.height)
  canvas.style.width = '100%'
  canvas.style.display = 'block'

  await page.render({ canvasContext: ctx, viewport: scaled }).promise
  page.cleanup()
  return canvas
}

/**
 * Build a scrollable thumbnail grid inside `container`.
 * Thumbnails are rendered lazily as they scroll into view.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 * @param {number} totalPages
 * @param {HTMLElement} container  element to populate
 * @param {{ thumbWidth?: number, onPageClick?: (page0: number, el: HTMLElement) => void }} [opts]
 * @returns {{ observer: IntersectionObserver, setSelected: (pages0: Set<number>) => void }}
 */
export function buildThumbnailGrid(pdfDoc, totalPages, container, {
  thumbWidth = 128,
  onPageClick,
} = {}) {
  container.innerHTML = ''

  const observer = new IntersectionObserver(entries => {
    entries.forEach(async entry => {
      if (!entry.isIntersecting) return
      const thumb = entry.target
      if (thumb.dataset.rendered) return
      thumb.dataset.rendered = '1'
      observer.unobserve(thumb)

      const pageNum = parseInt(thumb.dataset.page)
      try {
        const canvas = await renderPage(pdfDoc, pageNum, thumbWidth)
        thumb.querySelector('.thumb-placeholder')?.replaceWith(canvas)
      } catch {
        // leave placeholder on render failure
      }
    })
  }, { threshold: 0.01, rootMargin: '150px' })

  for (let p = 1; p <= totalPages; p++) {
    const thumb = document.createElement('div')
    thumb.className     = 'split-thumb'
    thumb.dataset.page  = String(p)
    thumb.title         = `Page ${p}`

    // Placeholder sized to typical A4 ratio so grid doesn't jump on render
    const placeholder = document.createElement('div')
    placeholder.className = 'thumb-placeholder'
    placeholder.style.cssText = `
      width:100%;
      padding-bottom:141%;
      background:var(--bg);
      display:flex;align-items:center;justify-content:center;
      color:var(--text-subtle);font-size:11px;
    `
    placeholder.textContent = '…'

    const label = document.createElement('div')
    label.className   = 'split-thumb-num'
    label.textContent = String(p)

    thumb.appendChild(placeholder)
    thumb.appendChild(label)

    if (onPageClick) {
      thumb.addEventListener('click', e => onPageClick(p - 1, thumb, e))
    }

    container.appendChild(thumb)
    observer.observe(thumb)
  }

  // Returns a helper to sync visual selection state from outside
  function setSelected(pages0) {
    container.querySelectorAll('.split-thumb').forEach(el => {
      const p0 = parseInt(el.dataset.page) - 1
      el.classList.toggle('selected', pages0.has(p0))
    })
  }

  return { observer, setSelected }
}

/**
 * Convert a Set of 0-based page indices into a compact range string (1-based).
 * e.g. {0,1,2,5,8,9} → "1-3, 6, 9-10"
 *
 * @param {Set<number>} pages0
 * @returns {string}
 */
export function selectionToRangeStr(pages0) {
  if (!pages0.size) return ''
  const sorted = [...pages0].sort((a, b) => a - b)
  const ranges = []
  let start = sorted[0], end = sorted[0]

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i]
    } else {
      ranges.push(start === end ? String(start + 1) : `${start + 1}-${end + 1}`)
      start = sorted[i]
      end   = sorted[i]
    }
  }
  ranges.push(start === end ? String(start + 1) : `${start + 1}-${end + 1}`)
  return ranges.join(', ')
}
