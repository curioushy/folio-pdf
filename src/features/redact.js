/**
 * Redact — draw black rectangles over sensitive content on PDF pages.
 *
 * How it works:
 *   1. Render the page with PDF.js as a preview.
 *   2. User draws redaction boxes by clicking and dragging on the preview.
 *   3. On Apply, pdf-lib draws solid black filled rectangles at the equivalent
 *      positions in the real PDF coordinate space.
 *
 * IMPORTANT NOTE: This tool adds opaque black rectangles OVER the content.
 * The underlying text/graphics bytes remain in the file. For permanent
 * content removal (e.g. sensitive legal documents), use "Flatten to Images"
 * afterward — flattening rasterizes the page, merging the black boxes into
 * the pixels and permanently discarding the underlying data.
 *
 * PDF coordinate note: pdf-lib uses bottom-left origin; canvas is top-left.
 * Conversion: pdfY = pageHeight - (canvasY / scale)
 */

import { registerFeature }                              from '../core/registry.js'
import { readFile, saveAs }                             from '../core/fs.js'
import * as pdf                                         from '../core/pdf.js'
import { loadForRender }                                from '../core/renderer.js'
import { rgb }                                          from '@cantoo/pdf-lib'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { get }                                                               from '../core/state.js'

const BLACK = rgb(0, 0, 0)

registerFeature({
  id:          'redact',
  name:        'Redact',
  category:    'Protect',
  icon:        '⬛',
  description: 'Draw black boxes over sensitive text or images on any page',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Redact</h2>
          <p class="feature-desc">Draw black boxes over sensitive content, then click Apply.
            For permanent removal, also run <strong>Flatten to Images</strong> afterward.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">⬛</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>
      `
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Redact</h2>
        <p class="feature-desc">
          Drag to draw numbered black boxes · click a box to select it ·
          <kbd>Delete</kbd> to remove · click <strong>Apply Redactions</strong> when done.
          For truly permanent removal, also run <strong>Flatten to Images</strong> on the result.
        </p>
      </div>

      <!-- ── Canvas panel ───────────────────────────────────────────────────── -->
      <div class="panel" id="rd-preview-panel" style="display:none;">

        <!-- Toolbar: page nav | box count | clear actions -->
        <div class="rd-toolbar">
          <div class="rd-toolbar-nav">
            <button class="btn btn-sm" id="rd-prev">‹</button>
            <span id="rd-page-label" class="rd-page-label"></span>
            <button class="btn btn-sm" id="rd-next">›</button>
          </div>
          <span id="rd-box-count" class="status-text rd-box-count"></span>
          <div class="rd-toolbar-actions">
            <button class="btn btn-sm" id="rd-clear-page">Clear page</button>
            <button class="btn btn-sm" id="rd-clear-all">Clear all</button>
          </div>
        </div>

        <!-- Canvas + SVG overlay + drag rect -->
        <div style="position:relative;display:block;" id="rd-canvas-wrap">
          <canvas id="rd-canvas"
            style="display:block;width:100%;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:crosshair;"></canvas>
          <svg id="rd-svg"
            style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;"></svg>
          <div id="rd-drag-rect"
            style="display:none;position:absolute;border:2px solid #ef4444;background:rgba(239,68,68,0.2);pointer-events:none;"></div>
        </div>

        <!-- Selection bar (shown when a box is selected) -->
        <div id="rd-sel-bar"
          style="display:none;align-items:center;gap:8px;margin-top:8px;padding:7px 10px;
                 background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.28);
                 border-radius:var(--radius-sm);">
          <span id="rd-sel-label" style="flex:1;font-size:13px;color:var(--text-muted);"></span>
          <button class="btn btn-sm" id="rd-sel-delete"
            style="color:#ef4444;border-color:#ef4444;">🗑 Delete</button>
          <button class="btn btn-sm" id="rd-sel-deselect">Deselect</button>
        </div>

      </div>

      <!-- ── Box Manager ──────────────────────────────────────────────────────── -->
      <div class="panel" id="rd-manager-panel" style="display:none;">
        <div class="panel-header">
          <span class="panel-title">Box Manager</span>
          <span id="rd-manager-count" class="status-text"></span>
        </div>
        <div id="rd-manager-list"
          style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;">
          <span class="status-text" style="padding:8px 0;">No boxes yet — draw on the preview above.</span>
        </div>
      </div>

      <!-- ── Apply bar ──────────────────────────────────────────────────────────── -->
      <div class="action-bar">
        <button class="btn btn-primary btn-lg" id="rd-run" disabled
          style="flex:1;justify-content:center;">
          Apply Redactions
        </button>
        <div class="status-text" id="rd-status"
          style="text-align:center;margin-top:5px;font-size:12px;"></div>
      </div>
    `

    let srcBytes  = null
    let rDoc      = null
    let totalPgs  = 0
    let curPage   = 1
    let scale     = 1
    let pageW     = 1
    let pageH     = 1

    // boxes[pageNum] = [{x,y,w,h}] in PDF points (bottom-left origin)
    const boxes = {}
    // selected: { page, idx } | null
    let selected = null

    const pageLbl      = container.querySelector('#rd-page-label')
    const boxCount     = container.querySelector('#rd-box-count')
    const statusEl     = container.querySelector('#rd-status')
    const runBtn       = container.querySelector('#rd-run')
    const prevBtn      = container.querySelector('#rd-prev')
    const nextBtn      = container.querySelector('#rd-next')
    const previewPanel = container.querySelector('#rd-preview-panel')
    const managerPanel = container.querySelector('#rd-manager-panel')
    const managerList  = container.querySelector('#rd-manager-list')
    const managerCount = container.querySelector('#rd-manager-count')
    const canvas       = container.querySelector('#rd-canvas')
    const ctx          = canvas.getContext('2d')
    const svg          = container.querySelector('#rd-svg')
    const dragRect     = container.querySelector('#rd-drag-rect')
    const wrap         = container.querySelector('#rd-canvas-wrap')
    const selBar       = container.querySelector('#rd-sel-bar')
    const selLabel     = container.querySelector('#rd-sel-label')

    // ── Selection helpers ─────────────────────────────────────────────────────
    function setSelected(page, idx) {
      selected = (page != null && idx != null) ? { page, idx } : null
      const hasSelection = selected !== null
      selBar.style.display = hasSelection ? 'flex' : 'none'
      if (hasSelection) {
        selLabel.textContent = `Page ${selected.page}, Box ${selected.idx + 1} selected`
      }
      drawOverlay()
      renderBoxManager()
    }

    function deleteSelected() {
      if (!selected) return
      const pg  = selected.page
      const idx = selected.idx
      if (boxes[pg]) {
        boxes[pg].splice(idx, 1)
        if (!boxes[pg].length) delete boxes[pg]
      }
      selected = null
      selBar.style.display = 'none'
      if (pg === curPage) drawOverlay()
      updateBoxCount()
      renderBoxManager()
    }

    container.querySelector('#rd-sel-delete').addEventListener('click', deleteSelected)
    container.querySelector('#rd-sel-deselect').addEventListener('click', () => setSelected(null, null))

    // Delete key shortcut
    document.addEventListener('keydown', e => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected &&
          container.isConnected && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault()
        deleteSelected()
      }
    })

    // ── SVG overlay ───────────────────────────────────────────────────────────
    function drawOverlay() {
      svg.innerHTML = ''
      const pg = boxes[curPage] || []
      const scaleX = canvas.width  / pageW
      const scaleY = canvas.height / pageH

      pg.forEach((b, i) => {
        const cx = b.x * scaleX
        const cy = (pageH - b.y - b.h) * scaleY
        const cw = b.w * scaleX
        const ch = b.h * scaleY

        const isSelected = selected?.page === curPage && selected?.idx === i

        // Black fill rectangle
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        rect.setAttribute('x', cx); rect.setAttribute('y', cy)
        rect.setAttribute('width', cw); rect.setAttribute('height', ch)
        rect.setAttribute('fill', 'black')
        if (isSelected) {
          rect.setAttribute('stroke', '#3b82f6')
          rect.setAttribute('stroke-width', '3')
        }
        svg.appendChild(rect)

        // Number label (white text, centred in box)
        const fontSize = Math.max(10, Math.min(20, ch * 0.5, cw * 0.4))
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        text.setAttribute('x', cx + cw / 2)
        text.setAttribute('y', cy + ch / 2 + fontSize * 0.35)
        text.setAttribute('text-anchor', 'middle')
        text.setAttribute('font-size', fontSize)
        text.setAttribute('font-family', 'sans-serif')
        text.setAttribute('font-weight', 'bold')
        text.setAttribute('fill', isSelected ? '#93c5fd' : 'white')
        text.setAttribute('pointer-events', 'none')
        text.textContent = String(i + 1)
        svg.appendChild(text)
      })
    }

    // Click on canvas to select existing box
    canvas.addEventListener('click', e => {
      if (Math.abs(dragMoveDistance) > 6) return  // was a drag, not a click
      const cc = canvasCoords(e)
      const pg = boxes[curPage] || []
      const scaleX = canvas.width  / pageW
      const scaleY = canvas.height / pageH

      // Iterate in reverse so topmost (last drawn) box wins
      for (let i = pg.length - 1; i >= 0; i--) {
        const b = pg[i]
        const cx = b.x * scaleX, cy = (pageH - b.y - b.h) * scaleY
        const cw = b.w * scaleX, ch = b.h * scaleY
        if (cc.x >= cx && cc.x <= cx + cw && cc.y >= cy && cc.y <= cy + ch) {
          if (selected?.page === curPage && selected?.idx === i) {
            setSelected(null, null)  // click selected box again = deselect
          } else {
            setSelected(curPage, i)
          }
          return
        }
      }
      // Clicked empty area — deselect
      setSelected(null, null)
    })

    // ── Box Manager panel ─────────────────────────────────────────────────────
    function renderBoxManager() {
      const allEntries = []
      for (const [pgStr, rects] of Object.entries(boxes)) {
        const pg = parseInt(pgStr)
        rects.forEach((b, idx) => allEntries.push({ pg, idx, b }))
      }

      const total = allEntries.length
      managerCount.textContent = total ? `${total} box${total !== 1 ? 'es' : ''} total` : ''

      if (!total) {
        managerList.innerHTML = '<span class="status-text" style="padding:8px 0;">No boxes yet — draw on the preview above.</span>'
        return
      }

      // Group by page
      const byPage = {}
      for (const e of allEntries) {
        if (!byPage[e.pg]) byPage[e.pg] = []
        byPage[e.pg].push(e)
      }

      managerList.innerHTML = ''
      for (const [pgStr, entries] of Object.entries(byPage).sort((a, b) => a[0] - b[0])) {
        const pg = parseInt(pgStr)
        const pageHead = document.createElement('div')
        pageHead.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-subtle);text-transform:uppercase;letter-spacing:.05em;padding:6px 0 2px;border-top:1px solid var(--border);margin-top:4px;'
        pageHead.textContent = `Page ${pg}`
        managerList.appendChild(pageHead)

        entries.forEach(({ idx, b }) => {
          const isSelected = selected?.page === pg && selected?.idx === idx
          const wMm = (b.w / (72 / 25.4)).toFixed(0)
          const hMm = (b.h / (72 / 25.4)).toFixed(0)

          const row = document.createElement('div')
          row.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer;background:${isSelected ? 'rgba(59,130,246,0.1)' : 'var(--bg)'};border:1px solid ${isSelected ? '#3b82f6' : 'var(--border)'};`
          row.innerHTML = `
            <span style="background:black;color:white;font-size:11px;font-weight:bold;
              min-width:20px;height:20px;border-radius:3px;display:flex;align-items:center;
              justify-content:center;flex-shrink:0;">${idx + 1}</span>
            <span style="flex:1;font-size:12px;color:var(--text-muted);">
              Box ${idx + 1} &nbsp;·&nbsp; ${wMm}×${hMm} mm
            </span>
            <button data-pg="${pg}" data-idx="${idx}"
              style="background:none;border:1px solid #ef4444;color:#ef4444;border-radius:4px;
              padding:2px 8px;font-size:11px;cursor:pointer;flex-shrink:0;">Delete</button>
          `

          // Click row = navigate + select
          row.addEventListener('click', async e => {
            if (e.target.dataset.pg) return  // handled by button below
            if (pg !== curPage) {
              curPage = pg
              await renderCurPage()
            }
            setSelected(pg, idx)
          })

          // Delete button
          row.querySelector('button').addEventListener('click', e => {
            e.stopPropagation()
            if (selected?.page === pg && selected?.idx === idx) selected = null
            boxes[pg].splice(idx, 1)
            if (!boxes[pg].length) delete boxes[pg]
            if (pg === curPage) drawOverlay()
            updateBoxCount()
            renderBoxManager()
            if (selected) selBar.style.display = 'flex'
            else          selBar.style.display = 'none'
          })

          managerList.appendChild(row)
        })
      }
    }

    // ── Count / status ────────────────────────────────────────────────────────
    function updateBoxCount() {
      const all = Object.values(boxes).reduce((s, a) => s + a.length, 0)
      const pg  = (boxes[curPage] || []).length
      boxCount.textContent = pg
        ? `${pg} box${pg !== 1 ? 'es' : ''} on page · ${all} total`
        : all ? `${all} total (none on this page)` : 'No boxes yet'
      statusEl.textContent = all ? `${all} redaction${all > 1 ? 's' : ''} ready` : ''
      runBtn.disabled = all === 0
      managerPanel.style.display = ''  // always visible once PDF loaded
    }

    // ── Rendering ─────────────────────────────────────────────────────────────
    async function renderCurPage() {
      if (!rDoc) return
      const page     = await rDoc.getPage(curPage)
      const viewport = page.getViewport({ scale: 1 })
      pageW = viewport.width
      pageH = viewport.height

      // Use full panel width for the canvas
      const maxW = Math.max(300, (wrap.clientWidth || wrap.parentElement?.clientWidth || 700) - 2)
      scale = maxW / pageW

      const vp = page.getViewport({ scale })
      canvas.width  = Math.round(vp.width)
      canvas.height = Math.round(vp.height)
      await page.render({ canvasContext: ctx, viewport: vp }).promise
      page.cleanup()

      svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`)
      drawOverlay()
      pageLbl.textContent = `${curPage} / ${totalPgs}`
      prevBtn.disabled = curPage <= 1
      nextBtn.disabled = curPage >= totalPgs
      updateBoxCount()
    }

    // ── Drag to draw ──────────────────────────────────────────────────────────
    let dragging = false
    let dragStart = null
    let dragMoveDistance = 0

    function canvasCoords(e) {
      const rect  = canvas.getBoundingClientRect()
      const scaleX = canvas.width  / rect.width
      const scaleY = canvas.height / rect.height
      const src = e.touches ? e.touches[0] : e
      return {
        x: (src.clientX - rect.left) * scaleX,
        y: (src.clientY - rect.top)  * scaleY,
      }
    }

    function showDragRect(x1, y1, x2, y2) {
      const cRect  = canvas.getBoundingClientRect()
      const wRect  = wrap.getBoundingClientRect()
      const scaleX = cRect.width  / canvas.width
      const scaleY = cRect.height / canvas.height
      const lx = Math.min(x1, x2) * scaleX + (cRect.left - wRect.left)
      const ly = Math.min(y1, y2) * scaleY + (cRect.top  - wRect.top)
      const lw = Math.abs(x2 - x1) * scaleX
      const lh = Math.abs(y2 - y1) * scaleY
      dragRect.style.cssText = `display:block;position:absolute;left:${lx}px;top:${ly}px;width:${lw}px;height:${lh}px;border:2px solid #ef4444;background:rgba(239,68,68,0.2);pointer-events:none;`
    }

    canvas.addEventListener('mousedown', e => {
      e.preventDefault()
      dragging = true
      dragMoveDistance = 0
      dragStart = canvasCoords(e)
    })
    window.addEventListener('mousemove', e => {
      if (!dragging || !dragStart) return
      const cur = canvasCoords(e)
      dragMoveDistance = Math.max(Math.abs(cur.x - dragStart.x), Math.abs(cur.y - dragStart.y))
      showDragRect(dragStart.x, dragStart.y, cur.x, cur.y)
    })
    window.addEventListener('mouseup', e => {
      if (!dragging || !dragStart) return
      dragging = false
      const cur = canvasCoords(e)
      dragRect.style.display = 'none'
      if (dragMoveDistance > 6) commitBox(dragStart, cur)
      dragStart = null
    })

    canvas.addEventListener('touchstart', e => {
      e.preventDefault()
      dragging = true
      dragMoveDistance = 0
      dragStart = canvasCoords(e)
    }, { passive: false })
    window.addEventListener('touchmove', e => {
      if (!dragging || !dragStart) return
      const cur = canvasCoords(e)
      dragMoveDistance = Math.max(Math.abs(cur.x - dragStart.x), Math.abs(cur.y - dragStart.y))
      showDragRect(dragStart.x, dragStart.y, cur.x, cur.y)
    })
    window.addEventListener('touchend', e => {
      if (!dragging || !dragStart) return
      dragging = false
      const changedTouch = e.changedTouches[0]
      const rect  = canvas.getBoundingClientRect()
      const sx = canvas.width  / rect.width
      const sy = canvas.height / rect.height
      const cur = {
        x: (changedTouch.clientX - rect.left) * sx,
        y: (changedTouch.clientY - rect.top)  * sy,
      }
      dragRect.style.display = 'none'
      if (dragMoveDistance > 6) commitBox(dragStart, cur)
      dragStart = null
    })

    function commitBox(start, end) {
      const cw = canvas.width, ch = canvas.height
      const x1 = Math.max(0, Math.min(start.x, end.x))
      const y1 = Math.max(0, Math.min(start.y, end.y))
      const x2 = Math.min(cw, Math.max(start.x, end.x))
      const y2 = Math.min(ch, Math.max(start.y, end.y))
      if (x2 - x1 < 4 || y2 - y1 < 4) return

      const pdfX = (x1 / cw) * pageW
      const pdfY = ((ch - y2) / ch) * pageH
      const pdfW = ((x2 - x1) / cw) * pageW
      const pdfH = ((y2 - y1) / ch) * pageH

      if (!boxes[curPage]) boxes[curPage] = []
      boxes[curPage].push({ x: pdfX, y: pdfY, w: pdfW, h: pdfH })
      selected = null
      selBar.style.display = 'none'
      drawOverlay()
      updateBoxCount()
      renderBoxManager()
    }

    // ── Clear buttons ─────────────────────────────────────────────────────────
    container.querySelector('#rd-clear-page').addEventListener('click', () => {
      if (selected?.page === curPage) { selected = null; selBar.style.display = 'none' }
      boxes[curPage] = []
      drawOverlay()
      updateBoxCount()
      renderBoxManager()
    })
    container.querySelector('#rd-clear-all').addEventListener('click', () => {
      Object.keys(boxes).forEach(k => delete boxes[k])
      selected = null
      selBar.style.display = 'none'
      drawOverlay()
      updateBoxCount()
      renderBoxManager()
    })

    // ── Page navigation ───────────────────────────────────────────────────────
    prevBtn.addEventListener('click', () => { if (curPage > 1) { curPage--; renderCurPage() } })
    nextBtn.addEventListener('click', () => { if (curPage < totalPgs) { curPage++; renderCurPage() } })

    // ── PDF loading ───────────────────────────────────────────────────────────
    async function loadFile(file, initialPwd = null) {
      showProgress('Loading PDF…')
      try {
        srcBytes = await readFile(file)
        if (rDoc) rDoc.destroy()
        let pwd = initialPwd
        try {
          rDoc = await loadForRender(srcBytes, pwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          pwd = await promptPassword(file.name)
          if (!pwd) return
          showProgress('Decrypting…')
          rDoc = await loadForRender(srcBytes, pwd)
        }
        totalPgs = rDoc.numPages
        curPage  = 1
        Object.keys(boxes).forEach(k => delete boxes[k])
        previewPanel.style.display = ''
        runBtn.disabled = true
        await renderCurPage()
      } catch (err) {
        console.error(err); toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    // Auto-load from global file state
    setTimeout(() => loadFile(gf.file, gf.pwd), 0)

    // ── Apply ─────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      const totalBoxes = Object.values(boxes).reduce((s, a) => s + a.length, 0)
      if (totalBoxes === 0) {
        toast('Draw at least one redaction box first.', 'warning')
        return
      }
      showProgress('Loading PDF…')
      try {
        const cf = get().currentFile
        let doc
        try {
          doc = await pdf.load(srcBytes, cf.pwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(cf.name)
          if (!pwd) return
          showProgress('Decrypting…')
          doc = await pdf.load(srcBytes, pwd)
        }

        const pages = doc.getPages()
        let applied = 0
        for (const [pageNumStr, rects] of Object.entries(boxes)) {
          const page = pages[parseInt(pageNumStr) - 1]
          if (!page || !rects.length) continue
          const { width, height } = page.getSize()
          for (const b of rects) {
            page.drawRectangle({
              x: b.x, y: b.y, width: b.w, height: b.h,
              color: BLACK, opacity: 1,
              borderWidth: 0,
            })
            applied++
          }
        }

        updateProgress('Saving…')
        const outBytes = await pdf.save(doc)
        const outName  = get().currentFile.name.replace(/\.pdf$/i, '_redacted.pdf')
        await saveAs(outBytes, outName)
        toast(`${applied} area${applied > 1 ? 's' : ''} redacted → ${outName}`, 'success', 5000)
      } catch (err) {
        if (err.name !== 'AbortError') { console.error(err); toast('Failed: ' + err.message, 'error') }
      } finally {
        hideProgress()
      }
    })
  },
})
