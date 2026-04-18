/**
 * Compress feature — reduce PDF file size by re-rendering pages at lower resolution.
 * Output is image-based (not text-selectable) — same as "Print to PDF" at lower quality.
 */

import { registerFeature }                                         from '../core/registry.js'
import { readFile, saveAs }                                        from '../core/fs.js'
import * as renderer                                               from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, ensurePdf }                                     from '../core/utils.js'
import { get }                                                     from '../core/state.js'

// scale = target-dpi / 72 (PDF points per inch)
const PRESETS = {
  screen: {
    label: 'Screen / Email',
    desc:  '~72 dpi · smallest file, screen viewing only',
    scale: 1.0,
    quality: 0.72,
  },
  office: {
    label: 'Office',
    badge: 'Recommended',
    desc:  '~120 dpi · good for most office use',
    scale: 1.67,
    quality: 0.82,
  },
  print: {
    label: 'Print',
    desc:  '~150 dpi · suitable for printing',
    scale: 2.08,
    quality: 0.88,
  },
}

registerFeature({
  id:          'compress',
  name:        'Compress',
  category:    'Convert',
  icon:        '⊛',
  description: 'Reduce file size by re-rendering pages at lower resolution',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Compress PDF</h2>
        <p class="feature-desc">
          Reduce file size by re-rendering pages as images at lower resolution.
          Output will not have selectable text.
        </p>
      </div>

      <div class="feature-split">

        <!-- ── Source + Quality ─────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Source PDF</span></div>

          <div class="file-drop-zone" id="cmp-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="cmp-browse">Browse</button>
            <input type="file" id="cmp-input" accept=".pdf" hidden>
          </div>
          <div id="cmp-filename" class="file-name-display"></div>
          <div id="cmp-size-info" class="status-text" style="margin-bottom:10px;"></div>

          <div class="section-label">Quality preset</div>
          <div class="cmp-presets">
            <label class="cmp-preset">
              <input type="radio" name="cmp-quality" value="screen">
              <div class="cmp-preset-body">
                <span class="cmp-preset-name">Screen / Email</span>
                <span class="cmp-preset-desc">~72 dpi · smallest file, screen viewing only</span>
              </div>
            </label>
            <label class="cmp-preset">
              <input type="radio" name="cmp-quality" value="office" checked>
              <div class="cmp-preset-body">
                <span class="cmp-preset-name">
                  Office
                  <span class="badge badge-blue" style="font-size:10px;padding:1px 5px;">Recommended</span>
                </span>
                <span class="cmp-preset-desc">~120 dpi · good for most office use</span>
              </div>
            </label>
            <label class="cmp-preset">
              <input type="radio" name="cmp-quality" value="print">
              <div class="cmp-preset-body">
                <span class="cmp-preset-name">Print</span>
                <span class="cmp-preset-desc">~150 dpi · suitable for printing</span>
              </div>
            </label>
          </div>
        </div>

        <!-- ── Output ───────────────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">② Output</span></div>

          <div class="option-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
            <label style="min-width:unset;">Output filename</label>
            <input type="text" id="cmp-output" class="input" placeholder="compressed.pdf">
          </div>

          <div style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="cmp-run" disabled
              style="width:100%;justify-content:center;">
              Compress PDF
            </button>
            <div class="status-text" id="cmp-status" style="text-align:center;margin-top:8px;">
              Load a PDF to get started.
            </div>
          </div>

          <div id="cmp-result" style="display:none;margin-top:16px;
            background:var(--bg);border:1px solid var(--border);
            border-radius:var(--radius-sm);padding:12px;"></div>

          <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border);">
            <p style="font-size:12px;color:var(--text-subtle);line-height:1.7;">
              ℹ Pages are re-rendered as JPEG images, so text is no longer selectable or
              searchable in the output. For scanned PDFs this has no impact — they are already
              image-based. If size reduction is important and text searchability is not, this is
              the fastest approach.
            </p>
          </div>
        </div>

      </div>
    `

    let srcFile = null
    let srcPwd  = null
    const runBtn   = container.querySelector('#cmp-run')
    const statusEl = container.querySelector('#cmp-status')
    const nameEl   = container.querySelector('#cmp-filename')
    const sizeEl   = container.querySelector('#cmp-size-info')
    const resultEl = container.querySelector('#cmp-result')

    // ── File loading ──────────────────────────────────────────────────────────
    function setFile(file, pwd = null) {
      srcFile = file
      srcPwd  = pwd
      nameEl.textContent   = file.name
      sizeEl.textContent   = `Source size: ${(file.size / 1024).toFixed(0)} KB`
      container.querySelector('#cmp-output').value = stripExt(file.name) + '_compressed.pdf'
      runBtn.disabled      = false
      statusEl.textContent = 'Ready.'
      resultEl.style.display = 'none'
    }

    setupDropZone('cmp-drop', 'cmp-input', setFile)

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => setFile(gf.file, gf.pwd), 0)

    // ── Run ───────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      const preset = PRESETS[container.querySelector('input[name="cmp-quality"]:checked').value]
      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(srcFile)
        let renderDoc
        try {
          renderDoc = await renderer.loadForRender(bytes)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          showProgress('Decrypting…')
          renderDoc = await renderer.loadForRender(bytes, pwd)
        }

        const total    = renderDoc.numPages
        const outBytes = await renderer.renderToUnencryptedPdf(renderDoc, {
          scale:      preset.scale,
          quality:    preset.quality,
          onProgress: (n, t) => updateProgress(`Compressing page ${n} of ${t}…`),
        })
        renderDoc.destroy()

        updateProgress('Saving…')
        const outName = ensurePdf(
          container.querySelector('#cmp-output').value.trim() || stripExt(srcFile.name) + '_compressed'
        )
        await saveAs(outBytes, outName)

        const inKB  = (srcFile.size / 1024).toFixed(0)
        const outKB = (outBytes.byteLength / 1024).toFixed(0)
        const pct   = Math.round((1 - outBytes.byteLength / srcFile.size) * 100)
        const note  = pct > 0
          ? `↓ ${pct}% smaller`
          : `↑ ${Math.abs(pct)}% larger (source was already well-optimised)`

        toast(`Compressed → ${outName}`, 'success')
        statusEl.textContent = `Done — ${total} pages, ${note}`
        resultEl.style.display = 'block'
        resultEl.innerHTML = `
          <div class="cmp-result-row">
            <span>Input</span><strong>${inKB} KB</strong>
          </div>
          <div class="cmp-result-row">
            <span>Output</span><strong>${outKB} KB</strong>
          </div>
          <div class="cmp-result-row">
            <span>Change</span>
            <strong style="color:${pct > 0 ? 'var(--green)' : 'var(--amber)'};">${note}</strong>
          </div>
        `
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
