/**
 * Organise Pages — reorder, rotate, delete, duplicate, insert blank pages, and
 * import pages from a second PDF, all with live thumbnail preview.
 *
 * State model:
 *   sources[]  — array of { doc, renderDoc, name }
 *                  [0] = the primary loaded document
 *                  [1..] = additional PDFs imported via "From PDF…"
 *   slots[]    — ordered array of { id, srcIdx, origIdx, extraRotation }
 *                  srcIdx       : index into sources[]
 *                  origIdx      : 0-based page index within that source's pdf-lib doc
 *                  extraRotation: additional clockwise degrees (0/90/180/270)
 *   sel        — Set of slot ids currently selected
 *
 * On save, pages are copied from their respective source docs in slot order, and
 * extra rotations applied, producing a clean output PDF.
 */

import { registerFeature }                           from '../core/registry.js'
import { readFile, saveAs }                          from '../core/fs.js'
import * as pdf                                      from '../core/pdf.js'
import { loadForRender }                             from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, ensurePdf }                       from '../core/utils.js'
import { PDFDocument }                               from '@cantoo/pdf-lib'
import { get }                                       from '../core/state.js'

registerFeature({
  id:          'organise',
  name:        'Organise Pages',
  category:    'Pages',
  icon:        '⊞',
  description: 'Reorder, rotate, delete, duplicate pages and import pages from another PDF',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Organise Pages</h2>
          <p class="feature-desc">Drag thumbnails to reorder, rotate, delete, duplicate, insert blanks or import pages from another PDF.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">⊞</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>
      `
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Organise Pages</h2>
        <p class="feature-desc">
          Drag thumbnails to reorder · click to select · use the toolbar to rotate,
          duplicate, delete, insert blanks or pull in pages from another PDF.
        </p>
      </div>

      <!-- ── Top panel: file info + save ──────────────────────────────────── -->
      <div class="panel" style="margin-bottom:10px;">
        <div class="panel-header">
          <span class="panel-title" style="font-weight:400;color:var(--text);">${gf.name}</span>
          <span id="org-page-count" class="status-text"></span>
        </div>
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
          <div class="option-row" style="flex:1;min-width:200px;">
            <label>Output filename</label>
            <input type="text" id="org-output-name" class="input"
              value="${stripExt(gf.name)}_organised.pdf" placeholder="organised.pdf" style="flex:1;">
          </div>
          <button class="btn btn-primary btn-lg" id="org-save" disabled style="white-space:nowrap;flex-shrink:0;">
            💾 Save PDF
          </button>
        </div>
        <div class="status-text" id="org-save-hint" style="margin-top:8px;min-height:18px;"></div>
      </div>

      <!-- ── Toolbar — sticky so it stays visible while scrolling a long grid ── -->
      <div id="org-toolbar" class="org-toolbar hidden" style="
        position:sticky; top:0; z-index:10;
        background:var(--surface);
        border:1px solid var(--border);
        border-radius:var(--radius-sm);
        margin-bottom:10px;
        box-shadow:var(--shadow-sm);
      ">
        <div class="org-toolbar-left">
          <button class="btn btn-sm" id="org-select-all">Select all</button>
          <button class="btn btn-sm" id="org-select-none">Clear</button>
          <span id="org-sel-count" class="status-text" style="margin-left:6px;min-width:100px;"></span>
        </div>
        <div class="org-toolbar-right">
          <button class="btn btn-sm" id="org-rotate-ccw" title="Rotate 90° counter-clockwise">↺ CCW</button>
          <button class="btn btn-sm" id="org-rotate-cw"  title="Rotate 90° clockwise">↻ CW</button>
          <button class="btn btn-sm" id="org-duplicate"  title="Duplicate selected pages after last selection">⧉ Duplicate</button>
          <button class="btn btn-sm" id="org-reverse"    title="Reverse page order (all, or just selected)">⇅ Reverse</button>
          <button class="btn btn-sm" id="org-blank"      title="Insert a blank page after the last selected page (or at end)">＋ Blank</button>
          <button class="btn btn-sm" id="org-from-pdf"   title="Insert pages from another PDF">📥 From PDF…</button>
          <button class="btn btn-sm btn-danger" id="org-delete" title="Delete selected pages">✕ Delete</button>
        </div>
      </div>

      <!-- ── Page grid ──────────────────────────────────────────────────────── -->
      <div id="org-grid" class="org-grid"></div>

      <!-- ── Import-from-PDF modal ─────────────────────────────────────────── -->
      <div id="org-import-modal" style="
        display:none; position:fixed; inset:0;
        background:rgba(15,23,42,.6); z-index:150;
        align-items:center; justify-content:center;
        backdrop-filter:blur(2px);
      ">
        <div style="
          background:var(--surface); border-radius:var(--radius-lg);
          width:min(820px, 94vw); max-height:88vh;
          display:flex; flex-direction:column; box-shadow:var(--shadow-lg);
        ">
          <!-- Modal header -->
          <div style="padding:14px 18px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; flex-shrink:0;">
            <span style="font-weight:700; font-size:14px;">Add Pages from PDF</span>
            <span id="org-import-name" style="font-size:12px; color:var(--text-muted); font-family:var(--font-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:260px;"></span>
            <div style="flex:1"></div>
            <button class="btn btn-sm" id="org-import-sel-all">All</button>
            <button class="btn btn-sm" id="org-import-sel-none">None</button>
            <button class="btn btn-primary btn-sm" id="org-import-confirm" disabled>Insert 0 pages</button>
            <button class="btn btn-sm" id="org-import-cancel">✕</button>
          </div>
          <!-- Position option -->
          <div style="padding:10px 18px 8px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:12px; font-size:13px; flex-shrink:0;">
            <span style="color:var(--text-muted);">Insert</span>
            <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
              <input type="radio" name="org-import-pos" value="after" checked> After selected page
            </label>
            <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
              <input type="radio" name="org-import-pos" value="end"> At the end
            </label>
          </div>
          <!-- Page grid -->
          <div id="org-import-grid" class="org-grid" style="padding:12px; overflow-y:auto; flex:1; min-height:0;"></div>
          <!-- Help text -->
          <div style="padding:8px 18px; border-top:1px solid var(--border); font-size:12px; color:var(--text-subtle); flex-shrink:0;">
            Click thumbnails to select · Shift-click for range · Ctrl-click to toggle individual pages
          </div>
        </div>
      </div>
    `

    // ── State ─────────────────────────────────────────────────────────────────
    let srcPwd      = null
    let sources     = []    // [{ doc, renderDoc, name }]
    let slots       = []    // { id, srcIdx, origIdx, extraRotation }
    let nextId      = 0
    const sel       = new Set()
    let lastClickI  = null
    let dragSrcIdx  = null

    // Convenience getter for primary document
    const primaryDoc = () => sources[0]?.doc ?? null

    const THUMB_W   = 130

    const toolbar    = container.querySelector('#org-toolbar')
    const gridEl     = container.querySelector('#org-grid')
    const saveBtn    = container.querySelector('#org-save')
    const selCount   = container.querySelector('#org-sel-count')
    const pageCount  = container.querySelector('#org-page-count')
    const saveHint   = container.querySelector('#org-save-hint')

    // ── File loading ──────────────────────────────────────────────────────────
    async function loadFile(file, initialPwd = null) {
      showProgress('Loading PDF…')
      try {
        const bytes = await file.arrayBuffer()

        let doc, pwd = initialPwd
        try {
          doc = await pdf.load(bytes, pwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          pwd = await promptPassword(file.name)
          if (!pwd) return
          showProgress('Decrypting…')
          doc = await pdf.load(bytes, pwd)
        }

        srcPwd = pwd
        updateProgress('Loading thumbnails…')
        const renderDoc = await loadForRender(bytes, pwd)

        // Reset state
        if (sources[0]?.renderDoc) sources[0].renderDoc.destroy()
        sources = [{ doc, renderDoc, name: file.name }]
        slots = []
        sel.clear()
        nextId = 0

        for (let i = 0; i < doc.getPageCount(); i++) {
          slots.push({ id: nextId++, srcIdx: 0, origIdx: i, extraRotation: 0 })
        }
        lastClickI = null

        updatePageCountLabel()
        toolbar.classList.remove('hidden')
        saveBtn.disabled = false
        renderGrid()
        updateSelCount()
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    function updatePageCountLabel() {
      pageCount.textContent = `${slots.length} page${slots.length !== 1 ? 's' : ''}`
    }

    // Auto-load from global file state
    setTimeout(() => loadFile(gf.file, gf.pwd), 0)

    // ── Grid rendering ────────────────────────────────────────────────────────

    async function renderOneThumb(cell) {
      const si   = parseInt(cell.dataset.si)
      const slot = slots[si]
      if (!slot) return
      const src  = sources[slot.srcIdx]
      if (!src?.renderDoc) return   // blank pages or source not loaded → keep placeholder
      try {
        const page     = await src.renderDoc.getPage(slot.origIdx + 1)
        const vpNative = page.getViewport({ scale: 1 })
        const totalRot = (vpNative.rotation + slot.extraRotation) % 360
        const vpUnit   = page.getViewport({ scale: 1, rotation: totalRot })
        const scale    = THUMB_W / vpUnit.width
        const vpFinal  = page.getViewport({ scale, rotation: totalRot })
        const canvas   = document.createElement('canvas')
        canvas.width   = Math.round(vpFinal.width)
        canvas.height  = Math.round(vpFinal.height)
        canvas.style.width   = '100%'
        canvas.style.display = 'block'
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vpFinal }).promise
        page.cleanup()
        cell.querySelector('.org-thumb-canvas-wrap > div')?.replaceWith(canvas)
      } catch {
        // leave placeholder on render error
      }
    }

    function paintVisibleThumbs() {
      const panelRect = container.getBoundingClientRect()
      const buffer    = 400  // px ahead to pre-render
      gridEl.querySelectorAll('.org-thumb:not([data-rendered])').forEach(cell => {
        const r = cell.getBoundingClientRect()
        if (r.top < panelRect.bottom + buffer && r.bottom > panelRect.top - buffer) {
          cell.dataset.rendered = '1'
          renderOneThumb(cell)
        }
      })
    }

    function renderGrid() {
      // Remove previous scroll listener
      if (container._scrollPaint) {
        container.removeEventListener('scroll', container._scrollPaint)
        delete container._scrollPaint
      }

      gridEl.innerHTML = ''

      slots.forEach((slot, i) => {
        const cell = document.createElement('div')
        cell.className  = 'org-thumb' + (sel.has(slot.id) ? ' selected' : '')
        cell.draggable  = true
        cell.dataset.si = i

        const wrap = document.createElement('div')
        wrap.className = 'org-thumb-canvas-wrap'
        const ph = document.createElement('div')
        ph.className = 'org-thumb-placeholder'
        wrap.appendChild(ph)

        const label = document.createElement('div')
        label.className = 'org-thumb-label'

        const numSpan = document.createElement('span')
        numSpan.className   = 'org-thumb-num'
        numSpan.textContent = String(i + 1)
        label.appendChild(numSpan)

        // Source badge for imported pages
        if (slot.srcIdx > 0) {
          const srcBadge = document.createElement('span')
          srcBadge.className   = 'org-rot-badge'
          srcBadge.style.background = 'rgba(37,99,235,.12)'
          srcBadge.style.color      = 'var(--blue)'
          srcBadge.textContent = '↗'
          srcBadge.title = `From: ${sources[slot.srcIdx]?.name ?? ''}`
          label.appendChild(srcBadge)
        }

        if (slot.extraRotation) {
          const badge = document.createElement('span')
          badge.className   = 'org-rot-badge'
          badge.textContent = `↻${slot.extraRotation}°`
          label.appendChild(badge)
        }

        cell.appendChild(wrap)
        cell.appendChild(label)
        gridEl.appendChild(cell)

        // Drag to reorder
        cell.addEventListener('dragstart', e => {
          dragSrcIdx = i
          cell.classList.add('dragging')
          e.dataTransfer.effectAllowed = 'move'
        })
        cell.addEventListener('dragend', () => cell.classList.remove('dragging'))
        cell.addEventListener('dragover', e => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          gridEl.querySelectorAll('.org-thumb').forEach(c => c.classList.remove('drop-target'))
          if (dragSrcIdx !== null && dragSrcIdx !== i) cell.classList.add('drop-target')
        })
        cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'))
        cell.addEventListener('drop', e => {
          e.preventDefault()
          cell.classList.remove('drop-target')
          if (dragSrcIdx === null || dragSrcIdx === i) return
          const [moved] = slots.splice(dragSrcIdx, 1)
          slots.splice(i, 0, moved)
          dragSrcIdx = null
          renderGrid()
          updateSaveHint()
        })

        // Click to select
        cell.addEventListener('click', e => {
          const id = slot.id
          if (e.shiftKey && lastClickI !== null) {
            const lo = Math.min(i, lastClickI)
            const hi = Math.max(i, lastClickI)
            for (let j = lo; j <= hi; j++) sel.add(slots[j].id)
          } else if (e.ctrlKey || e.metaKey) {
            sel.has(id) ? sel.delete(id) : sel.add(id)
            lastClickI = i
          } else {
            sel.clear()
            sel.add(id)
            lastClickI = i
          }
          syncSelectionHighlights()
          updateSelCount()
        })

      })

      // Wire scroll-based lazy rendering
      container._scrollPaint = paintVisibleThumbs
      container.addEventListener('scroll', container._scrollPaint)
      requestAnimationFrame(paintVisibleThumbs)
    }

    function syncSelectionHighlights() {
      gridEl.querySelectorAll('.org-thumb').forEach(cell => {
        const slot = slots[parseInt(cell.dataset.si)]
        cell.classList.toggle('selected', slot ? sel.has(slot.id) : false)
      })
    }

    function updateSelCount() {
      const n = sel.size
      selCount.textContent = n ? `${n} page${n !== 1 ? 's' : ''} selected` : ''
    }

    function updateSaveHint() {
      if (!sources[0]) return
      const orig  = sources[0].doc.getPageCount()
      const curr  = slots.length
      const parts = []
      if (curr !== orig) parts.push(`${curr} pages (was ${orig})`)
      const rotated   = slots.filter(s => s.extraRotation).length
      const imported  = slots.filter(s => s.srcIdx > 0).length
      if (rotated)  parts.push(`${rotated} rotated`)
      if (imported) parts.push(`${imported} imported`)
      saveHint.textContent = parts.join(' · ')
    }

    function selectedIndices() {
      return slots.reduce((acc, s, i) => { if (sel.has(s.id)) acc.push(i); return acc }, [])
    }

    // ── Toolbar ───────────────────────────────────────────────────────────────
    container.querySelector('#org-select-all').addEventListener('click', () => {
      slots.forEach(s => sel.add(s.id))
      syncSelectionHighlights()
      updateSelCount()
    })
    container.querySelector('#org-select-none').addEventListener('click', () => {
      sel.clear()
      syncSelectionHighlights()
      updateSelCount()
    })

    container.querySelector('#org-rotate-ccw').addEventListener('click', () => {
      const idxs = selectedIndices()
      if (!idxs.length) { toast('Select pages first.', 'warning'); return }
      idxs.forEach(i => { slots[i].extraRotation = (slots[i].extraRotation + 270) % 360 })
      renderGrid()
      updateSaveHint()
    })

    container.querySelector('#org-rotate-cw').addEventListener('click', () => {
      const idxs = selectedIndices()
      if (!idxs.length) { toast('Select pages first.', 'warning'); return }
      idxs.forEach(i => { slots[i].extraRotation = (slots[i].extraRotation + 90) % 360 })
      renderGrid()
      updateSaveHint()
    })

    container.querySelector('#org-duplicate').addEventListener('click', () => {
      const idxs = selectedIndices()
      if (!idxs.length) { toast('Select pages first.', 'warning'); return }
      const insertAt = idxs[idxs.length - 1] + 1
      const copies   = idxs.map(i => ({ ...slots[i], id: nextId++ }))
      slots.splice(insertAt, 0, ...copies)
      sel.clear()
      copies.forEach(c => sel.add(c.id))
      updatePageCountLabel()
      renderGrid()
      updateSelCount()
      updateSaveHint()
      setTimeout(() => {
        gridEl.querySelector(`.org-thumb[data-si="${insertAt}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 50)
    })

    container.querySelector('#org-reverse').addEventListener('click', () => {
      if (!sources[0]) return
      const idxs = selectedIndices()
      if (idxs.length > 1) {
        const half = Math.floor(idxs.length / 2)
        for (let i = 0; i < half; i++) {
          const a = idxs[i], b = idxs[idxs.length - 1 - i]
          ;[slots[a], slots[b]] = [slots[b], slots[a]]
        }
        toast(`${idxs.length} selected pages reversed.`, 'info')
      } else {
        slots.reverse()
        sel.clear()
        toast('All pages reversed.', 'info')
      }
      renderGrid()
      updateSelCount()
      updateSaveHint()
    })

    container.querySelector('#org-blank').addEventListener('click', () => {
      if (!sources[0]) return
      const idxs     = selectedIndices()
      const insertAt = idxs.length ? idxs[idxs.length - 1] + 1 : slots.length

      // Match size of adjacent page (or A4 if none)
      const refSlot  = slots[insertAt > 0 ? insertAt - 1 : 0] ?? null
      const refPage  = refSlot ? sources[refSlot.srcIdx]?.doc.getPage(refSlot.origIdx) : null
      const { width, height } = refPage?.getSize() ?? { width: 595, height: 842 }

      // Blank page goes into the primary document (srcIdx=0)
      sources[0].doc.addPage([width, height])
      const blankOrigIdx = sources[0].doc.getPageCount() - 1

      const newSlot = { id: nextId++, srcIdx: 0, origIdx: blankOrigIdx, extraRotation: 0 }
      slots.splice(insertAt, 0, newSlot)
      sel.clear()
      sel.add(newSlot.id)

      updatePageCountLabel()
      renderGrid()
      updateSelCount()
      updateSaveHint()
      setTimeout(() => {
        gridEl.querySelector(`.org-thumb[data-si="${insertAt}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 50)
      toast('Blank page inserted.', 'info')
    })

    container.querySelector('#org-delete').addEventListener('click', () => {
      const idxs = selectedIndices()
      if (!idxs.length) { toast('Select pages first.', 'warning'); return }
      if (idxs.length >= slots.length) {
        toast('Cannot delete all pages — at least one must remain.', 'warning')
        return
      }
      const toRemove = new Set(idxs.map(i => slots[i].id))
      slots = slots.filter(s => !toRemove.has(s.id))
      toRemove.forEach(id => sel.delete(id))
      updatePageCountLabel()
      renderGrid()
      updateSelCount()
      updateSaveHint()
    })

    // ── Import from PDF ───────────────────────────────────────────────────────
    const importModal  = container.querySelector('#org-import-modal')
    const importGrid   = container.querySelector('#org-import-grid')
    const importName   = container.querySelector('#org-import-name')
    const importConfirm = container.querySelector('#org-import-confirm')

    // Hidden file input for the import picker
    const importInput = document.createElement('input')
    importInput.type   = 'file'
    importInput.accept = '.pdf'
    importInput.hidden = true
    container.appendChild(importInput)

    let importDoc      = null   // pdf-lib doc being previewed
    let importRenderDoc = null  // PDF.js doc for thumbnails
    let importSel      = new Set()  // selected slot ids in import modal
    let importSlots    = []         // { id, origIdx }
    let importLastClickI = null
    let importNextId   = 0

    function updateImportConfirm() {
      const n = importSel.size
      importConfirm.disabled = n === 0
      importConfirm.textContent = `Insert ${n} page${n !== 1 ? 's' : ''}`
    }

    // Render the thumbnail for one import cell
    async function renderOneImportThumb(cell) {
      const i    = parseInt(cell.dataset.si)
      const slot = importSlots[i]
      if (!slot || !importRenderDoc) return
      try {
        const page    = await importRenderDoc.getPage(slot.origIdx + 1)
        const vpUnit  = page.getViewport({ scale: 1 })
        const scale   = THUMB_W / vpUnit.width
        const vpFinal = page.getViewport({ scale })
        const canvas  = document.createElement('canvas')
        canvas.width  = Math.round(vpFinal.width)
        canvas.height = Math.round(vpFinal.height)
        canvas.style.width   = '100%'
        canvas.style.display = 'block'
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vpFinal }).promise
        page.cleanup()
        cell.querySelector('.org-thumb-canvas-wrap > div')?.replaceWith(canvas)
      } catch {}
    }

    // Paint any unrendered cells currently in (or near) the import grid viewport
    function paintVisibleImportThumbs() {
      if (!importRenderDoc) return
      const gridRect = importGrid.getBoundingClientRect()
      const buffer   = 500  // px ahead to pre-render
      importGrid.querySelectorAll('.org-thumb:not([data-rendered])').forEach(cell => {
        const r = cell.getBoundingClientRect()
        if (r.top < gridRect.bottom + buffer && r.bottom > gridRect.top - buffer) {
          cell.dataset.rendered = '1'
          renderOneImportThumb(cell)
        }
      })
    }

    function renderImportGrid() {
      // Remove old scroll listener
      if (importGrid._scrollPaint) {
        importGrid.removeEventListener('scroll', importGrid._scrollPaint)
        delete importGrid._scrollPaint
      }

      importGrid.innerHTML = ''
      importSlots.forEach((slot, i) => {
        const cell      = document.createElement('div')
        cell.className  = 'org-thumb' + (importSel.has(slot.id) ? ' selected' : '')
        cell.dataset.si = i

        const wrap = document.createElement('div')
        wrap.className = 'org-thumb-canvas-wrap'
        const ph = document.createElement('div')
        ph.className = 'org-thumb-placeholder'
        wrap.appendChild(ph)

        const label = document.createElement('div')
        label.className = 'org-thumb-label'
        const numSpan = document.createElement('span')
        numSpan.className   = 'org-thumb-num'
        numSpan.textContent = String(i + 1)
        label.appendChild(numSpan)

        cell.appendChild(wrap)
        cell.appendChild(label)
        importGrid.appendChild(cell)

        cell.addEventListener('click', e => {
          const id = slot.id
          if (e.shiftKey && importLastClickI !== null) {
            const lo = Math.min(i, importLastClickI)
            const hi = Math.max(i, importLastClickI)
            for (let j = lo; j <= hi; j++) importSel.add(importSlots[j].id)
          } else if (e.ctrlKey || e.metaKey) {
            importSel.has(id) ? importSel.delete(id) : importSel.add(id)
            importLastClickI = i
          } else {
            const wasSelected = importSel.has(id) && importSel.size === 1
            importSel.clear()
            if (!wasSelected) importSel.add(id)
            importLastClickI = wasSelected ? null : i
          }
          // Sync highlights
          importGrid.querySelectorAll('.org-thumb').forEach(c => {
            const s = importSlots[parseInt(c.dataset.si)]
            c.classList.toggle('selected', s ? importSel.has(s.id) : false)
          })
          updateImportConfirm()
        })

      })

      // Wire scroll-based lazy rendering and paint initially-visible thumbs
      importGrid._scrollPaint = paintVisibleImportThumbs
      importGrid.addEventListener('scroll', importGrid._scrollPaint)
      // Small delay so the grid has laid out before we measure offsetTop
      requestAnimationFrame(paintVisibleImportThumbs)
    }

    container.querySelector('#org-from-pdf').addEventListener('click', () => {
      importInput.value = ''
      importInput.click()
    })

    importInput.addEventListener('change', async e => {
      const file = e.target.files[0]
      if (!file) return
      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(file)
        let doc, pwd = null
        try {
          doc = await pdf.load(bytes)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          pwd = await promptPassword(file.name)
          if (!pwd) return
          showProgress('Decrypting…')
          doc = await pdf.load(bytes, pwd)
        }

        updateProgress('Loading thumbnails…')
        if (importRenderDoc) importRenderDoc.destroy()
        importRenderDoc = await loadForRender(bytes, pwd)
        importDoc = doc

        importSel.clear()
        importNextId = 0
        importLastClickI = null
        importSlots = []
        for (let i = 0; i < doc.getPageCount(); i++) {
          importSlots.push({ id: importNextId++, origIdx: i })
        }

        importName.textContent = file.name
        importName.title       = file.name
        updateImportConfirm()

        importModal.style.display = 'flex'
        renderImportGrid()
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })

    function closeImportModal() {
      importModal.style.display = 'none'
    }

    container.querySelector('#org-import-cancel').addEventListener('click', closeImportModal)
    importModal.addEventListener('click', e => {
      if (e.target === importModal) closeImportModal()
    })

    container.querySelector('#org-import-sel-all').addEventListener('click', () => {
      importSlots.forEach(s => importSel.add(s.id))
      importGrid.querySelectorAll('.org-thumb').forEach(c => c.classList.add('selected'))
      updateImportConfirm()
    })
    container.querySelector('#org-import-sel-none').addEventListener('click', () => {
      importSel.clear()
      importGrid.querySelectorAll('.org-thumb').forEach(c => c.classList.remove('selected'))
      updateImportConfirm()
    })

    importConfirm.addEventListener('click', () => {
      if (!importDoc || importSel.size === 0) return

      // Register the import doc as a new source (or reuse if same doc already added)
      const srcIdx = sources.length
      sources.push({ doc: importDoc, renderDoc: importRenderDoc, name: importName.textContent })
      // Prevent the modal from destroying these — clear local refs
      importDoc       = null
      importRenderDoc = null

      // Determine insert position
      const posMode  = container.querySelector('input[name="org-import-pos"]:checked').value
      const selIdxs  = selectedIndices()
      const insertAt = posMode === 'end'
        ? slots.length
        : (selIdxs.length ? selIdxs[selIdxs.length - 1] + 1 : slots.length)

      // Build new slots for the selected import pages (in their original order)
      const orderedImport = importSlots
        .filter(s => importSel.has(s.id))
        .map(s => ({ id: nextId++, srcIdx, origIdx: s.origIdx, extraRotation: 0 }))

      slots.splice(insertAt, 0, ...orderedImport)

      // Select the new pages
      sel.clear()
      orderedImport.forEach(s => sel.add(s.id))

      updatePageCountLabel()
      renderGrid()
      updateSelCount()
      updateSaveHint()

      setTimeout(() => {
        gridEl.querySelector(`.org-thumb[data-si="${insertAt}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 50)

      toast(`${orderedImport.length} page${orderedImport.length !== 1 ? 's' : ''} imported.`, 'success')
      closeImportModal()
    })

    // ── Save ──────────────────────────────────────────────────────────────────
    container.querySelector('#org-save').addEventListener('click', async () => {
      if (!sources[0]) return
      const outputName = ensurePdf(
        container.querySelector('#org-output-name').value.trim() ||
        stripExt(sources[0].name) + '_organised'
      )

      showProgress('Applying changes…')
      try {
        // Build output by copying each slot's page from its respective source doc
        const outDoc = await PDFDocument.create()

        // Group consecutive slots by source to batch copyPages calls
        for (let i = 0; i < slots.length; i++) {
          const slot      = slots[i]
          const srcDoc    = sources[slot.srcIdx].doc
          const [copied]  = await outDoc.copyPages(srcDoc, [slot.origIdx])
          outDoc.addPage(copied)
        }

        // Apply extra rotations (index in outDoc = index in slots)
        slots.forEach((slot, i) => {
          if (slot.extraRotation) pdf.rotatePages(outDoc, [i], slot.extraRotation)
        })

        updateProgress('Saving…')
        const bytes = await pdf.save(outDoc)
        await saveAs(bytes, outputName)
        toast(
          `Saved ${slots.length} page${slots.length !== 1 ? 's' : ''} → ${outputName}`,
          'success',
        )
      } catch (err) {
        if (err.name !== 'AbortError') toast('Save failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })
  },
})
