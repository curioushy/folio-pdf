/**
 * Normalise Page Size — make every page the same size.
 *
 * Common need: a document assembled from multiple sources has a mix of
 * A4, Letter, screenshots, scanned pages etc. This makes them uniform
 * for consistent printing or binding.
 *
 * Uses pdf-lib's `doc.embedPage()` + `page.drawPage()` to re-place each
 * source page inside a new page of the target size, maintaining vector
 * quality. Two fit modes:
 *   Scale to fit — page content is scaled (up or down) to fill the target
 *   Center        — content is kept at original size and centered; excess
 *                   area is white; content is clipped if larger
 */

import { registerFeature }                              from '../core/registry.js'
import { readFile, saveAs }                             from '../core/fs.js'
import * as pdf                                         from '../core/pdf.js'
import { PDFDocument }                                  from '@cantoo/pdf-lib'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { get }                                                               from '../core/state.js'

const PT_PER_MM = 72 / 25.4

const SIZES = {
  'a4':     [595.28, 841.89],
  'letter': [612, 792],
  'a3':     [841.89, 1190.55],
  'a5':     [419.53, 595.28],
  'a4l':    [841.89, 595.28],   // A4 landscape
  'letterl':[792, 612],         // Letter landscape
}

registerFeature({
  id:          'normalise-pages',
  name:        'Normalise Page Size',
  category:    'Convert',
  icon:        '⬜',
  description: 'Make every page the same size — useful for mixed-format documents',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Normalise Page Size</h2>
        <p class="feature-desc">
          Resize all pages to the same size. Content is either scaled to fit
          or centered on the new page.
        </p>
      </div>

      <div class="feature-split">

        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Source PDF</span></div>
          <div class="file-drop-zone" id="np-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="np-browse">Browse</button>
            <input type="file" id="np-input" accept=".pdf" hidden>
          </div>
          <div id="np-filename" class="file-name-display"></div>
          <div id="np-info" class="status-text" style="margin-top:4px;"></div>
        </div>

        <div class="panel">
          <div class="panel-header"><span class="panel-title">② Target Size</span></div>

          <div class="option-row">
            <label>Page size</label>
            <select id="np-size" class="input" style="max-width:220px;">
              <option value="a4"      selected>A4 Portrait  (210×297 mm)</option>
              <option value="a4l">A4 Landscape  (297×210 mm)</option>
              <option value="letter">Letter Portrait  (8.5×11 in)</option>
              <option value="letterl">Letter Landscape  (11×8.5 in)</option>
              <option value="a3">A3 Portrait  (297×420 mm)</option>
              <option value="a5">A5 Portrait  (148×210 mm)</option>
              <option value="first">Match first page</option>
              <option value="most">Match most common size</option>
              <option value="custom">Custom…</option>
            </select>
          </div>

          <div id="np-custom-row" style="display:none;">
            <div class="option-row">
              <label>Width (mm)</label>
              <input type="number" id="np-cw" class="input" min="10" max="2000" value="210"
                style="max-width:90px;">
            </div>
            <div class="option-row">
              <label>Height (mm)</label>
              <input type="number" id="np-ch" class="input" min="10" max="2000" value="297"
                style="max-width:90px;">
            </div>
          </div>

          <div class="section-label" style="margin-top:14px;">Fit Mode</div>
          <div class="option-row">
            <label>Mode</label>
            <select id="np-mode" class="input" style="max-width:220px;">
              <option value="fit"    selected>Scale to fit (maintain aspect ratio)</option>
              <option value="fill">Scale to fill (may crop edges)</option>
              <option value="center">Center (no scaling, clip if oversized)</option>
              <option value="stretch">Stretch to fill (may distort)</option>
            </select>
          </div>

          <div class="option-row">
            <label>Margin (mm)</label>
            <input type="number" id="np-margin" class="input" min="0" max="50" value="0"
              style="max-width:80px;">
            <span class="status-text">inset from edge (fit mode only)</span>
          </div>

          <div class="action-bar">
            <button class="btn btn-primary btn-lg" id="np-run" disabled
              style="width:100%;justify-content:center;">
              Normalise Pages
            </button>
          </div>
        </div>

      </div>
    `

    let srcFile = null
    let srcPwd  = null
    const nameEl = container.querySelector('#np-filename')
    const infoEl = container.querySelector('#np-info')
    const runBtn = container.querySelector('#np-run')

    container.querySelector('#np-size').addEventListener('change', e => {
      container.querySelector('#np-custom-row').style.display =
        e.target.value === 'custom' ? 'block' : 'none'
    })

    async function loadFile(file, initialPwd = null) {
      srcFile = file
      nameEl.textContent = file.name
      showProgress('Loading…')
      try {
        const bytes = await readFile(file)
        let pwd = initialPwd
        const doc   = await pdf.load(bytes, pwd || undefined).catch(async err => {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          pwd = await promptPassword(file.name)
          if (!pwd) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' })
          showProgress('Decrypting…')
          return pdf.load(bytes, pwd)
        })
        srcPwd = pwd
        const n = doc.getPageCount()
        // Count distinct sizes
        const sizeMap = new Map()
        doc.getPages().forEach(p => {
          const { width, height } = p.getSize()
          const k = `${Math.round(width)}x${Math.round(height)}`
          sizeMap.set(k, (sizeMap.get(k) || 0) + 1)
        })
        infoEl.textContent = `${n} pages · ${sizeMap.size} distinct size${sizeMap.size > 1 ? 's' : ''}`
        runBtn.disabled = false
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    const dropZone = container.querySelector('#np-drop')
    const input    = container.querySelector('#np-input')
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) loadFile(f)
    })
    container.querySelector('#np-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => {
      if (e.target.files[0]) { loadFile(e.target.files[0]); input.value = '' }
    })

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => loadFile(gf.file, gf.pwd), 0)

    runBtn.addEventListener('click', async () => {
      if (!srcFile) return
      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(srcFile)
        let srcDoc
        try {
          srcDoc = await pdf.load(bytes, srcPwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          srcPwd = pwd
          showProgress('Decrypting…')
          srcDoc = await pdf.load(bytes, pwd)
        }

        const srcPages  = srcDoc.getPages()
        const total     = srcPages.length
        const mode      = container.querySelector('#np-mode').value
        const marginMm  = parseFloat(container.querySelector('#np-margin').value) || 0
        const marginPt  = marginMm * PT_PER_MM
        const sizeKey   = container.querySelector('#np-size').value

        // Resolve target size
        let tgtW, tgtH
        if (sizeKey === 'first') {
          const s = srcPages[0].getSize()
          ;[tgtW, tgtH] = [s.width, s.height]
        } else if (sizeKey === 'most') {
          const sizeMap = new Map()
          srcPages.forEach(p => {
            const { width, height } = p.getSize()
            const k = `${Math.round(width)}x${Math.round(height)}`
            sizeMap.set(k, { count: (sizeMap.get(k)?.count || 0) + 1, w: width, h: height })
          })
          const best = [...sizeMap.values()].sort((a, b) => b.count - a.count)[0]
          ;[tgtW, tgtH] = [best.w, best.h]
        } else if (sizeKey === 'custom') {
          tgtW = parseFloat(container.querySelector('#np-cw').value) * PT_PER_MM
          tgtH = parseFloat(container.querySelector('#np-ch').value) * PT_PER_MM
        } else {
          ;[tgtW, tgtH] = SIZES[sizeKey]
        }

        const outDoc = await PDFDocument.create()

        for (let i = 0; i < total; i++) {
          updateProgress(`Processing page ${i + 1} of ${total}…`)
          const srcPage = srcPages[i]
          const { width: sw, height: sh } = srcPage.getSize()

          const embedded = await outDoc.embedPage(srcPage)
          const outPage  = outDoc.addPage([tgtW, tgtH])

          const availW = tgtW - 2 * marginPt
          const availH = tgtH - 2 * marginPt

          let drawW, drawH, drawX, drawY

          if (mode === 'stretch') {
            drawW = availW; drawH = availH
            drawX = marginPt; drawY = marginPt
          } else if (mode === 'center') {
            drawW = sw; drawH = sh
            drawX = (tgtW - sw) / 2
            drawY = (tgtH - sh) / 2
          } else {
            const scaleX = availW / sw
            const scaleY = availH / sh
            const s = mode === 'fill' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY)
            drawW = sw * s
            drawH = sh * s
            drawX = marginPt + (availW - drawW) / 2
            drawY = marginPt + (availH - drawH) / 2
          }

          outPage.drawPage(embedded, { x: drawX, y: drawY, width: drawW, height: drawH })
        }

        const outBytes = await outDoc.save()
        const outName  = srcFile.name.replace(/\.pdf$/i, '_normalised.pdf')
        await saveAs(outBytes, outName)
        toast(`${total} pages normalised → ${outName}`, 'success')

      } catch (err) {
        if (err.name !== 'AbortError') { console.error(err); toast('Failed: ' + err.message, 'error') }
      } finally {
        hideProgress()
      }
    })
  },
})
