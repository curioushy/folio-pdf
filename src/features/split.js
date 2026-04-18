/**
 * Split / Extract feature — with live page thumbnail grid.
 *
 * Five modes:
 *  1. Extract pages    — click thumbnails or type a range → one output PDF
 *  2. Every page       — each page → its own PDF
 *  3. By ranges        — define named sections → one PDF per section
 *  4. By bookmarks     — read the PDF outline, split at chapter boundaries
 *  5. By blank pages   — scan for blank pages, split at each gap
 */

import { registerFeature }  from '../core/registry.js'
import { get }              from '../core/state.js'
import { readHandle, readFile, saveAs, writeToWorkspace } from '../core/fs.js'
import * as pdf             from '../core/pdf.js'
import { loadForRender, buildThumbnailGrid, selectionToRangeStr } from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword, pickFromWorkspace } from '../core/ui.js'
import { parsePageRange, stripExt, ensurePdf, safeName } from '../core/utils.js'

registerFeature({
  id:          'split',
  name:        'Split / Extract',
  category:    'Pages',
  icon:        '✂',
  description: 'Extract pages or split a PDF into multiple files — by range, bookmarks or blank pages',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Split / Extract</h2>
        <p class="feature-desc">
          Click pages to select them, or choose a split strategy from the tabs below.
        </p>
      </div>

      <div class="feature-split" style="align-items:stretch;">

        <!-- ── SOURCE PANEL ───────────────────────────────────────── -->
        <div class="panel" style="display:flex;flex-direction:column;min-height:500px;">

          <!-- Before load -->
          <div id="split-before-load">
            <div class="panel-header">
              <span class="panel-title">① Source PDF</span>
            </div>
            <div class="file-drop-zone" id="split-drop">
              <span>Drag a PDF here, or</span>
              <button class="btn btn-sm" id="split-from-workspace">From folder</button>
              <button class="btn btn-sm" id="split-browse">Browse</button>
              <input type="file" id="split-file-input" accept=".pdf" hidden>
            </div>
          </div>

          <!-- After load: thumbnail view -->
          <div id="split-thumb-section" style="display:none;flex:1;flex-direction:column;">
            <div class="panel-header" style="flex-shrink:0;">
              <div style="display:flex;flex-direction:column;gap:2px;overflow:hidden;">
                <span class="panel-title">① Source PDF</span>
                <span id="split-file-label" style="font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
              </div>
              <button class="btn btn-sm" id="split-change-file" style="flex-shrink:0;">Change</button>
            </div>

            <!-- Selection bar (shown in extract mode) -->
            <div id="split-selection-bar" class="split-selection-bar" style="display:none;flex-shrink:0;">
              <span id="split-sel-count">0 pages selected</span>
              <div style="display:flex;gap:4px;">
                <button class="btn btn-sm" id="split-sel-all">All</button>
                <button class="btn btn-sm" id="split-sel-none">None</button>
              </div>
            </div>

            <!-- Thumbnail grid -->
            <div id="split-thumb-grid" class="split-thumb-grid"></div>
          </div>

        </div>

        <!-- ── OUTPUT PANEL ───────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">② Output</span>
            <span id="split-page-count" class="status-text"></span>
          </div>

          <!-- Mode tabs -->
          <div class="tab-group" style="flex-wrap:wrap;">
            <button class="tab active" data-tab="extract">Extract</button>
            <button class="tab"        data-tab="each">Every page</button>
            <button class="tab"        data-tab="ranges">By ranges</button>
            <button class="tab"        data-tab="bookmarks">Bookmarks</button>
            <button class="tab"        data-tab="blank">Blank pages</button>
          </div>

          <!-- ── Extract ── -->
          <div id="tab-extract" class="tab-content">
            <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
              Click to toggle · Shift-click for a range · Ctrl/⌘-click to toggle individually · or type a range below.
            </p>
            <div class="option-row">
              <label>Pages <small>(1-based)</small></label>
              <input type="text" id="extract-range" class="input" placeholder="e.g. 1-3, 5, 8-10 — blank = all" style="max-width:220px;">
            </div>
            <div class="option-row">
              <label>Output filename</label>
              <input type="text" id="extract-filename" class="input" placeholder="extracted.pdf" style="max-width:220px;">
            </div>
            ${dirPickerHTML('extract')}
            <div style="margin-top:20px;">
              <button class="btn btn-primary btn-lg" id="extract-run" disabled style="width:100%;justify-content:center;">Extract pages</button>
              <div class="status-text" id="extract-status" style="text-align:center;margin-top:8px;">Load a PDF first.</div>
            </div>
          </div>

          <!-- ── Every page ── -->
          <div id="tab-each" class="tab-content hidden">
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px;">
              Each page saved as <code>{name}_p01.pdf</code>, <code>{name}_p02.pdf</code> …
              <br>A target folder is required.
            </p>
            ${dirPickerHTML('each', true)}
            <div style="margin-top:20px;">
              <button class="btn btn-primary btn-lg" id="each-run" disabled style="width:100%;justify-content:center;">Split every page</button>
              <div class="status-text" id="each-status" style="text-align:center;margin-top:8px;">Load a PDF first.</div>
            </div>
          </div>

          <!-- ── By ranges ── -->
          <div id="tab-ranges" class="tab-content hidden">
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">
              Each row → one output PDF. Name the section, set a page range.
            </p>
            <div id="ranges-list" class="file-list" style="margin-bottom:8px;"></div>
            <button class="btn btn-sm" id="ranges-add-row">+ Add section</button>
            <div style="margin-top:12px;">${dirPickerHTML('ranges', true)}</div>
            <div style="margin-top:20px;">
              <button class="btn btn-primary btn-lg" id="ranges-run" disabled style="width:100%;justify-content:center;">Split by ranges</button>
              <div class="status-text" id="ranges-status" style="text-align:center;margin-top:8px;">Load a PDF first.</div>
            </div>
          </div>

          <!-- ── By bookmarks ── -->
          <div id="tab-bookmarks" class="tab-content hidden">
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">
              Splits at top-level bookmark boundaries. Each section → one PDF named after its bookmark title.
            </p>
            <div id="bkm-loading" class="status-text" style="display:none;margin-bottom:8px;">Loading bookmarks…</div>
            <div id="bkm-empty"   class="status-text" style="display:none;margin-bottom:8px;color:var(--amber);">
              This PDF has no bookmarks. Add some with the Bookmarks tool, or use By ranges instead.
            </div>
            <div style="display:flex;gap:6px;margin-bottom:8px;" id="bkm-sel-bar">
              <button class="btn btn-sm" id="bkm-sel-all">All</button>
              <button class="btn btn-sm" id="bkm-sel-none">None</button>
              <span id="bkm-sel-count" class="status-text" style="margin-left:4px;"></span>
            </div>
            <div id="bkm-list" class="file-list" style="max-height:280px;overflow-y:auto;margin-bottom:10px;"></div>
            ${dirPickerHTML('bkm', true)}
            <div style="margin-top:16px;">
              <button class="btn btn-primary btn-lg" id="bkm-run" disabled style="width:100%;justify-content:center;">Split by bookmarks</button>
              <div class="status-text" id="bkm-status" style="text-align:center;margin-top:8px;">Load a PDF first.</div>
            </div>
          </div>

          <!-- ── By blank pages ── -->
          <div id="tab-blank" class="tab-content hidden">
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">
              Detects blank separator pages and splits the document at each one.
              Common for scanned batches where a blank page separates documents.
            </p>

            <div class="section-label">Detection</div>
            <div class="option-row">
              <label>Text threshold</label>
              <input type="number" id="blank-threshold" class="input" value="20" min="0" max="500" style="max-width:70px;">
              <span class="status-text">chars — pages below this are candidates</span>
            </div>
            <div class="option-row">
              <label>Pixel check</label>
              <input type="checkbox" id="blank-pixel-check" checked>
              <span class="status-text">Also render to verify near-white pages</span>
            </div>
            <button class="btn btn-sm" id="blank-scan" disabled style="margin-bottom:14px;">🔍 Scan for blank pages</button>

            <div id="blank-results-wrap" style="display:none;">
              <div class="section-label">Detected blank pages</div>
              <div id="blank-results" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;"></div>
              <div class="option-row">
                <label>Keep blanks</label>
                <input type="checkbox" id="blank-keep">
                <span class="status-text">Include blank pages at segment boundaries</span>
              </div>
            </div>

            <div id="blank-none-msg" class="status-text" style="display:none;color:var(--green);margin-bottom:10px;">
              ✓ No blank pages found — nothing to split.
            </div>

            ${dirPickerHTML('blank', true)}
            <div style="margin-top:16px;">
              <button class="btn btn-primary btn-lg" id="blank-run" disabled style="width:100%;justify-content:center;">Split at blank pages</button>
              <div class="status-text" id="blank-status" style="text-align:center;margin-top:8px;">Load a PDF and scan first.</div>
            </div>
          </div>

        </div>
      </div>
    `

    // ── State ────────────────────────────────────────────────────────────────
    let sourceBytes   = null
    let sourceDoc     = null
    let renderDoc     = null
    let sourceName    = ''
    let srcPwd        = null
    let thumbObserver = null
    let setThumbSelected = null

    const selectedPages  = new Set()
    let lastClickedPage0 = null     // for shift-click range select

    // Bookmarks state
    let bkmItems       = []    // [{title, pageStart, pageEnd, checked}]
    let bkmDir         = null
    let bookmarksReady = false

    // Blank pages state
    let blankPages  = []   // 1-based page numbers detected as blank
    let blankDir    = null
    let blankScanned = false

    const pageCountEl = container.querySelector('#split-page-count')

    // ── Tab switching ────────────────────────────────────────────────────────
    let activeTab = 'extract'
    container.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        container.querySelectorAll('.tab-group .tab').forEach(t => t.classList.remove('active'))
        container.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'))
        tab.classList.add('active')
        activeTab = tab.dataset.tab
        container.querySelector(`#tab-${activeTab}`).classList.remove('hidden')
        container.querySelector('#split-selection-bar').style.display =
          activeTab === 'extract' ? 'flex' : 'none'

        // Lazy-load bookmarks when switching to that tab
        if (activeTab === 'bookmarks' && renderDoc && !bookmarksReady) {
          loadBookmarks()
        }
      })
    })

    // ── Load source file ─────────────────────────────────────────────────────
    async function loadSource(fileOrNull, handleOrNull = null, initialPwd = null) {
      showProgress('Loading PDF…')
      try {
        thumbObserver?.disconnect()
        renderDoc?.destroy()
        renderDoc     = null
        bookmarksReady = false
        blankScanned   = false
        blankPages     = []

        const bytes = handleOrNull
          ? await readHandle(handleOrNull)
          : await readFile(fileOrNull)

        const name = fileOrNull?.name ?? (await handleOrNull.getFile()).name

        let doc
        try {
          doc = await pdf.load(bytes)
        } catch (err) {
          if (err.code === 'ENCRYPTED') {
            hideProgress()
            toast('This PDF is password-protected. Use Protect → Unlock to decrypt it first.', 'warning', 6000)
            return
          }
          throw err
        }

        sourceBytes = bytes
        sourceDoc   = doc
        sourceName  = stripExt(name)

        const total = doc.getPageCount()
        pageCountEl.textContent = `${total} page${total !== 1 ? 's' : ''}`

        container.querySelector('#extract-filename').value = sourceName + '_extracted.pdf'
        container.querySelector('#split-file-label').textContent = name

        updateProgress('Rendering thumbnails…')
        renderDoc = await loadForRender(bytes)

        container.querySelector('#split-before-load').style.display = 'none'
        const thumbSection = container.querySelector('#split-thumb-section')
        thumbSection.style.display = 'flex'

        const grid = container.querySelector('#split-thumb-grid')
        selectedPages.clear()
        lastClickedPage0 = null

        const { observer, setSelected } = buildThumbnailGrid(
          renderDoc, total, grid,
          {
            thumbWidth: 130,
            onPageClick: (page0, el, e) => {
              if (activeTab !== 'extract') return

              if (e.shiftKey && lastClickedPage0 !== null) {
                // Range select — add everything between last click and here
                const lo = Math.min(page0, lastClickedPage0)
                const hi = Math.max(page0, lastClickedPage0)
                for (let p = lo; p <= hi; p++) selectedPages.add(p)
                // don't update lastClickedPage0 so chained shifts keep extending from anchor
              } else if (e.ctrlKey || e.metaKey) {
                // Toggle individual
                selectedPages.has(page0) ? selectedPages.delete(page0) : selectedPages.add(page0)
                lastClickedPage0 = page0
              } else {
                // Plain click: toggle this page
                selectedPages.has(page0) ? selectedPages.delete(page0) : selectedPages.add(page0)
                lastClickedPage0 = page0
              }

              setThumbSelected?.(selectedPages)
              syncSelectionUI()
            },
          }
        )
        thumbObserver    = observer
        setThumbSelected = setSelected

        container.querySelector('#split-selection-bar').style.display =
          activeTab === 'extract' ? 'flex' : 'none'

        // Reset bookmarks tab UI
        container.querySelector('#bkm-loading').style.display = 'none'
        container.querySelector('#bkm-empty').style.display   = 'none'
        container.querySelector('#bkm-list').innerHTML         = ''
        container.querySelector('#bkm-sel-bar').style.display  = 'none'
        // Reset blank tab UI
        container.querySelector('#blank-results-wrap').style.display = 'none'
        container.querySelector('#blank-none-msg').style.display     = 'none'
        container.querySelector('#blank-run').disabled = true

        updateRunButtons()

        // Auto-load bookmarks if that tab is already active
        if (activeTab === 'bookmarks') loadBookmarks()

        toast(`Loaded: ${total} pages`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed to load PDF: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    // ── Selection sync (extract tab) ─────────────────────────────────────────
    function syncSelectionUI() {
      const rangeStr = selectionToRangeStr(selectedPages)
      container.querySelector('#extract-range').value = rangeStr
      const count = selectedPages.size
      container.querySelector('#split-sel-count').textContent =
        count ? `${count} page${count !== 1 ? 's' : ''} selected` : 'Click pages to select'
    }

    container.querySelector('#extract-range').addEventListener('input', e => {
      if (!sourceDoc) return
      const indices = e.target.value.trim()
        ? parsePageRange(e.target.value, sourceDoc.getPageCount())
        : []
      selectedPages.clear()
      indices.forEach(i => selectedPages.add(i))
      setThumbSelected?.(selectedPages)
      const count = selectedPages.size
      container.querySelector('#split-sel-count').textContent =
        count ? `${count} page${count !== 1 ? 's' : ''} selected` : 'Click pages to select'
    })

    container.querySelector('#split-sel-all').addEventListener('click', () => {
      if (!sourceDoc) return
      sourceDoc.getPageIndices().forEach(i => selectedPages.add(i))
      setThumbSelected?.(selectedPages)
      syncSelectionUI()
    })
    container.querySelector('#split-sel-none').addEventListener('click', () => {
      selectedPages.clear()
      setThumbSelected?.(selectedPages)
      syncSelectionUI()
    })

    container.querySelector('#split-change-file').addEventListener('click', () => {
      thumbObserver?.disconnect()
      renderDoc?.destroy()
      renderDoc     = null
      sourceDoc     = null
      sourceBytes   = null
      bookmarksReady = false
      blankScanned     = false
      selectedPages.clear()
      lastClickedPage0 = null
      pageCountEl.textContent = ''
      container.querySelector('#split-thumb-section').style.display = 'none'
      container.querySelector('#split-before-load').style.display   = 'block'
      updateRunButtons()
    })

    // ── Run button states ────────────────────────────────────────────────────
    function updateRunButtons() {
      const loaded = !!sourceDoc
      container.querySelector('#extract-run').disabled = !loaded
      container.querySelector('#each-run').disabled    = !loaded || !eachDir
      container.querySelector('#ranges-run').disabled  = !loaded || !rangesDir
      container.querySelector('#blank-scan').disabled  = !loaded

      const checkedBkm = bkmItems.filter(b => b.checked).length
      container.querySelector('#bkm-run').disabled =
        !loaded || !bkmDir || !bookmarksReady || checkedBkm === 0

      if (loaded) {
        container.querySelector('#extract-status').textContent = 'Click thumbnails or type a range.'
        container.querySelector('#each-status').textContent    = eachDir   ? `Will save to ${eachDir.name}/`   : 'Pick a target folder.'
        container.querySelector('#ranges-status').textContent  = rangesDir ? `Will save to ${rangesDir.name}/` : 'Pick a target folder.'
        container.querySelector('#bkm-status').textContent     = bkmDir    ? `Will save to ${bkmDir.name}/`    : 'Pick a target folder.'
        container.querySelector('#blank-status').textContent   = blankScanned
          ? (blankDir ? `Will save to ${blankDir.name}/` : 'Pick a target folder.')
          : 'Scan for blank pages first.'
      } else {
        ;['extract','each','ranges','bkm','blank'].forEach(id => {
          const el = container.querySelector(`#${id}-status`)
          if (el) el.textContent = 'Load a PDF first.'
        })
      }
    }

    // ── File input / drop zone ───────────────────────────────────────────────
    const dropZone  = container.querySelector('#split-drop')
    const fileInput = container.querySelector('#split-file-input')

    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault()
      dropZone.classList.remove('drag-over')
      const f = Array.from(e.dataTransfer.files).find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) loadSource(f)
    })

    container.querySelector('#split-browse').addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) loadSource(e.target.files[0])
      fileInput.value = ''
    })

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => loadSource(gf.file, null, gf.pwd), 0)

    container.querySelector('#split-from-workspace').addEventListener('click', async () => {
      const { scannedFiles } = get()
      if (!scannedFiles.length) {
        toast('No folder open. Use "Open folder" in the top bar.', 'warning')
        return
      }
      const indices = await pickFromWorkspace(scannedFiles)
      if (indices.length) {
        const f = scannedFiles[indices[0]]
        loadSource(null, f.handle)
      }
    })

    // ── Directory pickers ────────────────────────────────────────────────────
    let extractDir = null
    let eachDir    = null
    let rangesDir  = null

    function wireDirPicker(prefix, onSet) {
      const pickBtn  = container.querySelector(`#${prefix}-pick-dir`)
      const clearBtn = container.querySelector(`#${prefix}-clear-dir`)
      const label    = container.querySelector(`#${prefix}-dir-label`)
      if (!pickBtn) return

      pickBtn.addEventListener('click', async () => {
        try {
          const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
          onSet(handle)
          label.textContent      = handle.name + '/'
          clearBtn.style.display = 'inline-flex'
          updateRunButtons()
        } catch (err) {
          if (err.name !== 'AbortError') toast('Could not open folder', 'error')
        }
      })

      clearBtn?.addEventListener('click', () => {
        onSet(null)
        label.textContent = prefix === 'extract'
          ? 'Save As dialog (default)'
          : 'Required — multiple files will be saved here'
        clearBtn.style.display = 'none'
        updateRunButtons()
      })
    }

    wireDirPicker('extract', h => { extractDir = h })
    wireDirPicker('each',    h => { eachDir    = h; updateRunButtons() })
    wireDirPicker('ranges',  h => { rangesDir  = h; updateRunButtons() })
    wireDirPicker('bkm',     h => { bkmDir     = h; updateRunButtons() })
    wireDirPicker('blank',   h => { blankDir   = h; updateRunButtons() })

    // ── Mode 1: Extract pages ────────────────────────────────────────────────
    container.querySelector('#extract-run').addEventListener('click', async () => {
      if (!sourceDoc) return
      const rangeStr = container.querySelector('#extract-range').value.trim()
      const filename = ensurePdf(container.querySelector('#extract-filename').value.trim() || sourceName + '_extracted')
      const total    = sourceDoc.getPageCount()
      const indices  = rangeStr ? parsePageRange(rangeStr, total) : sourceDoc.getPageIndices()

      if (!indices.length) { toast('No pages selected.', 'warning'); return }

      showProgress(`Extracting ${indices.length} page${indices.length !== 1 ? 's' : ''}…`)
      try {
        const out   = await pdf.extractPages(sourceDoc, indices)
        const bytes = await pdf.save(out)
        if (extractDir) {
          await writeToWorkspace(extractDir, filename, bytes)
          toast(`Saved ${indices.length} pages → ${extractDir.name}/${filename}`, 'success')
        } else {
          await saveAs(bytes, filename)
          toast(`Saved ${indices.length} pages → ${filename}`, 'success')
        }
      } catch (err) {
        if (err.name !== 'AbortError') toast('Extract failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })

    // ── Mode 2: Every page ───────────────────────────────────────────────────
    container.querySelector('#each-run').addEventListener('click', async () => {
      if (!sourceDoc || !eachDir) return
      const total  = sourceDoc.getPageCount()
      const padLen = String(total).length

      showProgress(`Splitting ${total} pages…`)
      try {
        for (let i = 0; i < total; i++) {
          updateProgress(`Page ${i + 1} of ${total}…`)
          const out      = await pdf.extractPages(sourceDoc, [i])
          const bytes    = await pdf.save(out)
          const filename = `${safeName(sourceName)}_p${String(i + 1).padStart(padLen, '0')}.pdf`
          await writeToWorkspace(eachDir, filename, bytes)
        }
        toast(`Split into ${total} files → ${eachDir.name}/`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') toast('Split failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })

    // ── Mode 3: By ranges ────────────────────────────────────────────────────
    const rangesList = container.querySelector('#ranges-list')
    const rangeRows  = []

    function renderRangeRows() {
      rangesList.innerHTML = rangeRows.length === 0
        ? '<div class="empty-hint">No sections yet — add one below.</div>'
        : rangeRows.map((r, i) => `
            <div class="file-row" data-idx="${i}" style="gap:6px;">
              <span style="font-size:11px;color:var(--text-subtle);flex-shrink:0;width:16px;text-align:right;">${i + 1}</span>
              <input type="text" class="input rng-range" value="${r.range}" placeholder="1-5" style="width:90px;flex-shrink:0;" data-idx="${i}">
              <input type="text" class="input rng-name"  value="${r.name}"  placeholder="Section name" style="flex:1;" data-idx="${i}">
              <button class="btn-icon" data-action="remove" data-idx="${i}">✕</button>
            </div>
          `).join('')

      rangesList.querySelectorAll('.rng-range').forEach(el =>
        el.addEventListener('input', e => { rangeRows[parseInt(e.target.dataset.idx)].range = e.target.value }))
      rangesList.querySelectorAll('.rng-name').forEach(el =>
        el.addEventListener('input', e => { rangeRows[parseInt(e.target.dataset.idx)].name = e.target.value }))
      rangesList.querySelectorAll('[data-action="remove"]').forEach(btn =>
        btn.addEventListener('click', e => {
          rangeRows.splice(parseInt(e.target.dataset.idx), 1)
          renderRangeRows()
        }))
    }

    container.querySelector('#ranges-add-row').addEventListener('click', () => {
      rangeRows.push({ range: '', name: `Section ${rangeRows.length + 1}` })
      renderRangeRows()
    })

    container.querySelector('#ranges-run').addEventListener('click', async () => {
      if (!sourceDoc || !rangesDir) return
      const total = sourceDoc.getPageCount()
      const valid = rangeRows.filter(r => r.range.trim())
      if (!valid.length) { toast('Add at least one section with a page range.', 'warning'); return }

      showProgress(`Splitting into ${valid.length} sections…`)
      try {
        for (let i = 0; i < valid.length; i++) {
          const row     = valid[i]
          const indices = parsePageRange(row.range, total)
          if (!indices.length) { toast(`"${row.name}": invalid range — skipped`, 'warning'); continue }
          updateProgress(`Section ${i + 1}/${valid.length}: ${row.name}…`)
          const out   = await pdf.extractPages(sourceDoc, indices)
          const bytes = await pdf.save(out)
          await writeToWorkspace(rangesDir, ensurePdf(safeName(row.name || `section_${i + 1}`)), bytes)
        }
        toast(`Saved ${valid.length} sections → ${rangesDir.name}/`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') toast('Split failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })

    // ── Mode 4: By bookmarks ─────────────────────────────────────────────────

    async function destToPageNum(dest) {
      try {
        let resolved = dest
        if (typeof dest === 'string') resolved = await renderDoc.getDestination(dest)
        if (!resolved) return null
        const idx = await renderDoc.getPageIndex(resolved[0])
        return idx + 1   // 1-based
      } catch {
        return null
      }
    }

    async function loadBookmarks() {
      if (!renderDoc) return
      bookmarksReady = false
      bkmItems = []

      const loadingEl = container.querySelector('#bkm-loading')
      const emptyEl   = container.querySelector('#bkm-empty')
      const selBar    = container.querySelector('#bkm-sel-bar')
      const list      = container.querySelector('#bkm-list')

      loadingEl.style.display = 'block'
      emptyEl.style.display   = 'none'
      selBar.style.display    = 'none'
      list.innerHTML          = ''

      try {
        const outline = await renderDoc.getOutline()
        loadingEl.style.display = 'none'

        if (!outline?.length) {
          emptyEl.style.display = 'block'
          updateRunButtons()
          return
        }

        // Resolve top-level items to page numbers
        const raw = []
        for (const item of outline) {
          if (!item.dest && !item.url) continue
          const pageNum = await destToPageNum(item.dest)
          if (pageNum != null) raw.push({ title: item.title || '(untitled)', pageNum })
        }

        // Deduplicate and sort
        const seen = new Set()
        const sorted = raw
          .sort((a, b) => a.pageNum - b.pageNum)
          .filter(item => { if (seen.has(item.pageNum)) return false; seen.add(item.pageNum); return true })

        if (!sorted.length) {
          emptyEl.style.display = 'block'
          updateRunButtons()
          return
        }

        const total = sourceDoc.getPageCount()
        bkmItems = sorted.map((item, i) => ({
          title:     item.title,
          pageStart: item.pageNum,
          pageEnd:   i < sorted.length - 1 ? sorted[i + 1].pageNum - 1 : total,
          checked:   true,
        }))

        bookmarksReady = true
        selBar.style.display = 'flex'
        renderBkmList()
        updateRunButtons()
      } catch (err) {
        loadingEl.style.display = 'none'
        emptyEl.style.display   = 'block'
        console.warn('Bookmark loading failed:', err)
        updateRunButtons()
      }
    }

    function renderBkmList() {
      const list    = container.querySelector('#bkm-list')
      const count   = container.querySelector('#bkm-sel-count')
      const checked = bkmItems.filter(b => b.checked).length
      count.textContent = checked ? `${checked} of ${bkmItems.length} selected` : 'None selected'

      list.innerHTML = bkmItems.map((item, i) => {
        const pageRange = item.pageStart === item.pageEnd
          ? `p.${item.pageStart}`
          : `pp. ${item.pageStart}–${item.pageEnd}`
        const pages = item.pageEnd - item.pageStart + 1
        const fname = `${String(i + 1).padStart(2, '0')}_${safeName(item.title).slice(0, 50)}.pdf`
        return `
          <label class="file-row" style="cursor:pointer;gap:8px;" title="${fname}">
            <input type="checkbox" ${item.checked ? 'checked' : ''} data-bkm-idx="${i}"
              style="accent-color:var(--blue);flex-shrink:0;">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;">
              ${item.title}
            </span>
            <span class="badge badge-blue" style="flex-shrink:0;">${pageRange}</span>
            <span class="status-text" style="flex-shrink:0;">${pages}p</span>
          </label>`
      }).join('')

      list.querySelectorAll('[data-bkm-idx]').forEach(cb =>
        cb.addEventListener('change', e => {
          bkmItems[parseInt(e.target.dataset.bkmIdx)].checked = e.target.checked
          renderBkmList()
          updateRunButtons()
        })
      )
    }

    container.querySelector('#bkm-sel-all').addEventListener('click', () => {
      bkmItems.forEach(b => b.checked = true)
      renderBkmList()
      updateRunButtons()
    })
    container.querySelector('#bkm-sel-none').addEventListener('click', () => {
      bkmItems.forEach(b => b.checked = false)
      renderBkmList()
      updateRunButtons()
    })

    container.querySelector('#bkm-run').addEventListener('click', async () => {
      if (!sourceDoc || !bkmDir) return
      const toSplit = bkmItems.filter(b => b.checked)
      if (!toSplit.length) return

      showProgress(`Splitting into ${toSplit.length} sections…`)
      try {
        for (let i = 0; i < toSplit.length; i++) {
          const item    = toSplit[i]
          const indices = []
          for (let p = item.pageStart - 1; p < item.pageEnd; p++) indices.push(p)
          updateProgress(`${i + 1}/${toSplit.length}: ${item.title}…`)
          const out      = await pdf.extractPages(sourceDoc, indices)
          const bytes    = await pdf.save(out)
          const padded   = String(bkmItems.indexOf(item) + 1).padStart(2, '0')
          const filename = ensurePdf(`${padded}_${safeName(item.title).slice(0, 50)}`)
          await writeToWorkspace(bkmDir, filename, bytes)
        }
        toast(`${toSplit.length} sections saved → ${bkmDir.name}/`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') toast('Split failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })

    // ── Mode 5: By blank pages ───────────────────────────────────────────────

    container.querySelector('#blank-scan').addEventListener('click', async () => {
      if (!renderDoc) return
      const threshold   = parseInt(container.querySelector('#blank-threshold').value) || 20
      const pixelCheck  = container.querySelector('#blank-pixel-check').checked
      const total       = renderDoc.numPages

      blankPages   = []
      blankScanned = false
      container.querySelector('#blank-results-wrap').style.display = 'none'
      container.querySelector('#blank-none-msg').style.display     = 'none'
      container.querySelector('#blank-run').disabled               = true

      showProgress('Scanning for blank pages…')
      try {
        for (let i = 1; i <= total; i++) {
          updateProgress(`Scanning page ${i} of ${total}…`)
          const page    = await renderDoc.getPage(i)
          const content = await page.getTextContent()
          const chars   = content.items.reduce((n, it) => n + it.str.trim().length, 0)

          if (chars < threshold) {
            let isBlank = !pixelCheck
            if (pixelCheck) {
              const vp      = page.getViewport({ scale: 0.3 })
              const canvas  = document.createElement('canvas')
              canvas.width  = Math.ceil(vp.width)
              canvas.height = Math.ceil(vp.height)
              const ctx     = canvas.getContext('2d')
              await page.render({ canvasContext: ctx, viewport: vp }).promise
              const data    = ctx.getImageData(0, 0, canvas.width, canvas.height).data
              let brightness = 0
              for (let j = 0; j < data.length; j += 4) {
                brightness += (data[j] + data[j + 1] + data[j + 2]) / 3
              }
              isBlank = brightness / (data.length / 4) > 245
            }
            if (isBlank) blankPages.push(i)
          }
          page.cleanup()
        }

        blankScanned = true

        if (blankPages.length === 0) {
          container.querySelector('#blank-none-msg').style.display = 'block'
        } else {
          renderBlankResults()
          container.querySelector('#blank-results-wrap').style.display = 'block'
        }
        updateRunButtons()
        toast(`Scan complete: ${blankPages.length} blank page${blankPages.length !== 1 ? 's' : ''} found.`, 'info')
      } catch (err) {
        toast('Scan failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })

    function renderBlankResults() {
      const wrap = container.querySelector('#blank-results')
      wrap.innerHTML = blankPages.map(pg => `
        <label style="display:inline-flex;align-items:center;gap:4px;
          padding:3px 8px;border:1px solid var(--border-dark);border-radius:20px;
          font-size:12px;cursor:pointer;background:var(--surface);white-space:nowrap;">
          <input type="checkbox" checked data-blank-pg="${pg}" style="accent-color:var(--blue);">
          p.${pg}
        </label>
      `).join('')
    }

    container.querySelector('#blank-run').addEventListener('click', async () => {
      if (!sourceDoc || !blankDir || !blankScanned) return

      // Collect which blank pages are still checked
      const activeBlanks = new Set()
      container.querySelectorAll('[data-blank-pg]:checked').forEach(cb =>
        activeBlanks.add(parseInt(cb.dataset.blankPg))
      )
      if (!activeBlanks.size) { toast('No blank pages selected as split points.', 'warning'); return }

      const keepBlanks = container.querySelector('#blank-keep').checked
      const total      = sourceDoc.getPageCount()

      // Compute segments: page ranges between blank pages
      const boundaries = [0, ...[...activeBlanks].sort((a, b) => a - b), total + 1]
      const segments   = []
      for (let i = 0; i < boundaries.length - 1; i++) {
        const start = boundaries[i] + 1              // 1-based, first page after blank
        const end   = boundaries[i + 1] - 1          // 1-based, last page before next blank
        if (i === 0) {
          // First segment: from page 1 to first blank - 1
          if (start <= end) segments.push({ start: 1, end: boundaries[1] - 1 })
        } else {
          const segStart = keepBlanks ? boundaries[i] : start
          const segEnd   = end
          if (segStart <= segEnd) segments.push({ start: segStart, end: segEnd })
        }
      }
      // Remove empty segments
      const valid = segments.filter(s => s.start <= s.end && s.start >= 1 && s.end <= total)

      if (!valid.length) { toast('No non-blank segments to save.', 'warning'); return }

      const padLen = String(valid.length).length
      showProgress(`Splitting into ${valid.length} segment${valid.length !== 1 ? 's' : ''}…`)
      try {
        for (let i = 0; i < valid.length; i++) {
          const { start, end } = valid[i]
          const indices = []
          for (let p = start - 1; p < end; p++) indices.push(p)
          updateProgress(`Segment ${i + 1} of ${valid.length} (pp. ${start}–${end})…`)
          const out      = await pdf.extractPages(sourceDoc, indices)
          const bytes    = await pdf.save(out)
          const filename = `${safeName(sourceName)}_part${String(i + 1).padStart(padLen, '0')}.pdf`
          await writeToWorkspace(blankDir, filename, bytes)
        }
        toast(`${valid.length} segments saved → ${blankDir.name}/`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') toast('Split failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })

    // Initial renders
    renderRangeRows()
    updateRunButtons()
  },
})

// ── HTML helpers ──────────────────────────────────────────────────────────────

function dirPickerHTML(prefix, required = false) {
  const defaultLabel = required
    ? 'Required — multiple files will be saved here'
    : 'Save As dialog (default)'
  return `
    <div class="option-row" style="align-items:flex-start;">
      <label style="padding-top:7px;">Save to${required ? ' <span style="color:var(--red);">*</span>' : ''}</label>
      <div style="flex:1;display:flex;flex-direction:column;gap:5px;">
        <div style="display:flex;gap:6px;">
          <button class="btn btn-sm" id="${prefix}-pick-dir" style="flex:1;">📁 Pick folder…</button>
          <button class="btn btn-sm" id="${prefix}-clear-dir" style="display:none;">Clear</button>
        </div>
        <span id="${prefix}-dir-label" style="font-size:11.5px;color:var(--text-muted);font-family:var(--font-mono);">${defaultLabel}</span>
      </div>
    </div>
  `
}
