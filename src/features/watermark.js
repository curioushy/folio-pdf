/**
 * Watermark & Stamp — unified tool.
 *
 * Tabs:  ✦ Text / Stamp  |  🖼 Image  |  # Bates
 *
 * Live canvas preview updates as settings change.
 * Stamp presets (DRAFT, APPROVED …) + full custom text.
 * Image watermark supports JPEG / PNG.
 * Bates tab: sequential reference numbers (PROD000001…) stamped per page.
 *
 * File is supplied via the global sidebar slot — no per-feature file picker.
 */

import { registerFeature }   from '../core/registry.js'
import { readFile, saveAs }  from '../core/fs.js'
import * as pdf              from '../core/pdf.js'
import { loadForRender }     from '../core/renderer.js'
import { StandardFonts, rgb } from '@cantoo/pdf-lib'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, ensurePdf, parsePageRange } from '../core/utils.js'
import { get }                                  from '../core/state.js'

registerFeature({
  id:          'watermark',
  name:        'Watermark & Stamp',
  category:    'Stamp',
  icon:        '✦',
  description: 'Text watermark, stamp preset, image logo, or Bates numbering — live preview',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Watermark &amp; Stamp</h2>
          <p class="feature-desc">Apply a text watermark, quick stamp, image logo, or Bates numbers.
            Preview updates live as you adjust settings.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">✦</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>
      `
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Watermark &amp; Stamp</h2>
        <p class="feature-desc">Apply a text watermark, quick stamp, image logo, or Bates numbers.
          Preview updates live.
          <strong style="color:var(--text);">${gf.name}</strong> —
          ${gf.pageCount} page${gf.pageCount !== 1 ? 's' : ''}
        </p>
      </div>

      <div style="display:flex;gap:20px;align-items:flex-start;">

        <!-- ── LEFT: Controls ──────────────────────────────────────────────── -->
        <div class="panel" style="flex:0 0 370px;min-width:0;">

          <!-- Tabs -->
          <div class="tab-group">
            <button class="tab active" data-tab="text">✦ Text / Stamp</button>
            <button class="tab"        data-tab="image">🖼 Image</button>
            <button class="tab"        data-tab="bates"># Bates</button>
          </div>

          <!-- ── Text / Stamp tab ──────────────────────────────────────────── -->
          <div id="wm-tab-text" class="tab-content">

            <div class="option-row" style="margin-top:12px;">
              <label>Stamp text</label>
              <select id="wm-preset" class="input" style="max-width:210px;">
                <option value="CONFIDENTIAL">CONFIDENTIAL</option>
                <option value="DRAFT">DRAFT</option>
                <option value="APPROVED">APPROVED</option>
                <option value="COPY">COPY</option>
                <option value="VOID">VOID</option>
                <option value="FOR REVIEW">FOR REVIEW</option>
                <option value="REJECTED">REJECTED</option>
                <option value="SAMPLE">SAMPLE</option>
                <option value="__custom__">Custom…</option>
              </select>
            </div>
            <div id="wm-custom-row" class="option-row" style="display:none;">
              <label>Custom text</label>
              <input type="text" id="wm-custom-text" class="input"
                placeholder="Your text" style="max-width:240px;">
            </div>

            <div class="section-label" style="margin-top:12px;">Position</div>
            <div class="wm-positions">
              <label class="wm-pos-btn"><input type="radio" name="wm-pos" value="diagonal" checked><span>↗ Diagonal</span></label>
              <label class="wm-pos-btn"><input type="radio" name="wm-pos" value="center"  ><span>⊙ Centre</span></label>
              <label class="wm-pos-btn"><input type="radio" name="wm-pos" value="top"     ><span>▲ Top</span></label>
              <label class="wm-pos-btn"><input type="radio" name="wm-pos" value="bottom"  ><span>▼ Bottom</span></label>
            </div>

            <div class="option-row" style="margin-top:12px;">
              <label>Colour</label>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <button class="wm-swatch" data-color="#9ca3af" title="Grey"
                  style="width:22px;height:22px;border-radius:4px;background:#9ca3af;border:2px solid transparent;cursor:pointer;padding:0;outline:none;"></button>
                <button class="wm-swatch" data-color="#dc2626" title="Red"
                  style="width:22px;height:22px;border-radius:4px;background:#dc2626;border:2px solid transparent;cursor:pointer;padding:0;outline:none;"></button>
                <button class="wm-swatch" data-color="#2563eb" title="Blue"
                  style="width:22px;height:22px;border-radius:4px;background:#2563eb;border:2px solid transparent;cursor:pointer;padding:0;outline:none;"></button>
                <button class="wm-swatch" data-color="#16a34a" title="Green"
                  style="width:22px;height:22px;border-radius:4px;background:#16a34a;border:2px solid transparent;cursor:pointer;padding:0;outline:none;"></button>
                <input type="color" id="wm-color" value="#9ca3af"
                  title="Custom colour"
                  style="width:28px;height:28px;padding:1px;border:1px solid var(--border-dark);
                         border-radius:var(--radius-sm);cursor:pointer;flex-shrink:0;">
              </div>
            </div>

            <div class="option-row" style="margin-top:10px;">
              <label>Opacity <span id="wm-opacity-val" style="font-variant-numeric:tabular-nums;">15%</span></label>
              <input type="range" id="wm-opacity" min="5" max="80" value="15" style="flex:1;">
            </div>

            <div class="option-row">
              <label>Font size</label>
              <input type="number" id="wm-fontsize" class="input" value="60" min="8" max="200"
                style="max-width:80px;">
              <span class="status-text">pt</span>
            </div>

          </div><!-- /text tab -->

          <!-- ── Image tab ─────────────────────────────────────────────────── -->
          <div id="wm-tab-image" class="tab-content hidden">

            <div class="section-label" style="margin-top:12px;">Image / Logo</div>
            <div class="file-drop-zone" id="wmi-drop" style="padding:14px;">
              <span>Drag JPG or PNG here, or</span>
              <button class="btn btn-sm" id="wmi-browse">Browse</button>
              <input type="file" id="wmi-input" accept=".jpg,.jpeg,.png" hidden>
            </div>
            <div id="wmi-filename" class="file-name-display" style="display:none;"></div>
            <img id="wmi-thumb" alt=""
              style="max-width:100%;max-height:56px;object-fit:contain;display:none;
                     margin-top:6px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px;">

            <div class="section-label" style="margin-top:12px;">Position</div>
            <div class="wm-positions">
              <label class="wm-pos-btn"><input type="radio" name="wmi-pos" value="center"  checked><span>⊙ Centre</span></label>
              <label class="wm-pos-btn"><input type="radio" name="wmi-pos" value="diagonal"      ><span>↗ Diagonal</span></label>
              <label class="wm-pos-btn"><input type="radio" name="wmi-pos" value="top"           ><span>▲ Top</span></label>
              <label class="wm-pos-btn"><input type="radio" name="wmi-pos" value="bottom"        ><span>▼ Bottom</span></label>
            </div>

            <div class="option-row" style="margin-top:10px;">
              <label>Opacity <span id="wmi-opacity-val" style="font-variant-numeric:tabular-nums;">25%</span></label>
              <input type="range" id="wmi-opacity" min="5" max="90" value="25" style="flex:1;">
            </div>

            <div class="option-row">
              <label>Size</label>
              <select id="wmi-size" class="input" style="max-width:210px;">
                <option value="0.20">Small — 20% of page</option>
                <option value="0.35" selected>Medium — 35% of page</option>
                <option value="0.50">Large — 50% of page</option>
                <option value="0.70">X-Large — 70% of page</option>
              </select>
            </div>

          </div><!-- /image tab -->

          <!-- ── Bates tab ─────────────────────────────────────────────────── -->
          <div id="wm-tab-bates" class="tab-content hidden">

            <div class="section-label" style="margin-top:12px;">Numbering Format</div>
            <div class="option-row">
              <label>Prefix</label>
              <input type="text" id="bt-prefix" class="input" placeholder="e.g. PROD" value="PROD"
                style="max-width:160px;">
            </div>
            <div class="option-row">
              <label>Start number</label>
              <input type="number" id="bt-start" class="input" min="0" value="1"
                style="max-width:110px;">
            </div>
            <div class="option-row">
              <label>Digits (padding)</label>
              <input type="number" id="bt-pad" class="input" min="1" max="12" value="6"
                style="max-width:80px;">
            </div>
            <div class="option-row">
              <label>Suffix</label>
              <input type="text" id="bt-suffix" class="input" placeholder="(optional)"
                style="max-width:160px;">
            </div>

            <div class="option-row" style="flex-direction:column;align-items:flex-start;gap:4px;margin-top:4px;">
              <label>Preview</label>
              <code id="bt-preview" style="font-size:14px;color:var(--text);"></code>
            </div>

            <div class="section-label" style="margin-top:14px;">Appearance</div>
            <div class="option-row">
              <label>Position</label>
              <select id="bt-pos" class="input" style="max-width:200px;">
                <option value="bottom-right" selected>Bottom right</option>
                <option value="bottom-center">Bottom center</option>
                <option value="bottom-left">Bottom left</option>
                <option value="top-right">Top right</option>
                <option value="top-center">Top center</option>
                <option value="top-left">Top left</option>
              </select>
            </div>
            <div class="option-row">
              <label>Font size (pt)</label>
              <input type="number" id="bt-size" class="input" min="6" max="24" value="8"
                style="max-width:80px;">
            </div>
            <div class="option-row">
              <label>Margin (pt)</label>
              <input type="number" id="bt-margin" class="input" min="4" max="72" value="18"
                style="max-width:80px;">
            </div>
            <div class="option-row">
              <label>Colour</label>
              <input type="color" id="bt-color" value="#000000"
                style="width:44px;height:32px;padding:2px;border:1px solid var(--border);
                       border-radius:4px;background:none;cursor:pointer;">
            </div>

          </div><!-- /bates tab -->

          <div style="border-top:1px solid var(--border);margin:16px 0;"></div>

          <!-- Shared settings -->
          <div class="option-row">
            <label>Apply to</label>
            <select id="wm-pages-sel" class="input" style="max-width:180px;">
              <option value="all">All pages</option>
              <option value="first">First page only</option>
              <option value="custom">Custom range…</option>
            </select>
          </div>
          <div id="wm-pages-custom-row" class="option-row" style="display:none;">
            <label>Range</label>
            <input type="text" id="wm-pages-custom" class="input"
              placeholder="e.g. 1-3, 5, 8-10" style="max-width:200px;">
          </div>

          <div class="option-row" style="flex-direction:column;align-items:flex-start;gap:4px;margin-top:10px;">
            <label style="min-width:unset;">Output filename</label>
            <input type="text" id="wm-output" class="input"
              value="${stripExt(gf.name)}_watermarked.pdf" style="width:100%;">
          </div>

          <div style="margin-top:16px;">
            <button class="btn btn-primary btn-lg" id="wm-run"
              style="width:100%;justify-content:center;">
              Apply Watermark
            </button>
            <div class="status-text" id="wm-status" style="text-align:center;margin-top:8px;"></div>
          </div>

        </div><!-- /left -->

        <!-- ── RIGHT: Preview ──────────────────────────────────────────────── -->
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;position:sticky;top:0;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:13px;font-weight:600;color:var(--text-muted);">Preview</span>
            <button class="btn btn-sm" id="wm-prev-page" disabled>‹</button>
            <span id="wm-page-label"
              style="font-size:12px;color:var(--text-muted);min-width:64px;text-align:center;">—</span>
            <button class="btn btn-sm" id="wm-next-page" disabled>›</button>
          </div>
          <div id="wm-preview-wrap" style="
            background:#e2e8f0;border:1px solid var(--border);border-radius:var(--radius);
            min-height:320px;display:flex;align-items:center;justify-content:center;overflow:hidden;
          ">
            <canvas id="wm-preview-canvas" style="max-width:100%;display:none;"></canvas>
            <span id="wm-preview-ph" style="font-size:13px;color:var(--text-subtle);">
              Loading preview…
            </span>
          </div>
        </div>

      </div>
    `

    // ── State ──────────────────────────────────────────────────────────────────
    let renderDoc     = null    // PDF.js doc for preview
    let previewPage   = 1       // 1-based
    let activeTab     = 'text'
    let imgFile       = null
    let imgElement    = null    // HTMLImageElement for canvas preview
    let previewTimer  = null

    const runBtn    = container.querySelector('#wm-run')
    const statusEl  = container.querySelector('#wm-status')
    const pageLabel = container.querySelector('#wm-page-label')
    const prevBtn   = container.querySelector('#wm-prev-page')
    const nextBtn   = container.querySelector('#wm-next-page')
    const canvas    = container.querySelector('#wm-preview-canvas')
    const placeholder = container.querySelector('#wm-preview-ph')

    // ── Load PDF for preview immediately ──────────────────────────────────────
    ;(async () => {
      try {
        const bytes = await readFile(gf.file)
        renderDoc   = await loadForRender(bytes, gf.pwd)
        previewPage = 1
        updatePageNav()
        schedulePreview()
      } catch {
        placeholder.textContent = 'Preview unavailable.'
      }
    })()

    // ── Tab switching ──────────────────────────────────────────────────────────
    container.querySelectorAll('.tab-group .tab').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.tab-group .tab').forEach(t => t.classList.remove('active'))
        btn.classList.add('active')
        activeTab = btn.dataset.tab
        container.querySelector('#wm-tab-text').classList.toggle('hidden', activeTab !== 'text')
        container.querySelector('#wm-tab-image').classList.toggle('hidden', activeTab !== 'image')
        container.querySelector('#wm-tab-bates').classList.toggle('hidden', activeTab !== 'bates')
        schedulePreview()
      })
    })

    // ── Image file loading ─────────────────────────────────────────────────────
    const imgZone   = container.querySelector('#wmi-drop')
    const imgInput  = container.querySelector('#wmi-input')
    const imgThumb  = container.querySelector('#wmi-thumb')
    const imgNameEl = container.querySelector('#wmi-filename')

    imgZone.addEventListener('dragover',  e => { e.preventDefault(); imgZone.classList.add('drag-over') })
    imgZone.addEventListener('dragleave', () => imgZone.classList.remove('drag-over'))
    imgZone.addEventListener('drop', e => {
      e.preventDefault(); imgZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => /\.(jpg|jpeg|png)$/i.test(f.name))
      if (f) loadImg(f)
    })
    container.querySelector('#wmi-browse').addEventListener('click', () => imgInput.click())
    imgInput.addEventListener('change', e => { if (e.target.files[0]) { loadImg(e.target.files[0]); imgInput.value = '' } })

    function loadImg(file) {
      imgFile = file
      imgNameEl.textContent = file.name
      imgNameEl.style.display = 'block'
      if (imgThumb._url) URL.revokeObjectURL(imgThumb._url)
      imgThumb._url = URL.createObjectURL(file)
      imgThumb.src  = imgThumb._url
      imgThumb.style.display = 'block'
      const img  = new Image()
      img.onload = () => { imgElement = img; schedulePreview() }
      img.src    = imgThumb._url
    }

    // ── Colour swatches ────────────────────────────────────────────────────────
    const colorInput = container.querySelector('#wm-color')
    container.querySelectorAll('.wm-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        colorInput.value = sw.dataset.color
        highlightSwatch(sw)
        schedulePreview()
      })
    })
    colorInput.addEventListener('input', () => { clearSwatchHighlight(); schedulePreview() })
    highlightSwatch(container.querySelector('.wm-swatch'))

    function highlightSwatch(active) {
      container.querySelectorAll('.wm-swatch').forEach(s => {
        s.style.border = s === active ? '2px solid var(--text)' : '2px solid transparent'
      })
    }
    function clearSwatchHighlight() {
      container.querySelectorAll('.wm-swatch').forEach(s => { s.style.border = '2px solid transparent' })
    }

    // ── Preset selector ────────────────────────────────────────────────────────
    container.querySelector('#wm-preset').addEventListener('change', e => {
      container.querySelector('#wm-custom-row').style.display =
        e.target.value === '__custom__' ? 'flex' : 'none'
      schedulePreview()
    })
    container.querySelector('#wm-custom-text').addEventListener('input', schedulePreview)

    // ── Opacity sliders ────────────────────────────────────────────────────────
    const opSlider  = container.querySelector('#wm-opacity')
    const opLabel   = container.querySelector('#wm-opacity-val')
    opSlider.addEventListener('input', () => { opLabel.textContent = opSlider.value + '%'; schedulePreview() })

    const opiSlider = container.querySelector('#wmi-opacity')
    const opiLabel  = container.querySelector('#wmi-opacity-val')
    opiSlider.addEventListener('input', () => { opiLabel.textContent = opiSlider.value + '%'; schedulePreview() })

    // ── Other settings → preview ───────────────────────────────────────────────
    container.querySelector('#wm-fontsize').addEventListener('input', schedulePreview)
    container.querySelectorAll('input[name="wm-pos"], input[name="wmi-pos"]')
      .forEach(el => el.addEventListener('change', schedulePreview))
    container.querySelector('#wmi-size').addEventListener('change', schedulePreview)

    // ── Bates live preview + settings ─────────────────────────────────────────
    const btPreviewEl = container.querySelector('#bt-preview')
    function updateBatesPreview() {
      const prefix = container.querySelector('#bt-prefix').value || ''
      const start  = parseInt(container.querySelector('#bt-start').value) || 1
      const pad    = parseInt(container.querySelector('#bt-pad').value)   || 6
      const suffix = container.querySelector('#bt-suffix').value || ''
      btPreviewEl.textContent = `${prefix}${String(start).padStart(pad, '0')}${suffix}`
      schedulePreview()
    }
    ;['#bt-prefix','#bt-start','#bt-pad','#bt-suffix'].forEach(id =>
      container.querySelector(id).addEventListener('input', updateBatesPreview))
    container.querySelector('#bt-pos').addEventListener('change', schedulePreview)
    container.querySelector('#bt-size').addEventListener('input', schedulePreview)
    container.querySelector('#bt-margin').addEventListener('input', schedulePreview)
    container.querySelector('#bt-color').addEventListener('input', schedulePreview)
    updateBatesPreview()

    // ── Pages selector ─────────────────────────────────────────────────────────
    container.querySelector('#wm-pages-sel').addEventListener('change', e => {
      container.querySelector('#wm-pages-custom-row').style.display =
        e.target.value === 'custom' ? 'flex' : 'none'
    })

    // ── Page navigation ────────────────────────────────────────────────────────
    function updatePageNav() {
      if (!renderDoc) return
      const total = renderDoc.numPages
      pageLabel.textContent = `${previewPage} / ${total}`
      prevBtn.disabled = previewPage <= 1
      nextBtn.disabled = previewPage >= total
    }
    prevBtn.addEventListener('click', () => { previewPage--; updatePageNav(); schedulePreview() })
    nextBtn.addEventListener('click', () => { previewPage++; updatePageNav(); schedulePreview() })

    // ── Live preview ───────────────────────────────────────────────────────────
    function schedulePreview() {
      clearTimeout(previewTimer)
      previewTimer = setTimeout(drawPreview, 100)
    }

    async function drawPreview() {
      if (!renderDoc) return
      const ctx     = canvas.getContext('2d')
      const pdfPage = await renderDoc.getPage(previewPage)
      const vpUnit  = pdfPage.getViewport({ scale: 1 })
      const wrap    = container.querySelector('#wm-preview-wrap')
      const maxW    = Math.max(100, wrap.clientWidth - 24)
      const scale   = Math.min(2, maxW / vpUnit.width)
      const vp      = pdfPage.getViewport({ scale })

      canvas.width  = Math.round(vp.width)
      canvas.height = Math.round(vp.height)
      canvas.style.display = 'block'
      placeholder.style.display = 'none'

      await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise
      pdfPage.cleanup()

      if (activeTab === 'text') {
        drawTextOverlay(ctx, canvas.width, canvas.height, scale)
      } else if (activeTab === 'image' && imgElement) {
        drawImageOverlay(ctx, canvas.width, canvas.height)
      } else if (activeTab === 'bates') {
        drawBatesOverlay(ctx, canvas.width, canvas.height, scale)
      }
    }

    function getTextConfig() {
      const presetVal = container.querySelector('#wm-preset').value
      const text      = presetVal === '__custom__'
        ? (container.querySelector('#wm-custom-text').value.trim() || 'WATERMARK')
        : presetVal
      const position  = container.querySelector('input[name="wm-pos"]:checked').value
      const opacity   = parseInt(opSlider.value) / 100
      const fontSize  = Math.max(8, parseInt(container.querySelector('#wm-fontsize').value) || 60)
      const hex       = colorInput.value
      return { text, position, opacity, fontSize, hex }
    }

    function drawTextOverlay(ctx, w, h, pdfScale) {
      const { text, position, opacity, fontSize, hex } = getTextConfig()
      const pxSize = fontSize * pdfScale
      ctx.save()
      ctx.globalAlpha  = opacity
      ctx.fillStyle    = hex
      ctx.font         = `bold ${pxSize}px Helvetica, Arial, sans-serif`
      ctx.textBaseline = 'alphabetic'
      const tw = ctx.measureText(text).width

      if (position === 'diagonal') {
        ctx.translate(w / 2, h / 2)
        ctx.rotate(-Math.PI / 4)
        ctx.fillText(text, -tw / 2, pxSize * 0.35)
      } else if (position === 'center') {
        ctx.fillText(text, (w - tw) / 2, h / 2 + pxSize * 0.35)
      } else if (position === 'top') {
        ctx.fillText(text, (w - tw) / 2, pxSize + 14 * pdfScale)
      } else {
        ctx.fillText(text, (w - tw) / 2, h - 14 * pdfScale)
      }
      ctx.restore()
    }

    function drawImageOverlay(ctx, w, h) {
      const opacity  = parseInt(opiSlider.value) / 100
      const scale    = parseFloat(container.querySelector('#wmi-size').value) || 0.35
      const position = container.querySelector('input[name="wmi-pos"]:checked').value
      const imgW     = w * scale
      const imgH     = imgElement.height * (imgW / imgElement.width)
      let x, y

      if (position === 'center' || position === 'diagonal') {
        x = (w - imgW) / 2; y = (h - imgH) / 2
      } else if (position === 'top') {
        x = (w - imgW) / 2; y = 10
      } else {
        x = (w - imgW) / 2; y = h - imgH - 10
      }

      ctx.save()
      ctx.globalAlpha = opacity
      if (position === 'diagonal') {
        ctx.translate(x + imgW / 2, y + imgH / 2)
        ctx.rotate(-Math.PI / 4)
        ctx.drawImage(imgElement, -imgW / 2, -imgH / 2, imgW, imgH)
      } else {
        ctx.drawImage(imgElement, x, y, imgW, imgH)
      }
      ctx.restore()
    }

    function drawBatesOverlay(ctx, w, h, pdfScale) {
      const prefix = container.querySelector('#bt-prefix').value || ''
      const start  = parseInt(container.querySelector('#bt-start').value) || 1
      const pad    = parseInt(container.querySelector('#bt-pad').value)   || 6
      const suffix = container.querySelector('#bt-suffix').value || ''
      const label  = `${prefix}${String(start).padStart(pad, '0')}${suffix}`
      const pos    = container.querySelector('#bt-pos').value
      const size   = (parseFloat(container.querySelector('#bt-size').value) || 8) * pdfScale
      const margin = (parseFloat(container.querySelector('#bt-margin').value) || 18) * pdfScale
      const color  = container.querySelector('#bt-color').value

      ctx.save()
      ctx.globalAlpha  = 1
      ctx.fillStyle    = color
      ctx.font         = `bold ${size}px Courier, monospace`
      ctx.textBaseline = 'alphabetic'
      const tw     = ctx.measureText(label).width
      const isTop  = pos.startsWith('top')
      let x
      if      (pos.endsWith('left'))   x = margin
      else if (pos.endsWith('right'))  x = w - tw - margin
      else                             x = (w - tw) / 2
      const y = isTop ? size + margin : h - margin
      ctx.fillText(label, x, y)
      ctx.restore()
    }

    // ── Apply / Save ───────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      showProgress('Loading PDF…')
      try {
        const cf    = get().currentFile
        const bytes = await readFile(cf.file)
        let srcPwd  = cf.pwd
        let doc
        try {
          doc = await pdf.load(bytes, srcPwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          srcPwd = await promptPassword(cf.name)
          if (!srcPwd) return
          showProgress('Decrypting…')
          doc = await pdf.load(bytes, srcPwd)
        }

        // Resolve page indices
        const pagesSel  = container.querySelector('#wm-pages-sel').value
        let pageIndices = null
        if (pagesSel === 'first') {
          pageIndices = [0]
        } else if (pagesSel === 'custom') {
          const raw = container.querySelector('#wm-pages-custom').value.trim()
          pageIndices = parsePageRange(raw, doc.getPageCount())
          if (!pageIndices.length) {
            toast('Invalid page range — applying to all pages.', 'warning')
            pageIndices = null
          }
        }

        if (activeTab === 'text') {
          const { text, position, opacity, fontSize, hex } = getTextConfig()
          if (!text) { toast('Enter watermark text.', 'warning'); hideProgress(); return }
          const color = [
            parseInt(hex.slice(1, 3), 16) / 255,
            parseInt(hex.slice(3, 5), 16) / 255,
            parseInt(hex.slice(5, 7), 16) / 255,
          ]
          updateProgress('Stamping…')
          await pdf.addTextWatermark(doc, text, { opacity, fontSize, color, position, pageIndices })

        } else if (activeTab === 'image') {
          if (!imgFile) { toast('Load an image first.', 'warning'); hideProgress(); return }
          const isJpeg   = /\.(jpg|jpeg)$/i.test(imgFile.name)
          const imgBytes = await readFile(imgFile)
          const opacity  = parseInt(opiSlider.value) / 100
          const scale    = parseFloat(container.querySelector('#wmi-size').value) || 0.35
          const position = container.querySelector('input[name="wmi-pos"]:checked').value
          updateProgress('Stamping…')
          await pdf.addImageWatermark(doc, imgBytes, isJpeg ? 'jpeg' : 'png',
            { opacity, scale, position, pageIndices })

        } else {
          // Bates numbering
          const font   = await doc.embedFont(StandardFonts.Courier)
          const pages  = doc.getPages()
          const total  = pages.length
          const prefix = container.querySelector('#bt-prefix').value || ''
          const start  = parseInt(container.querySelector('#bt-start').value) || 1
          const pad    = parseInt(container.querySelector('#bt-pad').value)   || 6
          const suffix = container.querySelector('#bt-suffix').value || ''
          const posKey = container.querySelector('#bt-pos').value
          const size   = parseFloat(container.querySelector('#bt-size').value)   || 8
          const margin = parseFloat(container.querySelector('#bt-margin').value) || 18
          const hex    = container.querySelector('#bt-color').value
          const colorRgb = rgb(
            parseInt(hex.slice(1, 3), 16) / 255,
            parseInt(hex.slice(3, 5), 16) / 255,
            parseInt(hex.slice(5, 7), 16) / 255,
          )
          const targetIdx = pageIndices ?? pages.map((_, i) => i)
          const isTop  = posKey.startsWith('top')
          const isLeft  = posKey.endsWith('left')
          const isRight = posKey.endsWith('right')

          let counter = start
          updateProgress('Stamping Bates numbers…')
          for (const i of targetIdx) {
            const page  = pages[i]
            const { width, height } = page.getSize()
            const label = `${prefix}${String(counter).padStart(pad, '0')}${suffix}`
            const tw    = font.widthOfTextAtSize(label, size)
            let x
            if      (isLeft)  x = margin
            else if (isRight) x = width - tw - margin
            else              x = (width - tw) / 2
            const y = isTop ? height - margin - size : margin
            page.drawText(label, { x, y, size, font, color: colorRgb })
            counter++
          }

          const lastLabel = `${prefix}${String(counter - 1).padStart(pad, '0')}${suffix}`
          toast(
            `Bates stamped ${targetIdx.length} pages (${btPreviewEl.textContent} … ${lastLabel})`,
            'success', 5000
          )
          const outBytes2 = await pdf.save(doc)
          const outName2  = ensurePdf(container.querySelector('#wm-output').value.trim() || stripExt(cf.name) + '_bates')
          await saveAs(outBytes2, outName2)
          statusEl.textContent = `Done — ${targetIdx.length} pages Bates-stamped.`
          hideProgress()
          return
        }

        updateProgress('Saving…')
        const outName  = ensurePdf(
          container.querySelector('#wm-output').value.trim() ||
          stripExt(gf.name) + '_watermarked'
        )
        const outBytes = await pdf.save(doc)
        await saveAs(outBytes, outName)
        toast(`Watermark applied → ${outName}`, 'success')
        statusEl.textContent = `Done — ${doc.getPageCount()} pages processed.`

      } catch (err) {
        if (err.name !== 'AbortError') { console.error(err); toast('Failed: ' + err.message, 'error') }
      } finally {
        hideProgress()
      }
    })
  },
})
