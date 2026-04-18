/**
 * Images → PDF — combine JPG/PNG/WEBP images into a single PDF.
 *
 * Page sizing modes:
 *   'fit'     — page size matches the image's pixel dimensions (72 dpi assumption)
 *   'a4'      — A4 (595 × 841 pt); image scaled to fit within margins, centred
 *   'letter'  — Letter (612 × 792 pt); image scaled to fit within margins, centred
 *
 * WEBP (and any format pdf-lib can't embed natively) is converted to PNG via
 * an off-screen canvas before embedding.
 */

import { registerFeature }                                        from '../core/registry.js'
import { saveAs }                                                 from '../core/fs.js'
import * as pdf                                                   from '../core/pdf.js'
import { toast, showProgress, updateProgress, hideProgress }      from '../core/ui.js'
import { stripExt, ensurePdf }                                    from '../core/utils.js'

const PAGE_SIZES = {
  a4:     [595.28, 841.89],
  letter: [612,    792   ],
}
const MARGIN = 28   // pt — padding inside A4/Letter pages

registerFeature({
  id:          'images-to-pdf',
  name:        'Images → PDF',
  category:    'Multi-file',
  icon:        '🖼',
  description: 'Combine JPG, PNG or WEBP images into a single PDF',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Images → PDF</h2>
        <p class="feature-desc">Drag &amp; drop images below, reorder them, then export as a PDF. Supports JPG, PNG and WEBP.</p>
      </div>

      <div class="feature-split">

        <!-- ── Image queue ────────────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">① Images</span>
            <span id="img-count" class="status-text">0 images</span>
          </div>

          <div class="file-drop-zone" id="img-drop">
            <span>Drag images here, or</span>
            <button class="btn btn-sm" id="img-browse">Browse</button>
            <input type="file" id="img-input" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple hidden>
          </div>

          <div id="img-list" class="img-queue"></div>
        </div>

        <!-- ── Options + Output ───────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">② Options</span>
          </div>

          <div class="section-label">Page size</div>
          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">
            <label class="option-row" style="gap:8px;">
              <input type="radio" name="img-pagesize" value="fit" checked>
              <span>
                <strong>Fit to image</strong><br>
                <small>Each page is exactly the image's pixel size</small>
              </span>
            </label>
            <label class="option-row" style="gap:8px;">
              <input type="radio" name="img-pagesize" value="a4">
              <span>
                <strong>A4</strong> <small>(210 × 297 mm)</small><br>
                <small>Image scaled to fit, centred with margins</small>
              </span>
            </label>
            <label class="option-row" style="gap:8px;">
              <input type="radio" name="img-pagesize" value="letter">
              <span>
                <strong>Letter</strong> <small>(8.5 × 11 in)</small><br>
                <small>Image scaled to fit, centred with margins</small>
              </span>
            </label>
          </div>

          <div style="border-top:1px solid var(--border);margin:14px 0;"></div>

          <div class="option-row">
            <label>Output filename</label>
            <input type="text" id="img-output" class="input" value="images.pdf" style="flex:1;">
          </div>

          <div style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="img-run" disabled style="width:100%;justify-content:center;">
              Create PDF
            </button>
            <div class="status-text" id="img-status" style="text-align:center;margin-top:8px;">
              Add at least one image.
            </div>
          </div>
        </div>

      </div>
    `

    // queue: [{ id, file, previewUrl }]
    const queue    = []
    let   nextId   = 0
    let   dragSrc  = null

    const listEl   = container.querySelector('#img-list')
    const countEl  = container.querySelector('#img-count')
    const runBtn   = container.querySelector('#img-run')
    const statusEl = container.querySelector('#img-status')

    // ── Queue rendering ───────────────────────────────────────────────────────
    function renderList() {
      listEl.innerHTML = ''
      if (!queue.length) {
        listEl.innerHTML = '<div class="empty-hint">No images added yet.</div>'
      } else {
        queue.forEach((item, i) => {
          const row = document.createElement('div')
          row.className      = 'img-row'
          row.draggable      = true
          row.dataset.idx    = i

          row.innerHTML = `
            <span class="drag-handle" title="Drag to reorder">⠿</span>
            <img src="${item.previewUrl}" class="img-thumb" alt="">
            <span class="img-name" title="${item.file.name}">${item.file.name}</span>
            <span class="status-text" style="white-space:nowrap;">${fmtSize(item.file.size)}</span>
            <button class="btn-icon" data-remove="${i}" title="Remove">✕</button>
          `

          // Drag to reorder
          row.addEventListener('dragstart', e => {
            dragSrc = i; row.classList.add('dragging')
            e.dataTransfer.effectAllowed = 'move'
          })
          row.addEventListener('dragend',  () => row.classList.remove('dragging'))
          row.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' })
          row.addEventListener('drop',     e => {
            e.preventDefault()
            if (dragSrc === null || dragSrc === i) return
            const [moved] = queue.splice(dragSrc, 1)
            queue.splice(i, 0, moved)
            dragSrc = null
            renderList()
          })

          // Remove button
          row.querySelector('[data-remove]').addEventListener('click', () => {
            URL.revokeObjectURL(item.previewUrl)
            queue.splice(i, 1)
            renderList()
          })

          listEl.appendChild(row)
        })
      }

      countEl.textContent  = `${queue.length} image${queue.length !== 1 ? 's' : ''}`
      runBtn.disabled      = queue.length === 0
      statusEl.textContent = queue.length === 0
        ? 'Add at least one image.'
        : `Ready — ${queue.length} page${queue.length !== 1 ? 's' : ''} in output PDF.`
    }

    function addFiles(files) {
      const accepted = [...files].filter(f =>
        /\.(jpe?g|png|webp)$/i.test(f.name) || f.type.startsWith('image/')
      )
      accepted.forEach(file => {
        queue.push({ id: nextId++, file, previewUrl: URL.createObjectURL(file) })
      })
      renderList()
    }

    // ── File picker + drop ────────────────────────────────────────────────────
    const dropZone  = container.querySelector('#img-drop')
    const fileInput = container.querySelector('#img-input')

    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      addFiles(e.dataTransfer.files)
    })
    container.querySelector('#img-browse').addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', e => { addFiles(e.target.files); fileInput.value = '' })

    // ── Run ───────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      const pageSize = container.querySelector('input[name="img-pagesize"]:checked').value
      const outName  = ensurePdf(container.querySelector('#img-output').value.trim() || 'images')

      showProgress('Creating PDF…')
      try {
        const { PDFDocument } = await import('@cantoo/pdf-lib')
        const doc = await PDFDocument.create()

        for (let i = 0; i < queue.length; i++) {
          const item = queue[i]
          updateProgress(`Embedding image ${i + 1} of ${queue.length}…`)

          const bytes    = await item.file.arrayBuffer()
          const isJpeg   = /\.(jpe?g)$/i.test(item.file.name) || item.file.type === 'image/jpeg'
          const isPng    = /\.png$/i.test(item.file.name)      || item.file.type === 'image/png'

          let imgEmbed
          if (isJpeg) {
            imgEmbed = await doc.embedJpg(bytes)
          } else if (isPng) {
            imgEmbed = await doc.embedPng(bytes)
          } else {
            // WEBP or other — convert via canvas
            const pngBytes = await convertToPng(item.file)
            imgEmbed = await doc.embedPng(pngBytes)
          }

          const { width: imgW, height: imgH } = imgEmbed

          let pageW, pageH, drawX, drawY, drawW, drawH

          if (pageSize === 'fit') {
            pageW = imgW; pageH = imgH
            drawX = 0;    drawY = 0
            drawW = imgW; drawH = imgH
          } else {
            const [pw, ph] = PAGE_SIZES[pageSize]
            const available = { w: pw - MARGIN * 2, h: ph - MARGIN * 2 }
            const scale     = Math.min(available.w / imgW, available.h / imgH)
            drawW = imgW * scale
            drawH = imgH * scale
            drawX = (pw - drawW) / 2
            drawY = (ph - drawH) / 2
            pageW = pw; pageH = ph
          }

          const page = doc.addPage([pageW, pageH])
          page.drawImage(imgEmbed, { x: drawX, y: drawY, width: drawW, height: drawH })
        }

        updateProgress('Saving…')
        const { PDFName } = await import('@cantoo/pdf-lib')
        const outBytes = await doc.save()
        await saveAs(outBytes, outName)
        toast(`Created ${queue.length}-page PDF → ${outName}`, 'success')
        statusEl.textContent = `Done — ${queue.length} pages saved.`
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })

    renderList()
  },
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSize(bytes) {
  if (bytes < 1024)      return bytes + ' B'
  if (bytes < 1048576)   return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1048576).toFixed(2) + ' MB'
}

/**
 * Convert any browser-supported image file to PNG bytes via an offscreen canvas.
 * Used for WEBP and any other format pdf-lib can't embed natively.
 * @param {File} file
 * @returns {Promise<Uint8Array>}
 */
async function convertToPng(file) {
  const url    = URL.createObjectURL(file)
  const img    = new Image()
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url })
  URL.revokeObjectURL(url)

  const canvas    = document.createElement('canvas')
  canvas.width    = img.naturalWidth
  canvas.height   = img.naturalHeight
  canvas.getContext('2d').drawImage(img, 0, 0)

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) { reject(new Error('Canvas conversion failed')); return }
      blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf))).catch(reject)
    }, 'image/png')
  })
}
