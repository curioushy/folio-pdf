/**
 * Overlay / Underlay feature — stamp one PDF on top of (or visually behind)
 * every page of another. Classic use cases: apply a letterhead behind a
 * document, stamp a signature or approval template on top.
 *
 * "Overlay" places the stamp at full opacity on top of existing content.
 * "Underlay" places the stamp at reduced opacity, giving the visual impression
 * of being behind the content — the simplest approach that works reliably
 * across all PDF viewers without manipulating content streams.
 */

import { registerFeature }                                              from '../core/registry.js'
import { readFile, saveAs }                                             from '../core/fs.js'
import * as pdf                                                         from '../core/pdf.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, ensurePdf, parsePageRange }                         from '../core/utils.js'
import { PDFDocument }                                                  from '@cantoo/pdf-lib'

registerFeature({
  id:          'overlay',
  name:        'Overlay / Underlay',
  category:    'Multi-file',
  icon:        '📄',
  description: 'Stamp one PDF on top of (or visually behind) every page of another — letterheads, approvals, signatures',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Overlay / Underlay</h2>
        <p class="feature-desc">
          Combine two PDFs by drawing one over the pages of another.
          Use Overlay to stamp approvals or signatures on top; use Underlay
          to apply letterheads or watermark templates at low opacity behind content.
        </p>
      </div>

      <div class="feature-split">

        <!-- ── LEFT: Base PDF ────────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Base PDF</span></div>
          <p class="status-text" style="margin-bottom:8px;">The document to stamp onto.</p>

          <div class="file-drop-zone" id="ov-base-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="ov-base-browse">Browse</button>
            <input type="file" id="ov-base-input" accept=".pdf" hidden>
          </div>
          <div id="ov-base-filename" class="file-name-display"></div>

          <div style="border-top:1px solid var(--border);margin:18px 0;"></div>

          <!-- Pages to apply overlay to -->
          <div class="section-label">Apply overlay to</div>
          <div class="option-row">
            <select id="ov-pages-sel" class="input" style="max-width:200px;">
              <option value="all">All pages</option>
              <option value="first">First page only</option>
              <option value="last">Last page only</option>
              <option value="custom">Custom range…</option>
            </select>
          </div>
          <div id="ov-pages-custom-row" class="option-row" style="display:none;">
            <label>Range</label>
            <input type="text" id="ov-pages-custom" class="input"
              placeholder="e.g. 1-3, 5, 8-10" style="max-width:200px;">
          </div>
        </div>

        <!-- ── RIGHT: Overlay PDF + Options ─────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">② Overlay PDF &amp; Options</span></div>
          <p class="status-text" style="margin-bottom:8px;">The stamp, letterhead, or template to apply.</p>

          <div class="file-drop-zone" id="ov-overlay-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="ov-overlay-browse">Browse</button>
            <input type="file" id="ov-overlay-input" accept=".pdf" hidden>
          </div>
          <div id="ov-overlay-filename" class="file-name-display"></div>

          <div class="option-row" style="margin-top:14px;">
            <label>Overlay page to use</label>
            <input type="number" id="ov-overlay-page" class="input" value="1" min="1"
              style="max-width:70px;">
            <span class="status-text">of overlay PDF</span>
          </div>

          <div style="border-top:1px solid var(--border);margin:14px 0;"></div>

          <!-- Mode -->
          <div class="section-label">Mode</div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;" id="ov-mode-group">
            <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;">
              <input type="radio" name="ov-mode" value="overlay" checked style="margin-top:3px;">
              <span>
                <strong>Overlay (on top)</strong><br>
                <span class="status-text">Drawn over existing content. Use for approvals, signatures, stamps.</span>
              </span>
            </label>
            <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;">
              <input type="radio" name="ov-mode" value="underlay" style="margin-top:3px;">
              <span>
                <strong>Underlay (behind, low opacity)</strong><br>
                <span class="status-text">Drawn at reduced opacity — visually behind content. Use for letterheads and backgrounds.</span>
              </span>
            </label>
          </div>

          <!-- Opacity -->
          <div class="option-row">
            <label>Opacity <span id="ov-opacity-val" style="font-variant-numeric:tabular-nums;">80%</span></label>
            <input type="range" id="ov-opacity" min="10" max="100" value="80" style="flex:1;">
          </div>

          <div style="border-top:1px solid var(--border);margin:14px 0;"></div>

          <!-- Output -->
          <div class="option-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
            <label style="min-width:unset;">Output filename</label>
            <input type="text" id="ov-output" class="input" placeholder="document_overlaid.pdf"
              style="width:100%;">
          </div>

          <!-- Action -->
          <div style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="ov-run" disabled
              style="width:100%;justify-content:center;">
              Apply Overlay
            </button>
            <div class="status-text" id="ov-status" style="text-align:center;margin-top:8px;">
              Load both PDFs to get started.
            </div>
          </div>
        </div>

      </div>
    `

    // ── State ──────────────────────────────────────────────────────────────────
    let baseFile    = null
    let overlayFile = null

    const runBtn    = container.querySelector('#ov-run')
    const statusEl  = container.querySelector('#ov-status')
    const baseNameEl    = container.querySelector('#ov-base-filename')
    const overlayNameEl = container.querySelector('#ov-overlay-filename')

    function checkReady() {
      const ready = !!(baseFile && overlayFile)
      runBtn.disabled = !ready
      if (ready) statusEl.textContent = 'Ready — click Apply Overlay.'
    }

    function setBaseFile(file) {
      baseFile = file
      baseNameEl.textContent = file.name
      if (!container.querySelector('#ov-output').value) {
        container.querySelector('#ov-output').value = stripExt(file.name) + '_overlaid.pdf'
      } else {
        container.querySelector('#ov-output').value = stripExt(file.name) + '_overlaid.pdf'
      }
      checkReady()
    }

    function setOverlayFile(file) {
      overlayFile = file
      overlayNameEl.textContent = file.name
      checkReady()
    }

    // ── Drop zones ─────────────────────────────────────────────────────────────
    setupDropZone('ov-base-drop',    'ov-base-input',    setBaseFile)
    setupDropZone('ov-overlay-drop', 'ov-overlay-input', setOverlayFile)

    function setupDropZone(dropId, inputId, onFile) {
      const zone  = container.querySelector(`#${dropId}`)
      const input = container.querySelector(`#${inputId}`)
      const browseId = dropId.replace('-drop', '-browse')
      zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over') })
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
      zone.addEventListener('drop', e => {
        e.preventDefault(); zone.classList.remove('drag-over')
        const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
        if (f) onFile(f)
      })
      container.querySelector(`#${browseId}`).addEventListener('click', () => input.click())
      input.addEventListener('change', e => { if (e.target.files[0]) { onFile(e.target.files[0]); input.value = '' } })
    }

    // ── Pages selector ─────────────────────────────────────────────────────────
    container.querySelector('#ov-pages-sel').addEventListener('change', e => {
      container.querySelector('#ov-pages-custom-row').style.display =
        e.target.value === 'custom' ? 'flex' : 'none'
    })

    // ── Opacity slider — defaults update with mode ─────────────────────────────
    const opacitySlider = container.querySelector('#ov-opacity')
    const opacityLabel  = container.querySelector('#ov-opacity-val')
    opacitySlider.addEventListener('input', () => {
      opacityLabel.textContent = opacitySlider.value + '%'
    })

    container.querySelectorAll('input[name="ov-mode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        if (radio.value === 'underlay') {
          opacitySlider.value      = 25
          opacityLabel.textContent = '25%'
        } else {
          opacitySlider.value      = 80
          opacityLabel.textContent = '80%'
        }
      })
    })

    // ── Run ────────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      showProgress('Loading base PDF…')
      try {
        // Load base PDF
        const baseBytes = await readFile(baseFile)
        let baseDoc
        try { baseDoc = await pdf.load(baseBytes) }
        catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(baseFile.name)
          if (!pwd) return
          showProgress('Decrypting base PDF…')
          baseDoc = await pdf.load(baseBytes, pwd)
        }

        // Load overlay PDF
        updateProgress('Loading overlay PDF…')
        const overlayBytes = await readFile(overlayFile)
        let overlayDoc
        try { overlayDoc = await PDFDocument.load(overlayBytes) }
        catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(overlayFile.name)
          if (!pwd) return
          showProgress('Decrypting overlay PDF…')
          overlayDoc = await PDFDocument.load(overlayBytes, { password: pwd })
        }

        // Validate overlay page number
        const overlayPageInput = parseInt(container.querySelector('#ov-overlay-page').value) || 1
        const overlayPageCount = overlayDoc.getPageCount()
        if (overlayPageInput < 1 || overlayPageInput > overlayPageCount) {
          toast(
            `Overlay PDF only has ${overlayPageCount} page${overlayPageCount > 1 ? 's' : ''}. ` +
            `Using page 1.`,
            'warning',
          )
        }
        const overlayPageIdx = Math.min(Math.max(overlayPageInput - 1, 0), overlayPageCount - 1)

        // Embed the overlay page into the base doc
        updateProgress('Embedding overlay page…')
        const [embeddedPage] = await baseDoc.embedPdf(overlayDoc, [overlayPageIdx])

        // Resolve target pages
        const pagesSel = container.querySelector('#ov-pages-sel').value
        const allPages = baseDoc.getPages()
        let targetPages

        if (pagesSel === 'first') {
          targetPages = [allPages[0]]
        } else if (pagesSel === 'last') {
          targetPages = [allPages[allPages.length - 1]]
        } else if (pagesSel === 'custom') {
          const raw = container.querySelector('#ov-pages-custom').value.trim()
          const indices = parsePageRange(raw, baseDoc.getPageCount())
          if (!indices.length) {
            toast('Invalid page range — applying to all pages.', 'warning')
            targetPages = allPages
          } else {
            targetPages = indices.map(i => allPages[i]).filter(Boolean)
          }
        } else {
          targetPages = allPages
        }

        const mode    = container.querySelector('input[name="ov-mode"]:checked').value
        const opacity = parseInt(opacitySlider.value) / 100

        updateProgress('Applying overlay…')
        for (const page of targetPages) {
          const { width, height } = page.getSize()
          const drawOpts = {
            x: 0,
            y: 0,
            width,
            height,
            opacity: mode === 'underlay' ? opacity * 0.4 : opacity,
          }
          page.drawPage(embeddedPage, drawOpts)
        }

        updateProgress('Saving…')
        const outName  = ensurePdf(
          container.querySelector('#ov-output').value.trim() || stripExt(baseFile.name) + '_overlaid'
        )
        const outBytes = await pdf.save(baseDoc)
        await saveAs(outBytes, outName)

        const pageWord = targetPages.length === 1 ? 'page' : 'pages'
        const modeLabel = mode === 'underlay' ? 'underlay' : 'overlay'
        toast(`${modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1)} applied to ${targetPages.length} ${pageWord} → ${outName}`, 'success')
        statusEl.textContent = `Done — ${modeLabel} applied to ${targetPages.length} ${pageWord}.`
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed: ' + err.message, 'error')
          statusEl.textContent = 'Error — see console for details.'
        }
      } finally {
        hideProgress()
      }
    })
  },
})
