/**
 * Sign PDF — add a handwritten or image signature to a PDF page.
 *
 * Workflow:
 *   1. Draw a signature on the canvas (or upload a PNG / JPEG image).
 *   2. Choose which page(s) to apply it to.
 *   3. Choose position (preset corners + custom X/Y offsets) and size.
 *   4. Save — the signature is embedded as a PNG and drawn with pdf-lib.
 *
 * The output is a static (flattened) image on the page — not an interactive
 * AcroForm signature field. It looks identical in any viewer.
 */

import { registerFeature }                              from '../core/registry.js'
import { readFile, saveAs }                             from '../core/fs.js'
import * as pdf                                         from '../core/pdf.js'
import { toast, showProgress, hideProgress, promptPassword } from '../core/ui.js'
import { parsePageRange }                               from '../core/utils.js'
import { get }                                          from '../core/state.js'

const PT_PER_MM = 72 / 25.4

registerFeature({
  id:          'sign',
  name:        'Sign PDF',
  category:    'Protect',
  icon:        '✍',
  description: 'Draw or upload a signature and stamp it onto PDF pages',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Sign PDF</h2>
          <p class="feature-desc">Draw a signature or upload an image, then place it on any page.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">✍</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>`
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Sign PDF</h2>
        <p class="feature-desc">
          Draw a signature or upload an image, then place it on any page.
        </p>
      </div>

      <div class="feature-split">

        <!-- ── Left: source + signature ─────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Source PDF</span></div>
          <div id="sg-filename" class="file-name-display">${gf.name}</div>
          <div id="sg-info" class="status-text" style="margin-top:4px;"></div>

          <div class="section-label" style="margin-top:16px;">② Signature</div>

          <!-- Mode tabs -->
          <div style="display:flex;gap:6px;margin-bottom:10px;">
            <button class="btn btn-sm" id="sg-mode-draw" style="font-weight:bold;">✏ Draw</button>
            <button class="btn btn-sm" id="sg-mode-upload">⬆ Upload image</button>
          </div>

          <!-- Draw panel -->
          <div id="sg-draw-panel">
            <div style="position:relative;border:1px solid var(--border);border-radius:var(--radius-sm);background:#fff;touch-action:none;">
              <canvas id="sg-canvas" width="400" height="150"
                style="display:block;width:100%;cursor:crosshair;border-radius:var(--radius-sm);"></canvas>
              <span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
                color:#ccc;font-size:13px;pointer-events:none;" id="sg-placeholder">
                Sign here
              </span>
            </div>
            <div style="display:flex;gap:8px;margin-top:8px;align-items:center;">
              <button class="btn btn-sm" id="sg-clear">Clear</button>
              <label style="font-size:12px;color:var(--text-muted);">Colour</label>
              <input type="color" id="sg-ink" value="#000000"
                style="width:36px;height:28px;padding:2px;border:1px solid var(--border);border-radius:4px;background:none;cursor:pointer;">
              <label style="font-size:12px;color:var(--text-muted);">Thickness</label>
              <input type="range" id="sg-thickness" min="1" max="8" value="2" style="width:80px;">
            </div>
          </div>

          <!-- Upload panel -->
          <div id="sg-upload-panel" style="display:none;">
            <div class="file-drop-zone" id="sg-img-drop" style="min-height:80px;">
              <span>Drag PNG/JPEG here, or</span>
              <button class="btn btn-sm" id="sg-img-browse">Browse</button>
              <input type="file" id="sg-img-input" accept="image/png,image/jpeg" hidden>
            </div>
            <div style="margin-top:8px;text-align:center;">
              <img id="sg-img-preview" style="max-height:120px;max-width:100%;display:none;border:1px solid var(--border);border-radius:4px;">
            </div>
          </div>
        </div>

        <!-- ── Right: placement + save ─────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">③ Placement</span></div>

          <div class="option-row">
            <label>Apply to pages</label>
            <select id="sg-pages-sel" class="input" style="max-width:180px;">
              <option value="all">All pages</option>
              <option value="first" selected>First page only</option>
              <option value="last">Last page only</option>
              <option value="custom">Custom range…</option>
            </select>
          </div>
          <div id="sg-pages-row" class="option-row" style="display:none;">
            <label>Range</label>
            <input type="text" id="sg-pages-custom" class="input"
              placeholder="e.g. 3, 5-7" style="max-width:180px;">
          </div>

          <div class="option-row">
            <label>Position</label>
            <select id="sg-pos" class="input" style="max-width:200px;">
              <option value="bottom-right" selected>Bottom right</option>
              <option value="bottom-left">Bottom left</option>
              <option value="bottom-center">Bottom center</option>
              <option value="top-right">Top right</option>
              <option value="top-left">Top left</option>
              <option value="top-center">Top center</option>
              <option value="center">Center</option>
            </select>
          </div>

          <div class="option-row">
            <label>Width (mm)</label>
            <input type="number" id="sg-width-mm" class="input" min="10" max="200" value="60"
              style="max-width:90px;">
            <span class="status-text">height auto-scales</span>
          </div>

          <div class="option-row">
            <label>Offset X (mm)</label>
            <input type="number" id="sg-off-x" class="input" value="10"
              style="max-width:90px;">
          </div>
          <div class="option-row">
            <label>Offset Y (mm)</label>
            <input type="number" id="sg-off-y" class="input" value="10"
              style="max-width:90px;">
          </div>
          <div class="option-row">
            <label>Opacity</label>
            <input type="range" id="sg-opacity" min="10" max="100" value="100" style="flex:1;">
            <span id="sg-opacity-val" style="min-width:36px;font-size:12px;color:var(--text-muted);">100%</span>
          </div>

          <div class="action-bar" style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="sg-run" disabled
              style="width:100%;justify-content:center;">
              Apply Signature
            </button>
          </div>

          <p style="font-size:11px;color:var(--text-subtle);margin-top:12px;line-height:1.6;">
            ℹ The signature is drawn directly on the page as a static image.
            It is visible in all PDF viewers. For legally binding e-signatures
            (PKI/certificate-based), use dedicated signing software.
          </p>
        </div>

      </div>
    `

    let srcFile    = null
    let srcPwd     = null
    let sigPngBytes = null   // Uint8Array of the PNG to embed

    // ── Mode tabs ─────────────────────────────────────────────────────────────
    const drawPanel   = container.querySelector('#sg-draw-panel')
    const uploadPanel = container.querySelector('#sg-upload-panel')

    container.querySelector('#sg-mode-draw').addEventListener('click', () => {
      drawPanel.style.display   = ''
      uploadPanel.style.display = 'none'
      container.querySelector('#sg-mode-draw').style.fontWeight   = 'bold'
      container.querySelector('#sg-mode-upload').style.fontWeight = ''
    })
    container.querySelector('#sg-mode-upload').addEventListener('click', () => {
      drawPanel.style.display   = 'none'
      uploadPanel.style.display = ''
      container.querySelector('#sg-mode-draw').style.fontWeight   = ''
      container.querySelector('#sg-mode-upload').style.fontWeight = 'bold'
    })

    // ── Drawing canvas ────────────────────────────────────────────────────────
    const canvas    = container.querySelector('#sg-canvas')
    const ctx       = canvas.getContext('2d')
    const placeholder = container.querySelector('#sg-placeholder')
    let drawing = false
    let hasDrawing = false

    function getPos(e) {
      const rect = canvas.getBoundingClientRect()
      const src  = e.touches ? e.touches[0] : e
      const scaleX = canvas.width  / rect.width
      const scaleY = canvas.height / rect.height
      return [(src.clientX - rect.left) * scaleX, (src.clientY - rect.top) * scaleY]
    }

    canvas.addEventListener('mousedown',  e => { drawing = true; ctx.beginPath(); ctx.moveTo(...getPos(e)) })
    canvas.addEventListener('mousemove',  e => {
      if (!drawing) return
      placeholder.style.display = 'none'
      hasDrawing = true
      ctx.strokeStyle = container.querySelector('#sg-ink').value
      ctx.lineWidth   = parseFloat(container.querySelector('#sg-thickness').value)
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.lineTo(...getPos(e))
      ctx.stroke()
    })
    canvas.addEventListener('mouseup',   () => { drawing = false })
    canvas.addEventListener('mouseleave',() => { drawing = false })
    canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; ctx.beginPath(); ctx.moveTo(...getPos(e)) }, { passive: false })
    canvas.addEventListener('touchmove',  e => {
      e.preventDefault()
      if (!drawing) return
      placeholder.style.display = 'none'
      hasDrawing = true
      ctx.strokeStyle = container.querySelector('#sg-ink').value
      ctx.lineWidth   = parseFloat(container.querySelector('#sg-thickness').value)
      ctx.lineCap     = 'round'
      ctx.lineTo(...getPos(e))
      ctx.stroke()
    }, { passive: false })
    canvas.addEventListener('touchend', () => { drawing = false })

    container.querySelector('#sg-clear').addEventListener('click', () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      placeholder.style.display = ''
      hasDrawing = false
    })

    // ── Image upload ──────────────────────────────────────────────────────────
    function loadSigImage(file) {
      const reader = new FileReader()
      reader.onload = e => {
        const img = container.querySelector('#sg-img-preview')
        img.src = e.target.result
        img.style.display = ''
      }
      reader.readAsDataURL(file)
    }

    const imgDropZone = container.querySelector('#sg-img-drop')
    imgDropZone.addEventListener('dragover',  e => { e.preventDefault(); imgDropZone.classList.add('drag-over') })
    imgDropZone.addEventListener('dragleave', () => imgDropZone.classList.remove('drag-over'))
    imgDropZone.addEventListener('drop', e => {
      e.preventDefault(); imgDropZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'))
      if (f) loadSigImage(f)
    })
    container.querySelector('#sg-img-browse').addEventListener('click', () =>
      container.querySelector('#sg-img-input').click())
    container.querySelector('#sg-img-input').addEventListener('change', e => {
      if (e.target.files[0]) { loadSigImage(e.target.files[0]); e.target.value = '' }
    })

    // Opacity label
    const opacitySlider = container.querySelector('#sg-opacity')
    const opacityVal    = container.querySelector('#sg-opacity-val')
    opacitySlider.addEventListener('input', () => {
      opacityVal.textContent = opacitySlider.value + '%'
    })

    // Pages selector
    container.querySelector('#sg-pages-sel').addEventListener('change', e => {
      container.querySelector('#sg-pages-row').style.display =
        e.target.value === 'custom' ? 'flex' : 'none'
    })

    const nameEl = container.querySelector('#sg-filename')
    const infoEl = container.querySelector('#sg-info')
    const runBtn = container.querySelector('#sg-run')

    async function loadFile(file, initialPwd = null) {
      srcFile = file
      nameEl.textContent = file.name
      showProgress('Loading…')
      try {
        const bytes = await readFile(file)
        let pwd = initialPwd
        const doc = await pdf.load(bytes, pwd || undefined).catch(async err => {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          pwd = await promptPassword(file.name)
          if (!pwd) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' })
          showProgress('Decrypting…')
          return pdf.load(bytes, pwd)
        })
        srcPwd = pwd
        const n = doc.getPageCount()
        infoEl.textContent = `${n} page${n > 1 ? 's' : ''}`
        runBtn.disabled = false
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    setTimeout(() => loadFile(gf.file, gf.pwd), 0)

    // ── Capture signature bytes ───────────────────────────────────────────────
    async function captureSig() {
      const mode = drawPanel.style.display === 'none' ? 'upload' : 'draw'

      if (mode === 'draw') {
        if (!hasDrawing) throw new Error('Please draw a signature first.')
        return new Promise((resolve, reject) => {
          canvas.toBlob(blob => {
            if (!blob) { reject(new Error('Failed to capture canvas')); return }
            blob.arrayBuffer().then(ab => resolve(new Uint8Array(ab)))
          }, 'image/png')
        })

      } else {
        const img = container.querySelector('#sg-img-preview')
        if (!img.src || !img.style.display) throw new Error('Please upload a signature image first.')
        // Fetch the data URL and convert to bytes
        const resp = await fetch(img.src)
        const ab   = await resp.arrayBuffer()
        return new Uint8Array(ab)
      }
    }

    // ── Run ───────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      if (!srcFile) return

      // Capture signature
      let sigBytes
      try {
        sigBytes = await captureSig()
      } catch (err) {
        toast(err.message, 'warning')
        return
      }

      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(srcFile)
        let doc
        try {
          doc = await pdf.load(bytes, srcPwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          srcPwd = pwd
          showProgress('Decrypting…')
          doc = await pdf.load(bytes, pwd)
        }

        // Embed signature PNG
        const embedded = await doc.embedPng(sigBytes)
        const totalPgs = doc.getPageCount()
        const widthMm  = parseFloat(container.querySelector('#sg-width-mm').value) || 60
        const offXmm   = parseFloat(container.querySelector('#sg-off-x').value)   ?? 10
        const offYmm   = parseFloat(container.querySelector('#sg-off-y').value)   ?? 10
        const opacity  = parseInt(opacitySlider.value) / 100
        const posKey   = container.querySelector('#sg-pos').value

        // Resolve target pages
        let targetIdx
        const pagesSel = container.querySelector('#sg-pages-sel').value
        if (pagesSel === 'first')  targetIdx = [0]
        else if (pagesSel === 'last')   targetIdx = [totalPgs - 1]
        else if (pagesSel === 'custom') {
          const raw = container.querySelector('#sg-pages-custom').value.trim()
          targetIdx = parsePageRange(raw, totalPgs)
        } else {
          targetIdx = doc.getPages().map((_, i) => i)
        }

        for (const i of targetIdx) {
          const page = doc.getPage(i)
          const { width, height } = page.getSize()

          const sigW = widthMm * PT_PER_MM
          const sigH = sigW * (embedded.height / embedded.width)
          const offX = offXmm * PT_PER_MM
          const offY = offYmm * PT_PER_MM

          let x, y
          const [vSide, hSide] = (() => {
            if (posKey === 'center') return ['center', 'center']
            return posKey.split('-')
          })()

          if      (hSide === 'left')   x = offX
          else if (hSide === 'right')  x = width - sigW - offX
          else                         x = (width - sigW) / 2

          if      (vSide === 'top')    y = height - sigH - offY
          else if (vSide === 'bottom') y = offY
          else                         y = (height - sigH) / 2

          page.drawImage(embedded, { x, y, width: sigW, height: sigH, opacity })
        }

        const outBytes = await pdf.save(doc)
        const outName  = srcFile.name.replace(/\.pdf$/i, '_signed.pdf')
        await saveAs(outBytes, outName)
        toast(`Signed ${targetIdx.length} page${targetIdx.length > 1 ? 's' : ''} → ${outName}`, 'success')

      } catch (err) {
        if (err.name !== 'AbortError') { console.error(err); toast('Failed: ' + err.message, 'error') }
      } finally {
        hideProgress()
      }
    })
  },
})
