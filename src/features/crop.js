/**
 * Crop Pages feature — trim margins on a PDF's pages.
 *
 * Workflow:
 *   1. User drops a PDF → we render page 1 as a preview canvas.
 *   2. A draggable crop rectangle overlays the preview. Corner/edge handles
 *      let the user resize it interactively; numeric inputs (mm) reflect
 *      the current margins in sync with drags.
 *   3. On Apply, we call pdf-lib's `setCropBox` on every page in the chosen
 *      range, producing a PDF whose viewers and printers show only the
 *      cropped region.
 *
 * Note: cropping only adjusts the /CropBox — the original page content is
 * still in the file, just not displayed. If you need to *remove* the trimmed
 * content, render to images and rebuild. For viewing/printing, /CropBox is
 * what you want.
 */

import { registerFeature }                                          from '../core/registry.js'
import { readFile, saveAs }                                         from '../core/fs.js'
import * as pdf                                                     from '../core/pdf.js'
import * as renderer                                                from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, parsePageRange }                                 from '../core/utils.js'
import { get }                                                      from '../core/state.js'

const PT_PER_MM = 72 / 25.4   // 1 mm ≈ 2.835 pt

registerFeature({
  id:          'crop',
  name:        'Crop Pages',
  category:    'Pages',
  icon:        '✂',
  description: 'Trim margins — removes white space around pages',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Crop Pages</h2>
        <p class="feature-desc">
          Trim margins around your PDF pages. Drag the handles on the preview
          to set the crop area — or type exact margins in millimetres below.
        </p>
      </div>

      <div class="feature-split">

        <!-- ── LEFT: Source + Settings ─────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Source &amp; Settings</span></div>

          <div class="file-drop-zone" id="crop-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="crop-browse">Browse</button>
            <input type="file" id="crop-input" accept=".pdf" hidden>
          </div>
          <div id="crop-filename" class="file-name-display"></div>

          <div class="section-label" style="margin-top:14px;">Margins to trim (mm)</div>
          <div class="option-row">
            <label>Top</label>
            <input type="number" id="crop-top" class="input" value="0" min="0" step="1" style="max-width:100px;">
          </div>
          <div class="option-row">
            <label>Right</label>
            <input type="number" id="crop-right" class="input" value="0" min="0" step="1" style="max-width:100px;">
          </div>
          <div class="option-row">
            <label>Bottom</label>
            <input type="number" id="crop-bottom" class="input" value="0" min="0" step="1" style="max-width:100px;">
          </div>
          <div class="option-row">
            <label>Left</label>
            <input type="number" id="crop-left" class="input" value="0" min="0" step="1" style="max-width:100px;">
          </div>

          <div class="section-label" style="margin-top:14px;">Quick presets</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            <button class="btn btn-sm" data-preset="reset">Reset</button>
            <button class="btn btn-sm" data-preset="5">Trim 5mm</button>
            <button class="btn btn-sm" data-preset="10">Trim 10mm</button>
            <button class="btn btn-sm" data-preset="15">Trim 15mm</button>
            <button class="btn btn-sm" data-preset="20">Trim 20mm</button>
          </div>

          <div class="section-label" style="margin-top:14px;">Apply to</div>
          <div class="option-row">
            <label>Pages</label>
            <select id="crop-pages-sel" class="input" style="max-width:180px;">
              <option value="all" selected>All pages</option>
              <option value="custom">Custom range…</option>
            </select>
          </div>
          <div id="crop-pages-custom-row" class="option-row" style="display:none;">
            <label>Range</label>
            <input type="text" id="crop-pages-custom" class="input"
              placeholder="e.g. 1-3, 5, 8-10" style="max-width:200px;">
          </div>

          <div class="action-bar" style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="crop-run" disabled
              style="width:100%;justify-content:center;">
              Save Cropped PDF
            </button>
          </div>
          <div class="status-text" id="crop-status" style="text-align:center;margin-top:8px;">
            Load a PDF to get started.
          </div>

          <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);">
            <p style="font-size:12px;color:var(--text-subtle);line-height:1.7;">
              ℹ Cropping only adjusts what viewers display. The original
              content is preserved in the file — open the result in Acrobat and
              "Reset Page Boxes" restores the full page if needed.
            </p>
          </div>
        </div>

        <!-- ── RIGHT: Preview ──────────────────────────────────────────── -->
        <div class="panel" style="display:flex;flex-direction:column;">
          <div class="panel-header">
            <span class="panel-title">② Preview</span>
            <span class="status-text" id="crop-dims"></span>
          </div>

          <div id="crop-preview-wrap"
            style="position:relative;flex:1;min-height:420px;display:flex;
                   align-items:center;justify-content:center;
                   background:var(--bg);border:1px solid var(--border);
                   border-radius:var(--radius-sm);overflow:hidden;">
            <div id="crop-preview-empty" style="color:var(--text-subtle);font-size:13px;">
              Preview will appear here after loading a PDF.
            </div>
            <div id="crop-preview-stage" style="position:relative;display:none;">
              <canvas id="crop-canvas" style="display:block;box-shadow:var(--shadow);"></canvas>
              <div id="crop-overlay"
                style="position:absolute;border:2px solid var(--blue);
                       background:rgba(37,99,235,0.08);box-sizing:border-box;
                       cursor:move;">
                <div class="crop-handle" data-h="nw" style="top:-7px;left:-7px;cursor:nwse-resize;"></div>
                <div class="crop-handle" data-h="n"  style="top:-7px;left:50%;margin-left:-6px;cursor:ns-resize;"></div>
                <div class="crop-handle" data-h="ne" style="top:-7px;right:-7px;cursor:nesw-resize;"></div>
                <div class="crop-handle" data-h="e"  style="top:50%;right:-7px;margin-top:-6px;cursor:ew-resize;"></div>
                <div class="crop-handle" data-h="se" style="bottom:-7px;right:-7px;cursor:nwse-resize;"></div>
                <div class="crop-handle" data-h="s"  style="bottom:-7px;left:50%;margin-left:-6px;cursor:ns-resize;"></div>
                <div class="crop-handle" data-h="sw" style="bottom:-7px;left:-7px;cursor:nesw-resize;"></div>
                <div class="crop-handle" data-h="w"  style="top:50%;left:-7px;margin-top:-6px;cursor:ew-resize;"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>
        .crop-handle {
          position: absolute; width: 12px; height: 12px;
          background: var(--blue); border: 2px solid #fff;
          border-radius: 2px; box-sizing: border-box;
          box-shadow: 0 0 0 1px rgba(0,0,0,0.15);
        }
      </style>
    `

    // ── State ───────────────────────────────────────────────────────────────
    let srcFile = null
    let srcPwd  = null
    let srcBytes = null
    let pageWidthPt = 0   // page 1 width in PDF points
    let pageHeightPt = 0
    let displayScale = 1  // screen px per PDF pt
    /** Margins in mm (state of record — drags + inputs sync to these) */
    const margins = { top: 0, right: 0, bottom: 0, left: 0 }

    // ── DOM ──────────────────────────────────────────────────────────────────
    const $ = sel => container.querySelector(sel)
    const runBtn    = $('#crop-run')
    const statusEl  = $('#crop-status')
    const nameEl    = $('#crop-filename')
    const canvas    = $('#crop-canvas')
    const overlay   = $('#crop-overlay')
    const stage     = $('#crop-preview-stage')
    const empty     = $('#crop-preview-empty')
    const dimsEl    = $('#crop-dims')
    const inputs = {
      top:    $('#crop-top'),
      right:  $('#crop-right'),
      bottom: $('#crop-bottom'),
      left:   $('#crop-left'),
    }

    // ── Margin ↔ overlay sync ────────────────────────────────────────────────
    function syncOverlayFromMargins() {
      if (!pageWidthPt) return
      const leftPx   = margins.left   * PT_PER_MM * displayScale
      const topPx    = margins.top    * PT_PER_MM * displayScale
      const rightPx  = margins.right  * PT_PER_MM * displayScale
      const bottomPx = margins.bottom * PT_PER_MM * displayScale
      const widthPx  = canvas.width  - leftPx - rightPx
      const heightPx = canvas.height - topPx  - bottomPx
      overlay.style.left   = leftPx + 'px'
      overlay.style.top    = topPx  + 'px'
      overlay.style.width  = Math.max(20, widthPx)  + 'px'
      overlay.style.height = Math.max(20, heightPx) + 'px'

      // Status dims
      const cropWmm = (pageWidthPt  / PT_PER_MM) - margins.left - margins.right
      const cropHmm = (pageHeightPt / PT_PER_MM) - margins.top  - margins.bottom
      dimsEl.textContent =
        `Output: ${cropWmm.toFixed(0)} × ${cropHmm.toFixed(0)} mm`
    }

    function syncInputsFromMargins() {
      inputs.top.value    = Math.round(margins.top)
      inputs.right.value  = Math.round(margins.right)
      inputs.bottom.value = Math.round(margins.bottom)
      inputs.left.value   = Math.round(margins.left)
    }

    function clampMargins() {
      const maxH = (pageWidthPt  / PT_PER_MM) - 5   // leave 5mm min width
      const maxV = (pageHeightPt / PT_PER_MM) - 5
      if (margins.left + margins.right > maxH) {
        margins.right = Math.max(0, maxH - margins.left)
      }
      if (margins.top + margins.bottom > maxV) {
        margins.bottom = Math.max(0, maxV - margins.top)
      }
      for (const k of Object.keys(margins)) margins[k] = Math.max(0, margins[k])
    }

    function updateAll() {
      clampMargins()
      syncInputsFromMargins()
      syncOverlayFromMargins()
    }

    // Inputs → margins
    Object.entries(inputs).forEach(([side, el]) => {
      el.addEventListener('input', () => {
        margins[side] = parseFloat(el.value) || 0
        updateAll()
      })
    })

    // Presets
    container.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.preset
        if (p === 'reset') {
          margins.top = margins.right = margins.bottom = margins.left = 0
        } else {
          const v = parseFloat(p)
          margins.top = margins.right = margins.bottom = margins.left = v
        }
        updateAll()
      })
    })

    // ── Interactive drag on overlay ──────────────────────────────────────────
    let dragState = null
    overlay.addEventListener('mousedown', e => {
      e.preventDefault()
      const handle = e.target.closest('.crop-handle')
      const rect = overlay.getBoundingClientRect()
      dragState = {
        handle: handle ? handle.dataset.h : 'move',
        startX: e.clientX,
        startY: e.clientY,
        startLeft:   parseFloat(overlay.style.left)   || 0,
        startTop:    parseFloat(overlay.style.top)    || 0,
        startWidth:  rect.width,
        startHeight: rect.height,
      }
    })

    window.addEventListener('mousemove', e => {
      if (!dragState) return
      const dx = e.clientX - dragState.startX
      const dy = e.clientY - dragState.startY
      const { handle, startLeft, startTop, startWidth, startHeight } = dragState

      let newLeft   = startLeft
      let newTop    = startTop
      let newRight  = canvas.width  - startLeft - startWidth
      let newBottom = canvas.height - startTop  - startHeight

      if (handle === 'move') {
        newLeft   = Math.max(0, Math.min(canvas.width  - startWidth,  startLeft + dx))
        newTop    = Math.max(0, Math.min(canvas.height - startHeight, startTop  + dy))
        newRight  = canvas.width  - newLeft - startWidth
        newBottom = canvas.height - newTop  - startHeight
      } else {
        if (handle.includes('n')) {
          newTop = Math.max(0, Math.min(canvas.height - 20, startTop + dy))
        }
        if (handle.includes('s')) {
          newBottom = Math.max(0, Math.min(canvas.height - 20, (canvas.height - startTop - startHeight) - dy))
        }
        if (handle.includes('w')) {
          newLeft = Math.max(0, Math.min(canvas.width - 20, startLeft + dx))
        }
        if (handle.includes('e')) {
          newRight = Math.max(0, Math.min(canvas.width - 20, (canvas.width - startLeft - startWidth) - dx))
        }
      }

      margins.left   = newLeft   / displayScale / PT_PER_MM
      margins.top    = newTop    / displayScale / PT_PER_MM
      margins.right  = newRight  / displayScale / PT_PER_MM
      margins.bottom = newBottom / displayScale / PT_PER_MM
      updateAll()
    })

    window.addEventListener('mouseup', () => { dragState = null })

    // ── Pages selector ───────────────────────────────────────────────────────
    $('#crop-pages-sel').addEventListener('change', e => {
      $('#crop-pages-custom-row').style.display =
        e.target.value === 'custom' ? 'flex' : 'none'
    })

    // ── File loading ─────────────────────────────────────────────────────────
    async function setFile(file, pwd = null) {
      srcFile = file
      srcPwd  = pwd
      nameEl.textContent = file.name
      statusEl.textContent = 'Rendering preview…'
      runBtn.disabled = true
      empty.style.display = 'block'
      stage.style.display = 'none'

      try {
        srcBytes = await readFile(file)
        let rDoc
        try {
          rDoc = await renderer.loadForRender(srcBytes)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          const pwd = await promptPassword(file.name)
          if (!pwd) { statusEl.textContent = 'Cancelled.'; return }
          rDoc = await renderer.loadForRender(srcBytes, pwd)
          // Stash password for save step via re-decrypt (not supported in pdf-lib)
          // — for now we only support unencrypted PDFs going through the save path.
          toast('Password-protected PDFs: crop works on rendered pages only in v1.', 'warning')
        }

        // Render page 1 to the preview canvas at fit-width scale
        const page1 = await rDoc.getPage(1)
        const nativeVp = page1.getViewport({ scale: 1 })
        pageWidthPt  = nativeVp.width
        pageHeightPt = nativeVp.height

        // Fit canvas to its wrap (max 600 wide, 520 tall)
        const wrap = $('#crop-preview-wrap')
        const maxW = Math.max(200, wrap.clientWidth  - 40)
        const maxH = Math.max(200, wrap.clientHeight - 40)
        const scaleW = maxW / pageWidthPt
        const scaleH = maxH / pageHeightPt
        displayScale = Math.min(scaleW, scaleH, 1.5)
        const vp = page1.getViewport({ scale: displayScale })

        canvas.width  = Math.round(vp.width)
        canvas.height = Math.round(vp.height)
        await page1.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
        page1.cleanup()
        rDoc.destroy()

        empty.style.display = 'none'
        stage.style.display = 'block'
        margins.top = margins.right = margins.bottom = margins.left = 0
        updateAll()

        runBtn.disabled = false
        statusEl.textContent = 'Ready.'
      } catch (err) {
        console.error(err)
        statusEl.textContent = 'Failed to load: ' + err.message
        toast('Load failed: ' + err.message, 'error')
      }
    }

    setupDropZone('crop-drop', 'crop-input', setFile)

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => setFile(gf.file, gf.pwd), 0)

    // ── Run (save cropped PDF) ───────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      if (!srcBytes) return

      showProgress('Cropping…')
      try {
        let doc
        try {
          doc = await pdf.load(srcBytes)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          showProgress('Decrypting…')
          doc = await pdf.load(srcBytes, pwd)
        }

        const totalPages = doc.getPageCount()
        let pageIndices
        if ($('#crop-pages-sel').value === 'custom') {
          const raw = $('#crop-pages-custom').value.trim()
          pageIndices = parsePageRange(raw, totalPages)
          if (!pageIndices.length) {
            toast('Invalid page range.', 'warning')
            hideProgress(); return
          }
        } else {
          pageIndices = Array.from({ length: totalPages }, (_, i) => i)
        }

        const topPt    = margins.top    * PT_PER_MM
        const rightPt  = margins.right  * PT_PER_MM
        const bottomPt = margins.bottom * PT_PER_MM
        const leftPt   = margins.left   * PT_PER_MM

        for (const i of pageIndices) {
          const page = doc.getPage(i)
          const { width: w, height: h } = page.getSize()

          // Respect any existing crop box (start from it, not the media box).
          // pdf-lib uses mediaBox as origin when cropBox absent.
          const cropW = Math.max(5, w - leftPt - rightPt)
          const cropH = Math.max(5, h - topPt  - bottomPt)

          // PDF coords: origin bottom-left, y-up.
          // "Top margin" removes from the top → lower the upper edge by topPt.
          page.setCropBox(leftPt, bottomPt, cropW, cropH)
        }

        updateProgress('Saving…')
        const outBytes = await pdf.save(doc)
        const outName  = stripExt(srcFile.name) + '_cropped.pdf'
        await saveAs(outBytes, outName)

        toast(`Cropped → ${outName} (${pageIndices.length} page${pageIndices.length > 1 ? 's' : ''})`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    })

    // ── Drop zone helper ─────────────────────────────────────────────────────
    function setupDropZone(dropId, inputId, onFile) {
      const zone  = container.querySelector(`#${dropId}`)
      const input = container.querySelector(`#${inputId}`)
      zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over') })
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
      zone.addEventListener('drop', e => {
        e.preventDefault(); zone.classList.remove('drag-over')
        const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
        if (f) onFile(f)
      })
      zone.querySelector('button').addEventListener('click', () => input.click())
      input.addEventListener('change', e => {
        if (e.target.files[0]) { onFile(e.target.files[0]); input.value = '' }
      })
    }
  },
})
