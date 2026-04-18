/**
 * Application bootstrap.
 *
 * Shell responsibilities:
 *   - Sidebar file slot  (global open-PDF state)
 *   - Feature nav        (collapsible categories, search, active highlight)
 *   - Navigation         (render feature into #feature-content)
 *   - PDF Viewer         (page view + thumbnail grid when a file is open)
 */

import { get, update, subscribe }                from './state.js'
import { toast, showProgress, hideProgress, promptPassword } from './ui.js'
import { load as pdfLoad }                       from './pdf.js'
import { loadForRender, renderPage }             from './renderer.js'
import { getFeatures, getFeature }               from './registry.js'

// Trigger feature self-registration (side-effects only)
import '../features/index.js'

// ── Viewer state (module-level) ───────────────────────────────────────────────

let viewerRenderDoc  = null   // PDF.js PDFDocumentProxy for the current file
let viewerSourceFile = null   // File object — identity check to detect file swaps
let viewerPage       = 1
let viewerMode       = 'single'   // 'single' | 'thumbs'
let viewerZoom       = 100        // percent; 100 = fit width
let viewerAbort      = null       // AbortController for keyboard / scroll listeners

const ZOOM_STEPS = [25, 33, 50, 67, 75, 100, 125, 150, 200, 300, 400]

// ── Navigation ────────────────────────────────────────────────────────────────

export function navigate(featureId) {
  const feature = getFeature(featureId)
  if (!feature) return

  // Kill any active viewer keyboard handler
  viewerAbort?.abort()
  viewerAbort = null

  update({ activeFeature: featureId })

  const container = document.getElementById('feature-content')
  container.innerHTML = ''
  feature.render(container)
  container.scrollTop = 0
}

// ── Welcome screen ────────────────────────────────────────────────────────────

function showWelcome() {
  viewerAbort?.abort()
  viewerAbort = null
  update({ activeFeature: null })
  const container = document.getElementById('feature-content')
  container.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">⬡</div>
      <h1>Folio <span style="font-weight:400;opacity:.45;">PDF</span></h1>
      <p class="welcome-tagline">An Exploratory Project by Curious HY</p>
      <label class="welcome-drop-zone" id="welcome-drop-zone">
        <input type="file" accept=".pdf" style="display:none" id="welcome-file-input">
        <span class="welcome-drop-icon">📄</span>
        <span class="welcome-drop-label">Open PDF</span>
        <span class="welcome-drop-sub">or drag &amp; drop a file here</span>
      </label>
    </div>
  `
  container.scrollTop = 0

  // Wire the welcome drop zone
  const dropZone  = container.querySelector('#welcome-drop-zone')
  const fileInput = container.querySelector('#welcome-file-input')
  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) openGlobalFile(e.target.files[0])
  })
  dropZone.addEventListener('dragover', e => {
    e.preventDefault(); dropZone.classList.add('wdz-drag')
  })
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('wdz-drag'))
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('wdz-drag')
    const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
    if (f) openGlobalFile(f)
  })
}

// ── PDF Viewer ────────────────────────────────────────────────────────────────

export function showViewer() {
  const state = get()
  if (!state.currentFile) return

  // Kill previous viewer listeners
  viewerAbort?.abort()
  viewerAbort = new AbortController()

  update({ activeFeature: null })

  const cf        = state.currentFile
  const container = document.getElementById('feature-content')
  container.innerHTML = ''
  container.scrollTop = 0

  // Clamp helper
  const clamp = n => Math.max(1, Math.min(n, cf.pageCount))
  viewerPage = clamp(viewerPage)

  // ── Build shell ──────────────────────────────────────────────────────────
  const bar = document.createElement('div')
  bar.className = 'viewer-bar'
  bar.innerHTML = `
    <div class="viewer-nav" id="viewer-nav-group">
      <button class="viewer-btn" id="viewer-prev" title="Previous page (←)">‹</button>
      <span class="viewer-page-info">
        <span id="viewer-pg">${viewerPage}</span><span class="viewer-of"> of ${cf.pageCount}</span>
      </span>
      <button class="viewer-btn" id="viewer-next" title="Next page (→)">›</button>
    </div>
    <div class="viewer-zoom-group">
      <button class="viewer-btn" id="viewer-zoom-out" title="Zoom out">−</button>
      <input class="viewer-zoom-input" id="viewer-zoom-val" type="text"
        value="${viewerZoom}%" title="Zoom level — type a percentage or use +/−">
      <button class="viewer-btn" id="viewer-zoom-in"  title="Zoom in">+</button>
    </div>
    <div class="viewer-mode-btns">
      <button class="viewer-mode-btn${viewerMode === 'single' ? ' active' : ''}" id="viewer-single">Page</button>
      <button class="viewer-mode-btn${viewerMode === 'thumbs'  ? ' active' : ''}" id="viewer-thumbs">Thumbnails</button>
      <button class="viewer-btn viewer-fs-btn" id="viewer-fs" title="Fullscreen">⛶</button>
    </div>
  `

  const content = document.createElement('div')
  content.className = 'viewer-content'

  container.appendChild(bar)
  container.appendChild(content)

  // ── Wire controls ────────────────────────────────────────────────────────
  const prevBtn    = bar.querySelector('#viewer-prev')
  const nextBtn    = bar.querySelector('#viewer-next')
  const pgSpan     = bar.querySelector('#viewer-pg')
  const singleBtn  = bar.querySelector('#viewer-single')
  const thumbsBtn  = bar.querySelector('#viewer-thumbs')
  const zoomOutBtn = bar.querySelector('#viewer-zoom-out')
  const zoomInBtn  = bar.querySelector('#viewer-zoom-in')
  const zoomInput  = bar.querySelector('#viewer-zoom-val')
  const fsBtn      = bar.querySelector('#viewer-fs')

  function updateNavVis() {
    const hidden = viewerMode !== 'single'
    bar.querySelector('#viewer-nav-group').style.visibility  = hidden ? 'hidden' : ''
    bar.querySelector('.viewer-zoom-group').style.visibility = hidden ? 'hidden' : ''
  }

  function setPage(n) {
    viewerPage = clamp(n)
    pgSpan.textContent = viewerPage
    prevBtn.disabled = viewerPage <= 1
    nextBtn.disabled = viewerPage >= cf.pageCount
    if (viewerMode === 'single') renderSingle()
  }

  prevBtn.addEventListener('click', () => setPage(viewerPage - 1))
  nextBtn.addEventListener('click', () => setPage(viewerPage + 1))
  prevBtn.disabled = viewerPage <= 1
  nextBtn.disabled = viewerPage >= cf.pageCount

  // ── Zoom controls ──────────────────────────────────────────────────────
  function applyZoom(z) {
    viewerZoom = Math.max(25, Math.min(400, Math.round(z)))
    zoomInput.value = viewerZoom + '%'
    if (viewerMode === 'single') renderSingle()
  }

  zoomOutBtn.addEventListener('click', () => {
    const prev = [...ZOOM_STEPS].reverse().find(s => s < viewerZoom)
    applyZoom(prev ?? 25)
  })
  zoomInBtn.addEventListener('click', () => {
    const next = ZOOM_STEPS.find(s => s > viewerZoom)
    applyZoom(next ?? 400)
  })
  zoomInput.addEventListener('change', () => {
    const raw = parseInt(zoomInput.value.replace('%', '').trim())
    if (!isNaN(raw)) applyZoom(raw)
    else zoomInput.value = viewerZoom + '%'
  })
  zoomInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.target.blur() }
  })

  singleBtn.addEventListener('click', () => {
    viewerMode = 'single'
    singleBtn.classList.add('active')
    thumbsBtn.classList.remove('active')
    updateNavVis()
    content.innerHTML = ''
    renderSingle()
  })

  thumbsBtn.addEventListener('click', () => {
    viewerMode = 'thumbs'
    thumbsBtn.classList.add('active')
    singleBtn.classList.remove('active')
    updateNavVis()
    content.innerHTML = ''
    renderThumbs()
  })

  updateNavVis()

  // ── Fullscreen ─────────────────────────────────────────────────────────
  const mainArea = document.querySelector('.main-area')

  function updateFsBtn() {
    const isFs = !!document.fullscreenElement
    fsBtn.classList.toggle('active', isFs)
    fsBtn.title = isFs ? 'Exit fullscreen (Esc)' : 'Fullscreen'
  }

  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      mainArea.requestFullscreen().catch(() => {})
    }
  })

  document.addEventListener('fullscreenchange', () => {
    updateFsBtn()
    // Re-render at new container width after fullscreen transition settles
    if (viewerMode === 'single') setTimeout(renderSingle, 80)
  }, { signal: viewerAbort.signal })

  updateFsBtn()

  // ── Keyboard navigation ────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName ?? ''
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (viewerMode === 'single') {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setPage(viewerPage + 1) }
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); setPage(viewerPage - 1) }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomInBtn.click() }
      if (e.key === '-')                  { e.preventDefault(); zoomOutBtn.click() }
    } else if (viewerMode === 'thumbs') {
      const cols = colCount()
      if (e.key === 'ArrowRight')              { e.preventDefault(); setThumbFocus(thumbFocusPage + 1) }
      else if (e.key === 'ArrowLeft')          { e.preventDefault(); setThumbFocus(thumbFocusPage - 1) }
      else if (e.key === 'ArrowDown')          { e.preventDefault(); setThumbFocus(thumbFocusPage + cols) }
      else if (e.key === 'ArrowUp')            { e.preventDefault(); setThumbFocus(thumbFocusPage - cols) }
      else if (e.key === 'Home')               { e.preventDefault(); setThumbFocus(1) }
      else if (e.key === 'End')                { e.preventDefault(); setThumbFocus(cf.pageCount) }
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (thumbFocusPage > 0) { viewerPage = thumbFocusPage; viewerMode = 'single'; showViewer() }
      }
    }
  }, { signal: viewerAbort.signal })

  // ── Single-page renderer ─────────────────────────────────────────────────
  let renderToken = 0

  async function renderSingle() {
    const token = ++renderToken
    content.innerHTML = '<div class="viewer-loading">Rendering…</div>'

    const doc = await ensureViewerDoc(cf)
    if (token !== renderToken) return
    if (!doc) {
      content.innerHTML = '<div class="viewer-loading viewer-error">Failed to render PDF.</div>'
      return
    }

    let page
    try { page = await doc.getPage(viewerPage) }
    catch { content.innerHTML = '<div class="viewer-loading viewer-error">Page unavailable.</div>'; return }
    if (token !== renderToken) { page.cleanup(); return }

    const viewport     = page.getViewport({ scale: 1 })
    const availW       = Math.max(content.clientWidth - 48, 300)
    const fitScale     = availW / viewport.width
    const displayScale = fitScale * (viewerZoom / 100)

    // Render canvas at device pixel ratio for sharp display on HiDPI/retina screens
    const dpr       = Math.min(window.devicePixelRatio || 1, 3)
    const renderVP  = page.getViewport({ scale: displayScale * dpr })
    const displayVP = page.getViewport({ scale: displayScale })
    const cssW      = Math.round(displayVP.width)
    const cssH      = Math.round(displayVP.height)

    const canvas   = document.createElement('canvas')
    canvas.width   = Math.round(renderVP.width)
    canvas.height  = Math.round(renderVP.height)
    canvas.style.cssText = `display:block;width:${cssW}px;height:${cssH}px;box-shadow:var(--shadow-lg);border-radius:2px;background:#fff;`

    // Render canvas + fetch text content in parallel
    const [, textContent] = await Promise.all([
      page.render({ canvasContext: canvas.getContext('2d'), viewport: renderVP }).promise,
      page.getTextContent().catch(() => null),
    ])
    if (token !== renderToken) { page.cleanup(); return }

    // Text layer — invisible spans positioned over glyphs, enabling select + copy
    const textLayer = document.createElement('div')
    textLayer.className = 'viewer-text-layer'
    if (textContent && pdfjsLib.renderTextLayer) {
      try {
        await pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container:         textLayer,
          viewport:          displayVP,
        }).promise
      } catch { /* scanned/image PDFs have no text — silently skip */ }
    }

    page.cleanup()
    if (token !== renderToken) return

    content.innerHTML = ''
    const pageWrap = document.createElement('div')
    pageWrap.style.cssText = `position:relative;width:${cssW}px;height:${cssH}px;margin:0 auto;box-shadow:var(--shadow-lg);border-radius:2px;flex-shrink:0;`
    // Remove box-shadow from canvas itself (now on wrapper)
    canvas.style.boxShadow = ''
    canvas.style.borderRadius = ''
    pageWrap.appendChild(canvas)
    pageWrap.appendChild(textLayer)

    const wrap = document.createElement('div')
    wrap.style.cssText = 'padding:20px 24px 32px;display:flex;justify-content:center;'
    wrap.appendChild(pageWrap)
    content.appendChild(wrap)
  }

  // ── Thumbnail-grid renderer ──────────────────────────────────────────────
  let thumbFocusPage = 0   // 1-based; 0 = none

  function setThumbFocus(p, scroll = true) {
    const prev = thumbFocusPage
    thumbFocusPage = Math.max(1, Math.min(p, cf.pageCount))
    // Update visual focus
    const grid = content.querySelector('.viewer-thumbs')
    if (!grid) return
    grid.querySelectorAll('.viewer-thumb-cell').forEach(cell => {
      cell.classList.toggle('viewer-thumb-focused', parseInt(cell.dataset.page) === thumbFocusPage)
    })
    // Scroll into view
    if (scroll) {
      const focusedCell = grid.querySelector(`.viewer-thumb-cell[data-page="${thumbFocusPage}"]`)
      focusedCell?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }

  function colCount() {
    const grid = content.querySelector('.viewer-thumbs')
    if (!grid) return 4
    // gridTemplateColumns gives the actual computed track sizes e.g. "140px 140px 140px"
    const tracks = getComputedStyle(grid).gridTemplateColumns
    return tracks.split(' ').length || 4
  }

  function renderThumbs() {
    content.innerHTML = '<div class="viewer-loading">Loading thumbnails…</div>'

    ensureViewerDoc(cf).then(doc => {
      if (!doc) {
        content.innerHTML = '<div class="viewer-loading viewer-error">Failed to render PDF.</div>'
        return
      }

      content.innerHTML = ''
      const grid = document.createElement('div')
      grid.className = 'viewer-thumbs'
      content.appendChild(grid)

      for (let p = 1; p <= cf.pageCount; p++) {
        const cell = document.createElement('div')
        cell.className        = 'viewer-thumb-cell'
        cell.dataset.page     = String(p)
        cell.dataset.rendered = '0'

        const ph = document.createElement('div')
        ph.className = 'viewer-thumb-ph'

        const lbl = document.createElement('div')
        lbl.className   = 'viewer-thumb-lbl'
        lbl.textContent = String(p)

        cell.appendChild(ph)
        cell.appendChild(lbl)

        // Click → switch to single-page mode at this page
        cell.addEventListener('click', () => {
          viewerPage = p
          viewerMode = 'single'
          showViewer()
        })

        grid.appendChild(cell)
      }

      // Set initial keyboard focus to current viewerPage
      thumbFocusPage = 0
      setThumbFocus(viewerPage, false)

      // Lazy rendering via getBoundingClientRect (IntersectionObserver is
      // unreliable inside overflow:auto containers)
      const BUFFER = 250
      let painting = false

      function paintVisible() {
        if (painting) return
        painting = true
        requestAnimationFrame(async () => {
          painting = false
          const cr = content.getBoundingClientRect()
          const cells = grid.querySelectorAll('.viewer-thumb-cell[data-rendered="0"]')
          for (const cell of cells) {
            const r = cell.getBoundingClientRect()
            if (r.bottom >= cr.top - BUFFER && r.top <= cr.bottom + BUFFER) {
              cell.dataset.rendered = '1'
              const pageNum = parseInt(cell.dataset.page)
              try {
                const thumbW = cell.clientWidth || 140
                const canvas = await renderPage(doc, pageNum, thumbW)
                canvas.style.cssText = 'display:block;width:100%;border-radius:2px;'
                cell.querySelector('.viewer-thumb-ph')?.replaceWith(canvas)
              } catch {
                const ph = cell.querySelector('.viewer-thumb-ph')
                if (ph) ph.textContent = '!'
              }
            }
          }
        })
      }

      content.addEventListener('scroll', paintVisible, { signal: viewerAbort.signal })
      setTimeout(paintVisible, 60)
    })
  }

  // ── Initial render ───────────────────────────────────────────────────────
  if (viewerMode === 'single') renderSingle()
  else renderThumbs()
}

/** Load (or reuse) the PDF.js document for `cf`. */
async function ensureViewerDoc(cf) {
  if (viewerRenderDoc && viewerSourceFile === cf.file) return viewerRenderDoc

  // Destroy stale doc
  if (viewerRenderDoc) {
    viewerRenderDoc.destroy().catch(() => {})
    viewerRenderDoc  = null
    viewerSourceFile = null
  }

  try {
    const bytes      = await cf.file.arrayBuffer()
    viewerRenderDoc  = await loadForRender(bytes, cf.pwd)
    viewerSourceFile = cf.file
    return viewerRenderDoc
  } catch {
    return null
  }
}

// ── Sidebar file slot ─────────────────────────────────────────────────────────

function renderFileSlot() {
  const slot = document.getElementById('sidebar-file-slot')

  // Hidden file input — created once, lives outside the slot so innerHTML
  // reassignment never destroys the listener.
  const fileInput = document.createElement('input')
  fileInput.type    = 'file'
  fileInput.accept  = '.pdf'
  fileInput.style.display = 'none'
  document.body.appendChild(fileInput)
  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) { openGlobalFile(e.target.files[0]); fileInput.value = '' }
  })

  // Persistent drag events (survive innerHTML replacements)
  slot.addEventListener('dragover',  e => { e.preventDefault(); slot.classList.add('sfs-drag') })
  slot.addEventListener('dragleave', ()  => slot.classList.remove('sfs-drag'))
  slot.addEventListener('drop', e => {
    e.preventDefault()
    slot.classList.remove('sfs-drag')
    const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
    if (f) openGlobalFile(f)
  })

  function draw(state) {
    slot.classList.remove('sfs-drag')
    const cf = state.currentFile

    if (cf) {
      slot.className = 'sidebar-file-slot sfs-loaded'
      slot.onclick   = null

      const icon = document.createElement('span')
      icon.className   = 'sfs-icon'
      icon.textContent = '📄'

      const info = document.createElement('div')
      info.className = 'sfs-info'
      info.title     = 'Back to viewer'
      info.style.cursor = 'pointer'

      const name = document.createElement('span')
      name.className   = 'sfs-name'
      name.textContent = cf.name
      name.title       = cf.name

      const meta = document.createElement('span')
      meta.className   = 'sfs-meta'
      meta.textContent = cf.pageCount === 1 ? '1 page' : `${cf.pageCount} pages`

      info.appendChild(name)
      info.appendChild(meta)
      info.addEventListener('click', () => showViewer())

      const close = document.createElement('button')
      close.className   = 'sfs-close'
      close.title       = 'Close file'
      close.textContent = '×'
      close.addEventListener('click', e => {
        e.stopPropagation()
        update({ currentFile: null })
      })

      slot.innerHTML = ''
      slot.appendChild(icon)
      slot.appendChild(info)
      slot.appendChild(close)

    } else {
      slot.className = 'sidebar-file-slot sfs-empty'
      slot.innerHTML = `
        <button class="sfs-open-btn" type="button">📄&nbsp; Open PDF</button>
        <span class="sfs-drop-hint">or drag &amp; drop a file here</span>
      `
      slot.onclick = () => fileInput.click()
    }
  }

  // Re-render the content area whenever the global file changes
  let prevFile = get().currentFile
  subscribe(state => {
    const fileChanged = state.currentFile !== prevFile
    if (fileChanged) {
      const wasNull = prevFile === null
      prevFile = state.currentFile

      if (!state.currentFile) {
        // File closed → destroy viewer doc + show welcome
        if (viewerRenderDoc) {
          viewerRenderDoc.destroy().catch(() => {})
          viewerRenderDoc  = null
          viewerSourceFile = null
        }
        viewerPage = 1
        showWelcome()
      } else if (wasNull) {
        // File opened from no-file state
        viewerPage = 1
        viewerMode = 'single'
        viewerZoom = 100
        // If user had already navigated to a feature, re-render it (now with file).
        // Otherwise show the viewer.
        if (state.activeFeature) navigate(state.activeFeature)
        else showViewer()
      } else {
        // File swapped while another was already open → re-render current view
        viewerPage = 1
        viewerMode = 'single'
        viewerZoom = 100
        if (state.activeFeature) navigate(state.activeFeature)
        else showViewer()
      }
    }
    draw(state)
  })

  draw(get())
}

async function openGlobalFile(file) {
  showProgress('Opening…')
  try {
    const bytes = await file.arrayBuffer()
    let pageCount, pwd = null

    try {
      const doc = await pdfLoad(bytes)
      pageCount = doc.getPageCount()
    } catch (err) {
      if (err.code !== 'ENCRYPTED') throw err
      hideProgress()
      pwd = await promptPassword(file.name)
      if (!pwd) return
      showProgress('Decrypting…')
      const doc = await pdfLoad(bytes, pwd)
      pageCount = doc.getPageCount()
    }

    update({ currentFile: { file, name: file.name, pwd, pageCount } })
    // subscribe handler in renderFileSlot drives the viewer/feature routing

  } catch (err) {
    if (err.name !== 'AbortError') toast('Could not open file: ' + err.message, 'error')
  } finally {
    hideProgress()
  }
}

// ── Feature nav ───────────────────────────────────────────────────────────────

// Store which categories are EXPANDED (default = none = all collapsed)
const NAV_EXPAND_KEY = 'folio-nav-expanded'

function loadExpanded() {
  try { return new Set(JSON.parse(localStorage.getItem(NAV_EXPAND_KEY) || '[]')) }
  catch { return new Set() }
}
function saveExpanded(set) {
  try { localStorage.setItem(NAV_EXPAND_KEY, JSON.stringify([...set])) } catch {}
}

function renderNav() {
  const navWrap = document.getElementById('feature-nav')

  navWrap.innerHTML = `
    <div class="nav-search-wrap">
      <input id="nav-search" class="nav-search" placeholder="Search tools…" autocomplete="off" spellcheck="false">
      <button id="nav-search-clear" class="nav-search-clear" title="Clear">✕</button>
    </div>
  `

  const searchInput = navWrap.querySelector('#nav-search')
  const searchClear = navWrap.querySelector('#nav-search-clear')

  // Group features by category, preserving insertion order
  const categories = {}
  getFeatures().forEach(f => {
    if (!categories[f.category]) categories[f.category] = []
    categories[f.category].push(f)
  })

  const expanded = loadExpanded()

  Object.entries(categories).forEach(([cat, feats]) => {
    const section = document.createElement('div')
    section.className   = 'nav-section'
    section.dataset.cat = cat

    // Default: collapsed. Only expand if in the saved expanded set.
    if (!expanded.has(cat)) section.classList.add('collapsed')

    const hdr = document.createElement('div')
    hdr.className = 'nav-category'
    hdr.innerHTML = `<span>${cat}</span><span class="nav-chevron">›</span>`
    section.appendChild(hdr)

    feats.forEach(f => {
      const btn = document.createElement('button')
      btn.className         = 'nav-item'
      btn.dataset.featureId = f.id
      btn.title             = f.description ?? ''
      btn.innerHTML         = `<span class="nav-icon">${f.icon}</span><span>${f.name}</span>`
      btn.addEventListener('click', () => navigate(f.id))
      section.appendChild(btn)
    })

    hdr.addEventListener('click', () => {
      if (searchInput.value.trim()) return   // no collapse while searching
      section.classList.toggle('collapsed')
      if (section.classList.contains('collapsed')) {
        expanded.delete(cat)
      } else {
        expanded.add(cat)
      }
      saveExpanded(expanded)
    })

    navWrap.appendChild(section)
  })

  // ── Search filter ──────────────────────────────────────────────────────────
  function applySearch(q) {
    const term = q.trim().toLowerCase()
    searchClear.style.display = term ? 'flex' : 'none'
    navWrap.querySelectorAll('.nav-section').forEach(section => {
      let anyVisible = false
      section.querySelectorAll('.nav-item').forEach(btn => {
        const match = !term || btn.querySelector('span:last-child').textContent.toLowerCase().includes(term)
        btn.style.display = match ? '' : 'none'
        if (match) anyVisible = true
      })
      section.style.display = anyVisible ? '' : 'none'
      if (term) section.classList.remove('collapsed')   // force-expand matches
    })
  }

  searchInput.addEventListener('input', () => applySearch(searchInput.value))
  searchClear.addEventListener('click', () => {
    searchInput.value = ''
    applySearch('')
    navWrap.querySelectorAll('.nav-section').forEach(section => {
      section.style.display = ''
      section.querySelectorAll('.nav-item').forEach(btn => btn.style.display = '')
      if (!expanded.has(section.dataset.cat)) section.classList.add('collapsed')
    })
  })

  // ── Active highlight + auto-expand section ─────────────────────────────────
  subscribe(({ activeFeature }) => {
    navWrap.querySelectorAll('.nav-item').forEach(btn => {
      const isActive = btn.dataset.featureId === activeFeature
      btn.classList.toggle('active', isActive)
      if (isActive) {
        const section = btn.closest('.nav-section')
        if (section?.classList.contains('collapsed')) {
          section.classList.remove('collapsed')
          expanded.add(section.dataset.cat)
          saveExpanded(expanded)
        }
      }
    })
  })
}

// ── Version label ─────────────────────────────────────────────────────────────

function stampVersion() {
  document.querySelectorAll('.sidebar-version').forEach(el => {
    if (el.textContent.includes('{{VERSION}}')) {
      el.textContent = typeof __APP_VERSION__ !== 'undefined' ? `v${__APP_VERSION__}` : 'v?'
    }
  })
}

// ── Boot ──────────────────────────────────────────────────────────────────────

export function boot() {
  stampVersion()
  renderFileSlot()
  renderNav()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
