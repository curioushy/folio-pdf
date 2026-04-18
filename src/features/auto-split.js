/**
 * Auto-split on Blank — detect blank pages in a PDF and split the document
 * into separate files at those blank pages.
 *
 * Common use case: scanning a batch of physical documents produces one large
 * PDF with blank separator pages between individual documents.
 *
 * Detection uses two signals (configurable):
 *   1. Text threshold — pages with fewer visible characters than the threshold
 *      are candidates for "blank".
 *   2. Pixel brightness — candidate pages are rendered at a reduced scale;
 *      if the average pixel brightness exceeds 245/255 the page is confirmed
 *      blank (catches pages that have whitespace text objects but no ink).
 *
 * Splitting uses pdf-lib to copy page ranges into new PDFDocuments, which
 * are then saved directly to a user-chosen output directory.
 */

import { registerFeature }  from '../core/registry.js'
import { readFile }         from '../core/fs.js'
import * as renderer        from '../core/renderer.js'
import * as pdf             from '../core/pdf.js'
import { PDFDocument }      from '@cantoo/pdf-lib'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt }         from '../core/utils.js'

// ── Detection helpers ─────────────────────────────────────────────────────────

/**
 * Scan a PDF.js document for blank pages.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} rDoc
 * @param {number}  textThreshold   Pages with fewer chars than this are candidates
 * @param {boolean} checkPixels     If true, also render and check average brightness
 * @param {function(number,number):void} onProgress  Called with (currentPage, totalPages)
 * @returns {Promise<number[]>}  1-based page numbers of detected blank pages
 */
async function scanForBlankPages(rDoc, textThreshold, checkPixels, onProgress) {
  const blank = []

  for (let i = 1; i <= rDoc.numPages; i++) {
    onProgress(i, rDoc.numPages)
    const page = await rDoc.getPage(i)

    // ── Text signal ───────────────────────────────────────────────────────────
    const content   = await page.getTextContent()
    const charCount = content.items.reduce((n, item) => n + item.str.trim().length, 0)

    if (charCount < textThreshold) {
      if (checkPixels) {
        // ── Pixel brightness signal ───────────────────────────────────────────
        // Render at 30 % of native size — fast, still sufficient for brightness check
        const viewport = page.getViewport({ scale: 0.3 })
        const canvas   = document.createElement('canvas')
        canvas.width   = Math.ceil(viewport.width)
        canvas.height  = Math.ceil(viewport.height)
        const ctx      = canvas.getContext('2d')

        await page.render({ canvasContext: ctx, viewport }).promise

        const imageData      = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let   totalBrightness = 0
        for (let j = 0; j < imageData.length; j += 4) {
          totalBrightness += (imageData[j] + imageData[j + 1] + imageData[j + 2]) / 3
        }
        const avgBrightness = totalBrightness / (imageData.length / 4)

        if (avgBrightness > 245) blank.push(i)
      } else {
        // Text-only check: low character count is sufficient
        blank.push(i)
      }
    }

    page.cleanup()
  }

  return blank
}

/**
 * Given a total page count and a sorted list of 1-based blank-page numbers,
 * compute the non-blank segments as arrays of 0-based page indices.
 *
 * Example:
 *   totalPages=10, blanks=[4,8]
 *   → segments: [[0,1,2], [4,5,6], [8,9]]  (0-based)
 *
 * @param {number}   totalPages
 * @param {number[]} blankPages  Sorted 1-based page numbers
 * @param {boolean}  keepBlanks  If true, include the blank page at the start/end of each segment
 * @returns {number[][]}  Array of 0-based page-index arrays (empty segments are omitted)
 */
function computeSegments(totalPages, blankPages, keepBlanks) {
  const blankSet = new Set(blankPages)

  // Build ordered list of "split points" — add virtual sentinels
  const splits = [0, ...blankPages, totalPages + 1]

  const segments = []

  for (let s = 0; s < splits.length - 1; s++) {
    const start = splits[s]       // 1-based (0 for sentinel) — exclusive for content
    const end   = splits[s + 1]  // 1-based — exclusive for content

    // Content pages are those strictly between the two split points
    // (start is a blank page or sentinel; end is the next blank page or sentinel)
    const pages = []

    // Determine the first and last content page (1-based) in this segment
    const contentStart = start + 1   // page after the blank / start sentinel
    const contentEnd   = end   - 1   // page before the next blank / end sentinel

    if (contentStart > contentEnd) continue   // Consecutive blanks or trailing blank → skip

    if (keepBlanks) {
      // Prepend the blank page that opened this segment (not for the first segment
      // which follows the sentinel, not a real blank page)
      if (s > 0 && blankSet.has(start)) pages.push(start - 1)   // 0-based
    }

    for (let p = contentStart; p <= contentEnd; p++) {
      pages.push(p - 1)   // convert to 0-based
    }

    if (keepBlanks) {
      // Append the blank page that closes this segment (not for the last segment)
      if (s < splits.length - 2 && blankSet.has(end)) pages.push(end - 1)   // 0-based
    }

    if (pages.length > 0) segments.push(pages)
  }

  return segments
}

// ── Feature ───────────────────────────────────────────────────────────────────

registerFeature({
  id:          'auto-split',
  name:        'Auto-split on Blank',
  category:    'Pages',
  icon:        '✂️',
  description: 'Detect blank separator pages and split the PDF into segments',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Auto-split on Blank</h2>
        <p class="feature-desc">
          Scan a PDF for blank pages and split it into separate files at each one.
          Ideal for batches of scanned documents separated by blank sheets.
        </p>
      </div>

      <!-- Single panel layout -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">

        <!-- ── Left: source + detection options ─────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Source PDF</span></div>

          <div class="file-drop-zone" id="as-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="as-browse">Browse</button>
            <input type="file" id="as-input" accept=".pdf" hidden>
          </div>
          <div id="as-filename" class="file-name-display"></div>
          <div id="as-page-count" class="status-text" style="margin-bottom:10px;"></div>

          <div class="section-label" style="margin-top:14px;">Detection options</div>

          <div class="option-row">
            <label style="display:flex;flex-direction:column;gap:2px;">
              Text threshold
              <span style="font-size:11px;color:var(--text-muted);font-weight:400;">characters per page</span>
            </label>
            <input type="number" id="as-text-thr" class="input" value="20" min="0" max="500" step="1"
              style="max-width:80px;text-align:right;">
          </div>

          <div class="option-row" style="margin-top:8px;">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="as-check-pixels" checked style="accent-color:var(--blue);">
              Also detect near-white pages
            </label>
          </div>
          <p style="font-size:11.5px;color:var(--text-muted);margin:2px 0 12px 0;line-height:1.5;">
            Renders each low-text page at reduced size and checks average brightness.
            Catches pages with invisible or whitespace-only text objects.
          </p>

          <div style="margin-top:12px;">
            <button class="btn btn-primary" id="as-scan" disabled style="width:100%;justify-content:center;">
              Scan for blank pages
            </button>
            <div class="status-text" id="as-scan-status" style="text-align:center;margin-top:8px;">
              Load a PDF to get started.
            </div>
          </div>
        </div>

        <!-- ── Right: results + split options ───────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">② Results &amp; Split</span></div>

          <!-- Blank page results -->
          <div id="as-results" style="display:none;">
            <div class="section-label">Detected blank pages</div>
            <div id="as-blank-list"
              style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;max-height:160px;overflow-y:auto;"></div>
            <div id="as-blank-summary" class="status-text" style="margin-bottom:12px;"></div>

            <div class="section-label">Split options</div>
            <div class="option-row" style="margin-bottom:16px;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="as-keep-blanks" style="accent-color:var(--blue);">
                Include blank pages in output segments
              </label>
            </div>
            <p style="font-size:11.5px;color:var(--text-muted);margin:0 0 16px 0;line-height:1.5;">
              When checked, the blank page is kept at the boundary of each output segment.
              When unchecked (default), blank pages are discarded entirely.
            </p>

            <button class="btn btn-primary btn-lg" id="as-split" disabled
              style="width:100%;justify-content:center;">
              Split into <span id="as-segment-count">0</span> files…
            </button>
            <div class="status-text" id="as-split-status" style="text-align:center;margin-top:8px;"></div>
          </div>

          <!-- Pre-scan placeholder -->
          <div id="as-prescan-hint" style="color:var(--text-muted);font-size:13px;line-height:1.7;">
            Load a PDF and click <strong>Scan for blank pages</strong> to analyse the document.
            The scan results and split controls will appear here.
          </div>

          <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border);">
            <p style="font-size:12px;color:var(--text-subtle);line-height:1.7;">
              ℹ Blank page detection uses two heuristics: a character-count check on
              the text layer, and an optional pixel-brightness check (requires rendering).
              The brightness check adds time but catches pages that contain invisible
              or whitespace-only text objects.
              <br><br>
              Output files are named <code>{name}_part01.pdf</code>, <code>_part02.pdf</code> …
              and saved to a folder you choose.
            </p>
          </div>
        </div>

      </div>
    `

    // ── State ─────────────────────────────────────────────────────────────────
    let srcFile       = null
    let srcBytes      = null
    let rDoc          = null     // PDF.js doc (kept alive for potential re-scan)
    let detectedBlanks = []     // 1-based page numbers confirmed blank
    let checkedBlanks  = []     // subset of detectedBlanks that have their checkbox ticked

    const scanBtn       = container.querySelector('#as-scan')
    const splitBtn      = container.querySelector('#as-split')
    const pageCountEl   = container.querySelector('#as-page-count')
    const scanStatusEl  = container.querySelector('#as-scan-status')
    const splitStatusEl = container.querySelector('#as-split-status')
    const nameEl        = container.querySelector('#as-filename')
    const resultsEl     = container.querySelector('#as-results')
    const prescanHint   = container.querySelector('#as-prescan-hint')
    const blankListEl   = container.querySelector('#as-blank-list')
    const blankSummaryEl= container.querySelector('#as-blank-summary')
    const segCountEl    = container.querySelector('#as-segment-count')

    // ── File loading ──────────────────────────────────────────────────────────
    function setFile(file) {
      srcFile = file
      nameEl.textContent     = file.name
      pageCountEl.textContent = ''
      scanBtn.disabled       = false
      scanStatusEl.textContent = 'Ready — click Scan to begin.'

      // Reset results area
      resultsEl.style.display  = 'none'
      prescanHint.style.display = 'block'
      detectedBlanks = []
      checkedBlanks  = []

      // Destroy previous render doc
      rDoc?.destroy()
      rDoc      = null
      srcBytes  = null
    }

    setupDropZone('as-drop', 'as-input', setFile)

    // ── Scan ──────────────────────────────────────────────────────────────────
    scanBtn.addEventListener('click', async () => {
      if (!srcFile) return

      const textThreshold = Math.max(0, parseInt(container.querySelector('#as-text-thr').value) || 20)
      const checkPixels   = container.querySelector('#as-check-pixels').checked

      showProgress('Loading PDF…')
      try {
        // Load bytes once; reuse for pdf-lib split later
        srcBytes = await readFile(srcFile)

        // Destroy any previous render doc before re-loading
        rDoc?.destroy()
        rDoc = null

        try {
          rDoc = await renderer.loadForRender(srcBytes)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          showProgress('Decrypting…')
          rDoc = await renderer.loadForRender(srcBytes, pwd)
        }

        const totalPages = rDoc.numPages
        pageCountEl.textContent = `${totalPages} page${totalPages !== 1 ? 's' : ''}`

        updateProgress('Scanning page 1…')
        detectedBlanks = await scanForBlankPages(
          rDoc,
          textThreshold,
          checkPixels,
          (current, total) => updateProgress(`Scanning page ${current} of ${total}…`)
        )

        // ── Render results ────────────────────────────────────────────────────
        prescanHint.style.display = 'none'
        resultsEl.style.display   = 'block'

        if (detectedBlanks.length === 0) {
          blankListEl.innerHTML   = ''
          blankSummaryEl.textContent = 'No blank pages detected.'
          splitBtn.disabled          = true
          segCountEl.textContent     = '0'
          scanStatusEl.textContent   = 'Scan complete — no blank pages found.'
          toast('No blank pages detected.', 'info')
          hideProgress()
          return
        }

        // Build a checkbox chip for each detected blank page
        checkedBlanks = [...detectedBlanks]   // all ticked by default
        renderBlankChips(totalPages)

        scanStatusEl.textContent = `Scan complete — ${detectedBlanks.length} blank page${detectedBlanks.length !== 1 ? 's' : ''} found.`
        toast(`Found ${detectedBlanks.length} blank page${detectedBlanks.length !== 1 ? 's' : ''}.`, 'success')
        updateSplitButton(totalPages)
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Scan failed: ' + err.message, 'error')
          scanStatusEl.textContent = 'Error: ' + err.message
        }
      } finally {
        hideProgress()
      }
    })

    // ── Render blank-page chips with checkboxes ───────────────────────────────
    function renderBlankChips(totalPages) {
      blankListEl.innerHTML = detectedBlanks.map(p => `
        <label style="display:inline-flex;align-items:center;gap:5px;
          padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);
          font-size:12px;cursor:pointer;background:var(--bg);user-select:none;">
          <input type="checkbox" data-page="${p}" checked style="accent-color:var(--blue);">
          Page ${p}
        </label>
      `).join('')

      blankListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          checkedBlanks = detectedBlanks.filter(p => {
            const el = blankListEl.querySelector(`input[data-page="${p}"]`)
            return el ? el.checked : false
          })
          updateSplitButton(totalPages)
        })
      })
    }

    // ── Update segment count and split button state ───────────────────────────
    function updateSplitButton(totalPages) {
      const sorted   = [...checkedBlanks].sort((a, b) => a - b)
      const segments = computeSegments(totalPages, sorted, false)   // preview without keepBlanks

      const count = segments.length
      segCountEl.textContent = String(count)
      splitBtn.disabled      = count === 0

      if (checkedBlanks.length > 0) {
        blankSummaryEl.textContent =
          `${checkedBlanks.length} blank page${checkedBlanks.length !== 1 ? 's' : ''} selected — ` +
          `will produce ${count} segment${count !== 1 ? 's' : ''}.`
      } else {
        blankSummaryEl.textContent = 'No blank pages selected — nothing to split on.'
      }
    }

    // ── Split ─────────────────────────────────────────────────────────────────
    splitBtn.addEventListener('click', async () => {
      if (!srcBytes || !rDoc) return

      const keepBlanks   = container.querySelector('#as-keep-blanks').checked
      const totalPages   = rDoc.numPages
      const sorted       = [...checkedBlanks].sort((a, b) => a - b)
      const segments     = computeSegments(totalPages, sorted, keepBlanks)

      if (segments.length === 0) {
        toast('No segments to save — check your blank page selection.', 'warning')
        return
      }

      // Pick output directory
      let outDir
      try {
        outDir = await window.showDirectoryPicker({ mode: 'readwrite' })
      } catch (err) {
        if (err.name !== 'AbortError') toast('Could not open folder.', 'error')
        return
      }

      const baseName = stripExt(srcFile.name)
      const padLen   = String(segments.length).length

      showProgress('Loading PDF for splitting…')
      try {
        // Load with pdf-lib for page copying
        let pdfDoc
        try {
          pdfDoc = await pdf.load(srcBytes)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          showProgress('Decrypting for split…')
          pdfDoc = await pdf.load(srcBytes, pwd)
        }

        for (let s = 0; s < segments.length; s++) {
          const pageIndices = segments[s]   // 0-based
          const partNum     = String(s + 1).padStart(padLen, '0')
          const filename    = `${baseName}_part${partNum}.pdf`

          updateProgress(`Saving segment ${s + 1} of ${segments.length} (${pageIndices.length} page${pageIndices.length !== 1 ? 's' : ''})…`)

          const outDoc   = await PDFDocument.create()
          const copied   = await outDoc.copyPages(pdfDoc, pageIndices)
          copied.forEach(p => outDoc.addPage(p))

          const outBytes = await outDoc.save()

          // Write to chosen directory
          const fileHandle = await outDir.getFileHandle(filename, { create: true })
          const writable   = await fileHandle.createWritable()
          await writable.write(outBytes)
          await writable.close()
        }

        splitStatusEl.textContent = `Saved ${segments.length} file${segments.length !== 1 ? 's' : ''} → ${outDir.name}/`
        toast(`Split complete — ${segments.length} files saved to ${outDir.name}/`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Split failed: ' + err.message, 'error')
          splitStatusEl.textContent = 'Error: ' + err.message
        }
      } finally {
        hideProgress()
      }
    })

    // ── Drop zone helper ──────────────────────────────────────────────────────
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
