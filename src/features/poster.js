/**
 * Poster / Tile Print — split one large PDF page across multiple sheets.
 *
 * Use case: you have a large-format page (A0 poster, floor plan, map) and
 * want to print it on regular A4/Letter sheets, then tape them together.
 *
 * How it works:
 *   The source page is embedded as a PDF Form XObject (vector, no rasterisation).
 *   For each tile in the grid, a new output sheet is created and the embedded
 *   page is drawn offset so that only the relevant tile portion is visible
 *   (content outside the sheet boundary is clipped by the PDF viewer).
 *
 * With overlap: adjacent tiles share `overlap` pt of content so you can cut
 * and align them precisely when assembling.
 */

import { registerFeature }                              from '../core/registry.js'
import { readFile, saveAs }                             from '../core/fs.js'
import * as pdf                                         from '../core/pdf.js'
import { PDFDocument, rgb, StandardFonts, degrees }    from '@cantoo/pdf-lib'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { get }                                                               from '../core/state.js'

const PT_PER_MM = 72 / 25.4

const SHEET_SIZES = {
  'a4':     [595.28, 841.89],
  'letter': [612, 792],
  'a3':     [841.89, 1190.55],
  'a5':     [419.53, 595.28],
}

registerFeature({
  id:          'poster',
  name:        'Poster / Tile Print',
  category:    'Pages',
  icon:        '🗺',
  description: 'Split a large page across multiple sheets for assembly',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Poster / Tile Print</h2>
        <p class="feature-desc">
          Split a large PDF page (poster, floor plan, map) across multiple A4 or Letter
          sheets so you can print and assemble them. Content quality is vector — no
          rasterisation.
        </p>
      </div>

      <div class="feature-split">

        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Source PDF</span></div>
          <div class="file-drop-zone" id="pt-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="pt-browse">Browse</button>
            <input type="file" id="pt-input" accept=".pdf" hidden>
          </div>
          <div id="pt-filename" class="file-name-display"></div>
          <div id="pt-info" class="status-text" style="margin-top:4px;"></div>

          <div class="section-label" style="margin-top:14px;">Page to tile</div>
          <div class="option-row">
            <label>Page number</label>
            <input type="number" id="pt-page" class="input" min="1" value="1"
              style="max-width:90px;">
            <span id="pt-page-hint" class="status-text"></span>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header"><span class="panel-title">② Tiling Options</span></div>

          <div class="option-row">
            <label>Output sheet</label>
            <select id="pt-sheet" class="input" style="max-width:200px;">
              <option value="a4"     selected>A4 Portrait</option>
              <option value="a4l">A4 Landscape</option>
              <option value="letter">Letter Portrait</option>
              <option value="letterl">Letter Landscape</option>
              <option value="a3">A3 Portrait</option>
            </select>
          </div>

          <div class="option-row">
            <label>Grid</label>
            <select id="pt-grid" class="input" style="max-width:200px;">
              <option value="2x1">2 × 1  (2 sheets wide, 1 tall)</option>
              <option value="1x2">1 × 2  (1 wide, 2 tall)</option>
              <option value="2x2" selected>2 × 2  (4 sheets)</option>
              <option value="3x2">3 × 2  (6 sheets)</option>
              <option value="2x3">2 × 3  (6 sheets)</option>
              <option value="3x3">3 × 3  (9 sheets)</option>
              <option value="4x3">4 × 3  (12 sheets)</option>
              <option value="4x4">4 × 4  (16 sheets)</option>
            </select>
          </div>

          <div class="option-row">
            <label>Overlap (mm)</label>
            <input type="number" id="pt-overlap" class="input" min="0" max="30" value="5"
              style="max-width:80px;">
            <span class="status-text">shared content at edges for alignment</span>
          </div>

          <div class="option-row">
            <label>Margin (mm)</label>
            <input type="number" id="pt-margin" class="input" min="0" max="30" value="10"
              style="max-width:80px;">
            <span class="status-text">printable area inset</span>
          </div>

          <div class="option-row">
            <label>Tile labels</label>
            <input type="checkbox" id="pt-labels" checked style="width:auto;">
            <span class="status-text" style="margin-left:4px;">Print "A1", "A2"… in corner of each sheet</span>
          </div>

          <div class="option-row">
            <label>Crop marks</label>
            <input type="checkbox" id="pt-marks" checked style="width:auto;">
            <span class="status-text" style="margin-left:4px;">Corner marks to guide cutting and alignment</span>
          </div>

          <div id="pt-preview-info" class="status-text"
            style="margin-top:8px;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);display:none;">
          </div>

          <div class="action-bar">
            <button class="btn btn-primary btn-lg" id="pt-run" disabled
              style="width:100%;justify-content:center;">
              Create Tiled PDF
            </button>
          </div>
        </div>

      </div>
    `

    let srcFile = null
    let srcPwd  = null
    const nameEl  = container.querySelector('#pt-filename')
    const infoEl  = container.querySelector('#pt-info')
    const runBtn  = container.querySelector('#pt-run')
    const pageHint = container.querySelector('#pt-page-hint')
    const previewInfo = container.querySelector('#pt-preview-info')

    function updatePreview() {
      if (!srcFile) return
      const [cols, rows] = container.querySelector('#pt-grid').value.split('x').map(Number)
      const sheetKey = container.querySelector('#pt-sheet').value
      const [sw, sh] = SHEET_SIZES[sheetKey] || SHEET_SIZES['a4']
      const overlapPt = parseFloat(container.querySelector('#pt-overlap').value || 0) * PT_PER_MM
      const marginPt  = parseFloat(container.querySelector('#pt-margin').value  || 0) * PT_PER_MM
      const tileStepW = sw - marginPt * 2 - overlapPt
      const tileStepH = sh - marginPt * 2 - overlapPt
      const totalW    = (tileStepW * cols + overlapPt)
      const totalH    = (tileStepH * rows + overlapPt)
      const wMm = (totalW / PT_PER_MM).toFixed(0)
      const hMm = (totalH / PT_PER_MM).toFixed(0)
      previewInfo.style.display = ''
      previewInfo.textContent =
        `${cols * rows} sheets · assembled size ≈ ${wMm} × ${hMm} mm`
    }

    ;['#pt-grid','#pt-sheet','#pt-overlap','#pt-margin'].forEach(id => {
      container.querySelector(id).addEventListener('change', updatePreview)
      container.querySelector(id).addEventListener('input',  updatePreview)
    })

    async function loadFile(file, initialPwd = null) {
      srcFile = file
      nameEl.textContent = file.name
      showProgress('Loading…')
      try {
        const bytes = await readFile(file)
        let pwd = initialPwd
        const doc   = await pdf.load(bytes, pwd || undefined).catch(async err => {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          pwd = await promptPassword(file.name)
          if (!pwd) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' })
          showProgress('Decrypting…')
          return pdf.load(bytes, pwd)
        })
        srcPwd = pwd
        const n = doc.getPageCount()
        infoEl.textContent = `${n} page${n > 1 ? 's' : ''}`
        container.querySelector('#pt-page').max = n
        pageHint.textContent = `of ${n}`
        runBtn.disabled = false
        updatePreview()
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    const dropZone = container.querySelector('#pt-drop')
    const input    = container.querySelector('#pt-input')
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) loadFile(f)
    })
    container.querySelector('#pt-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => {
      if (e.target.files[0]) { loadFile(e.target.files[0]); input.value = '' }
    })

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => loadFile(gf.file, gf.pwd), 0)

    runBtn.addEventListener('click', async () => {
      if (!srcFile) return
      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(srcFile)
        let srcDoc
        try {
          srcDoc = await pdf.load(bytes, srcPwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          srcPwd = pwd
          showProgress('Decrypting…')
          srcDoc = await pdf.load(bytes, pwd)
        }

        const total   = srcDoc.getPageCount()
        const pNum    = Math.max(1, Math.min(total, parseInt(container.querySelector('#pt-page').value) || 1))
        const srcPage = srcDoc.getPage(pNum - 1)
        const { width: srcW, height: srcH } = srcPage.getSize()

        const [cols, rows]  = container.querySelector('#pt-grid').value.split('x').map(Number)
        const sheetKey      = container.querySelector('#pt-sheet').value
        const [sheetW, sheetH] = sheetKey.endsWith('l')
          ? SHEET_SIZES[sheetKey.slice(0, -1)].slice().reverse()
          : SHEET_SIZES[sheetKey] || SHEET_SIZES['a4']
        const overlapPt = parseFloat(container.querySelector('#pt-overlap').value || 0) * PT_PER_MM
        const marginPt  = parseFloat(container.querySelector('#pt-margin').value  || 0) * PT_PER_MM
        const showLabels = container.querySelector('#pt-labels').checked
        const showMarks  = container.querySelector('#pt-marks').checked

        // Content area per tile (inside margins, minus overlap shared with next tile)
        const contentW = sheetW - 2 * marginPt
        const contentH = sheetH - 2 * marginPt
        // Each tile steps by (contentW - overlap) in the source coordinate space
        const stepW = contentW - overlapPt
        const stepH = contentH - overlapPt
        // Total source area covered:
        const totalCovW = stepW * cols + overlapPt
        const totalCovH = stepH * rows + overlapPt

        // Scale source page to fit exactly the total covered area, maintaining aspect ratio
        const scaleX  = totalCovW / srcW
        const scaleY  = totalCovH / srcH
        const scale   = Math.min(scaleX, scaleY)
        const scaledW = srcW * scale
        const scaledH = srcH * scale
        // Center within total covered area
        const offX = (totalCovW - scaledW) / 2
        const offY = (totalCovH - scaledH) / 2

        updateProgress('Embedding source page…')
        const outDoc   = await PDFDocument.create()
        const embedded = await outDoc.embedPage(srcPage)
        const font     = showLabels ? await outDoc.embedFont(StandardFonts.HelveticaBold) : null
        const GREY     = rgb(0.6, 0.6, 0.6)
        const COL_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

        const numSheets = cols * rows
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            updateProgress(`Building sheet ${row * cols + col + 1} of ${numSheets}…`)
            const sheet = outDoc.addPage([sheetW, sheetH])

            // The embedded page should be drawn such that tile (col,row) shows
            // the correct slice of the source.
            //
            // In PDF coords (bottom-left origin):
            //   The tile at (col, row) from top-left shows source area:
            //     x: col*stepW … col*stepW + contentW
            //     y (top-down): row*stepH … row*stepH + contentH
            //
            // The embedded page bottom-left in poster space: (offX, offY)
            // To render tile (col, row), we shift so that:
            //   poster_x = col*stepW  appears at sheet_x = marginPt
            //   poster_y = totalCovH - (row+1)*stepH  appears at sheet_y = marginPt
            //
            // drawX = marginPt - col*stepW + offX
            // drawY = marginPt - (rows-1-row)*stepH + offY

            const drawX = marginPt - col * stepW + offX
            const drawY = marginPt - (rows - 1 - row) * stepH + offY

            sheet.drawPage(embedded, { x: drawX, y: drawY, width: scaledW, height: scaledH })

            // ── Crop marks ───────────────────────────────────────────────────
            if (showMarks) {
              const mk = 8    // mark length pt
              const gl = 4    // gap from content edge
              const corners = [
                [marginPt, marginPt],
                [sheetW - marginPt, marginPt],
                [marginPt, sheetH - marginPt],
                [sheetW - marginPt, sheetH - marginPt],
              ]
              for (const [cx, cy] of corners) {
                const dx = cx < sheetW / 2 ? -1 : 1
                const dy = cy < sheetH / 2 ? -1 : 1
                sheet.drawLine({ start: { x: cx + dx * gl, y: cy }, end: { x: cx + dx * (gl + mk), y: cy }, thickness: 0.5, color: GREY })
                sheet.drawLine({ start: { x: cx, y: cy + dy * gl }, end: { x: cx, y: cy + dy * (gl + mk) }, thickness: 0.5, color: GREY })
              }
            }

            // ── Tile label ───────────────────────────────────────────────────
            if (showLabels && font) {
              const label = `${COL_LABELS[col] || col + 1}${row + 1}`
              sheet.drawText(label, {
                x: 6, y: sheetH - 16,
                size: 10, font, color: GREY,
              })
            }
          }
        }

        const outBytes = await outDoc.save()
        const outName  = srcFile.name.replace(/\.pdf$/i, `_poster_${cols}x${rows}.pdf`)
        await saveAs(outBytes, outName)
        toast(
          `${numSheets} sheet${numSheets > 1 ? 's' : ''} created → ${outName}`,
          'success'
        )
      } catch (err) {
        if (err.name !== 'AbortError') { console.error(err); toast('Failed: ' + err.message, 'error') }
      } finally {
        hideProgress()
      }
    })
  },
})
