/**
 * Stamp feature — apply a quick legal/business stamp to every page (or selected
 * pages). Faster and simpler than the full Watermark tool — predefined stamp
 * choices with a custom option, colour picker, position, opacity, and font size.
 */

import { registerFeature }                                              from '../core/registry.js'
import { readFile, saveAs }                                             from '../core/fs.js'
import * as pdf                                                         from '../core/pdf.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, ensurePdf, parsePageRange }                         from '../core/utils.js'
import { PDFDocument, rgb, degrees, StandardFonts }                    from '@cantoo/pdf-lib'

registerFeature({
  id:          'stamp',
  name:        'Stamp',
  category:    'Stamp',
  icon:        '🔖',
  description: 'Apply a quick legal or business stamp (DRAFT, CONFIDENTIAL, APPROVED…) to PDF pages',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Stamp</h2>
        <p class="feature-desc">
          Apply a predefined legal or business stamp to every page (or selected pages).
          Faster than the full Watermark tool — just pick your stamp and go.
        </p>
      </div>

      <div class="panel">

        <!-- File drop ──────────────────────────────────────────────────── -->
        <div class="panel-header"><span class="panel-title">① Source PDF</span></div>

        <div class="file-drop-zone" id="stamp-drop">
          <span>Drag a PDF here, or</span>
          <button class="btn btn-sm" id="stamp-browse">Browse</button>
          <input type="file" id="stamp-input" accept=".pdf" hidden>
        </div>
        <div id="stamp-filename" class="file-name-display"></div>

        <div style="border-top:1px solid var(--border);margin:18px 0;"></div>

        <!-- Stamp options ──────────────────────────────────────────────── -->
        <div class="panel-header" style="margin-top:0;"><span class="panel-title">② Stamp Options</span></div>

        <div class="option-row">
          <label>Stamp type</label>
          <select id="stamp-type" class="input" style="max-width:220px;">
            <option value="DRAFT">DRAFT</option>
            <option value="CONFIDENTIAL">CONFIDENTIAL</option>
            <option value="APPROVED">APPROVED</option>
            <option value="COPY">COPY</option>
            <option value="VOID">VOID</option>
            <option value="FOR REVIEW">FOR REVIEW</option>
            <option value="REJECTED">REJECTED</option>
            <option value="__custom__">Custom…</option>
          </select>
        </div>

        <div id="stamp-custom-row" class="option-row" style="display:none;">
          <label>Custom text</label>
          <input type="text" id="stamp-custom-text" class="input"
            placeholder="Enter stamp text" style="max-width:260px;">
        </div>

        <div class="option-row">
          <label>Colour</label>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;" id="stamp-colors">
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="radio" name="stamp-color" value="#dc2626" checked>
              <span style="display:inline-block;width:18px;height:18px;border-radius:3px;background:#dc2626;border:1px solid var(--border-dark);"></span>
              <span>Red</span>
            </label>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="radio" name="stamp-color" value="#1d4edd">
              <span style="display:inline-block;width:18px;height:18px;border-radius:3px;background:#1d4edd;border:1px solid var(--border-dark);"></span>
              <span>Blue</span>
            </label>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="radio" name="stamp-color" value="#64748b">
              <span style="display:inline-block;width:18px;height:18px;border-radius:3px;background:#64748b;border:1px solid var(--border-dark);"></span>
              <span>Gray</span>
            </label>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="radio" name="stamp-color" value="#16a34a">
              <span style="display:inline-block;width:18px;height:18px;border-radius:3px;background:#16a34a;border:1px solid var(--border-dark);"></span>
              <span>Green</span>
            </label>
          </div>
        </div>

        <div class="section-label" style="margin-top:14px;">Position</div>
        <div class="wm-positions">
          <label class="wm-pos-btn"><input type="radio" name="stamp-pos" value="diagonal" checked><span>↗ Diagonal</span></label>
          <label class="wm-pos-btn"><input type="radio" name="stamp-pos" value="center"  ><span>⊙ Centre</span></label>
          <label class="wm-pos-btn"><input type="radio" name="stamp-pos" value="header"  ><span>▲ Header</span></label>
          <label class="wm-pos-btn"><input type="radio" name="stamp-pos" value="footer"  ><span>▼ Footer</span></label>
        </div>

        <div class="option-row" style="margin-top:14px;">
          <label>Opacity <span id="stamp-opacity-val" style="font-variant-numeric:tabular-nums;">20%</span></label>
          <input type="range" id="stamp-opacity" min="10" max="60" value="20" style="flex:1;">
        </div>

        <div class="option-row">
          <label>Font size</label>
          <input type="number" id="stamp-fontsize" class="input" value="48" min="20" max="120"
            style="max-width:80px;">
          <span class="status-text">pt</span>
        </div>

        <div style="border-top:1px solid var(--border);margin:18px 0;"></div>

        <!-- Pages + Output ─────────────────────────────────────────────── -->
        <div class="panel-header" style="margin-top:0;"><span class="panel-title">③ Pages &amp; Output</span></div>

        <div class="option-row">
          <label>Apply to</label>
          <select id="stamp-pages-sel" class="input" style="max-width:180px;">
            <option value="all">All pages</option>
            <option value="first">First page only</option>
            <option value="custom">Custom range…</option>
          </select>
        </div>
        <div id="stamp-pages-custom-row" class="option-row" style="display:none;">
          <label>Range</label>
          <input type="text" id="stamp-pages-custom" class="input"
            placeholder="e.g. 1-3, 5, 8-10" style="max-width:200px;">
        </div>

        <div class="option-row" style="margin-top:14px;flex-direction:column;align-items:flex-start;gap:4px;">
          <label style="min-width:unset;">Output filename</label>
          <input type="text" id="stamp-output" class="input" placeholder="document_stamped.pdf"
            style="width:100%;max-width:400px;">
        </div>

        <!-- Action ─────────────────────────────────────────────────────── -->
        <div class="action-bar" style="margin-top:20px;">
          <button class="btn btn-primary btn-lg" id="stamp-run" disabled
            style="min-width:160px;justify-content:center;">
            Apply Stamp
          </button>
          <div class="status-text" id="stamp-status" style="margin-left:14px;">
            Load a PDF to get started.
          </div>
        </div>

      </div>
    `

    // ── State ──────────────────────────────────────────────────────────────────
    let srcFile = null

    const runBtn   = container.querySelector('#stamp-run')
    const statusEl = container.querySelector('#stamp-status')
    const nameEl   = container.querySelector('#stamp-filename')

    // ── File drop zone ─────────────────────────────────────────────────────────
    const zone  = container.querySelector('#stamp-drop')
    const input = container.querySelector('#stamp-input')

    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over') })
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) setFile(f)
    })
    container.querySelector('#stamp-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => { if (e.target.files[0]) { setFile(e.target.files[0]); input.value = '' } })

    function setFile(file) {
      srcFile = file
      nameEl.textContent = file.name
      container.querySelector('#stamp-output').value = stripExt(file.name) + '_stamped.pdf'
      runBtn.disabled      = false
      statusEl.textContent = 'Ready.'
    }

    // ── Stamp type selector — reveal custom text input ─────────────────────────
    container.querySelector('#stamp-type').addEventListener('change', e => {
      const isCustom = e.target.value === '__custom__'
      container.querySelector('#stamp-custom-row').style.display = isCustom ? 'flex' : 'none'
    })

    // ── Opacity slider ─────────────────────────────────────────────────────────
    const opacitySlider = container.querySelector('#stamp-opacity')
    const opacityLabel  = container.querySelector('#stamp-opacity-val')
    opacitySlider.addEventListener('input', () => {
      opacityLabel.textContent = opacitySlider.value + '%'
    })

    // ── Pages selector ─────────────────────────────────────────────────────────
    container.querySelector('#stamp-pages-sel').addEventListener('change', e => {
      container.querySelector('#stamp-pages-custom-row').style.display =
        e.target.value === 'custom' ? 'flex' : 'none'
    })

    // ── Run ────────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      // Resolve stamp text
      const typeVal = container.querySelector('#stamp-type').value
      const stampText = typeVal === '__custom__'
        ? container.querySelector('#stamp-custom-text').value.trim()
        : typeVal

      if (!stampText) {
        toast('Enter custom stamp text.', 'warning')
        return
      }

      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(srcFile)
        let doc
        try { doc = await pdf.load(bytes) }
        catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          showProgress('Decrypting…')
          doc = await pdf.load(bytes, pwd)
        }

        // Resolve target page indices
        const pagesSel = container.querySelector('#stamp-pages-sel').value
        let targetIndices
        if (pagesSel === 'first') {
          targetIndices = [0]
        } else if (pagesSel === 'custom') {
          const raw = container.querySelector('#stamp-pages-custom').value.trim()
          targetIndices = parsePageRange(raw, doc.getPageCount())
          if (!targetIndices.length) {
            toast('Invalid page range — applying to all pages.', 'warning')
            targetIndices = null
          }
        } else {
          targetIndices = null   // all pages
        }

        const allPages = doc.getPages()
        const pages    = targetIndices ? targetIndices.map(i => allPages[i]).filter(Boolean) : allPages

        // Resolve colour
        const hexColor = container.querySelector('input[name="stamp-color"]:checked').value
        const r = parseInt(hexColor.slice(1, 3), 16) / 255
        const g = parseInt(hexColor.slice(3, 5), 16) / 255
        const b = parseInt(hexColor.slice(5, 7), 16) / 255
        const color = rgb(r, g, b)

        const opacity  = parseInt(opacitySlider.value) / 100
        const fontSize = Math.min(120, Math.max(20, parseInt(container.querySelector('#stamp-fontsize').value) || 48))
        const position = container.querySelector('input[name="stamp-pos"]:checked').value

        updateProgress('Embedding font…')
        const font = await doc.embedFont(StandardFonts.HelveticaBold)

        updateProgress('Stamping pages…')
        const textWidth = font.widthOfTextAtSize(stampText, fontSize)

        for (const page of pages) {
          const { width, height } = page.getSize()

          let x, y, rotation

          if (position === 'diagonal') {
            // Centre of the page, rotated 45°
            rotation  = degrees(45)
            x         = (width  - textWidth) / 2
            y         = (height - fontSize)  / 2
          } else if (position === 'center') {
            rotation  = degrees(0)
            x         = (width  - textWidth) / 2
            y         = (height - fontSize)  / 2
          } else if (position === 'header') {
            rotation  = degrees(0)
            x         = (width  - textWidth) / 2
            y         = height - fontSize - 20
          } else {
            // footer
            rotation  = degrees(0)
            x         = (width  - textWidth) / 2
            y         = 20
          }

          page.drawText(stampText, {
            x,
            y,
            size:    fontSize,
            font,
            color,
            opacity,
            rotate:  rotation,
          })
        }

        updateProgress('Saving…')
        const outName  = ensurePdf(
          container.querySelector('#stamp-output').value.trim() || stripExt(srcFile.name) + '_stamped'
        )
        const outBytes = await pdf.save(doc)
        await saveAs(outBytes, outName)

        const pageWord = pages.length === 1 ? 'page' : 'pages'
        toast(`Stamp applied to ${pages.length} ${pageWord} → ${outName}`, 'success')
        statusEl.textContent = `Done — ${pages.length} ${pageWord} stamped.`
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed: ' + err.message, 'error')
          statusEl.textContent = 'Error — see console for details.'
        }
      } finally {
        hideProgress()
      }
    })
  },
})
