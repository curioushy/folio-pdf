/**
 * Merge feature — combine multiple PDFs, with optional page picking per source.
 */

import { registerFeature } from '../core/registry.js'
import { get } from '../core/state.js'
import { readHandle, readFile, saveAs, writeToWorkspace } from '../core/fs.js'
import * as pdf from '../core/pdf.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword, pickFromWorkspace } from '../core/ui.js'
import { parsePageRange, stripExt, ensurePdf } from '../core/utils.js'

registerFeature({
  id:          'merge',
  name:        'Merge PDFs',
  category:    'Multi-file',
  icon:        '⊕',
  description: 'Combine multiple PDFs into one document',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Merge PDFs</h2>
        <p class="feature-desc">Combine multiple PDFs into one. Drag rows to reorder.</p>
      </div>

      <div class="feature-split">

        <!-- ── SOURCE PANEL ────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">① Source files</span>
            <span id="merge-count" class="status-text">0 files</span>
          </div>

          <div class="file-drop-zone" id="merge-drop">
            <span>Drag PDFs here, or</span>
            <button class="btn btn-sm" id="merge-from-workspace">From folder</button>
            <button class="btn btn-sm" id="merge-browse">Browse</button>
            <input type="file" id="merge-file-input" accept=".pdf" multiple hidden>
          </div>

          <div id="merge-file-list" class="file-list file-list-scroll"></div>
        </div>

        <!-- ── TARGET PANEL ────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">② Output</span>
          </div>

          <div class="option-row">
            <label>Filename</label>
            <input type="text" id="merge-output-name" class="input" value="merged.pdf">
          </div>

          <div class="option-row" style="align-items:flex-start;">
            <label style="padding-top:7px;">Save to</label>
            <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
              <div style="display:flex;gap:6px;">
                <button class="btn btn-sm" id="merge-pick-dir" style="flex:1;">📁 Pick folder…</button>
                <button class="btn btn-sm" id="merge-clear-dir" style="display:none;">Clear</button>
              </div>
              <span id="merge-save-dir-label" style="font-size:11.5px;color:var(--text-muted);font-family:var(--font-mono);word-break:break-all;">Save As dialog (default)</span>
            </div>
          </div>

          <div style="border-top:1px solid var(--border);margin:14px 0;"></div>

          <div class="section-label">Options</div>
          <label class="option-row" style="align-items:flex-start;">
            <input type="checkbox" id="merge-bookmarks" checked style="margin-top:2px;">
            <span style="flex:1;">Add bookmark for each source file<br>
              <small>Creates a clickable outline in the merged PDF</small>
            </span>
          </label>

          <div style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="merge-run" disabled style="width:100%;justify-content:center;">Merge PDFs</button>
            <div class="status-text" id="merge-status" style="text-align:center;margin-top:8px;">Add at least 2 PDFs to merge.</div>
          </div>
        </div>

      </div>
    `

    // Local list of files queued for merging
    // { id, name, path?, handle?, file?, password?, pageRange? }
    const queue = []
    let dragSrcIdx  = null
    let targetDir   = null   // FileSystemDirectoryHandle — if set, save directly here

    const listEl    = container.querySelector('#merge-file-list')
    const runBtn    = container.querySelector('#merge-run')
    const statusEl  = container.querySelector('#merge-status')
    const countEl   = container.querySelector('#merge-count')
    const dirLabel  = container.querySelector('#merge-save-dir-label')
    const clearBtn  = container.querySelector('#merge-clear-dir')

    // ── Target directory picker ──────────────────────────────────────────────
    container.querySelector('#merge-pick-dir').addEventListener('click', async () => {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
        targetDir = handle
        dirLabel.textContent = handle.name + '/'
        clearBtn.style.display = 'inline-flex'
      } catch (err) {
        if (err.name !== 'AbortError') toast('Could not open folder: ' + err.message, 'error')
      }
    })

    clearBtn.addEventListener('click', () => {
      targetDir = null
      dirLabel.textContent = 'Save As dialog (default)'
      clearBtn.style.display = 'none'
    })

    // ── Render list ──────────────────────────────────────────────────────────
    function renderList() {
      if (!queue.length) {
        listEl.innerHTML = '<div class="empty-hint">No files added yet.</div>'
      } else {
        listEl.innerHTML = queue.map((f, i) => `
          <div class="file-row" draggable="true" data-idx="${i}">
            <span class="drag-handle" title="Drag to reorder">⠿</span>
            <span class="file-name" title="${f.path ?? f.name}">${f.name}</span>
            ${f.pageRange ? `<span class="badge badge-blue" title="Page filter">pp. ${f.pageRange}</span>` : ''}
            ${f.password  ? `<span class="badge" title="Password set">🔒</span>` : ''}
            <button class="btn btn-sm" data-action="pages"    data-idx="${i}" title="Select specific pages">Pages</button>
            <button class="btn btn-sm" data-action="password" data-idx="${i}" title="Set password for encrypted PDF">🔑</button>
            <button class="btn-icon"   data-action="remove"   data-idx="${i}" title="Remove">✕</button>
          </div>
        `).join('')
        attachDragHandlers()
      }

      runBtn.disabled  = queue.length < 2
      countEl.textContent = `${queue.length} file${queue.length !== 1 ? 's' : ''}`
      statusEl.textContent = queue.length < 2
        ? 'Add at least 2 PDFs to merge.'
        : `Ready to merge ${queue.length} files.`
    }

    // ── Drag-to-reorder ──────────────────────────────────────────────────────
    function attachDragHandlers() {
      listEl.querySelectorAll('.file-row').forEach(row => {
        row.addEventListener('dragstart', e => {
          dragSrcIdx = parseInt(row.dataset.idx)
          row.classList.add('dragging')
          e.dataTransfer.effectAllowed = 'move'
        })
        row.addEventListener('dragend',  () => row.classList.remove('dragging'))
        row.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' })
        row.addEventListener('drop',     e => {
          e.preventDefault()
          const targetIdx = parseInt(row.dataset.idx)
          if (dragSrcIdx === null || dragSrcIdx === targetIdx) return
          const [moved] = queue.splice(dragSrcIdx, 1)
          queue.splice(targetIdx, 0, moved)
          dragSrcIdx = null
          renderList()
        })
      })
    }

    // ── List click actions ───────────────────────────────────────────────────
    listEl.addEventListener('click', e => {
      const { action, idx } = e.target.dataset
      if (!action) return
      const i = parseInt(idx)

      if (action === 'remove') {
        queue.splice(i, 1)
        renderList()
      }

      if (action === 'password') {
        promptPassword(queue[i].name).then(pwd => {
          // null = cancel → leave unchanged; '' = clear; string = set
          if (pwd === null) return
          queue[i].password = pwd || undefined
          renderList()
        })
      }

      if (action === 'pages') {
        const current = queue[i].pageRange ?? ''
        const wrap = document.createElement('div')
        wrap.innerHTML = `
          <p style="font-size:13px;margin-bottom:12px;">
            Enter pages for <strong>${queue[i].name}</strong>.<br>
            <small>Examples: <code>1-3</code> &nbsp;·&nbsp; <code>1,3,5</code> &nbsp;·&nbsp; <code>1-3,7,10-12</code> &nbsp;·&nbsp; leave blank for all pages</small>
          </p>
          <input type="text" id="page-range-input" class="input" value="${current}" placeholder="e.g. 1-3, 5, 8-10">
        `
        import('../core/ui.js').then(({ modal }) => {
          modal({
            title: 'Select pages',
            content: wrap,
            actions: [
              { label: 'Clear (all pages)', variant: 'secondary', value: '' },
              { label: 'Apply',             variant: 'primary',   value: '__apply__' },
            ],
          }).then(result => {
            if (result === '__apply__') {
              queue[i].pageRange = document.getElementById('page-range-input')?.value.trim() || ''
            } else if (result === '') {
              queue[i].pageRange = ''
            }
            renderList()
          })
        })
      }
    })

    // ── Add from workspace ───────────────────────────────────────────────────
    container.querySelector('#merge-from-workspace').addEventListener('click', async () => {
      const { scannedFiles } = get()
      if (!scannedFiles.length) {
        toast('No folder open or no PDFs found. Use "Open folder" in the top bar.', 'warning')
        return
      }
      const indices = await pickFromWorkspace(scannedFiles)
      indices.forEach(i => {
        const f = scannedFiles[i]
        if (!queue.find(q => q.path === f.path)) {
          queue.push({ id: f.path, name: f.name, path: f.path, handle: f.handle, source: 'workspace' })
        }
      })
      renderList()
    })

    // ── Browse local files ───────────────────────────────────────────────────
    const fileInput = container.querySelector('#merge-file-input')
    container.querySelector('#merge-browse').addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', e => {
      Array.from(e.target.files).forEach(file => {
        queue.push({ id: file.name + Date.now(), name: file.name, file, source: 'local' })
      })
      renderList()
      fileInput.value = ''
    })

    // ── Drag-and-drop onto drop zone ─────────────────────────────────────────
    const dropZone = container.querySelector('#merge-drop')
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault()
      dropZone.classList.remove('drag-over')
      Array.from(e.dataTransfer.files)
        .filter(f => f.name.toLowerCase().endsWith('.pdf'))
        .forEach(file => queue.push({ id: file.name + Date.now(), name: file.name, file, source: 'local' }))
      renderList()
    })

    // ── Run merge ────────────────────────────────────────────────────────────
    container.querySelector('#merge-run').addEventListener('click', async () => {
      const outputName   = ensurePdf(container.querySelector('#merge-output-name').value.trim() || 'merged')
      const addBookmarks = container.querySelector('#merge-bookmarks').checked

      showProgress('Loading files…')
      try {
        const sources = []

        for (const entry of queue) {
          updateProgress(`Loading ${entry.name}…`)
          let bytes
          if (entry.source === 'workspace') {
            bytes = await readHandle(entry.handle)
          } else {
            bytes = await readFile(entry.file)
          }

          const doc = await loadWithPasswordRetry(bytes, entry)
          if (!doc) continue  // user cancelled or gave up

          // Parse page range if specified
          let pages = doc.getPageIndices()
          if (entry.pageRange) {
            pages = parsePageRange(entry.pageRange, doc.getPageCount())
            if (!pages.length) {
              toast(`Invalid page range for ${entry.name} — using all pages`, 'warning')
              pages = doc.getPageIndices()
            }
          }

          sources.push({ doc, pages, name: entry.name })
        }

        if (sources.length < 2) {
          toast('Need at least 2 successfully loaded files to merge.', 'warning')
          return
        }

        // Compute the starting page index of each source in the output doc
        // — needed for bookmarks. sources[0] starts at 0, sources[1] at len(sources[0].pages), etc.
        const pageStarts = []
        let running = 0
        for (const s of sources) {
          pageStarts.push(running)
          running += s.pages.length
        }

        updateProgress('Merging…')
        const merged = await pdf.mergePages(sources)

        if (addBookmarks) {
          pdf.setOutline(
            merged,
            sources.map((s, i) => ({
              title:     s.name.replace(/\.pdf$/i, ''),
              pageIndex: pageStarts[i],
            })),
          )
          // Nice document title too, purely cosmetic
          merged.setTitle(sources.map(s => s.name.replace(/\.pdf$/i, '')).join(' + '))
        }

        updateProgress('Saving…')
        const bytes = await pdf.save(merged)
        if (targetDir) {
          await writeToWorkspace(targetDir, outputName, bytes)
          toast(`Merged ${sources.length} files → ${targetDir.name}/${outputName}`, 'success')
        } else {
          await saveAs(bytes, outputName)
          toast(`Merged ${sources.length} files → ${outputName}`, 'success')
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Merge failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    })

    /**
     * Load a PDF, prompting inline for a password on encrypted sources.
     * - If entry.password is already set, tries that first (silent).
     * - On ENCRYPTED/WRONG_PASSWORD, prompts up to 3 times, caching the
     *   successful password back on the queue entry so re-runs don't re-ask.
     * - Returns the loaded PDFDocument, or null if the user gave up.
     *
     * Note: unlike the Password feature, we don't fall back to the image-render
     * path here. Merging 100 pages of re-rendered JPEGs would produce a huge
     * file and lose text. If native decrypt can't handle the cipher, we ask
     * the user to unlock it in the Password tab first.
     */
    async function loadWithPasswordRetry(bytes, entry) {
      // First attempt: no password (or the cached one)
      try {
        return await pdf.load(bytes, entry.password || null)
      } catch (err) {
        if (err.code !== 'ENCRYPTED' && err.code !== 'WRONG_PASSWORD') throw err
      }

      // Prompt loop — give the user a few shots before skipping the file
      for (let attempt = 0; attempt < 3; attempt++) {
        hideProgress()
        const pwd = await promptPassword(entry.name)
        if (pwd === null) return null                    // cancel → skip file
        if (!pwd)         { toast('Password required.', 'warning'); continue }

        showProgress(`Unlocking ${entry.name}…`)
        try {
          const doc = await pdf.load(bytes, pwd)
          entry.password = pwd                           // cache for re-runs
          renderList()
          return doc
        } catch (err) {
          if (err.code === 'WRONG_PASSWORD') {
            toast(`Wrong password for ${entry.name}.`, 'warning')
            continue
          }
          throw err
        }
      }

      toast(
        `Skipped ${entry.name} — could not unlock after 3 tries. ` +
        `If the cipher is unusual, unlock it in the Password tab first.`,
        'error', 6000,
      )
      return null
    }

    renderList()
  },
})

