/**
 * Insert Blank Pages — add blank pages at chosen positions in a PDF.
 *
 * Common uses:
 *   • Add a blank signing page at the end
 *   • Insert chapter dividers between specific pages
 *   • Fix double-sided printing by padding to even page counts
 *
 * Page size for the inserted blanks can match the adjacent page or be a
 * standard size (A4 / US Letter).
 */

import { registerFeature }                              from '../core/registry.js'
import { readFile, saveAs }                             from '../core/fs.js'
import * as pdf                                         from '../core/pdf.js'
import { toast, showProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, parsePageRange }                    from '../core/utils.js'

// Common page sizes in points (72pt = 1in)
const PAGE_SIZES = {
  'match':  null,           // resolved at runtime
  'a4':     [595.28, 841.89],
  'letter': [612, 792],
  'a3':     [841.89, 1190.55],
  'a5':     [419.53, 595.28],
}

registerFeature({
  id:          'insert-pages',
  name:        'Insert Blank Pages',
  category:    'Pages',
  icon:        '➕',
  description: 'Add blank pages at any position — signing pages, chapter dividers, padding',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Insert Blank Pages</h2>
        <p class="feature-desc">
          Add one or more blank pages before or after any page in the document.
        </p>
      </div>

      <div class="panel">

        <div class="section-label">Select PDF</div>
        <div class="file-drop-zone" id="ins-drop">
          Drag a PDF here, or
          <button class="btn btn-sm" id="ins-browse">Browse</button>
          <input type="file" id="ins-input" accept=".pdf" hidden>
        </div>
        <div id="ins-filename" class="file-name-display"></div>
        <div id="ins-info" class="status-text" style="margin-top:4px;"></div>

        <div class="section-label" style="margin-top:14px;">Position</div>

        <div class="option-row">
          <label>Insert</label>
          <select id="ins-where" class="input" style="max-width:240px;">
            <option value="before">Before page…</option>
            <option value="after">After page…</option>
            <option value="end" selected>At the end</option>
          </select>
        </div>

        <div class="option-row" id="ins-page-row" style="display:none;">
          <label>Page number</label>
          <input type="number" id="ins-page-num" class="input" min="1" value="1"
            style="max-width:100px;">
          <span id="ins-page-hint" class="status-text"></span>
        </div>

        <div class="section-label" style="margin-top:14px;">Blank Pages</div>

        <div class="option-row">
          <label>Count</label>
          <input type="number" id="ins-count" class="input" min="1" max="20" value="1"
            style="max-width:100px;">
        </div>

        <div class="option-row">
          <label>Page size</label>
          <select id="ins-size" class="input" style="max-width:200px;">
            <option value="match" selected>Match adjacent page</option>
            <option value="a4">A4  (210 × 297 mm)</option>
            <option value="letter">US Letter  (8.5 × 11 in)</option>
            <option value="a3">A3  (297 × 420 mm)</option>
            <option value="a5">A5  (148 × 210 mm)</option>
          </select>
        </div>

        <div class="option-row">
          <label>Orientation</label>
          <select id="ins-orient" class="input" style="max-width:200px;">
            <option value="portrait"  selected>Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </div>

        <div class="action-bar">
          <button class="btn btn-primary btn-lg" id="ins-run" disabled>Insert Pages</button>
        </div>

      </div>
    `

    let srcFile   = null
    let pdfDoc    = null
    let totalPgs  = 0

    const nameEl    = container.querySelector('#ins-filename')
    const infoEl    = container.querySelector('#ins-info')
    const runBtn    = container.querySelector('#ins-run')
    const whereEl   = container.querySelector('#ins-where')
    const pageRow   = container.querySelector('#ins-page-row')
    const pageNumEl = container.querySelector('#ins-page-num')
    const pageHint  = container.querySelector('#ins-page-hint')

    whereEl.addEventListener('change', () => {
      pageRow.style.display = whereEl.value === 'end' ? 'none' : 'flex'
    })

    async function loadFile(file) {
      srcFile = file
      nameEl.textContent = file.name
      showProgress('Loading…')
      try {
        const bytes = await readFile(file)
        try {
          pdfDoc = await pdf.load(bytes)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(file.name)
          if (!pwd) return
          showProgress('Decrypting…')
          pdfDoc = await pdf.load(bytes, pwd)
        }
        totalPgs = pdfDoc.getPageCount()
        infoEl.textContent = `${totalPgs} page${totalPgs > 1 ? 's' : ''}`
        pageNumEl.max   = totalPgs
        pageHint.textContent = `of ${totalPgs}`
        runBtn.disabled = false
      } catch (err) {
        console.error(err)
        toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    // Drop zone
    const dropZone = container.querySelector('#ins-drop')
    const input    = container.querySelector('#ins-input')
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) loadFile(f)
    })
    container.querySelector('#ins-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => {
      if (e.target.files[0]) { loadFile(e.target.files[0]); input.value = '' }
    })

    // Run
    runBtn.addEventListener('click', async () => {
      if (!pdfDoc) return

      const where   = whereEl.value
      const count   = Math.max(1, Math.min(20, parseInt(container.querySelector('#ins-count').value) || 1))
      const sizeKey = container.querySelector('#ins-size').value
      const orient  = container.querySelector('#ins-orient').value

      // Determine insert index (0-based, position BEFORE which to insert)
      let insertIdx
      if (where === 'end') {
        insertIdx = totalPgs
      } else {
        const pNum = Math.max(1, Math.min(totalPgs, parseInt(pageNumEl.value) || 1))
        insertIdx = where === 'before' ? pNum - 1 : pNum
      }

      // Determine page size
      let w, h
      if (sizeKey === 'match') {
        // Match adjacent page — prefer the page at insertIdx, fall back to insertIdx-1
        const adjIdx = Math.min(insertIdx, totalPgs - 1)
        const adjPage = pdfDoc.getPage(adjIdx)
        const sz = adjPage.getSize()
        // account for that page's own rotation
        const rot = adjPage.getRotation().angle % 360
        const rotated = rot === 90 || rot === 270
        ;[w, h] = rotated ? [sz.height, sz.width] : [sz.width, sz.height]
      } else {
        ;[w, h] = PAGE_SIZES[sizeKey]
      }

      if (orient === 'landscape' && h > w) [w, h] = [h, w]
      if (orient === 'portrait'  && w > h) [w, h] = [h, w]

      showProgress('Inserting blank pages…')
      try {
        // Insert blank pages at insertIdx (pdf-lib insertPage is 0-based)
        for (let i = 0; i < count; i++) {
          pdfDoc.insertPage(insertIdx + i, [w, h])
        }
        totalPgs = pdfDoc.getPageCount()
        pageNumEl.max = totalPgs
        pageHint.textContent = `of ${totalPgs}`
        infoEl.textContent = `${totalPgs} page${totalPgs > 1 ? 's' : ''}`

        const outBytes = await pdf.save(pdfDoc)
        const outName  = srcFile.name.replace(/\.pdf$/i, '_inserted.pdf')
        await saveAs(outBytes, outName)

        const pos = where === 'end' ? 'at the end' : `at position ${insertIdx + 1}`
        toast(
          `Inserted ${count} blank page${count > 1 ? 's' : ''} ${pos} → ${outName}`,
          'success'
        )
      } catch (err) {
        console.error(err)
        toast('Failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })
  },
})
