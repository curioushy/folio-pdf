/**
 * N-up / Imposition — place multiple PDF pages onto a single sheet.
 *
 * Layouts:
 *   2-up landscape: two pages side-by-side on a wider sheet
 *   4-up portrait:  four pages in a 2×2 grid
 *   2-up booklet:   pairs reordered for saddle-stitch folding
 *
 * Implementation note:
 *   pdf-lib's `PDFDocument.embedPage(page)` creates a Form XObject from a
 *   page, which can then be drawn at any position and scale with
 *   `page.drawPage(embedded, { x, y, width, height })`.
 *   This preserves vector quality (no rasterization).
 *
 * Output page size options: source size, A4, US Letter, A3.
 */

import { registerFeature }                              from '../core/registry.js'
import { readFile, saveAs }                             from '../core/fs.js'
import * as pdf                                         from '../core/pdf.js'
import { PDFDocument }                                  from '@cantoo/pdf-lib'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { parsePageRange }                               from '../core/utils.js'
import { get }                                         from '../core/state.js'

// Standard sheet sizes in points (72pt = 1in)
const SHEET_SIZES = {
  'a4-landscape':  [841.89, 595.28],
  'a4-portrait':   [595.28, 841.89],
  'letter-landscape': [792, 612],
  'letter-portrait':  [612, 792],
  'a3-landscape':  [1190.55, 841.89],
  'a3-portrait':   [841.89, 1190.55],
}

registerFeature({
  id:          'n-up',
  name:        'N-up / Imposition',
  category:    'Pages',
  icon:        '⊞',
  description: '2-up or 4-up: place multiple pages per sheet for printing',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>N-up / Imposition</h2>
        <p class="feature-desc">
          Arrange multiple PDF pages onto a single sheet — useful for
          printing drafts, handouts, or saddle-stitch booklets.
        </p>
      </div>

      <div class="feature-split">

        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Source PDF</span></div>
          <div class="file-drop-zone" id="nu-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="nu-browse">Browse</button>
            <input type="file" id="nu-input" accept=".pdf" hidden>
          </div>
          <div id="nu-filename" class="file-name-display"></div>
          <div id="nu-info" class="status-text" style="margin-top:4px;"></div>

          <div class="section-label" style="margin-top:14px;">Pages</div>
          <div class="option-row">
            <label>Source pages</label>
            <select id="nu-pages-sel" class="input" style="max-width:180px;">
              <option value="all">All pages</option>
              <option value="custom">Custom range…</option>
            </select>
          </div>
          <div id="nu-pages-row" class="option-row" style="display:none;">
            <label>Range</label>
            <input type="text" id="nu-pages-custom" class="input"
              placeholder="e.g. 1-8, 12" style="max-width:200px;">
          </div>
        </div>

        <div class="panel">
          <div class="panel-header"><span class="panel-title">② Layout</span></div>

          <div class="option-row">
            <label>Layout</label>
            <select id="nu-layout" class="input" style="max-width:220px;">
              <option value="2up" selected>2-up  (side by side)</option>
              <option value="4up">4-up  (2×2 grid)</option>
              <option value="booklet">Booklet  (2-up, saddle-stitch order)</option>
            </select>
          </div>

          <div class="option-row">
            <label>Sheet size</label>
            <select id="nu-sheet" class="input" style="max-width:220px;">
              <option value="a4-landscape"     selected>A4 Landscape</option>
              <option value="a4-portrait">A4 Portrait</option>
              <option value="letter-landscape">Letter Landscape</option>
              <option value="letter-portrait">Letter Portrait</option>
              <option value="a3-landscape">A3 Landscape</option>
              <option value="a3-portrait">A3 Portrait</option>
            </select>
          </div>

          <div class="option-row">
            <label>Gutter (mm)</label>
            <input type="number" id="nu-gutter" class="input" min="0" max="30" value="4"
              style="max-width:80px;">
            <span class="status-text">gap between pages</span>
          </div>

          <div class="option-row">
            <label>Margin (mm)</label>
            <input type="number" id="nu-margin" class="input" min="0" max="30" value="4"
              style="max-width:80px;">
            <span class="status-text">sheet edge</span>
          </div>

          <div class="option-row">
            <label>Draw borders</label>
            <input type="checkbox" id="nu-border" style="width:auto;">
          </div>

          <div class="action-bar">
            <button class="btn btn-primary btn-lg" id="nu-run" disabled
              style="width:100%;justify-content:center;">
              Create N-up PDF
            </button>
          </div>
        </div>

      </div>
    `

    let srcFile = null
    let srcPwd  = null

    // ── Drop zone ─────────────────────────────────────────────────────────────
    const dropZone = container.querySelector('#nu-drop')
    const input    = container.querySelector('#nu-input')
    const nameEl   = container.querySelector('#nu-filename')
    const infoEl   = container.querySelector('#nu-info')
    const runBtn   = container.querySelector('#nu-run')

    async function loadFile(file, initialPwd = null) {
      srcFile = file
      nameEl.textContent = file.name
      showProgress('Loading…')
      try {
        const bytes = await readFile(file)
        let pwd = initialPwd
        const doc = await pdf.load(bytes, pwd || undefined).catch(async err => {
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
        runBtn.disabled = false
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) loadFile(f)
    })
    container.querySelector('#nu-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => {
      if (e.target.files[0]) { loadFile(e.target.files[0]); input.value = '' }
    })

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => loadFile(gf.file, gf.pwd), 0)

    // Pages selector
    container.querySelector('#nu-pages-sel').addEventListener('change', e => {
      container.querySelector('#nu-pages-row').style.display =
        e.target.value === 'custom' ? 'flex' : 'none'
    })

    // ── Run ───────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      if (!srcFile) return

      showProgress('Loading PDF…')
      try {
        const bytes  = await readFile(srcFile)
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

        const totalSrc = srcDoc.getPageCount()
        const layout   = container.querySelector('#nu-layout').value
        const sheetKey = container.querySelector('#nu-sheet').value
        const gutterMm = parseFloat(container.querySelector('#nu-gutter').value) || 0
        const marginMm = parseFloat(container.querySelector('#nu-margin').value) || 0
        const drawBord = container.querySelector('#nu-border').checked
        const PT_PER_MM = 72 / 25.4
        const gutter = gutterMm * PT_PER_MM
        const margin = marginMm * PT_PER_MM

        // Resolve source page list
        let srcPageIdx
        if (container.querySelector('#nu-pages-sel').value === 'custom') {
          const raw = container.querySelector('#nu-pages-custom').value.trim()
          srcPageIdx = parsePageRange(raw, totalSrc)
        } else {
          srcPageIdx = Array.from({ length: totalSrc }, (_, i) => i)
        }

        const [sheetW, sheetH] = SHEET_SIZES[sheetKey]
        const perSheet = layout === '4up' ? 4 : 2

        // Booklet reordering: for N pages, order is [last, first, second, last-1, …]
        let orderedIdx
        if (layout === 'booklet') {
          // Pad to multiple of 4
          const padded = [...srcPageIdx]
          while (padded.length % 4 !== 0) padded.push(null)   // null = blank
          orderedIdx = []
          let lo = 0, hi = padded.length - 1
          while (lo < hi) {
            orderedIdx.push(hi--, lo++, lo++, hi--)
          }
        } else {
          orderedIdx = [...srcPageIdx]
        }

        // Pad to full sheets
        while (orderedIdx.length % perSheet !== 0) orderedIdx.push(null)

        updateProgress('Embedding pages…')
        const outDoc   = await PDFDocument.create()
        const srcPages = srcDoc.getPages()

        // Pre-embed all unique non-null pages once
        const embedded = new Map()
        for (const idx of new Set(orderedIdx.filter(i => i !== null))) {
          embedded.set(idx, await outDoc.embedPage(srcPages[idx]))
        }

        const numSheets = orderedIdx.length / perSheet

        for (let s = 0; s < numSheets; s++) {
          updateProgress(`Building sheet ${s + 1} of ${numSheets}…`)
          const sheet   = outDoc.addPage([sheetW, sheetH])
          const pageSet = orderedIdx.slice(s * perSheet, (s + 1) * perSheet)

          // Compute cell grid
          let cols, rows
          if (perSheet === 2) { cols = 2; rows = 1 }
          else                { cols = 2; rows = 2 }

          const cellW = (sheetW - 2 * margin - (cols - 1) * gutter) / cols
          const cellH = (sheetH - 2 * margin - (rows - 1) * gutter) / rows

          for (let ci = 0; ci < perSheet; ci++) {
            const srcIdx = pageSet[ci]
            const col    = ci % cols
            const row    = Math.floor(ci / cols)

            const cellX = margin + col * (cellW + gutter)
            // PDF y is from bottom, row 0 should be at top
            const cellY = sheetH - margin - (row + 1) * cellH - row * gutter

            if (srcIdx === null) continue   // blank cell (booklet padding)

            const emb  = embedded.get(srcIdx)
            const orig = srcPages[srcIdx]
            const { width: origW, height: origH } = orig.getSize()

            // Fit inside cell, maintain aspect ratio, center
            const scaleX = cellW / origW
            const scaleY = cellH / origH
            const fit    = Math.min(scaleX, scaleY)
            const drawnW = origW * fit
            const drawnH = origH * fit
            const offX   = (cellW - drawnW) / 2
            const offY   = (cellH - drawnH) / 2

            sheet.drawPage(emb, {
              x: cellX + offX,
              y: cellY + offY,
              width:  drawnW,
              height: drawnH,
            })

            if (drawBord) {
              sheet.drawRectangle({
                x: cellX, y: cellY, width: cellW, height: cellH,
                borderColor: { type: 'RGB', red: 0.7, green: 0.7, blue: 0.7 },
                borderWidth: 0.5,
                color: undefined,
              })
            }
          }
        }

        updateProgress('Saving…')
        const outBytes = await outDoc.save()
        const suffix   = layout === 'booklet' ? '_booklet' : `_${layout}`
        const outName  = srcFile.name.replace(/\.pdf$/i, `${suffix}.pdf`)
        await saveAs(outBytes, outName)

        const n = orderedIdx.filter(i => i !== null).length
        toast(
          `${numSheets} sheet${numSheets > 1 ? 's' : ''} · ${n} pages placed → ${outName}`,
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
