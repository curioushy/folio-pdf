/**
 * Grayscale feature — convert a colour PDF to grayscale.
 * Each page is rendered via PDF.js, desaturated with the standard luminance
 * formula (0.299R + 0.587G + 0.114B) via ImageData, then exported as JPEG
 * and embedded into a new pdf-lib document.
 */

import { registerFeature }                                          from '../core/registry.js'
import { get }                                                      from '../core/state.js'
import { loadForRender }                                            from '../core/renderer.js'
import { saveAs }                                                   from '../core/fs.js'
import { PDFDocument }                                              from '@cantoo/pdf-lib'
import { toast, showProgress, updateProgress, hideProgress }        from '../core/ui.js'
import { stripExt, ensurePdf }                                      from '../core/utils.js'

registerFeature({
  id:          'grayscale',
  name:        'Grayscale',
  category:    'Convert',
  icon:        '◑',
  description: 'Convert a colour PDF to grayscale (image-based output)',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Grayscale</h2>
          <p class="feature-desc">Convert a color PDF to grayscale. Output is image-based (JPEG pages).</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">◑</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>`
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Grayscale</h2>
        <p class="feature-desc">Convert a color PDF to grayscale. Output is image-based (JPEG pages).</p>
      </div>

      <div class="panel">
        <div class="panel-header">
          <span class="panel-title">${gf.name}</span>
          <span class="status-text">${gf.pageCount} page${gf.pageCount !== 1 ? 's' : ''}</span>
        </div>

        <div class="section-label" style="margin-top:14px;">Options</div>

        <div class="option-row">
          <label>Render scale</label>
          <select id="gray-scale" class="input" style="max-width:180px;">
            <option value="1.5">1.5× — faster / smaller</option>
            <option value="2" selected>2× — balanced (recommended)</option>
            <option value="2.5">2.5× — higher quality</option>
            <option value="3">3× — print quality</option>
          </select>
        </div>

        <div class="option-row">
          <label>JPEG quality <span id="gray-quality-val">85%</span></label>
          <input type="range" id="gray-quality" min="50" max="98" value="85" style="flex:1;">
        </div>

        <div class="option-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
          <label style="min-width:unset;">Output filename</label>
          <input type="text" id="gray-filename" class="input"
            value="${stripExt(gf.name)}_grayscale.pdf">
        </div>

        <div class="action-bar">
          <button class="btn btn-primary btn-lg" id="gray-run">◑ Convert to Grayscale</button>
        </div>
      </div>
    `

    // ── Quality slider label ──────────────────────────────────────────────────
    const qualitySlider = container.querySelector('#gray-quality')
    const qualityLabel  = container.querySelector('#gray-quality-val')
    qualitySlider.addEventListener('input', () => {
      qualityLabel.textContent = qualitySlider.value + '%'
    })

    // ── Run ───────────────────────────────────────────────────────────────────
    container.querySelector('#gray-run').addEventListener('click', async () => {
      const cf = get().currentFile
      if (!cf) return

      const scale   = parseFloat(container.querySelector('#gray-scale').value)
      const quality = parseInt(qualitySlider.value) / 100
      const outName = ensurePdf(
        container.querySelector('#gray-filename').value.trim() ||
        stripExt(cf.name) + '_grayscale'
      )

      showProgress('Loading PDF…')
      let rDoc
      try {
        const bytes = await cf.file.arrayBuffer()
        try {
          rDoc = await loadForRender(bytes, cf.pwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const { promptPassword } = await import('../core/ui.js')
          const pwd = await promptPassword(cf.name)
          if (!pwd) return
          showProgress('Decrypting…')
          rDoc = await loadForRender(bytes, pwd)
        }

        const total = rDoc.numPages
        const doc   = await PDFDocument.create()

        for (let pageNum = 1; pageNum <= total; pageNum++) {
          updateProgress(`Converting page ${pageNum} of ${total}…`)

          const page     = await rDoc.getPage(pageNum)
          const viewport = page.getViewport({ scale })
          const w        = Math.round(viewport.width)
          const h        = Math.round(viewport.height)

          const canvas = document.createElement('canvas')
          canvas.width  = w
          canvas.height = h
          const ctx = canvas.getContext('2d')

          await page.render({ canvasContext: ctx, viewport }).promise
          page.cleanup()

          // Apply grayscale via standard luminance formula
          const imageData = ctx.getImageData(0, 0, w, h)
          const data = imageData.data
          for (let i = 0; i < data.length; i += 4) {
            const luma = Math.round(
              0.299 * data[i] +
              0.587 * data[i + 1] +
              0.114 * data[i + 2]
            )
            data[i]     = luma
            data[i + 1] = luma
            data[i + 2] = luma
            // data[i + 3] = alpha — unchanged
          }
          ctx.putImageData(imageData, 0, 0)

          // Canvas → JPEG bytes
          const dataUrl  = canvas.toDataURL('image/jpeg', quality)
          const b64      = dataUrl.split(',')[1]
          const imgBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))

          const img     = await doc.embedJpg(imgBytes)
          const pdfPage = doc.addPage([w, h])
          pdfPage.drawImage(img, { x: 0, y: 0, width: w, height: h })
        }

        updateProgress('Saving…')
        const outBytes = await doc.save()
        doc.destroy()

        await saveAs(outBytes, outName)

        toast(`Saved → ${outName}`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed: ' + err.message, 'error')
        }
      } finally {
        if (rDoc) rDoc.destroy()
        hideProgress()
      }
    })
  },
})
