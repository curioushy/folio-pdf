/**
 * Split by Bookmarks feature — split a PDF into one file per chapter/section
 * using the document's built-in bookmark outline.
 *
 * Workflow:
 *   1. Load a PDF → extract top-level bookmarks via PDF.js getOutline()
 *   2. Resolve each bookmark's dest to a page number
 *   3. Compute page ranges: bookmark[i] → pages [pageNum[i] .. pageNum[i+1]-1]
 *   4. User reviews the list, checks/unchecks entries, picks an output folder
 *   5. Split via pdf-lib copyPages(), one PDFDocument per section
 *   6. Write files to the chosen folder with zero-padded numeric prefixes
 *
 * If a PDF has no outline, the user is directed to the Bookmarks tool.
 */

import { registerFeature }   from '../core/registry.js'
import { readFile }          from '../core/fs.js'
import * as pdf              from '../core/pdf.js'
import { PDFDocument }       from '@cantoo/pdf-lib'
import * as renderer         from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, safeName, ensurePdf } from '../core/utils.js'

registerFeature({
  id:          'split-bookmarks',
  name:        'Split by Bookmarks',
  category:    'Pages',
  icon:        '📑',
  description: 'Split a PDF into separate files — one per chapter — using its bookmark outline',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Split by Bookmarks</h2>
        <p class="feature-desc">
          Splits a PDF into one file per top-level bookmark.
          Select which sections to export, then choose an output folder.
        </p>
      </div>

      <div class="feature-split">

        <!-- ── Source ─────────────────────────────────────────────────────── -->
        <div class="panel" style="display:flex;flex-direction:column;">
          <div class="panel-header">
            <span class="panel-title">① Source PDF</span>
            <button class="btn btn-sm" id="sbm-change" style="display:none;">⇄ Change</button>
          </div>

          <div class="file-drop-zone" id="sbm-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="sbm-browse">Browse</button>
            <input type="file" id="sbm-input" accept=".pdf" hidden>
          </div>

          <div id="sbm-file-info" style="display:none;">
            <div id="sbm-filename" class="file-name-display"></div>
            <div class="status-text" id="sbm-page-count" style="margin-top:4px;"></div>
          </div>

          <!-- Options (shown after load) -->
          <div id="sbm-options" style="display:none;margin-top:16px;">
            <div class="section-label">Selection</div>
            <div style="display:flex;gap:8px;margin-bottom:8px;">
              <button class="btn btn-sm" id="sbm-sel-all">Select all</button>
              <button class="btn btn-sm" id="sbm-sel-none">Deselect all</button>
            </div>

            <div class="section-label" style="margin-top:14px;">Output folder</div>
            <div style="display:flex;gap:6px;margin-bottom:6px;">
              <button class="btn btn-sm" id="sbm-pick-dir" style="flex:1;">📁 Pick folder…</button>
              <button class="btn btn-sm" id="sbm-clear-dir" style="display:none;">Clear</button>
            </div>
            <span id="sbm-dir-label"
              style="font-size:11.5px;color:var(--text-muted);font-family:var(--font-mono);">
              Required — files will be saved here
            </span>
          </div>
        </div>

        <!-- ── Sections list + action ──────────────────────────────────────── -->
        <div class="panel" style="display:flex;flex-direction:column;">
          <div class="panel-header">
            <span class="panel-title">② Sections</span>
            <span class="status-text" id="sbm-count"></span>
          </div>

          <div id="sbm-placeholder" class="empty-hint" style="margin-top:32px;">
            Load a PDF to see its bookmark sections.
          </div>

          <!-- Section list -->
          <div id="sbm-list"
            style="flex:1;overflow-y:auto;min-height:200px;max-height:420px;
                   border:1px solid var(--border);border-radius:var(--radius-sm);
                   display:none;">
          </div>

          <!-- Split action -->
          <div id="sbm-action-area" style="display:none;margin-top:14px;">
            <div class="action-bar">
              <button class="btn btn-primary btn-lg" id="sbm-run" disabled
                style="flex:1;justify-content:center;">
                Split into <span id="sbm-run-count">0</span> files…
              </button>
            </div>
            <div class="status-text" id="sbm-status" style="text-align:center;margin-top:8px;"></div>
          </div>

        </div>
      </div>
    `

    // ── State ─────────────────────────────────────────────────────────────────
    let srcFile    = null
    let srcDoc     = null   // pdf-lib PDFDocument
    let rDoc       = null   // PDF.js PDFDocumentProxy
    let totalPages = 0
    let outDirHandle = null

    /**
     * @type {Array<{
     *   title: string,
     *   pageStart: number,   // 1-based, inclusive
     *   pageEnd:   number,   // 1-based, inclusive
     *   filename:  string,
     *   checked:   boolean,
     * }>}
     */
    let sections = []

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const dropZone      = container.querySelector('#sbm-drop')
    const fileInput     = container.querySelector('#sbm-input')
    const changeBtn     = container.querySelector('#sbm-change')
    const fileInfoEl    = container.querySelector('#sbm-file-info')
    const filenameEl    = container.querySelector('#sbm-filename')
    const pageCountEl   = container.querySelector('#sbm-page-count')
    const optionsEl     = container.querySelector('#sbm-options')
    const placeholder   = container.querySelector('#sbm-placeholder')
    const listEl        = container.querySelector('#sbm-list')
    const countEl       = container.querySelector('#sbm-count')
    const actionAreaEl  = container.querySelector('#sbm-action-area')
    const runBtn        = container.querySelector('#sbm-run')
    const runCountEl    = container.querySelector('#sbm-run-count')
    const statusEl      = container.querySelector('#sbm-status')
    const pickDirBtn    = container.querySelector('#sbm-pick-dir')
    const clearDirBtn   = container.querySelector('#sbm-clear-dir')
    const dirLabelEl    = container.querySelector('#sbm-dir-label')

    // ── Drop zone wiring ──────────────────────────────────────────────────────
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) loadFile(f)
    })
    container.querySelector('#sbm-browse').addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) { loadFile(e.target.files[0]); fileInput.value = '' }
    })
    changeBtn.addEventListener('click', () => fileInput.click())

    // ── Directory picker ──────────────────────────────────────────────────────
    pickDirBtn.addEventListener('click', async () => {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
        outDirHandle              = handle
        dirLabelEl.textContent    = handle.name + '/'
        clearDirBtn.style.display = 'inline-flex'
        updateRunBtn()
      } catch (err) {
        if (err.name !== 'AbortError') toast('Could not open folder', 'error')
      }
    })

    clearDirBtn.addEventListener('click', () => {
      outDirHandle              = null
      dirLabelEl.textContent    = 'Required — files will be saved here'
      clearDirBtn.style.display = 'none'
      updateRunBtn()
    })

    // ── Select all / deselect all ─────────────────────────────────────────────
    container.querySelector('#sbm-sel-all').addEventListener('click', () => {
      sections.forEach(s => { s.checked = true })
      renderList()
    })
    container.querySelector('#sbm-sel-none').addEventListener('click', () => {
      sections.forEach(s => { s.checked = false })
      renderList()
    })

    // ── Load file ─────────────────────────────────────────────────────────────
    async function loadFile(file) {
      showProgress('Loading PDF…')
      try {
        rDoc?.destroy()
        rDoc = null

        const bytes = await readFile(file)
        let doc, rdoc
        try {
          doc  = await pdf.load(bytes)
          rdoc = await renderer.loadForRender(bytes)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(file.name)
          if (!pwd) return
          showProgress('Decrypting…')
          doc  = await pdf.load(bytes, pwd)
          rdoc = await renderer.loadForRender(bytes, pwd)
        }

        srcFile    = file
        srcDoc     = doc
        rDoc       = rdoc
        totalPages = doc.getPageCount()

        // ── Get outline ──────────────────────────────────────────────────────
        updateProgress('Reading bookmarks…')
        const outline = await rDoc.getOutline()

        if (!outline || outline.length === 0) {
          hideProgress()
          // Show "no bookmarks" message in placeholder area
          dropZone.style.display    = 'none'
          fileInfoEl.style.display  = 'block'
          filenameEl.textContent    = file.name
          pageCountEl.textContent   = `${totalPages} page${totalPages !== 1 ? 's' : ''}`
          changeBtn.style.display   = 'inline-flex'
          placeholder.style.display = 'block'
          placeholder.innerHTML     = `
            <strong>No bookmarks found.</strong><br>
            <span style="font-size:12px;color:var(--text-muted);">
              Add bookmarks first using the
              <strong>Bookmarks</strong> tool, then come back to split.
            </span>
          `
          listEl.style.display       = 'none'
          actionAreaEl.style.display = 'none'
          optionsEl.style.display    = 'none'
          countEl.textContent        = ''
          toast('No bookmarks in this PDF.', 'warning')
          return
        }

        // ── Resolve page numbers for top-level items only ────────────────────
        const topLevel = outline  // already top-level only
        const pageNums = await Promise.all(
          topLevel.map(item => item.dest ? destToPageNum(rDoc, item.dest) : Promise.resolve(null))
        )

        // Build sections: skip items with no resolvable page, deduplicate same-page starts
        const resolved = []
        const seenPages = new Set()
        for (let i = 0; i < topLevel.length; i++) {
          const pg = pageNums[i]
          if (pg === null || pg === undefined) continue
          if (seenPages.has(pg)) continue   // skip duplicates on same start page
          seenPages.add(pg)
          resolved.push({ title: topLevel[i].title || '(Untitled)', pageNum: pg })
        }

        // Sort by page number ascending
        resolved.sort((a, b) => a.pageNum - b.pageNum)

        // Compute page ranges
        const padLen = String(resolved.length).length
        sections = resolved.map((item, i) => {
          const pageStart = item.pageNum
          const pageEnd   = i < resolved.length - 1
            ? resolved[i + 1].pageNum - 1
            : totalPages
          const filename  = `${String(i + 1).padStart(padLen, '0')}_${sanitizeFilename(item.title)}.pdf`
          return {
            title: item.title,
            pageStart,
            pageEnd,
            filename,
            checked: true,
          }
        })

        // ── Update UI ────────────────────────────────────────────────────────
        filenameEl.textContent   = file.name
        pageCountEl.textContent  = `${totalPages} page${totalPages !== 1 ? 's' : ''}`

        dropZone.style.display    = 'none'
        fileInfoEl.style.display  = 'block'
        optionsEl.style.display   = 'block'
        actionAreaEl.style.display = 'block'
        changeBtn.style.display   = 'inline-flex'

        renderList()
        updateRunBtn()
        toast(`Found ${sections.length} section${sections.length !== 1 ? 's' : ''}`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed to load: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    }

    // ── Resolve a PDF.js dest → 1-based page number ───────────────────────────
    async function destToPageNum(pdfJsDoc, dest) {
      try {
        let resolved = dest
        if (typeof dest === 'string') {
          resolved = await pdfJsDoc.getDestination(dest)
        }
        if (!Array.isArray(resolved) || !resolved.length) return null
        const pageRef = resolved[0]
        const pageIdx = await pdfJsDoc.getPageIndex(pageRef)
        return pageIdx + 1
      } catch {
        return null
      }
    }

    // ── Sanitise a bookmark title into a safe filename component ─────────────
    function sanitizeFilename(title) {
      return (title || 'section')
        .replace(/[^\w\s-]/g, '')      // remove non-word chars (keep spaces, hyphens)
        .replace(/\s+/g, '_')          // spaces → underscores
        .replace(/_+/g, '_')           // collapse multiple underscores
        .replace(/^_|_$/g, '')         // trim leading/trailing underscores
        .slice(0, 60)                  // cap length
        || 'section'
    }

    // ── Render section list ───────────────────────────────────────────────────
    function renderList() {
      if (sections.length === 0) {
        listEl.style.display      = 'none'
        placeholder.style.display = 'block'
        placeholder.textContent   = 'No sections found.'
        countEl.textContent = ''
        updateRunBtn()
        return
      }

      placeholder.style.display = 'none'
      listEl.style.display      = 'block'
      countEl.textContent       = `${sections.length} section${sections.length !== 1 ? 's' : ''}`

      listEl.innerHTML = sections.map((s, idx) => {
        const pageRange = s.pageStart === s.pageEnd
          ? `p. ${s.pageStart}`
          : `pp. ${s.pageStart}–${s.pageEnd}`
        const pageCount = s.pageEnd - s.pageStart + 1

        return `
          <label class="sbm-section-row" data-idx="${idx}"
            style="display:flex;align-items:center;gap:10px;
                   padding:8px 12px;border-bottom:1px solid var(--border);
                   cursor:pointer;${s.checked ? '' : 'opacity:0.5;'}">
            <input type="checkbox" class="sbm-check" data-idx="${idx}"
              ${s.checked ? 'checked' : ''}
              style="flex-shrink:0;accent-color:var(--blue);">
            <span style="flex:1;font-size:13px;overflow:hidden;
                         text-overflow:ellipsis;white-space:nowrap;"
              title="${escHtml(s.title)}">
              ${escHtml(s.title)}
            </span>
            <span style="font-size:11px;color:var(--text-muted);
                         background:var(--bg-subtle);padding:2px 7px;
                         border-radius:var(--radius-sm);flex-shrink:0;white-space:nowrap;">
              ${pageRange}
              <span style="color:var(--text-subtle);">(${pageCount}p)</span>
            </span>
            <span style="font-size:10.5px;color:var(--text-subtle);
                         font-family:var(--font-mono);max-width:180px;
                         overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;"
              title="${escHtml(s.filename)}">
              ${escHtml(s.filename)}
            </span>
          </label>
        `
      }).join('')

      // Wire checkboxes
      listEl.querySelectorAll('.sbm-check').forEach(cb => {
        cb.addEventListener('change', e => {
          const idx = parseInt(cb.dataset.idx)
          sections[idx].checked = cb.checked
          const row = listEl.querySelector(`label[data-idx="${idx}"]`)
          if (row) row.style.opacity = cb.checked ? '1' : '0.5'
          updateRunBtn()
        })
      })

      updateRunBtn()
    }

    // ── Update run button state ───────────────────────────────────────────────
    function updateRunBtn() {
      const checkedCount = sections.filter(s => s.checked).length
      runBtn.disabled    = !srcDoc || !outDirHandle || checkedCount === 0
      runCountEl.textContent = String(checkedCount)
    }

    // ── Split ─────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      if (!srcDoc || !outDirHandle) return

      const toSplit = sections.filter(s => s.checked)
      if (toSplit.length === 0) { toast('No sections selected.', 'warning'); return }

      showProgress(`Splitting into ${toSplit.length} files…`)
      statusEl.textContent = ''

      let saved = 0
      try {
        for (let i = 0; i < toSplit.length; i++) {
          const section = toSplit[i]
          updateProgress(`${i + 1}/${toSplit.length}: ${section.title}…`)

          // 0-based page indices
          const pageStart0 = section.pageStart - 1
          const pageEnd0   = section.pageEnd   - 1
          const indices    = Array.from(
            { length: pageEnd0 - pageStart0 + 1 },
            (_, k) => pageStart0 + k
          )

          // Build output PDF
          const outDoc = await PDFDocument.create()
          const copied = await outDoc.copyPages(srcDoc, indices)
          copied.forEach(p => outDoc.addPage(p))

          const outBytes = await outDoc.save()

          // Write to directory
          const fileHandle = await outDirHandle.getFileHandle(section.filename, { create: true })
          const writable   = await fileHandle.createWritable()
          await writable.write(outBytes)
          await writable.close()
          saved++
        }

        statusEl.textContent = `Saved ${saved} file${saved !== 1 ? 's' : ''} to ${outDirHandle.name}/`
        toast(`Split complete — ${saved} files → ${outDirHandle.name}/`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Split failed: ' + err.message, 'error')
          statusEl.textContent = 'Error: ' + err.message
        }
      } finally {
        hideProgress()
      }
    })

    // ── Utility ───────────────────────────────────────────────────────────────
    function escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }
  },
})
