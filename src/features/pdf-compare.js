/**
 * PDF Compare — render two PDFs side by side and highlight pixel differences.
 * Useful for reviewing document changes between revisions.
 *
 * View modes:
 *   side-by-side  — Doc A and Doc B rendered next to each other
 *   diff          — Diff canvas: changed pixels highlighted in red, unchanged dimmed
 *   overlay       — Same as diff canvas but labelled as an overlay
 */

import { registerFeature }                                                from '../core/registry.js'
import { readFile }                                                       from '../core/fs.js'
import * as renderer                                                      from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'

registerFeature({
  id:          'pdf-compare',
  name:        'PDF Compare',
  category:    'Multi-file',
  icon:        '🔍',
  description: 'Compare two PDFs page by page — differences are highlighted in red',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>PDF Compare</h2>
        <p class="feature-desc">Compare two PDFs page by page. Differences are highlighted in red.</p>
      </div>

      <div class="feature-split">

        <!-- ── Document A ──────────────────────────────────────────────────── -->
        <div class="panel" id="pc-panel-a">
          <div class="panel-header"><span class="panel-title">&#9312; Document A</span></div>
          <div class="file-drop-zone" id="pc-drop-a">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="pc-browse-a">Browse</button>
            <input type="file" id="pc-input-a" accept=".pdf" hidden>
          </div>
          <div id="pc-name-a" class="file-name-display"></div>
          <div id="pc-info-a" class="status-text"></div>
        </div>

        <!-- ── Document B ──────────────────────────────────────────────────── -->
        <div class="panel" id="pc-panel-b">
          <div class="panel-header"><span class="panel-title">&#9313; Document B</span></div>
          <div class="file-drop-zone" id="pc-drop-b">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="pc-browse-b">Browse</button>
            <input type="file" id="pc-input-b" accept=".pdf" hidden>
          </div>
          <div id="pc-name-b" class="file-name-display"></div>
          <div id="pc-info-b" class="status-text"></div>
        </div>

      </div>

      <!-- ── Comparison panel ─────────────────────────────────────────────── -->
      <div class="panel">

        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px;">
          <button class="btn btn-sm" id="pc-prev" disabled>&#8249; Prev</button>
          <span id="pc-page-info" style="font-size:13px; color:var(--text-muted);">—</span>
          <button class="btn btn-sm" id="pc-next" disabled>Next &#8250;</button>
          <div style="flex:1"></div>
          <label style="font-size:12px; color:var(--text-muted);">View:</label>
          <select id="pc-view-mode" class="input" style="max-width:160px;">
            <option value="sidebyside">Side by side</option>
            <option value="diff">Diff only</option>
            <option value="overlay">Overlay</option>
          </select>
          <label style="font-size:12px; color:var(--text-muted);">Threshold:</label>
          <input type="number" id="pc-threshold" class="input" value="10" min="1" max="255"
            style="max-width:60px;" title="Pixel difference threshold (1-255)">
          <button class="btn btn-primary btn-sm" id="pc-compare" disabled>Compare</button>
        </div>

        <!-- Comparison display -->
        <div id="pc-display" style="overflow:auto; max-height:70vh;">
          <div id="pc-side-by-side" style="display:flex; gap:8px; justify-content:center;">
            <canvas id="pc-canvas-a" style="max-width:48%; border:1px solid var(--border); border-radius:4px;"></canvas>
            <canvas id="pc-canvas-b" style="max-width:48%; border:1px solid var(--border); border-radius:4px;"></canvas>
          </div>
          <div id="pc-diff-view" style="display:none; text-align:center;">
            <canvas id="pc-canvas-diff" style="max-width:100%; border:1px solid var(--border); border-radius:4px;"></canvas>
          </div>
        </div>

        <!-- Legend (shown in diff / overlay modes) -->
        <div id="pc-legend" style="display:none; margin-top:6px; text-align:center; font-size:12px; color:var(--text-muted);">
          <span style="color:#dc2626;">&#9632;</span> Red = changed &nbsp;&nbsp;
          <span style="color:var(--text-subtle);">&#9632;</span> Faded = unchanged
        </div>

        <div id="pc-stats" class="status-text" style="margin-top:8px; text-align:center;"></div>

      </div>
    `

    // ── State ──────────────────────────────────────────────────────────────────
    let rDocA      = null
    let rDocB      = null
    let curPage    = 1
    let totalPages = 0
    let comparing  = false

    const nameElA   = container.querySelector('#pc-name-a')
    const nameElB   = container.querySelector('#pc-name-b')
    const infoElA   = container.querySelector('#pc-info-a')
    const infoElB   = container.querySelector('#pc-info-b')
    const pageInfoEl = container.querySelector('#pc-page-info')
    const prevBtn   = container.querySelector('#pc-prev')
    const nextBtn   = container.querySelector('#pc-next')
    const compareBtn = container.querySelector('#pc-compare')
    const statsEl   = container.querySelector('#pc-stats')
    const legend    = container.querySelector('#pc-legend')

    // ── Update page info and nav button states ─────────────────────────────────
    function updatePageInfo() {
      if (totalPages > 0) {
        pageInfoEl.textContent = `Page ${curPage} of ${totalPages}`
      } else {
        pageInfoEl.textContent = '—'
      }
      prevBtn.disabled = curPage <= 1 || totalPages === 0
      nextBtn.disabled = curPage >= totalPages || totalPages === 0
    }

    // ── Check whether both docs are loaded — enable Compare ───────────────────
    function checkReady() {
      const ready = !!(rDocA && rDocB)
      compareBtn.disabled = !ready
      if (ready) {
        totalPages = Math.min(rDocA.numPages, rDocB.numPages)
        curPage    = 1
        updatePageInfo()
        // Auto-compare page 1 immediately
        renderPage(curPage)
      }
    }

    // ── Apply view mode visibility ─────────────────────────────────────────────
    function applyViewMode() {
      const mode = container.querySelector('#pc-view-mode').value
      const sbsEl  = container.querySelector('#pc-side-by-side')
      const diffEl = container.querySelector('#pc-diff-view')

      if (mode === 'sidebyside') {
        sbsEl.style.display  = 'flex'
        diffEl.style.display = 'none'
        legend.style.display = 'none'
      } else {
        // 'diff' and 'overlay' both show the diff canvas
        sbsEl.style.display  = 'none'
        diffEl.style.display = 'block'
        legend.style.display = 'block'
      }
    }

    // ── Core render + diff function ────────────────────────────────────────────
    async function renderPage(pageNum) {
      if (!rDocA || !rDocB || comparing) return
      comparing = true
      showProgress(`Comparing page ${pageNum}…`)
      try {
        const SCALE = 1.5

        const pageA = await rDocA.getPage(pageNum)
        const pageB = await rDocB.getPage(pageNum)

        const vpA = pageA.getViewport({ scale: SCALE })
        const vpB = pageB.getViewport({ scale: SCALE })

        // Use max dimensions so pages are always the same canvas size
        const W = Math.round(Math.max(vpA.width,  vpB.width))
        const H = Math.round(Math.max(vpA.height, vpB.height))

        // ── Render Doc A ──────────────────────────────────────────────────────
        updateProgress(`Rendering page ${pageNum} — Document A…`)
        const canvA = container.querySelector('#pc-canvas-a')
        canvA.width  = W
        canvA.height = H
        const ctxA = canvA.getContext('2d')
        ctxA.fillStyle = '#ffffff'
        ctxA.fillRect(0, 0, W, H)
        await pageA.render({ canvasContext: ctxA, viewport: pageA.getViewport({ scale: SCALE }) }).promise

        // ── Render Doc B ──────────────────────────────────────────────────────
        updateProgress(`Rendering page ${pageNum} — Document B…`)
        const canvB = container.querySelector('#pc-canvas-b')
        canvB.width  = W
        canvB.height = H
        const ctxB = canvB.getContext('2d')
        ctxB.fillStyle = '#ffffff'
        ctxB.fillRect(0, 0, W, H)
        await pageB.render({ canvasContext: ctxB, viewport: pageB.getViewport({ scale: SCALE }) }).promise

        pageA.cleanup()
        pageB.cleanup()

        // ── Compute diff ──────────────────────────────────────────────────────
        updateProgress('Computing differences…')
        const threshold = Math.max(1, Math.min(255, parseInt(container.querySelector('#pc-threshold').value) || 10))

        const imgDataA = ctxA.getImageData(0, 0, W, H)
        const imgDataB = ctxB.getImageData(0, 0, W, H)

        const canvDiff = container.querySelector('#pc-canvas-diff')
        canvDiff.width  = W
        canvDiff.height = H
        const ctxDiff  = canvDiff.getContext('2d')
        const diffImg  = ctxDiff.createImageData(W, H)

        let diffPixels = 0
        const totalPixels = W * H
        const dataA = imgDataA.data
        const dataB = imgDataB.data
        const out   = diffImg.data

        for (let i = 0; i < dataA.length; i += 4) {
          const dr      = Math.abs(dataA[i]     - dataB[i])
          const dg      = Math.abs(dataA[i + 1] - dataB[i + 1])
          const db      = Math.abs(dataA[i + 2] - dataB[i + 2])
          const maxDiff = Math.max(dr, dg, db)

          if (maxDiff > threshold) {
            // Highlight changed pixels: semi-transparent red
            out[i]     = 220   // R
            out[i + 1] = 38    // G
            out[i + 2] = 38    // B
            out[i + 3] = 180   // semi-transparent
            diffPixels++
          } else {
            // Unchanged pixels: show dimmed version of B
            out[i]     = dataB[i]
            out[i + 1] = dataB[i + 1]
            out[i + 2] = dataB[i + 2]
            out[i + 3] = dataB[i + 3]
          }
        }

        ctxDiff.putImageData(diffImg, 0, 0)

        // ── Stats ─────────────────────────────────────────────────────────────
        const pct = ((diffPixels / totalPixels) * 100).toFixed(2)
        statsEl.textContent =
          `${diffPixels.toLocaleString()} different pixel${diffPixels !== 1 ? 's' : ''} ` +
          `(${pct}% of page area) at threshold ${threshold}`

        updatePageInfo()
        applyViewMode()
      } catch (err) {
        console.error(err)
        toast('Comparison failed: ' + err.message, 'error')
      } finally {
        comparing = false
        hideProgress()
      }
    }

    // ── Load helper with encryption support ───────────────────────────────────
    async function loadDoc(file, side) {
      const nameEl = side === 'a' ? nameElA : nameElB
      const infoEl = side === 'a' ? infoElA : infoElB

      showProgress(`Loading Document ${side.toUpperCase()}…`)
      try {
        const bytes = await readFile(file)
        let doc
        try {
          doc = await renderer.loadForRender(bytes)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(file.name)
          if (!pwd) return
          showProgress('Decrypting…')
          doc = await renderer.loadForRender(bytes, pwd)
        }

        // Destroy previous document for this slot
        if (side === 'a' && rDocA) rDocA.destroy()
        if (side === 'b' && rDocB) rDocB.destroy()

        if (side === 'a') rDocA = doc
        else              rDocB = doc

        nameEl.textContent = file.name
        infoEl.textContent = `${doc.numPages} page${doc.numPages !== 1 ? 's' : ''}`

        checkReady()
      } catch (err) {
        console.error(err)
        toast(`Failed to load Document ${side.toUpperCase()}: ` + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    // ── Drop zone helper ───────────────────────────────────────────────────────
    function setupDropZone(dropId, browseId, inputId, side) {
      const zone  = container.querySelector(`#${dropId}`)
      const input = container.querySelector(`#${inputId}`)
      zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over') })
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
      zone.addEventListener('drop', e => {
        e.preventDefault(); zone.classList.remove('drag-over')
        const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
        if (f) loadDoc(f, side)
      })
      container.querySelector(`#${browseId}`).addEventListener('click', () => input.click())
      input.addEventListener('change', e => {
        if (e.target.files[0]) { loadDoc(e.target.files[0], side); input.value = '' }
      })
    }

    setupDropZone('pc-drop-a', 'pc-browse-a', 'pc-input-a', 'a')
    setupDropZone('pc-drop-b', 'pc-browse-b', 'pc-input-b', 'b')

    // ── Navigation ─────────────────────────────────────────────────────────────
    prevBtn.addEventListener('click', () => {
      if (curPage > 1) { curPage--; renderPage(curPage) }
    })
    nextBtn.addEventListener('click', () => {
      if (curPage < totalPages) { curPage++; renderPage(curPage) }
    })

    // ── Compare button ─────────────────────────────────────────────────────────
    compareBtn.addEventListener('click', () => renderPage(curPage))

    // ── View mode selector ─────────────────────────────────────────────────────
    container.querySelector('#pc-view-mode').addEventListener('change', () => {
      // If a comparison has already been rendered, just switch the view
      const canvA = container.querySelector('#pc-canvas-a')
      if (canvA.width > 0) {
        applyViewMode()
      }
    })

    // ── Keyboard nav ──────────────────────────────────────────────────────────
    container.addEventListener('keydown', e => {
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (curPage > 1) { curPage--; renderPage(curPage) }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (curPage < totalPages) { curPage++; renderPage(curPage) }
      }
    })

    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '0')
  },
})
