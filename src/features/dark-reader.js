/**
 * Dark Reader — view a PDF in dark mode.
 * Inverts or tints page colors for comfortable reading in low light.
 * Pure viewer: no file is modified or saved.
 */

import { registerFeature }                                                from '../core/registry.js'
import { readFile }                                                       from '../core/fs.js'
import * as renderer                                                      from '../core/renderer.js'
import { toast, showProgress, hideProgress, promptPassword }              from '../core/ui.js'
import { get }                                                            from '../core/state.js'

registerFeature({
  id:          'dark-reader',
  name:        'Dark Reader',
  category:    'Tools',
  icon:        '🌙',
  description: 'View a PDF in dark mode — colors are inverted for comfortable reading in low light',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Dark Reader</h2>
        <p class="feature-desc">View a PDF in dark mode. Colors are inverted for comfortable reading. No file is modified.</p>
      </div>

      <div class="panel">

        <div class="file-drop-zone" id="dr-drop">
          <span>Drag a PDF here, or</span>
          <button class="btn btn-sm" id="dr-browse">Browse</button>
          <input type="file" id="dr-input" accept=".pdf" hidden>
        </div>
        <div id="dr-filename" class="file-name-display"></div>

        <!-- Controls toolbar (hidden until loaded) -->
        <div id="dr-toolbar" style="display:none; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap;">
          <button class="btn btn-sm" id="dr-prev">&#8249; Prev</button>
          <span id="dr-page-info" style="font-size:13px; color:var(--text-muted);">Page 1 of 1</span>
          <button class="btn btn-sm" id="dr-next">Next &#8250;</button>

          <div style="flex:1"></div>

          <label style="font-size:12px; color:var(--text-muted);">Mode:</label>
          <select id="dr-mode" class="input" style="max-width:180px;">
            <option value="invert">Invert (dark mode)</option>
            <option value="sepia">Sepia (warm)</option>
            <option value="normal">Normal</option>
          </select>

          <select id="dr-zoom" class="input" style="max-width:100px;">
            <option value="0.75">75%</option>
            <option value="1.0" selected>100%</option>
            <option value="1.25">125%</option>
            <option value="1.5">150%</option>
            <option value="2.0">200%</option>
          </select>
        </div>

        <!-- Canvas display area -->
        <div id="dr-canvas-wrap" style="overflow:auto; max-height:70vh; background:#1a1a2e; border-radius:8px; padding:16px; display:none; text-align:center;">
          <canvas id="dr-canvas" style="max-width:100%; display:inline-block;"></canvas>
        </div>

      </div>
    `

    // ── State ──────────────────────────────────────────────────────────────────
    let srcFile    = null
    let srcPwd     = null
    let rDoc       = null
    let curPage    = 1
    let totalPages = 1
    let rendering  = false

    const nameEl      = container.querySelector('#dr-filename')
    const toolbar     = container.querySelector('#dr-toolbar')
    const canvasWrap  = container.querySelector('#dr-canvas-wrap')
    const canvas      = container.querySelector('#dr-canvas')
    const pageInfoEl  = container.querySelector('#dr-page-info')
    const prevBtn     = container.querySelector('#dr-prev')
    const nextBtn     = container.querySelector('#dr-next')
    const modeSelect  = container.querySelector('#dr-mode')
    const zoomSelect  = container.querySelector('#dr-zoom')

    // ── Apply CSS filter based on mode ─────────────────────────────────────────
    function applyFilter() {
      const mode = modeSelect.value
      if (mode === 'invert') {
        canvas.style.filter = 'invert(1) hue-rotate(180deg)'
      } else if (mode === 'sepia') {
        canvas.style.filter = 'sepia(1) brightness(0.85)'
      } else {
        canvas.style.filter = 'none'
      }
    }

    // ── Update page info label and button states ───────────────────────────────
    function updatePageInfo() {
      pageInfoEl.textContent = `Page ${curPage} of ${totalPages}`
      prevBtn.disabled = curPage <= 1
      nextBtn.disabled = curPage >= totalPages
    }

    // ── Render a page to the canvas ────────────────────────────────────────────
    async function renderPage(pageNum) {
      if (!rDoc || rendering) return
      rendering = true
      try {
        const scale    = parseFloat(zoomSelect.value) || 1.0
        const page     = await rDoc.getPage(pageNum)
        const viewport = page.getViewport({ scale })

        canvas.width  = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)

        const ctx = canvas.getContext('2d')
        // White background so invert filter produces dark background
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        await page.render({ canvasContext: ctx, viewport }).promise
        page.cleanup()

        applyFilter()
        updatePageInfo()
      } catch (err) {
        console.error(err)
        toast('Failed to render page: ' + err.message, 'error')
      } finally {
        rendering = false
      }
    }

    // ── Load a PDF file ────────────────────────────────────────────────────────
    async function loadFile(file, initialPwd = null) {
      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(file)
        let doc, pwd = initialPwd
        try {
          doc = await renderer.loadForRender(bytes, pwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          pwd = await promptPassword(file.name)
          if (!pwd) return
          showProgress('Decrypting…')
          doc = await renderer.loadForRender(bytes, pwd)
        }

        srcFile    = file
        srcPwd     = pwd
        if (rDoc) rDoc.destroy()
        rDoc        = doc
        curPage     = 1
        totalPages  = rDoc.numPages
        nameEl.textContent = file.name

        toolbar.style.display    = 'flex'
        canvasWrap.style.display = 'block'

        await renderPage(curPage)
      } catch (err) {
        console.error(err)
        toast('Failed to load PDF: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    // ── Drop zone ──────────────────────────────────────────────────────────────
    const zone  = container.querySelector('#dr-drop')
    const input = container.querySelector('#dr-input')
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over') })
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) loadFile(f)
    })
    container.querySelector('#dr-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => { if (e.target.files[0]) { loadFile(e.target.files[0]); input.value = '' } })

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => loadFile(gf.file, gf.pwd), 0)

    // ── Navigation ─────────────────────────────────────────────────────────────
    prevBtn.addEventListener('click', async () => {
      if (curPage > 1) {
        curPage--
        await renderPage(curPage)
      }
    })

    nextBtn.addEventListener('click', async () => {
      if (curPage < totalPages) {
        curPage++
        await renderPage(curPage)
      }
    })

    // ── Zoom — re-render at new scale ──────────────────────────────────────────
    zoomSelect.addEventListener('change', () => renderPage(curPage))

    // ── Mode — just update filter, no re-render needed ─────────────────────────
    modeSelect.addEventListener('change', () => applyFilter())

    // ── Keyboard shortcuts — ArrowLeft / ArrowRight ────────────────────────────
    container.addEventListener('keydown', async e => {
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (curPage > 1) { curPage--; await renderPage(curPage) }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (curPage < totalPages) { curPage++; await renderPage(curPage) }
      }
    })

    // Make the container focusable so keydown events fire
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '0')
  },
})
