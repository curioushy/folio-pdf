/**
 * Bookmarks feature — view, add, edit, and delete PDF bookmarks (outline / TOC).
 *
 * Displays the existing outline from a PDF, lets the user:
 *   - See each bookmark title and its target page
 *   - Double-click a title to rename it inline
 *   - Delete individual bookmarks
 *   - Add new top-level bookmarks (page number + title)
 *   - Save the modified PDF with an updated flat outline
 *
 * Nesting beyond the first level is preserved for display only.
 * All bookmarks are written back as flat top-level entries on save
 * (a deliberate simplification to avoid corrupted nested refs).
 */

import { registerFeature }   from '../core/registry.js'
import { readFile, saveAs }  from '../core/fs.js'
import * as pdf              from '../core/pdf.js'
import * as renderer         from '../core/renderer.js'
import { PDFName, PDFString, PDFNumber } from '@cantoo/pdf-lib'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, ensurePdf } from '../core/utils.js'
import { get }                 from '../core/state.js'

registerFeature({
  id:          'bookmarks',
  name:        'Bookmarks',
  category:    'Tools',
  icon:        '🔖',
  description: 'View, edit, add and delete PDF bookmarks (table of contents)',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Bookmarks</h2>
        <p class="feature-desc">
          View, rename, delete, and add bookmarks in a PDF.
          Double-click any title to rename it inline.
        </p>
      </div>

      <div class="feature-split">

        <!-- ── Source ─────────────────────────────────────────────────────── -->
        <div class="panel" style="display:flex;flex-direction:column;">
          <div class="panel-header">
            <span class="panel-title">① Source PDF</span>
            <button class="btn btn-sm" id="bm-change" style="display:none;">⇄ Change</button>
          </div>

          <div class="file-drop-zone" id="bm-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="bm-browse">Browse</button>
            <input type="file" id="bm-input" accept=".pdf" hidden>
          </div>

          <div id="bm-file-info" style="display:none;">
            <div id="bm-filename" class="file-name-display"></div>
            <div class="status-text" id="bm-page-count" style="margin-top:4px;"></div>
          </div>

          <!-- ── Add bookmark ─────────────────────────────────────────────── -->
          <div id="bm-add-section" style="display:none;margin-top:16px;">
            <div class="section-label">Add bookmark</div>
            <div class="option-row" style="gap:8px;flex-wrap:wrap;">
              <input type="number" id="bm-add-page" class="input"
                placeholder="Page" min="1" style="width:80px;flex-shrink:0;">
              <input type="text"   id="bm-add-title" class="input"
                placeholder="Bookmark title" style="flex:1;min-width:120px;">
              <button class="btn btn-sm btn-primary" id="bm-add-btn">Add</button>
            </div>
            <div class="status-text" id="bm-add-status" style="margin-top:4px;min-height:16px;"></div>
          </div>
        </div>

        <!-- ── Bookmark tree + actions ─────────────────────────────────────── -->
        <div class="panel" style="display:flex;flex-direction:column;">
          <div class="panel-header">
            <span class="panel-title">② Bookmarks</span>
            <span class="status-text" id="bm-count"></span>
          </div>

          <div id="bm-placeholder" class="empty-hint" style="margin-top:32px;">
            Load a PDF to view its bookmarks.
          </div>

          <!-- Scrollable bookmark list -->
          <div id="bm-tree"
            style="flex:1;overflow-y:auto;min-height:200px;max-height:480px;
                   border:1px solid var(--border);border-radius:var(--radius-sm);
                   display:none;">
          </div>

          <div id="bm-actions" style="display:none;margin-top:14px;">
            <div class="option-row">
              <label>Output filename</label>
              <input type="text" id="bm-output" class="input"
                placeholder="output.pdf" style="flex:1;">
            </div>
            <div class="action-bar" style="margin-top:10px;">
              <button class="btn btn-primary btn-lg" id="bm-save" disabled
                style="flex:1;justify-content:center;">Save PDF</button>
            </div>
            <div class="status-text" id="bm-status" style="text-align:center;margin-top:8px;"></div>
          </div>

        </div>
      </div>
    `

    // ── State ────────────────────────────────────────────────────────────────
    let srcFile   = null
    let srcPwd    = null
    let pdfDoc    = null   // pdf-lib PDFDocument
    let rDoc      = null   // PDF.js PDFDocumentProxy
    let totalPages = 0
    let dirty      = false  // any edits made

    // Flat array — each item is {title: string, pageNum: number (1-based)}
    // Nesting beyond level-0 is shown with visual indent but stored flat.
    let bookmarks = []

    // ── DOM refs ─────────────────────────────────────────────────────────────
    const dropZone    = container.querySelector('#bm-drop')
    const fileInput   = container.querySelector('#bm-input')
    const changeBtn   = container.querySelector('#bm-change')
    const fileInfoEl  = container.querySelector('#bm-file-info')
    const filenameEl  = container.querySelector('#bm-filename')
    const pageCountEl = container.querySelector('#bm-page-count')
    const addSection  = container.querySelector('#bm-add-section')
    const addPageEl   = container.querySelector('#bm-add-page')
    const addTitleEl  = container.querySelector('#bm-add-title')
    const addBtn      = container.querySelector('#bm-add-btn')
    const addStatusEl = container.querySelector('#bm-add-status')
    const placeholder = container.querySelector('#bm-placeholder')
    const treeEl      = container.querySelector('#bm-tree')
    const countEl     = container.querySelector('#bm-count')
    const actionsEl   = container.querySelector('#bm-actions')
    const outputEl    = container.querySelector('#bm-output')
    const saveBtn     = container.querySelector('#bm-save')
    const statusEl    = container.querySelector('#bm-status')

    // ── Drop zone wiring ─────────────────────────────────────────────────────
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) loadFile(f)
    })
    container.querySelector('#bm-browse').addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) { loadFile(e.target.files[0]); fileInput.value = '' }
    })
    changeBtn.addEventListener('click', () => fileInput.click())

    // ── Load file ─────────────────────────────────────────────────────────────
    async function loadFile(file, initialPwd = null) {
      showProgress('Loading PDF…')
      try {
        rDoc?.destroy()
        rDoc = null

        const bytes = await readFile(file)
        let doc, rdoc, pwd = initialPwd
        try {
          doc  = await pdf.load(bytes, pwd || undefined)
          rdoc = await renderer.loadForRender(bytes, pwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          pwd = await promptPassword(file.name)
          if (!pwd) return
          showProgress('Decrypting…')
          doc  = await pdf.load(bytes, pwd)
          rdoc = await renderer.loadForRender(bytes, pwd)
        }

        srcPwd     = pwd
        srcFile    = file
        pdfDoc     = doc
        rDoc       = rdoc
        totalPages = doc.getPageCount()
        dirty      = false

        // ── Read outline via PDF.js ──────────────────────────────────────────
        updateProgress('Reading bookmarks…')
        const outline = await rDoc.getOutline()
        bookmarks = await flattenOutline(outline || [], rDoc)

        // ── Update UI ────────────────────────────────────────────────────────
        filenameEl.textContent = file.name
        pageCountEl.textContent = `${totalPages} page${totalPages !== 1 ? 's' : ''}`
        outputEl.value = stripExt(file.name) + '_bookmarks.pdf'
        addPageEl.max  = String(totalPages)

        dropZone.style.display   = 'none'
        fileInfoEl.style.display = 'block'
        addSection.style.display = 'block'
        actionsEl.style.display  = 'block'
        changeBtn.style.display  = 'inline-flex'
        placeholder.style.display = 'none'

        renderTree()
        updateSaveBtn()
        toast(`Loaded: ${bookmarks.length} bookmark${bookmarks.length !== 1 ? 's' : ''}`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    // ── Flatten outline recursively to a flat array with display levels ──────
    async function flattenOutline(items, pdfJsDoc, level = 0) {
      const result = []
      for (const item of items) {
        let pageNum = null
        if (item.dest) {
          pageNum = await destToPageNum(pdfJsDoc, item.dest)
        }
        result.push({
          title:   item.title || '(Untitled)',
          pageNum: pageNum ?? 1,
          level,
        })
        if (item.items && item.items.length > 0) {
          const children = await flattenOutline(item.items, pdfJsDoc, level + 1)
          result.push(...children)
        }
      }
      return result
    }

    // ── Resolve a PDF.js outline dest → 1-based page number ─────────────────
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

    // ── Render the bookmark tree ─────────────────────────────────────────────
    function renderTree() {
      if (bookmarks.length === 0) {
        treeEl.style.display = 'none'
        placeholder.style.display = 'block'
        placeholder.textContent   = 'No bookmarks found. Use the "Add bookmark" section above to create one.'
        countEl.textContent = '0 bookmarks'
        return
      }

      placeholder.style.display = 'none'
      treeEl.style.display      = 'block'
      countEl.textContent       = `${bookmarks.length} bookmark${bookmarks.length !== 1 ? 's' : ''}`

      treeEl.innerHTML = bookmarks.map((bm, idx) => {
        const indent = bm.level * 18
        return `
          <div class="bm-row" data-idx="${idx}"
            style="display:flex;align-items:center;gap:6px;
                   padding:6px 10px 6px ${10 + indent}px;
                   border-bottom:1px solid var(--border);
                   cursor:default;">
            <span class="bm-title"
              title="Double-click to rename"
              data-idx="${idx}"
              style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;
                     white-space:nowrap;cursor:text;">
              ${escHtml(bm.title)}
            </span>
            <span style="font-size:11px;color:var(--text-muted);
                         background:var(--bg-subtle);padding:2px 6px;
                         border-radius:var(--radius-sm);flex-shrink:0;white-space:nowrap;">
              p.${bm.pageNum}
            </span>
            <button class="btn-icon bm-delete" data-idx="${idx}"
              title="Delete bookmark" style="flex-shrink:0;">✕</button>
          </div>
        `
      }).join('')

      // ── Delete buttons ───────────────────────────────────────────────────
      treeEl.querySelectorAll('.bm-delete').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation()
          const idx = parseInt(btn.dataset.idx)
          bookmarks.splice(idx, 1)
          dirty = true
          renderTree()
          updateSaveBtn()
        })
      })

      // ── Double-click to rename inline ────────────────────────────────────
      treeEl.querySelectorAll('.bm-title').forEach(span => {
        span.addEventListener('dblclick', e => {
          const idx = parseInt(span.dataset.idx)
          startInlineEdit(span, idx)
        })
      })
    }

    // ── Inline title editing ─────────────────────────────────────────────────
    function startInlineEdit(span, idx) {
      const original = bookmarks[idx].title
      const input = document.createElement('input')
      input.type      = 'text'
      input.value     = original
      input.className = 'input'
      input.style.cssText = 'flex:1;font-size:13px;height:24px;padding:2px 6px;'

      span.replaceWith(input)
      input.select()
      input.focus()

      function commit() {
        const val = input.value.trim()
        if (val && val !== original) {
          bookmarks[idx].title = val
          dirty = true
          updateSaveBtn()
        }
        renderTree()
      }

      input.addEventListener('blur',  commit)
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commit() }
        if (e.key === 'Escape') { input.value = original; renderTree() }
      })
    }

    // ── Add bookmark ─────────────────────────────────────────────────────────
    addBtn.addEventListener('click', () => {
      const title   = addTitleEl.value.trim()
      const pageNum = parseInt(addPageEl.value)

      if (!title) {
        addStatusEl.textContent = 'Please enter a title.'
        addTitleEl.focus()
        return
      }
      if (isNaN(pageNum) || pageNum < 1 || pageNum > totalPages) {
        addStatusEl.textContent = `Page must be between 1 and ${totalPages}.`
        addPageEl.focus()
        return
      }

      bookmarks.push({ title, pageNum, level: 0 })
      dirty = true
      addTitleEl.value       = ''
      addPageEl.value        = ''
      addStatusEl.textContent = `Added "${title}" → p.${pageNum}`
      renderTree()
      updateSaveBtn()
      // Scroll to bottom of tree to show newly added item
      treeEl.scrollTop = treeEl.scrollHeight
    })

    // Allow Enter in the title field to trigger add
    addTitleEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addBtn.click() }
    })

    // ── Save button state ─────────────────────────────────────────────────────
    function updateSaveBtn() {
      saveBtn.disabled = !pdfDoc
    }

    // ── Write flat bookmarks to pdf-lib PDFDocument ───────────────────────────
    async function applyBookmarks(pdfDoc, items) {
      // items: [{title, pageNum (1-based)}]
      const pages = pdfDoc.getPages()

      // Remove existing Outlines from catalog
      pdfDoc.catalog.delete(PDFName.of('Outlines'))

      if (items.length === 0) return

      const outlineRef = pdfDoc.context.nextRef()
      const itemRefs   = items.map(() => pdfDoc.context.nextRef())

      const itemDicts = items.map((item, i) => {
        const pageIdx = Math.max(0, Math.min(pages.length - 1, item.pageNum - 1))
        const pageRef = pdfDoc.getPage(pageIdx).ref
        const dest    = pdfDoc.context.obj([pageRef, PDFName.of('XYZ'), null, null, null])

        const d = pdfDoc.context.obj({
          Title:  PDFString.of(item.title),
          Parent: outlineRef,
          Dest:   dest,
        })
        if (i > 0)               d.set(PDFName.of('Prev'), itemRefs[i - 1])
        if (i < items.length - 1) d.set(PDFName.of('Next'), itemRefs[i + 1])
        return d
      })

      itemDicts.forEach((d, i) => pdfDoc.context.assign(itemRefs[i], d))

      const outlineDict = pdfDoc.context.obj({
        Type:  PDFName.of('Outlines'),
        First: itemRefs[0],
        Last:  itemRefs[itemRefs.length - 1],
        Count: PDFNumber.of(items.length),
      })
      pdfDoc.context.assign(outlineRef, outlineDict)
      pdfDoc.catalog.set(PDFName.of('Outlines'), outlineRef)
    }

    // ── Save PDF ──────────────────────────────────────────────────────────────
    saveBtn.addEventListener('click', async () => {
      if (!pdfDoc) return
      const outName = ensurePdf(outputEl.value.trim() || stripExt(srcFile.name) + '_bookmarks')

      showProgress('Applying bookmarks…')
      try {
        await applyBookmarks(pdfDoc, bookmarks)
        updateProgress('Saving…')
        const bytes = await pdf.save(pdfDoc)
        await saveAs(bytes, outName)
        dirty = false
        statusEl.textContent = `Saved ${bookmarks.length} bookmark${bookmarks.length !== 1 ? 's' : ''}.`
        toast(`Saved → ${outName}`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Save failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    })

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => loadFile(gf.file, gf.pwd), 0)

    // ── Utility ───────────────────────────────────────────────────────────────
    function escHtml(str) {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }
  },
})
