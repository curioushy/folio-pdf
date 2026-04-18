/**
 * Rotate Pages — rotate individual pages or the whole document.
 *
 * Uses pdf-lib's page.setRotation(degrees(n)) which sets the /Rotate entry
 * in the page dictionary. All PDF viewers honour it correctly.
 *
 * UI: thumbnail grid, click to select pages, then rotate buttons.
 * Shift-click selects a range; Ctrl/Cmd-click toggles individual pages.
 */

import { registerFeature }                                          from '../core/registry.js'
import { readFile, saveAs }                                         from '../core/fs.js'
import * as pdf                                                     from '../core/pdf.js'
import { loadForRender, buildThumbnailGrid }                        from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt }                                                 from '../core/utils.js'

registerFeature({
  id:          'rotate',
  name:        'Rotate Pages',
  category:    'Pages',
  icon:        '↻',
  description: 'Rotate individual pages or the whole document by 90°, 180° or 270°',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Rotate Pages</h2>
        <p class="feature-desc">
          Select pages in the grid below, then use the rotate buttons.
          Click a thumbnail to select · Shift-click for a range · Ctrl/⌘-click to toggle.
        </p>
      </div>

      <div class="feature-split" style="margin-bottom:10px;">

        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">① Open PDF</span>
            <span id="rot-page-count" class="status-text"></span>
          </div>
          <div class="file-drop-zone" id="rot-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="rot-browse">Browse</button>
            <input type="file" id="rot-input" accept=".pdf" hidden>
          </div>
          <div id="rot-filename" class="file-name-display"></div>
        </div>

        <div class="panel">
          <div class="panel-header"><span class="panel-title">② Rotate &amp; Save</span></div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;" id="rot-btns">
            <button class="btn" id="rot-sel-all"  disabled>Select All</button>
            <button class="btn" id="rot-sel-none" disabled>Deselect All</button>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
            <button class="btn btn-primary" id="rot-ccw" disabled title="Rotate selected 90° counter-clockwise">↺ 90° CCW</button>
            <button class="btn btn-primary" id="rot-cw"  disabled title="Rotate selected 90° clockwise">↻ 90° CW</button>
            <button class="btn btn-primary" id="rot-180" disabled title="Rotate selected 180°">⤢ 180°</button>
          </div>

          <div class="status-text" id="rot-sel-status" style="margin-bottom:14px;">Load a PDF to get started.</div>

          <button class="btn btn-primary btn-lg" id="rot-save" disabled style="width:100%;justify-content:center;">
            Save Rotated PDF
          </button>
        </div>

      </div>

      <!-- Thumbnail grid -->
      <div class="panel" id="rot-grid-panel" style="display:none;">
        <div class="panel-header"><span class="panel-title">Pages</span></div>
        <div id="rot-grid" class="split-thumbs" style="display:flex;flex-wrap:wrap;gap:10px;padding:4px;"></div>
      </div>
    `

    let srcFile  = null
    let pdfDoc   = null   // pdf-lib doc
    let rDoc     = null   // PDF.js doc (for thumbnails)
    let totalPages = 0
    let selected = new Set()   // 0-based indices
    let lastClicked = -1

    const countEl    = container.querySelector('#rot-page-count')
    const nameEl     = container.querySelector('#rot-filename')
    const selStatus  = container.querySelector('#rot-sel-status')
    const gridPanel  = container.querySelector('#rot-grid-panel')
    const gridEl     = container.querySelector('#rot-grid')
    const saveBtn    = container.querySelector('#rot-save')

    const setRotBtnsDisabled = v => {
      ;['#rot-ccw','#rot-cw','#rot-180','#rot-sel-all','#rot-sel-none','#rot-save']
        .forEach(id => { container.querySelector(id).disabled = v })
    }

    function updateSelStatus() {
      const n = selected.size
      selStatus.textContent = n
        ? `${n} of ${totalPages} page${totalPages > 1 ? 's' : ''} selected`
        : 'No pages selected — click thumbnails to select.'
      container.querySelector('#rot-ccw').disabled = n === 0
      container.querySelector('#rot-cw').disabled  = n === 0
      container.querySelector('#rot-180').disabled  = n === 0
    }

    function syncGridSelection() {
      gridEl.querySelectorAll('.split-thumb').forEach(el => {
        el.classList.toggle('selected', selected.has(parseInt(el.dataset.page) - 1))
      })
      updateSelStatus()
    }

    async function loadFile(file) {
      srcFile = file
      nameEl.textContent = file.name

      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(file)

        // Load pdf-lib doc
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

        // Load PDF.js doc for thumbnails
        if (rDoc) rDoc.destroy()
        rDoc = await loadForRender(bytes)
        totalPages = pdfDoc.getPageCount()
        countEl.textContent = `${totalPages} page${totalPages > 1 ? 's' : ''}`

        selected.clear()
        lastClicked = -1
        setRotBtnsDisabled(false)
        container.querySelector('#rot-ccw').disabled = true
        container.querySelector('#rot-cw').disabled  = true
        container.querySelector('#rot-180').disabled  = true
        updateSelStatus()
        saveBtn.disabled = false
        gridPanel.style.display = ''

        // Build thumbnail grid
        buildThumbnailGrid(rDoc, totalPages, gridEl, {
          thumbWidth: 120,
          onPageClick: (page0, el) => {
            // page0 is 0-based
          },
        })

        // Attach our own click handler for selection (override the one in buildThumbnailGrid)
        gridEl.addEventListener('click', e => {
          const thumb = e.target.closest('.split-thumb')
          if (!thumb) return
          const p0 = parseInt(thumb.dataset.page) - 1

          if (e.shiftKey && lastClicked >= 0) {
            const lo = Math.min(lastClicked, p0)
            const hi = Math.max(lastClicked, p0)
            for (let i = lo; i <= hi; i++) selected.add(i)
          } else if (e.ctrlKey || e.metaKey) {
            selected.has(p0) ? selected.delete(p0) : selected.add(p0)
          } else {
            if (selected.size === 1 && selected.has(p0)) {
              selected.clear()
            } else {
              selected.clear()
              selected.add(p0)
            }
          }
          lastClicked = p0
          syncGridSelection()
        })

      } catch (err) {
        console.error(err)
        toast('Failed to load PDF: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    // Drop zone
    const dropZone = container.querySelector('#rot-drop')
    const input    = container.querySelector('#rot-input')
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) loadFile(f)
    })
    container.querySelector('#rot-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => {
      if (e.target.files[0]) { loadFile(e.target.files[0]); input.value = '' }
    })

    // Select all / none
    container.querySelector('#rot-sel-all').addEventListener('click', () => {
      for (let i = 0; i < totalPages; i++) selected.add(i)
      syncGridSelection()
    })
    container.querySelector('#rot-sel-none').addEventListener('click', () => {
      selected.clear()
      syncGridSelection()
    })

    // Rotate buttons — modify pdfDoc in place
    function applyRotation(angle) {
      if (!pdfDoc || selected.size === 0) return
      pdf.rotatePages(pdfDoc, [...selected], angle)
      // Re-render thumbnails for affected pages
      gridEl.querySelectorAll('.split-thumb').forEach(el => {
        const p0 = parseInt(el.dataset.page) - 1
        if (!selected.has(p0)) return
        // Flash to indicate change
        el.style.outline = '2px solid var(--accent)'
        setTimeout(() => { el.style.outline = '' }, 600)
      })
      toast(`Rotated ${selected.size} page${selected.size > 1 ? 's' : ''} by ${angle}°`, 'info', 2000)
    }

    container.querySelector('#rot-ccw').addEventListener('click', () => applyRotation(270))
    container.querySelector('#rot-cw').addEventListener('click',  () => applyRotation(90))
    container.querySelector('#rot-180').addEventListener('click', () => applyRotation(180))

    // Save
    container.querySelector('#rot-save').addEventListener('click', async () => {
      if (!pdfDoc) return
      showProgress('Saving…')
      try {
        const outBytes = await pdf.save(pdfDoc)
        const outName  = srcFile.name.replace(/\.pdf$/i, '_rotated.pdf')
        await saveAs(outBytes, outName)
        toast(`Saved → ${outName}`, 'success')
      } catch (err) {
        console.error(err)
        toast('Failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })
  },
})
