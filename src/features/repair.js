/**
 * Repair PDF — attempt to recover a damaged or malformed PDF file.
 *
 * Two-tier approach:
 *   Tier 1: pdf-lib with ignoreEncryption:true — re-parses the cross-reference
 *           table and object streams, then re-serialises cleanly. Fixes most
 *           structural corruption, truncated trailers, and conflicting xref offsets.
 *
 *   Tier 2: PDF.js fallback — PDF.js has a much more lenient parser that can
 *           recover partial files. We render each page to JPEG and rebuild the
 *           PDF. Output is image-based (not selectable) but the content is saved.
 */

import { registerFeature }                                          from '../core/registry.js'
import { readFile, saveAs }                                         from '../core/fs.js'
import { PDFDocument }                                              from '@cantoo/pdf-lib'
import { loadForRender, renderToUnencryptedPdf }                    from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress }        from '../core/ui.js'
import { get }                                                      from '../core/state.js'

registerFeature({
  id:          'repair',
  name:        'Repair PDF',
  category:    'Convert',
  icon:        '🔧',
  description: 'Attempt to recover a damaged or malformed PDF',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Repair PDF</h2>
        <p class="feature-desc">
          Attempt to recover a damaged, truncated or malformed PDF.
          Uses two recovery methods — the first preserves text and vectors;
          the fallback saves content as images.
        </p>
      </div>

      <div class="panel">

        <div class="section-label">Select PDF to Repair</div>
        <div class="file-drop-zone" id="rep-drop">
          Drag a PDF here, or
          <button class="btn btn-sm" id="rep-browse">Browse</button>
          <input type="file" id="rep-input" accept=".pdf" hidden>
        </div>
        <div id="rep-filename" class="file-name-display"></div>

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;margin:14px 0;font-size:13px;color:var(--text-muted);line-height:1.6;">
          <strong style="color:var(--text);">Method 1 — Structural re-parse (preserves text)</strong><br>
          Re-reads the raw byte stream tolerantly, rebuilds the cross-reference table,
          and re-serialises a clean copy. Text stays selectable.
          <br><br>
          <strong style="color:var(--text);">Method 2 — Render fallback (image-based)</strong><br>
          If Method 1 fails, each page is rendered with PDF.js (which has an even more
          lenient parser) and saved as a JPEG image. Text is no longer selectable, but
          the visual content is preserved.
          <br><br>
          <strong style="color:var(--text);">What it won't fix</strong><br>
          Truncated files missing more than a few pages, files encrypted with an unknown
          password, or files with corrupted image streams (those pages will render as
          blank or garbled).
        </div>

        <div class="action-bar">
          <button class="btn btn-primary btn-lg" id="rep-run" disabled>Attempt Repair</button>
        </div>
        <div class="status-text" id="rep-status" style="text-align:center;margin-top:8px;"></div>

      </div>
    `

    let srcFile = null
    const dropZone = container.querySelector('#rep-drop')
    const input    = container.querySelector('#rep-input')
    const nameEl   = container.querySelector('#rep-filename')
    const runBtn   = container.querySelector('#rep-run')
    const statusEl = container.querySelector('#rep-status')

    const setFile = file => {
      srcFile = file
      nameEl.textContent = file.name
      runBtn.disabled    = false
      statusEl.textContent = ''
    }

    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) setFile(f)
    })
    container.querySelector('#rep-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => {
      if (e.target.files[0]) setFile(e.target.files[0])
      input.value = ''
    })

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => setFile(gf.file), 0)   // gf.pwd not needed (uses ignoreEncryption)

    runBtn.addEventListener('click', async () => {
      if (!srcFile) return
      showProgress('Reading file…')
      try {
        const bytes = await readFile(srcFile)

        // ── Tier 1: pdf-lib lenient parse ─────────────────────────────────────
        updateProgress('Attempting structural repair…')
        let tier1Success = false
        try {
          // ignoreEncryption:true lets us load protected or structurally corrupt files
          const doc = await PDFDocument.load(bytes, {
            ignoreEncryption: true,
            throwOnInvalidObject: false,
            updateMetadata: false,
          })
          const outBytes = await doc.save({ useObjectStreams: false })
          const outName  = srcFile.name.replace(/\.pdf$/i, '_repaired.pdf')
          await saveAs(outBytes, outName)

          const n = doc.getPageCount()
          toast(`Repaired (Method 1) → ${outName} · ${n} page${n !== 1 ? 's' : ''} recovered`, 'success', 5000)
          statusEl.textContent = `Method 1 succeeded — ${n} pages, text preserved.`
          tier1Success = true
        } catch (err1) {
          console.warn('Repair tier 1 failed:', err1.message)
        }

        if (tier1Success) return

        // ── Tier 2: PDF.js render fallback ────────────────────────────────────
        updateProgress('Structural repair failed — trying render fallback…')
        let rDoc
        try {
          rDoc = await loadForRender(bytes)
        } catch (err2) {
          throw new Error(`Both repair methods failed.\n\nMethod 1: structural re-parse\nMethod 2: ${err2.message}`)
        }

        const total    = rDoc.numPages
        const outBytes = await renderToUnencryptedPdf(rDoc, {
          scale:      2.0,
          quality:    0.88,
          onProgress: (n, t) => updateProgress(`Rendering page ${n} of ${t}…`),
        })
        rDoc.destroy()

        const outName = srcFile.name.replace(/\.pdf$/i, '_repaired_images.pdf')
        await saveAs(outBytes, outName)
        toast(
          `Repaired (Method 2 — image fallback) → ${outName} · ${total} pages · text not selectable`,
          'success', 6000
        )
        statusEl.textContent = `Method 2 succeeded — ${total} pages as images. Text is not selectable.`

      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Repair failed: ' + err.message, 'error', 6000)
          statusEl.textContent = 'Could not recover this file.'
        }
      } finally {
        hideProgress()
      }
    })
  },
})
