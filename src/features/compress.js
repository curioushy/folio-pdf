/**
 * Compress feature — two methods:
 *
 *   Surgical  (default) — walks the object graph, downsamples image XObjects
 *                         in place. Text, vectors, links, annotations preserved.
 *                         Only effective when images dominate the file size.
 *
 *   Rasterise           — re-renders every page to JPEG. Maximum shrink on mixed
 *                         content, but the output has no selectable text and no
 *                         vector graphics or hyperlinks.
 */

import { registerFeature }                                         from '../core/registry.js'
import { readFile, saveAs }                                        from '../core/fs.js'
import * as pdf                                                    from '../core/pdf.js'
import * as renderer                                               from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, ensurePdf }                                     from '../core/utils.js'
import { get }                                                     from '../core/state.js'

// Presets carry params for BOTH methods so a single radio controls quality
// regardless of method.
const PRESETS = {
  screen: {
    label: 'Screen / Email',
    desc:  'Smallest file · on-screen viewing',
    surgical: { maxPixels: 1000, quality: 0.65 },
    raster:   { scale: 1.0,     quality: 0.72 },
  },
  office: {
    label: 'Office',
    badge: 'Recommended',
    desc:  'Balanced size and quality',
    surgical: { maxPixels: 1600, quality: 0.78 },
    raster:   { scale: 1.67,    quality: 0.82 },
  },
  print: {
    label: 'Print',
    desc:  'Light compression, near-original quality',
    surgical: { maxPixels: 2400, quality: 0.88 },
    raster:   { scale: 2.08,    quality: 0.88 },
  },
}

registerFeature({
  id:          'compress',
  name:        'Compress',
  category:    'Convert',
  icon:        '⊛',
  description: 'Reduce file size by shrinking embedded images',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Compress PDF</h2>
          <p class="feature-desc">Reduce file size by shrinking embedded images.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">📄</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>`
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Compress PDF</h2>
        <p class="feature-desc">Shrink embedded images to reduce file size.</p>
      </div>

      <div class="feature-split">

        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Method</span></div>

          <div class="cmp-presets">
            <label class="cmp-preset">
              <input type="radio" name="cmp-method" value="surgical" checked>
              <div class="cmp-preset-body">
                <span class="cmp-preset-name">
                  Surgical
                  <span class="badge badge-blue" style="font-size:10px;padding:1px 5px;">Recommended</span>
                </span>
                <span class="cmp-preset-desc">Downsamples images in place · text, vectors and links untouched</span>
              </div>
            </label>
            <label class="cmp-preset">
              <input type="radio" name="cmp-method" value="raster">
              <div class="cmp-preset-body">
                <span class="cmp-preset-name">Rasterise</span>
                <span class="cmp-preset-desc">Re-renders every page as JPEG · maximum shrink, loses selectable text</span>
              </div>
            </label>
          </div>

          <div class="section-label" style="margin-top:16px;">Quality preset</div>
          <div class="cmp-presets">
            ${Object.entries(PRESETS).map(([k, v]) => `
              <label class="cmp-preset">
                <input type="radio" name="cmp-quality" value="${k}" ${k === 'office' ? 'checked' : ''}>
                <div class="cmp-preset-body">
                  <span class="cmp-preset-name">
                    ${v.label}
                    ${v.badge ? `<span class="badge badge-blue" style="font-size:10px;padding:1px 5px;">${v.badge}</span>` : ''}
                  </span>
                  <span class="cmp-preset-desc">${v.desc}</span>
                </div>
              </label>
            `).join('')}
          </div>

          <div id="cmp-size-info" class="status-text" style="margin-top:12px;">
            Source size: ${(gf.file.size / 1024).toFixed(0)} KB
          </div>
        </div>

        <div class="panel">
          <div class="panel-header"><span class="panel-title">② Output</span></div>

          <div class="option-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
            <label style="min-width:unset;">Output filename</label>
            <input type="text" id="cmp-output" class="input"
              value="${stripExt(gf.name)}_compressed.pdf">
          </div>

          <div style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="cmp-run"
              style="width:100%;justify-content:center;">
              Compress PDF
            </button>
            <div class="status-text" id="cmp-status" style="text-align:center;margin-top:8px;">
              Ready.
            </div>
          </div>

          <div id="cmp-result" style="display:none;margin-top:16px;
            background:var(--bg);border:1px solid var(--border);
            border-radius:var(--radius-sm);padding:12px;"></div>

          <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border);">
            <p style="font-size:12px;color:var(--text-subtle);line-height:1.7;" id="cmp-tip">
              ℹ Surgical keeps your PDF's text, links and vector graphics intact —
              only embedded JPEG images are downsampled. If you need every last
              byte (and don't need selectable text), switch to Rasterise.
            </p>
          </div>
        </div>

      </div>
    `

    const runBtn    = container.querySelector('#cmp-run')
    const statusEl  = container.querySelector('#cmp-status')
    const resultEl  = container.querySelector('#cmp-result')
    const tipEl     = container.querySelector('#cmp-tip')

    const TIPS = {
      surgical: 'ℹ Surgical keeps your PDF\u2019s text, links and vector graphics intact — only embedded JPEG images are downsampled. If you need every last byte (and don\u2019t need selectable text), switch to Rasterise.',
      raster:   'ℹ Rasterise re-renders every page as a JPEG image. Output will not have selectable text or working hyperlinks, but file size is typically smallest on mixed content. For scanned PDFs the difference is usually tiny.',
    }
    container.querySelectorAll('input[name="cmp-method"]').forEach(r =>
      r.addEventListener('change', () => { tipEl.textContent = TIPS[r.value] })
    )

    runBtn.addEventListener('click', async () => {
      const method  = container.querySelector('input[name="cmp-method"]:checked').value
      const preset  = PRESETS[container.querySelector('input[name="cmp-quality"]:checked').value]
      const cf      = get().currentFile
      if (!cf) return

      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(cf.file)

        let outBytes
        if (method === 'surgical') {
          // Load with pdf-lib, walk XObjects, save.
          let doc
          try {
            doc = await pdf.load(bytes, cf.pwd || undefined)
          } catch (err) {
            if (err.code !== 'ENCRYPTED') throw err
            hideProgress()
            const pwd = await promptPassword(cf.name)
            if (!pwd) return
            showProgress('Decrypting…')
            doc = await pdf.load(bytes, pwd)
          }

          updateProgress('Scanning images…')
          const report = await pdf.compressImages(doc, {
            maxPixels: preset.surgical.maxPixels,
            quality:   preset.surgical.quality,
            onProgress: (n, t) => updateProgress(`Compressing image ${n + 1} of ${t}…`),
          })
          updateProgress('Saving…')
          outBytes = await pdf.save(doc)

          const outName = ensurePdf(
            container.querySelector('#cmp-output').value.trim() || stripExt(cf.name) + '_compressed'
          )
          await saveAs(outBytes, outName)

          const inKB  = (cf.file.size / 1024).toFixed(0)
          const outKB = (outBytes.byteLength / 1024).toFixed(0)
          const pct   = Math.round((1 - outBytes.byteLength / cf.file.size) * 100)
          const note  = pct > 0
            ? `↓ ${pct}% smaller`
            : `↑ ${Math.abs(pct)}% larger`

          toast(`Compressed → ${outName}`, 'success')
          statusEl.textContent = report.compressed === 0
            ? `Done — no eligible images found.`
            : `Done — ${report.compressed} of ${report.scanned} images compressed.`
          resultEl.style.display = 'block'
          resultEl.innerHTML = `
            <div class="cmp-result-row"><span>Input</span><strong>${inKB} KB</strong></div>
            <div class="cmp-result-row"><span>Output</span><strong>${outKB} KB</strong></div>
            <div class="cmp-result-row">
              <span>Change</span>
              <strong style="color:${pct > 0 ? 'var(--green)' : 'var(--amber)'};">${note}</strong>
            </div>
            <div class="cmp-result-row"><span>Images touched</span><strong>${report.compressed} / ${report.scanned}</strong></div>
          `
          if (report.scanned === 0) {
            resultEl.innerHTML += `
              <div style="font-size:12px;color:var(--text-subtle);margin-top:8px;line-height:1.5;">
                No DeviceRGB JPEG images found. Try the Rasterise method if the file is still too large.
              </div>`
          }
        } else {
          // Rasterise method — full page re-render via PDF.js.
          let renderDoc
          try {
            renderDoc = await renderer.loadForRender(bytes, cf.pwd || undefined)
          } catch (err) {
            if (err.code !== 'ENCRYPTED') throw err
            hideProgress()
            const pwd = await promptPassword(cf.name)
            if (!pwd) return
            showProgress('Decrypting…')
            renderDoc = await renderer.loadForRender(bytes, pwd)
          }

          const total = renderDoc.numPages
          outBytes = await renderer.renderToUnencryptedPdf(renderDoc, {
            scale:      preset.raster.scale,
            quality:    preset.raster.quality,
            onProgress: (n, t) => updateProgress(`Rasterising page ${n} of ${t}…`),
          })
          renderDoc.destroy()

          updateProgress('Saving…')
          const outName = ensurePdf(
            container.querySelector('#cmp-output').value.trim() || stripExt(cf.name) + '_compressed'
          )
          await saveAs(outBytes, outName)

          const inKB  = (cf.file.size / 1024).toFixed(0)
          const outKB = (outBytes.byteLength / 1024).toFixed(0)
          const pct   = Math.round((1 - outBytes.byteLength / cf.file.size) * 100)
          const note  = pct > 0
            ? `↓ ${pct}% smaller`
            : `↑ ${Math.abs(pct)}% larger (source was already well-optimised)`

          toast(`Compressed → ${outName}`, 'success')
          statusEl.textContent = `Done — ${total} pages, ${note}`
          resultEl.style.display = 'block'
          resultEl.innerHTML = `
            <div class="cmp-result-row"><span>Input</span><strong>${inKB} KB</strong></div>
            <div class="cmp-result-row"><span>Output</span><strong>${outKB} KB</strong></div>
            <div class="cmp-result-row">
              <span>Change</span>
              <strong style="color:${pct > 0 ? 'var(--green)' : 'var(--amber)'};">${note}</strong>
            </div>
          `
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    })
  },
})
