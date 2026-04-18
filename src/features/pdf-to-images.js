/**
 * PDF → Images feature — export each page as a separate image file.
 * Uses the File System Access API to write files directly to a chosen folder.
 */

import { registerFeature }                                         from '../core/registry.js'
import { readFile }                                                from '../core/fs.js'
import * as renderer                                               from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, parsePageRange }                                from '../core/utils.js'
import { get }                                                    from '../core/state.js'

registerFeature({
  id:          'pdf-to-images',
  name:        'PDF → Images',
  category:    'Convert',
  icon:        '🖼',
  description: 'Export PDF pages as individual image files (JPG / PNG)',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>PDF → Images</h2>
        <p class="feature-desc">
          Render each page as an image file and save them all to a folder you choose.
        </p>
      </div>

      <div class="feature-split">

        <!-- ── Source + Options ─────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Source PDF</span></div>

          <div class="file-drop-zone" id="pti-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="pti-browse">Browse</button>
            <input type="file" id="pti-input" accept=".pdf" hidden>
          </div>
          <div id="pti-filename" class="file-name-display"></div>

          <div class="section-label" style="margin-top:14px;">Format</div>
          <div class="option-row">
            <label>Image type</label>
            <select id="pti-format" class="input" style="max-width:120px;">
              <option value="jpeg" selected>JPEG</option>
              <option value="png">PNG</option>
            </select>
          </div>

          <div class="option-row" id="pti-quality-row">
            <label>JPEG quality <span id="pti-quality-val">88%</span></label>
            <input type="range" id="pti-quality" min="50" max="100" value="88" style="flex:1;">
          </div>

          <div class="option-row">
            <label>Resolution</label>
            <select id="pti-dpi" class="input" style="max-width:200px;">
              <option value="1.0">72 dpi — screen</option>
              <option value="2.08" selected>150 dpi — office</option>
              <option value="2.78">200 dpi — high quality</option>
              <option value="4.17">300 dpi — print</option>
            </select>
          </div>

          <div class="section-label" style="margin-top:14px;">Pages</div>
          <div class="option-row">
            <label>Export</label>
            <select id="pti-pages-sel" class="input" style="max-width:180px;">
              <option value="all">All pages</option>
              <option value="custom">Custom range…</option>
            </select>
          </div>
          <div id="pti-pages-custom-row" class="option-row" style="display:none;">
            <label>Range</label>
            <input type="text" id="pti-pages-custom" class="input"
              placeholder="e.g. 1-3, 5, 8-10" style="max-width:200px;">
          </div>
        </div>

        <!-- ── Export ───────────────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">② Export to Folder</span></div>

          <div class="option-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
            <label style="min-width:unset;">Filename prefix</label>
            <input type="text" id="pti-prefix" class="input" placeholder="page">
            <span class="status-text" style="margin-top:2px;">
              Files will be named: <em>prefix_001.jpg</em>, <em>prefix_002.jpg</em>, …
            </span>
          </div>

          <div style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="pti-run" disabled
              style="width:100%;justify-content:center;">
              Export to Folder…
            </button>
            <div class="status-text" id="pti-status" style="text-align:center;margin-top:8px;">
              Load a PDF to get started.
            </div>
          </div>

          <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border);">
            <p style="font-size:12px;color:var(--text-subtle);line-height:1.7;">
              ℹ You will be asked to choose a destination folder. All image files are written
              there directly. Existing files with the same name will be overwritten.
              <br><br>
              PNG produces lossless images (larger files); JPEG is smaller but introduces
              slight compression artefacts.
            </p>
          </div>
        </div>

      </div>
    `

    let srcFile = null
    let srcPwd  = null
    const runBtn   = container.querySelector('#pti-run')
    const statusEl = container.querySelector('#pti-status')
    const nameEl   = container.querySelector('#pti-filename')

    // ── File loading ──────────────────────────────────────────────────────────
    function setFile(file, pwd = null) {
      srcFile = file
      srcPwd  = pwd
      nameEl.textContent = file.name
      container.querySelector('#pti-prefix').value = stripExt(file.name)
      runBtn.disabled    = false
      statusEl.textContent = 'Ready.'
    }

    setupDropZone('pti-drop', 'pti-input', setFile)

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => setFile(gf.file, gf.pwd), 0)

    // ── Format → show/hide quality slider ────────────────────────────────────
    container.querySelector('#pti-format').addEventListener('change', e => {
      container.querySelector('#pti-quality-row').style.display =
        e.target.value === 'jpeg' ? 'flex' : 'none'
    })

    // ── Quality slider label ──────────────────────────────────────────────────
    const qualitySlider = container.querySelector('#pti-quality')
    const qualityLabel  = container.querySelector('#pti-quality-val')
    qualitySlider.addEventListener('input', () => {
      qualityLabel.textContent = qualitySlider.value + '%'
    })

    // ── Pages selector ────────────────────────────────────────────────────────
    container.querySelector('#pti-pages-sel').addEventListener('change', e => {
      container.querySelector('#pti-pages-custom-row').style.display =
        e.target.value === 'custom' ? 'flex' : 'none'
    })

    // ── Run ───────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
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

        const format    = container.querySelector('#pti-format').value
        const scale     = parseFloat(container.querySelector('#pti-dpi').value)
        const quality   = parseInt(qualitySlider.value) / 100
        const prefix    = container.querySelector('#pti-prefix').value.trim() || 'page'
        const mimeType  = format === 'jpeg' ? 'image/jpeg' : 'image/png'
        const ext       = format === 'jpeg' ? 'jpg' : 'png'
        const totalPgs  = rDoc.numPages

        // Resolve page list (1-based)
        let pageNums
        if (container.querySelector('#pti-pages-sel').value === 'custom') {
          const raw  = container.querySelector('#pti-pages-custom').value.trim()
          const idxs = parsePageRange(raw, totalPgs)
          if (!idxs.length) {
            toast('Invalid page range.', 'warning')
            rDoc.destroy(); hideProgress(); return
          }
          pageNums = idxs.map(i => i + 1)
        } else {
          pageNums = Array.from({ length: totalPgs }, (_, i) => i + 1)
        }

        // Ask user where to save
        updateProgress('Choose a destination folder…')
        let destDir
        try {
          destDir = await window.showDirectoryPicker({ mode: 'readwrite' })
        } catch {
          rDoc.destroy(); hideProgress(); return   // user cancelled
        }

        // Padding width: e.g. 12 pages → "01"–"12"
        const pad = String(pageNums[pageNums.length - 1]).length

        for (let i = 0; i < pageNums.length; i++) {
          const pNum   = pageNums[i]
          updateProgress(`Rendering page ${pNum} of ${totalPgs} (${i + 1}/${pageNums.length})…`)

          const page     = await rDoc.getPage(pNum)
          const viewport = page.getViewport({ scale })
          const canvas   = document.createElement('canvas')
          canvas.width   = Math.round(viewport.width)
          canvas.height  = Math.round(viewport.height)
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
          page.cleanup()

          const blob    = await new Promise(res => canvas.toBlob(res, mimeType, quality))
          const numPad  = String(pNum).padStart(pad, '0')
          const fname   = `${prefix}_${numPad}.${ext}`

          const fh       = await destDir.getFileHandle(fname, { create: true })
          const writable = await fh.createWritable()
          await writable.write(blob)
          await writable.close()
        }

        rDoc.destroy()
        const n = pageNums.length
        toast(`${n} image${n > 1 ? 's' : ''} saved to "${destDir.name}"`, 'success')
        statusEl.textContent = `Done — ${n} page${n > 1 ? 's' : ''} exported as ${ext.toUpperCase()}.`
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    })

    // ── Drop zone helper ─────────────────────────────────────────────────────
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
