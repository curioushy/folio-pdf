/**
 * Metadata feature — view and edit PDF document properties.
 *
 * Fields covered:
 *   Info dict  : Title, Author, Subject, Keywords, Creator, Language, Creation Date
 *   Catalog    : Page Layout, Page Mode
 *   ViewerPrefs: Display title in titlebar, Fit window, Centre window,
 *                Hide toolbar, Hide menu bar
 *
 *   Read-only display: Producer, File size, Modified date, Page count
 */

import { registerFeature }                                          from '../core/registry.js'
import { readFile, saveAs }                                         from '../core/fs.js'
import * as pdf                                                     from '../core/pdf.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, ensurePdf }                                      from '../core/utils.js'
import { get }                                                      from '../core/state.js'

registerFeature({
  id:          'metadata',
  name:        'Metadata',
  category:    'Tools',
  icon:        'ℹ',
  description: 'View and edit PDF title, author, viewer settings and more',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>PDF Metadata</h2>
        <p class="feature-desc">Read and edit document properties embedded in a PDF.</p>
      </div>

      <div class="feature-split">

        <!-- ── Source + document info ─────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">① Source PDF</span>
            <button class="btn btn-sm" id="meta-change" style="display:none;">⇄ Change</button>
          </div>

          <div class="file-drop-zone" id="meta-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="meta-browse">Browse</button>
            <input type="file" id="meta-input" accept=".pdf" hidden>
          </div>
          <div id="meta-filename" class="file-name-display" style="display:none;"></div>

          <div id="meta-info" style="display:none;">
            <div class="section-label" style="margin-top:14px;">Document info</div>
            <table class="meta-info-table">
              <tr><th>Pages</th>    <td id="mi-pages">—</td></tr>
              <tr><th>File size</th><td id="mi-size">—</td></tr>
              <tr><th>Producer</th> <td id="mi-producer">—</td></tr>
              <tr><th>Modified</th> <td id="mi-modified">—</td></tr>
            </table>
          </div>
        </div>

        <!-- ── Edit fields ────────────────────────────────────────────────── -->
        <div class="panel" style="overflow-y:auto;">
          <div class="panel-header">
            <span class="panel-title">② Properties</span>
          </div>

          <div id="meta-fields" style="opacity:.4;pointer-events:none;">

            <!-- ── Identity ─────────────────────────────────────────────── -->
            <div class="section-label">Identity</div>
            <div class="option-row">
              <label>Title</label>
              <input type="text" id="meta-title"    class="input" placeholder="Document title" style="flex:1;">
            </div>
            <div class="option-row">
              <label>Author</label>
              <input type="text" id="meta-author"   class="input" placeholder="Author name" style="flex:1;">
            </div>
            <div class="option-row">
              <label>Subject</label>
              <input type="text" id="meta-subject"  class="input" placeholder="Subject or description" style="flex:1;">
            </div>
            <div class="option-row">
              <label>Keywords</label>
              <input type="text" id="meta-keywords" class="input" placeholder="comma-separated keywords" style="flex:1;">
            </div>
            <div class="option-row">
              <label>Creator</label>
              <input type="text" id="meta-creator"  class="input" placeholder="Authoring application" style="flex:1;">
            </div>
            <div class="option-row">
              <label>Language</label>
              <input type="text" id="meta-language" class="input" placeholder="e.g. en-US, zh-CN, ms-MY"
                style="flex:1;" list="meta-lang-list">
              <datalist id="meta-lang-list">
                <option value="en-US"><option value="en-GB"><option value="zh-CN">
                <option value="zh-TW"><option value="ms-MY"><option value="ja-JP">
                <option value="ko-KR"><option value="de-DE"><option value="fr-FR">
                <option value="es-ES"><option value="ar"><option value="th-TH">
              </datalist>
            </div>

            <!-- ── Dates ────────────────────────────────────────────────── -->
            <div class="section-label" style="margin-top:14px;">Dates</div>
            <div class="option-row">
              <label>Created</label>
              <input type="datetime-local" id="meta-created" class="input" style="flex:1;max-width:240px;">
              <button class="btn btn-sm" id="meta-created-now" title="Set to now">Now</button>
            </div>

            <!-- ── Viewer / Display ──────────────────────────────────────── -->
            <div class="section-label" style="margin-top:14px;">Viewer &amp; Display</div>
            <div class="option-row">
              <label>Page layout</label>
              <select id="meta-layout" class="input" style="flex:1;max-width:220px;">
                <option value="SinglePage">Single page</option>
                <option value="OneColumn">Continuous scroll</option>
                <option value="TwoColumnLeft">Two-up (odd left)</option>
                <option value="TwoColumnRight">Two-up (odd right)</option>
                <option value="TwoPageLeft">Two pages (odd left)</option>
                <option value="TwoPageRight">Two pages (odd right)</option>
              </select>
            </div>
            <div class="option-row">
              <label>Open with</label>
              <select id="meta-pagemode" class="input" style="flex:1;max-width:220px;">
                <option value="UseNone">Nothing extra</option>
                <option value="UseOutlines">Bookmarks panel open</option>
                <option value="UseThumbs">Thumbnails panel open</option>
                <option value="FullScreen">Full screen</option>
              </select>
            </div>

            <div class="section-label" style="margin-top:14px;">Window behaviour</div>
            <label class="option-row"><input type="checkbox" id="vp-display-title">
              <span>Show document title in window titlebar <small>(instead of filename)</small></span>
            </label>
            <label class="option-row"><input type="checkbox" id="vp-fit-window">
              <span>Resize window to fit first page on open</span>
            </label>
            <label class="option-row"><input type="checkbox" id="vp-center-window">
              <span>Centre viewer window on screen on open</span>
            </label>
            <label class="option-row"><input type="checkbox" id="vp-hide-toolbar">
              <span>Hide viewer toolbar <small>(kiosk / presentation use)</small></span>
            </label>
            <label class="option-row"><input type="checkbox" id="vp-hide-menubar">
              <span>Hide viewer menu bar <small>(kiosk / presentation use)</small></span>
            </label>

            <div style="border-top:1px solid var(--border);margin:16px 0 12px;"></div>

            <div class="option-row">
              <label>Output filename</label>
              <input type="text" id="meta-output" class="input" placeholder="output.pdf" style="flex:1;">
            </div>

            <div style="margin-top:12px;display:flex;gap:8px;">
              <button class="btn btn-sm" id="meta-clear-identity">Clear identity fields</button>
              <button class="btn btn-primary btn-lg" id="meta-save" style="flex:1;justify-content:center;">
                Save PDF
              </button>
            </div>
            <div class="status-text" id="meta-status" style="margin-top:8px;text-align:center;"></div>

          </div><!-- /meta-fields -->

          <div id="meta-placeholder" class="empty-hint" style="margin-top:40px;">
            Load a PDF to view and edit its properties.
          </div>
        </div>

      </div>
    `

    let srcFile = null
    let srcPwd  = null
    let pdfDoc  = null

    const fieldsEl      = container.querySelector('#meta-fields')
    const placeholderEl = container.querySelector('#meta-placeholder')
    const infoEl        = container.querySelector('#meta-info')
    const nameEl        = container.querySelector('#meta-filename')
    const dropZone      = container.querySelector('#meta-drop')
    const changeBtn     = container.querySelector('#meta-change')

    const fmtDate = iso => { try { return iso ? new Date(iso).toLocaleString() : '—' } catch { return iso } }
    const fmtSize = b   => b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(2)+' MB'

    // ── "Now" button for creation date ──────────────────────────────────────
    container.querySelector('#meta-created-now').addEventListener('click', () => {
      const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
        .toISOString().slice(0, 16)
      container.querySelector('#meta-created').value = local
    })

    // ── Load file ─────────────────────────────────────────────────────────────
    async function loadFile(file, initialPwd = null) {
      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(file)
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

        srcFile = file
        srcPwd  = pwd
        pdfDoc  = doc

        // ── Read-only info ───────────────────────────────────────────────────
        const meta = pdf.getMetadata(doc)
        container.querySelector('#mi-pages').textContent    = meta.pages
        container.querySelector('#mi-size').textContent     = fmtSize(file.size)
        container.querySelector('#mi-producer').textContent = meta.producer || '—'
        container.querySelector('#mi-modified').textContent = fmtDate(meta.modified)

        // ── Identity fields ──────────────────────────────────────────────────
        container.querySelector('#meta-title').value    = meta.title
        container.querySelector('#meta-author').value   = meta.author
        container.querySelector('#meta-subject').value  = meta.subject
        container.querySelector('#meta-keywords').value = meta.keywords
        container.querySelector('#meta-creator').value  = meta.creator
        container.querySelector('#meta-language').value = doc.getLanguage?.() ?? ''

        // ── Creation date ────────────────────────────────────────────────────
        const created = doc.getCreationDate?.()
        if (created) {
          const local = new Date(created.getTime() - created.getTimezoneOffset() * 60000)
            .toISOString().slice(0, 16)
          container.querySelector('#meta-created').value = local
        } else {
          container.querySelector('#meta-created').value = ''
        }

        // ── Viewer settings ──────────────────────────────────────────────────
        const viewer = pdf.getViewerSettings(doc)
        container.querySelector('#meta-layout').value    = viewer.pageLayout
        container.querySelector('#meta-pagemode').value  = viewer.pageMode
        container.querySelector('#vp-display-title').checked = viewer.displayDocTitle
        container.querySelector('#vp-fit-window').checked    = viewer.fitWindow
        container.querySelector('#vp-center-window').checked = viewer.centerWindow
        container.querySelector('#vp-hide-toolbar').checked  = viewer.hideToolbar
        container.querySelector('#vp-hide-menubar').checked  = viewer.hideMenubar

        container.querySelector('#meta-output').value = stripExt(file.name) + '_meta.pdf'

        // ── Show UI ──────────────────────────────────────────────────────────
        nameEl.textContent      = file.name
        nameEl.style.display    = 'block'
        dropZone.style.display  = 'none'
        infoEl.style.display    = 'block'
        changeBtn.style.display = 'inline-flex'
        fieldsEl.style.opacity       = '1'
        fieldsEl.style.pointerEvents = 'auto'
        placeholderEl.style.display  = 'none'
        container.querySelector('#meta-status').textContent = ''
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    // ── Drop zone ─────────────────────────────────────────────────────────────
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) loadFile(f)
    })
    const fileInput = container.querySelector('#meta-input')
    container.querySelector('#meta-browse').addEventListener('click', () => fileInput.click())
    changeBtn.addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) { loadFile(e.target.files[0]); fileInput.value = '' }
    })

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => loadFile(gf.file, gf.pwd), 0)

    // ── Clear identity fields ─────────────────────────────────────────────────
    container.querySelector('#meta-clear-identity').addEventListener('click', () => {
      ['#meta-title','#meta-author','#meta-subject','#meta-keywords','#meta-creator','#meta-language']
        .forEach(s => { container.querySelector(s).value = '' })
    })

    // ── Save ─────────────────────────────────────────────────────────────────
    container.querySelector('#meta-save').addEventListener('click', async () => {
      if (!pdfDoc) return
      showProgress('Applying metadata…')
      try {
        // Parse creation date from the datetime-local input
        const createdRaw = container.querySelector('#meta-created').value
        const creationDate = createdRaw ? new Date(createdRaw) : null

        pdf.setMetadata(pdfDoc, {
          title:        container.querySelector('#meta-title').value,
          author:       container.querySelector('#meta-author').value,
          subject:      container.querySelector('#meta-subject').value,
          keywords:     container.querySelector('#meta-keywords').value,
          creator:      container.querySelector('#meta-creator').value,
          language:     container.querySelector('#meta-language').value,
          creationDate,
        })

        pdf.setViewerSettings(pdfDoc, {
          pageLayout:      container.querySelector('#meta-layout').value,
          pageMode:        container.querySelector('#meta-pagemode').value,
          displayDocTitle: container.querySelector('#vp-display-title').checked,
          fitWindow:       container.querySelector('#vp-fit-window').checked,
          centerWindow:    container.querySelector('#vp-center-window').checked,
          hideToolbar:     container.querySelector('#vp-hide-toolbar').checked,
          hideMenubar:     container.querySelector('#vp-hide-menubar').checked,
        })

        pdfDoc.setModificationDate(new Date())

        updateProgress('Saving…')
        const outName  = ensurePdf(container.querySelector('#meta-output').value.trim() || stripExt(srcFile.name) + '_meta')
        const outBytes = await pdf.save(pdfDoc)
        await saveAs(outBytes, outName)
        toast(`Metadata saved → ${outName}`, 'success')
        container.querySelector('#meta-status').textContent = 'Saved successfully.'
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })
  },
})
