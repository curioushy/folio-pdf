/**
 * Batch — apply one operation to many PDF files at once.
 *
 * Supported operations:
 *   Compress       — render at lower DPI
 *   Flatten        — rasterize pages (strips all non-visual content)
 *   Unlock         — remove password / restrictions
 *   Rotate         — rotate all pages
 *   Watermark      — add text watermark
 *   Page Numbers   — stamp page numbers
 *
 * Files are processed sequentially (to avoid memory issues with large docs).
 * Output goes to a folder chosen by the user via showDirectoryPicker.
 * Failed files are logged individually; successes continue.
 */

import { registerFeature }                              from '../core/registry.js'
import { readFile }                                     from '../core/fs.js'
import * as pdf                                         from '../core/pdf.js'
import { loadForRender, renderToUnencryptedPdf }        from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress } from '../core/ui.js'

const OPERATIONS = {
  compress: {
    label: 'Compress (reduce file size)',
    settings: `
      <div class="option-row">
        <label>Quality</label>
        <select id="bt-q-preset" class="input" style="max-width:220px;">
          <option value="screen">Screen / Email (~72 dpi)</option>
          <option value="office" selected>Office (~120 dpi)</option>
          <option value="print">Print (~150 dpi)</option>
        </select>
      </div>`,
  },
  flatten: {
    label: 'Flatten to Images (strip all invisible layers)',
    settings: `
      <div class="option-row">
        <label>Resolution</label>
        <select id="bt-fl-scale" class="input" style="max-width:220px;">
          <option value="1.39">100 dpi — smallest</option>
          <option value="2.08" selected>150 dpi — office</option>
          <option value="2.78">200 dpi — high quality</option>
        </select>
      </div>
      <div class="option-row">
        <label>JPEG quality <span id="bt-fl-qval">88%</span></label>
        <input type="range" id="bt-fl-quality" min="50" max="100" value="88" style="flex:1;">
      </div>`,
  },
  unlock: {
    label: 'Unlock (remove all protection)',
    settings: `
      <p class="status-text" style="margin:0;">
        Removes owner-password restrictions. If files have a user password
        they will be skipped (cannot batch-decrypt without a known password).
      </p>`,
  },
  rotate: {
    label: 'Rotate all pages',
    settings: `
      <div class="option-row">
        <label>Angle</label>
        <select id="bt-rot-angle" class="input" style="max-width:180px;">
          <option value="90">90° Clockwise</option>
          <option value="270">90° Counter-clockwise</option>
          <option value="180">180°</option>
        </select>
      </div>`,
  },
  watermark: {
    label: 'Add Text Watermark',
    settings: `
      <div class="option-row">
        <label>Text</label>
        <input type="text" id="bt-wm-text" class="input" value="CONFIDENTIAL">
      </div>
      <div class="option-row">
        <label>Position</label>
        <select id="bt-wm-pos" class="input" style="max-width:180px;">
          <option value="diagonal" selected>Diagonal</option>
          <option value="center">Center</option>
          <option value="top">Top</option>
          <option value="bottom">Bottom</option>
        </select>
      </div>
      <div class="option-row">
        <label>Opacity <span id="bt-wm-opval">15%</span></label>
        <input type="range" id="bt-wm-opacity" min="5" max="60" value="15" style="flex:1;">
      </div>`,
  },
  pagenumbers: {
    label: 'Add Page Numbers',
    settings: `
      <div class="option-row">
        <label>Format</label>
        <input type="text" id="bt-pn-fmt" class="input" value="{n}" style="max-width:160px;">
        <span class="status-text">{n} = page · {total} = count</span>
      </div>
      <div class="option-row">
        <label>Position</label>
        <select id="bt-pn-pos" class="input" style="max-width:200px;">
          <option value="bottom-center" selected>Bottom center</option>
          <option value="bottom-right">Bottom right</option>
          <option value="bottom-left">Bottom left</option>
          <option value="top-center">Top center</option>
          <option value="top-right">Top right</option>
          <option value="top-left">Top left</option>
        </select>
      </div>`,
  },
}

const COMPRESS_PRESETS = {
  screen: { scale: 1.0,  quality: 0.72 },
  office: { scale: 1.67, quality: 0.82 },
  print:  { scale: 2.08, quality: 0.88 },
}

registerFeature({
  id:          'batch',
  name:        'Batch Process',
  category:    'Multi-file',
  icon:        '⚡',
  description: 'Apply one operation to many PDF files at once',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Batch Process</h2>
        <p class="feature-desc">
          Apply one operation to many PDFs at once. Drop multiple files below,
          choose what to do, and pick an output folder.
        </p>
      </div>

      <div class="feature-split">

        <!-- ── Files ─────────────────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">① PDF Files</span>
            <span id="bt-file-count" class="status-text"></span>
          </div>
          <div class="file-drop-zone" id="bt-drop" style="min-height:80px;">
            <span>Drag multiple PDFs here, or</span>
            <button class="btn btn-sm" id="bt-browse">Browse</button>
            <input type="file" id="bt-input" accept=".pdf" multiple hidden>
          </div>
          <div id="bt-file-list"
            style="max-height:220px;overflow-y:auto;margin-top:8px;display:flex;flex-direction:column;gap:4px;">
          </div>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn btn-sm" id="bt-clear-files" style="display:none;">Clear all</button>
          </div>
        </div>

        <!-- ── Operation ─────────────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">② Operation</span></div>

          <div class="option-row">
            <label>Do this</label>
            <select id="bt-op" class="input" style="max-width:280px;">
              ${Object.entries(OPERATIONS).map(([k, v]) =>
                `<option value="${k}">${v.label}</option>`
              ).join('')}
            </select>
          </div>

          <div id="bt-op-settings" style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">
          </div>

          <div class="section-label" style="margin-top:14px;">Output</div>
          <div class="option-row">
            <label>Suffix</label>
            <input type="text" id="bt-suffix" class="input" value="_batch"
              style="max-width:140px;">
            <span class="status-text">appended before .pdf</span>
          </div>

          <div class="action-bar" style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="bt-run" disabled
              style="width:100%;justify-content:center;">
              Process &amp; Save to Folder…
            </button>
          </div>
        </div>

      </div>

      <!-- ── Progress log ──────────────────────────────────────────────────── -->
      <div id="bt-log-panel" class="panel" style="display:none;margin-top:0;">
        <div class="panel-header">
          <span class="panel-title">Progress</span>
          <span id="bt-log-summary" class="status-text"></span>
        </div>
        <div id="bt-log"
          style="max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;font-size:12px;font-family:monospace;">
        </div>
      </div>
    `

    let files = []

    const fileCountEl = container.querySelector('#bt-file-count')
    const fileListEl  = container.querySelector('#bt-file-list')
    const clearBtn    = container.querySelector('#bt-clear-files')
    const runBtn      = container.querySelector('#bt-run')
    const logPanel    = container.querySelector('#bt-log-panel')
    const logEl       = container.querySelector('#bt-log')
    const logSummary  = container.querySelector('#bt-log-summary')

    // ── File management ───────────────────────────────────────────────────────
    function addFiles(newFiles) {
      const existing = new Set(files.map(f => f.name))
      for (const f of newFiles) {
        if (f.name.toLowerCase().endsWith('.pdf') && !existing.has(f.name)) {
          files.push(f)
          existing.add(f.name)
        }
      }
      renderFileList()
    }

    function renderFileList() {
      fileListEl.innerHTML = ''
      for (let i = 0; i < files.length; i++) {
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;'
        row.innerHTML = `
          <span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
            title="${files[i].name}">${files[i].name}</span>
          <span style="font-size:11px;color:var(--text-subtle);white-space:nowrap;">${(files[i].size/1024).toFixed(0)} KB</span>
          <button data-idx="${i}" style="background:none;border:none;cursor:pointer;color:var(--text-subtle);font-size:14px;padding:0 2px;"
            title="Remove">×</button>
        `
        fileListEl.appendChild(row)
      }
      fileListEl.querySelectorAll('button[data-idx]').forEach(btn => {
        btn.addEventListener('click', e => {
          files.splice(parseInt(btn.dataset.idx), 1)
          renderFileList()
        })
      })
      const n = files.length
      fileCountEl.textContent = n ? `${n} file${n > 1 ? 's' : ''}` : ''
      clearBtn.style.display  = n ? '' : 'none'
      runBtn.disabled         = n === 0
    }

    clearBtn.addEventListener('click', () => { files = []; renderFileList() })

    // Drop zone
    const dropZone = container.querySelector('#bt-drop')
    const input    = container.querySelector('#bt-input')
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      addFiles([...e.dataTransfer.files])
    })
    container.querySelector('#bt-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => {
      addFiles([...e.target.files])
      input.value = ''
    })

    // ── Operation settings panel ──────────────────────────────────────────────
    const opSelect  = container.querySelector('#bt-op')
    const opSettings = container.querySelector('#bt-op-settings')

    function renderOpSettings() {
      opSettings.innerHTML = OPERATIONS[opSelect.value].settings || ''
      // Wire up live labels
      const flQ = opSettings.querySelector('#bt-fl-quality')
      const flV = opSettings.querySelector('#bt-fl-qval')
      if (flQ && flV) flQ.addEventListener('input', () => { flV.textContent = flQ.value + '%' })
      const wmO = opSettings.querySelector('#bt-wm-opacity')
      const wmV = opSettings.querySelector('#bt-wm-opval')
      if (wmO && wmV) wmO.addEventListener('input', () => { wmV.textContent = wmO.value + '%' })
    }
    opSelect.addEventListener('change', renderOpSettings)
    renderOpSettings()

    // ── Logging ───────────────────────────────────────────────────────────────
    function logLine(text, type = 'info') {
      const el = document.createElement('div')
      el.style.color = type === 'ok'    ? 'var(--green)'
                     : type === 'error' ? '#ef4444'
                     : type === 'warn'  ? 'var(--amber)'
                     : 'var(--text-muted)'
      el.textContent = text
      logEl.appendChild(el)
      logEl.scrollTop = logEl.scrollHeight
    }

    // ── Run ───────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      if (!files.length) return

      // Ask for destination folder
      let destDir
      try {
        destDir = await window.showDirectoryPicker({ mode: 'readwrite' })
      } catch { return }   // user cancelled

      const op     = opSelect.value
      const suffix = container.querySelector('#bt-suffix').value.trim() || '_batch'
      logEl.innerHTML = ''
      logPanel.style.display = ''
      logSummary.textContent = ''
      runBtn.disabled = true

      let ok = 0, failed = 0

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        updateProgress(`Processing ${i + 1}/${files.length}: ${file.name}`)
        logLine(`▶ ${file.name}`)
        try {
          const bytes    = await readFile(file)
          const outBytes = await processFile(op, bytes, file.name)
          if (!outBytes) { logLine(`  ⚠ Skipped (encrypted with user password)`, 'warn'); failed++; continue }

          const outName = file.name.replace(/\.pdf$/i, `${suffix}.pdf`)
          const fh      = await destDir.getFileHandle(outName, { create: true })
          const wr      = await fh.createWritable()
          await wr.write(outBytes)
          await wr.close()
          const kb = (outBytes.byteLength / 1024).toFixed(0)
          logLine(`  ✓ ${outName}  (${kb} KB)`, 'ok')
          ok++
        } catch (err) {
          logLine(`  ✗ ${err.message}`, 'error')
          console.error(file.name, err)
          failed++
        }
      }

      hideProgress()
      runBtn.disabled = false
      logSummary.textContent = `${ok} succeeded · ${failed} failed`
      const msg = `Batch done: ${ok}/${files.length} files → "${destDir.name}"`
      toast(msg, ok === files.length ? 'success' : 'warning', 5000)
    })

    // ── Per-file processing ───────────────────────────────────────────────────
    async function processFile(op, bytes, name) {
      if (op === 'compress') {
        const preset  = COMPRESS_PRESETS[opSettings.querySelector('#bt-q-preset')?.value || 'office']
        let rDoc
        try { rDoc = await loadForRender(bytes) }
        catch (err) { if (err.code === 'ENCRYPTED') return null; throw err }
        const out = await renderToUnencryptedPdf(rDoc, { scale: preset.scale, quality: preset.quality })
        rDoc.destroy()
        return out
      }

      if (op === 'flatten') {
        const scale   = parseFloat(opSettings.querySelector('#bt-fl-scale')?.value   || 2.08)
        const quality = parseInt(opSettings.querySelector('#bt-fl-quality')?.value  || 88) / 100
        let rDoc
        try { rDoc = await loadForRender(bytes) }
        catch (err) { if (err.code === 'ENCRYPTED') return null; throw err }
        const out = await renderToUnencryptedPdf(rDoc, { scale, quality })
        rDoc.destroy()
        return out
      }

      if (op === 'unlock') {
        let doc
        try { doc = await pdf.load(bytes) }
        catch (err) { if (err.code === 'ENCRYPTED') return null; throw err }
        return pdf.save(doc)
      }

      if (op === 'rotate') {
        const angle = parseInt(opSettings.querySelector('#bt-rot-angle')?.value || 90)
        let doc
        try { doc = await pdf.load(bytes) }
        catch (err) { if (err.code === 'ENCRYPTED') return null; throw err }
        pdf.rotatePages(doc, doc.getPageIndices(), angle)
        return pdf.save(doc)
      }

      if (op === 'watermark') {
        const text    = opSettings.querySelector('#bt-wm-text')?.value    || 'DRAFT'
        const pos     = opSettings.querySelector('#bt-wm-pos')?.value     || 'diagonal'
        const opacity = parseInt(opSettings.querySelector('#bt-wm-opacity')?.value || 15) / 100
        let doc
        try { doc = await pdf.load(bytes) }
        catch (err) { if (err.code === 'ENCRYPTED') return null; throw err }
        await pdf.addTextWatermark(doc, text, { opacity, position: pos })
        return pdf.save(doc)
      }

      if (op === 'pagenumbers') {
        const format   = opSettings.querySelector('#bt-pn-fmt')?.value  || '{n}'
        const position = opSettings.querySelector('#bt-pn-pos')?.value  || 'bottom-center'
        let doc
        try { doc = await pdf.load(bytes) }
        catch (err) { if (err.code === 'ENCRYPTED') return null; throw err }
        await pdf.addPageNumbers(doc, { format, position })
        return pdf.save(doc)
      }

      throw new Error(`Unknown operation: ${op}`)
    }
  },
})
