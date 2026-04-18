/**
 * Flatten feature — render every page to a JPEG and rebuild as an image-based PDF.
 *
 * What this solves:
 *   • Strip layers no amount of flag-editing can touch: form fields, comments,
 *     hidden annotations, unusual ciphers, weird ownership metadata.
 *   • Normalize "weird" PDFs so they open cleanly in any viewer.
 *   • Simulate "Print → Save as PDF" from Acrobat, but offline and in bulk.
 *
 * Trade-offs:
 *   • Output is image-based. Text is NOT selectable/searchable. Run Folio-OCR
 *     afterward if you need searchable text back.
 *   • File size depends on resolution × JPEG quality (a slider here).
 *   • Vector crispness is lost — pages become raster.
 *
 * This is the same engine used by Unlock's PDF.js fallback tier, exposed as
 * its own feature.
 */

import { registerFeature }                                          from '../core/registry.js'
import { readFile, saveAs }                                         from '../core/fs.js'
import { loadForRender, renderToUnencryptedPdf }                    from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { get }                                                               from '../core/state.js'

registerFeature({
  id:          'flatten',
  name:        'Flatten to Images',
  category:    'Convert',
  icon:        '🖨',
  description: 'Rasterize every page — strips any hidden layer, DRM-lite, or weird ownership',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Flatten to Images</h2>
        <p class="feature-desc">
          Render every page as a JPEG and rebuild the PDF from those images.
          Equivalent to "Print → Save as PDF" in Acrobat, done offline.
          The output has the same pages, visually identical, but no form fields,
          no comments, no hidden layers, no annotations, no DRM-lite — just pictures.
        </p>
      </div>

      <div class="panel">

        <div class="section-label">Select PDF</div>
        <div class="file-drop-zone" id="flat-drop">
          Drag a PDF here, or
          <button class="btn btn-sm" id="flat-browse">Browse</button>
          <input type="file" id="flat-input" accept=".pdf" hidden>
        </div>
        <div id="flat-filename" class="file-name-display"></div>

        <div class="section-label" style="margin-top:14px;">Resolution</div>
        <div class="option-row">
          <label>Render quality</label>
          <select id="flat-scale" class="input" style="max-width:240px;">
            <option value="1.39">100 dpi — smallest file</option>
            <option value="2.08" selected>150 dpi — office (recommended)</option>
            <option value="2.78">200 dpi — high quality</option>
            <option value="4.17">300 dpi — print quality (large file)</option>
          </select>
        </div>

        <div class="option-row">
          <label>JPEG quality <span id="flat-quality-val">88%</span></label>
          <input type="range" id="flat-quality" min="50" max="100" value="88" style="flex:1;">
        </div>

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;margin:14px 0;font-size:13px;color:var(--text-muted);line-height:1.6;">
          <strong style="color:var(--text);">What gets stripped</strong><br>
          Printing/copying restrictions, form fields and their data, comments and
          annotations, hidden layers, JavaScript actions, embedded files,
          bookmarks, metadata, digital signatures — anything that isn't the
          visible page content. You get back a PDF that looks identical but is
          just a stack of flattened images.
          <br><br>
          <strong style="color:var(--text);">Trade-off</strong><br>
          Text stops being selectable or searchable. If you need that back,
          run the output through Folio-OCR (Tools → OCR).
          <br><br>
          <strong style="color:var(--text);">Passwords</strong><br>
          If the PDF has a user password, you'll be asked to enter it.
          Flattening a file you can't legitimately open won't work — this
          tool doesn't break cryptography, it just re-renders what you can
          already see.
        </div>

        <div class="action-bar">
          <button class="btn btn-primary btn-lg" id="flat-run" disabled>Flatten PDF</button>
        </div>

      </div>
    `

    // ── State ─────────────────────────────────────────────────────────────────
    let srcFile = null
    let srcPwd  = null
    const dropZone = container.querySelector('#flat-drop')
    const input    = container.querySelector('#flat-input')
    const nameEl   = container.querySelector('#flat-filename')
    const runBtn   = container.querySelector('#flat-run')

    const setFile = file => {
      srcFile = file
      nameEl.textContent = file.name
      runBtn.disabled    = false
    }

    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = Array.from(e.dataTransfer.files).find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) setFile(f)
    })
    container.querySelector('#flat-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => {
      if (e.target.files[0]) setFile(e.target.files[0])
      input.value = ''
    })

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => { setFile(gf.file); srcPwd = gf.pwd }, 0)

    // Quality slider label
    const qSlider = container.querySelector('#flat-quality')
    const qLabel  = container.querySelector('#flat-quality-val')
    qSlider.addEventListener('input', () => { qLabel.textContent = qSlider.value + '%' })

    // ── Run ───────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      if (!srcFile) return

      const scale   = parseFloat(container.querySelector('#flat-scale').value)
      const quality = parseInt(qSlider.value) / 100

      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(srcFile)

        let rDoc
        try {
          rDoc = await loadForRender(bytes, srcPwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          srcPwd = pwd
          showProgress('Decrypting…')
          try {
            rDoc = await loadForRender(bytes, pwd)
          } catch (err2) {
            if (err2.code === 'WRONG_PASSWORD') {
              toast('Wrong password — could not decrypt the PDF.', 'error')
              return
            }
            throw err2
          }
        }

        const total = rDoc.numPages
        const outBytes = await renderToUnencryptedPdf(rDoc, {
          scale,
          quality,
          onProgress: (n, t) => updateProgress(`Rendering page ${n} of ${t}…`),
        })
        rDoc.destroy()

        updateProgress('Saving flattened PDF…')
        const outName = srcFile.name.replace(/\.pdf$/i, '_flat.pdf')
        await saveAs(outBytes, outName)

        const kb = Math.round(outBytes.length / 1024)
        const size = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`
        toast(
          `Flattened → ${outName} (${total} page${total > 1 ? 's' : ''}, ${size})`,
          'success', 5000
        )
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    })
  },
})
