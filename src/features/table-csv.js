/**
 * Table → CSV feature — extract tabular data from PDF pages using
 * bounding-box heuristics on PDF.js text content items.
 *
 * Algorithm:
 *   1. Filter and sort text items by descending Y (PDF origin is bottom-left).
 *   2. Group items into rows where adjacent items' Y positions are within
 *      yTolerance of the row's first item.
 *   3. Sort each row by X to get reading order.
 *   4. Build a global column-boundary list by clustering all distinct X
 *      positions across all rows using colGap as the minimum cluster width.
 *   5. Assign each item to the nearest column boundary → produce CSV cells.
 */

import { registerFeature }  from '../core/registry.js'
import { readFile, saveAs } from '../core/fs.js'
import * as renderer        from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, parsePageRange } from '../core/utils.js'
import { get }                      from '../core/state.js'

// ── CSV helpers ───────────────────────────────────────────────────────────────

/**
 * Group text items into rows by Y proximity, assign to column buckets,
 * and return a 2-D array of cell strings.
 *
 * @param {Array<{str:string, transform:number[], width:number, height:number}>} items
 * @param {number} yTol   Vertical tolerance in pt — items within this distance share a row
 * @param {number} colGap Minimum horizontal gap in pt that separates two columns
 * @returns {string[][]}
 */
function extractCSV(items, yTol, colGap) {
  if (!items.length) return []

  // Filter blank-string items and sort by descending Y (top of page first)
  items = [...items].filter(i => i.str.trim()).sort((a, b) => b.transform[5] - a.transform[5])
  if (!items.length) return []

  // ── Group into rows by Y proximity ────────────────────────────────────────
  const rows = []
  let currentRow = [items[0]]
  for (let i = 1; i < items.length; i++) {
    const yDiff = Math.abs(items[i].transform[5] - currentRow[0].transform[5])
    if (yDiff <= yTol) {
      currentRow.push(items[i])
    } else {
      rows.push(currentRow)
      currentRow = [items[i]]
    }
  }
  rows.push(currentRow)

  // ── Sort each row by X position ───────────────────────────────────────────
  rows.forEach(r => r.sort((a, b) => a.transform[4] - b.transform[4]))

  // ── Build unified column boundary list ────────────────────────────────────
  // Collect every X origin across all rows, sort, then cluster with colGap.
  const allX = rows.flatMap(r => r.map(i => i.transform[4])).sort((a, b) => a - b)
  const colBoundaries = [allX[0]]
  for (let i = 1; i < allX.length; i++) {
    if (allX[i] - colBoundaries[colBoundaries.length - 1] > colGap) {
      colBoundaries.push(allX[i])
    }
  }

  // ── Assign items to columns ───────────────────────────────────────────────
  const numCols = colBoundaries.length
  const csvRows = rows.map(row => {
    const cells = new Array(numCols).fill('')
    row.forEach(item => {
      const x = item.transform[4]
      // Find the column boundary closest to this item's X origin
      let col = 0
      let minDist = Math.abs(x - colBoundaries[0])
      for (let c = 1; c < colBoundaries.length; c++) {
        const d = Math.abs(x - colBoundaries[c])
        if (d < minDist) { minDist = d; col = c }
      }
      // Append to cell (multiple items may share the same column on one row)
      cells[col] = cells[col] ? cells[col] + ' ' + item.str : item.str
    })
    return cells
  })

  return csvRows
}

/**
 * Serialise a 2-D array of strings to a CSV string.
 * Fields are quoted if they contain commas, double-quotes, or newlines.
 *
 * @param {string[][]} rows
 * @returns {string}
 */
function toCSV(rows) {
  return rows.map(row =>
    row.map(cell => {
      const s = cell.trim()
      if (s.includes(',') || s.includes('"') || s.includes('\n'))
        return '"' + s.replace(/"/g, '""') + '"'
      return s
    }).join(',')
  ).join('\n')
}

// ── Feature ───────────────────────────────────────────────────────────────────

registerFeature({
  id:          'table-csv',
  name:        'Table → CSV',
  category:    'Extract',
  icon:        '📊',
  description: 'Extract tabular data from PDF pages into a CSV file',

  render(container) {
    const gf = get().currentFile
    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Table → CSV</h2>
          <p class="feature-desc">Extract tabular data from a PDF into a CSV file.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">📊</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>
      `
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Table → CSV</h2>
        <p class="feature-desc">
          Extract tabular data from <strong style="color:var(--text);">${gf.name}</strong> using positional heuristics on the text layer.
          Works best for simple, grid-style tables. Scanned PDFs with no text layer will
          produce no output.
        </p>
      </div>

      <div class="feature-split">

        <!-- ── Source + Options ─────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Source + Options</span></div>

          <div class="section-label" style="margin-top:14px;">Pages</div>
          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
              <input type="radio" name="tc-pages" value="all" checked style="accent-color:var(--blue);">
              All pages
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
              <input type="radio" name="tc-pages" value="custom" style="accent-color:var(--blue);">
              Custom range
            </label>
          </div>
          <div id="tc-range-row" class="option-row" style="display:none;margin-bottom:12px;">
            <label>Range</label>
            <input type="text" id="tc-range" class="input" placeholder="e.g. 1-3, 5, 8" style="max-width:200px;">
          </div>

          <div class="section-label">Detection</div>
          <div class="option-row">
            <label style="display:flex;flex-direction:column;gap:2px;">
              Row tolerance
              <span style="font-size:11px;color:var(--text-muted);font-weight:400;">(pt) — increase for loose layouts</span>
            </label>
            <input type="number" id="tc-ytol" class="input" value="4" min="0" max="40" step="1"
              style="max-width:80px;text-align:right;">
          </div>
          <div class="option-row" style="margin-top:8px;">
            <label>Column gap <span style="font-size:11px;color:var(--text-muted);font-weight:400;">(pt)</span></label>
            <input type="number" id="tc-colgap" class="input" value="12" min="1" max="200" step="1"
              style="max-width:80px;text-align:right;">
          </div>

          <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border);">
            <p style="font-size:12px;color:var(--text-subtle);line-height:1.7;">
              ℹ Heuristic extraction works best for straightforward grid tables.
              Merged cells, rotated text, and columns that shift between pages may
              produce imperfect results. Adjust the row tolerance and column gap
              to improve alignment for your specific document.
            </p>
          </div>
        </div>

        <!-- ── Preview + Export ─────────────────────────────────────────── -->
        <div class="panel" style="display:flex;flex-direction:column;">
          <div class="panel-header">
            <span class="panel-title">② Preview &amp; Export</span>
            <span id="tc-stats" class="status-text"></span>
          </div>

          <textarea id="tc-preview"
            readonly
            placeholder="CSV preview will appear here after clicking Extract &amp; Save CSV…"
            style="flex:1;min-height:300px;resize:vertical;font-family:var(--font-mono);
                   font-size:12px;line-height:1.6;border:1px solid var(--border);
                   border-radius:var(--radius-sm);padding:10px;background:var(--bg);
                   color:var(--text);width:100%;box-sizing:border-box;"></textarea>

          <div class="action-bar" style="margin-top:12px;">
            <button class="btn btn-primary btn-lg" id="tc-run">
              Extract &amp; Save CSV…
            </button>
            <button class="btn btn-sm" id="tc-copy" disabled>
              📋 Copy to Clipboard
            </button>
          </div>
          <div class="status-text" id="tc-status" style="margin-top:8px;">
            Ready — click Extract &amp; Save CSV… to begin.
          </div>
        </div>

      </div>
    `

    // ── State ─────────────────────────────────────────────────────────────────
    let fullCSV  = ''   // The complete CSV string, used for clipboard/save

    const runBtn    = container.querySelector('#tc-run')
    const copyBtn   = container.querySelector('#tc-copy')
    const statusEl  = container.querySelector('#tc-status')
    const statsEl   = container.querySelector('#tc-stats')
    const previewEl = container.querySelector('#tc-preview')

    // ── Page-range radio toggle ───────────────────────────────────────────────
    container.querySelectorAll('input[name="tc-pages"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const custom = container.querySelector('input[name="tc-pages"]:checked').value === 'custom'
        container.querySelector('#tc-range-row').style.display = custom ? 'flex' : 'none'
      })
    })

    // ── Extract & Save ────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      const { file: srcFile, pwd: srcPwd } = get().currentFile

      const yTol   = Math.max(0,  parseFloat(container.querySelector('#tc-ytol').value)   || 4)
      const colGap = Math.max(1,  parseFloat(container.querySelector('#tc-colgap').value)  || 12)
      const useCustomRange = container.querySelector('input[name="tc-pages"]:checked').value === 'custom'
      const rangeStr = container.querySelector('#tc-range').value.trim()

      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(srcFile)
        let rDoc
        try {
          rDoc = await renderer.loadForRender(bytes)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          showProgress('Decrypting…')
          rDoc = await renderer.loadForRender(bytes, pwd)
        }

        const totalPages = rDoc.numPages

        // Resolve page indices (1-based → 0-based)
        let pageIndices
        if (useCustomRange && rangeStr) {
          pageIndices = parsePageRange(rangeStr, totalPages)
          if (!pageIndices.length) {
            hideProgress()
            toast('Invalid page range — check your input.', 'warning')
            rDoc.destroy()
            return
          }
        } else {
          pageIndices = Array.from({ length: totalPages }, (_, i) => i)
        }

        // ── Extract text from each page ───────────────────────────────────────
        const allRows     = []   // accumulated 2-D array across all pages
        let totalColCount = 0

        for (let pi = 0; pi < pageIndices.length; pi++) {
          const pageNum = pageIndices[pi] + 1   // 1-based for display / PDF.js
          updateProgress(`Extracting page ${pageNum} of ${totalPages}…`)

          const page    = await rDoc.getPage(pageNum)
          const content = await page.getTextContent()
          page.cleanup()

          const pageRows = extractCSV(content.items, yTol, colGap)

          if (pageRows.length) {
            // Blank-row separator between pages when accumulating multiple pages
            if (allRows.length > 0) allRows.push([])

            allRows.push(...pageRows)

            // Track maximum column count across all pages
            const pageCols = pageRows[0]?.length ?? 0
            if (pageCols > totalColCount) totalColCount = pageCols
          }
        }

        rDoc.destroy()

        if (!allRows.length) {
          hideProgress()
          statusEl.textContent = 'No text found. The PDF may be scanned (image-only).'
          toast('No text extracted — scanned or image-only PDF?', 'warning')
          return
        }

        // Normalise all rows to the same column count (pad with empty strings)
        const normalised = allRows.map(row => {
          if (row.length === totalColCount) return row
          const padded = [...row]
          while (padded.length < totalColCount) padded.push('')
          return padded
        })

        fullCSV = toCSV(normalised)

        // ── Build preview (first 50 rows / 3000 chars) ────────────────────────
        const PREVIEW_ROWS  = 50
        const PREVIEW_CHARS = 3000
        const previewRows   = normalised.slice(0, PREVIEW_ROWS)
        let previewText     = toCSV(previewRows)

        if (previewText.length > PREVIEW_CHARS) {
          previewText = previewText.slice(0, PREVIEW_CHARS) + '\n…'
        }

        const remaining = normalised.length - previewRows.length
        if (remaining > 0) {
          previewText += `\n\n… and ${remaining} more row${remaining !== 1 ? 's' : ''}`
        }

        previewEl.value      = previewText
        copyBtn.disabled     = false
        statsEl.textContent  = `${normalised.filter(r => r.length > 0).length} rows × ${totalColCount} col${totalColCount !== 1 ? 's' : ''} across ${pageIndices.length} page${pageIndices.length !== 1 ? 's' : ''}`
        statusEl.textContent = 'Extracted — choose a save location below.'

        // ── Save dialog ───────────────────────────────────────────────────────
        updateProgress('Opening save dialog…')
        const suggestedName = stripExt(srcFile.name) + '.csv'
        let fileHandle
        try {
          fileHandle = await window.showSaveFilePicker({
            suggestedName,
            types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }],
          })
        } catch (err) {
          // User cancelled — extraction still succeeded, preview is shown
          hideProgress()
          statusEl.textContent = 'Extraction complete — use Copy to Clipboard or click the button again to save.'
          toast('Save cancelled — CSV is ready in the preview.', 'info')
          return
        }

        updateProgress('Saving…')
        // Write UTF-8 BOM + CSV for maximum Excel compatibility
        const enc      = new TextEncoder()
        const bom      = new Uint8Array([0xEF, 0xBB, 0xBF])
        const csvBytes = enc.encode(fullCSV)
        const out      = new Uint8Array(bom.length + csvBytes.length)
        out.set(bom)
        out.set(csvBytes, bom.length)

        const writable = await fileHandle.createWritable()
        await writable.write(out)
        await writable.close()

        statusEl.textContent = `Saved → ${fileHandle.name}`
        toast(`Saved → ${fileHandle.name}`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Extraction failed: ' + err.message, 'error')
          statusEl.textContent = 'Error: ' + err.message
        }
      } finally {
        hideProgress()
      }
    })

    // ── Copy to clipboard ─────────────────────────────────────────────────────
    copyBtn.addEventListener('click', async () => {
      if (!fullCSV) return
      try {
        await navigator.clipboard.writeText(fullCSV)
        toast('CSV copied to clipboard.', 'success')
      } catch {
        toast('Clipboard unavailable — select all text in the preview and copy manually.', 'warning')
      }
    })

  },
})
