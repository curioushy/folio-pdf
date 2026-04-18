/**
 * Extract Images feature — pull embedded raster images out of a PDF.
 *
 * Uses PDF.js `getOperatorList()` to walk each page's operator stream, looking
 * for image-painting ops (`paintImageXObject`, `paintJpegXObject`, and inline
 * variants). For each one we grab the decoded pixel data via `page.objs` and
 * re-encode it as PNG or JPEG.
 *
 * Notes:
 *   • Deduplicates by XObject name (same name across pages → one file).
 *   • Output naming: `<prefix>_p<page>_<idx>.<ext>` so users can locate the
 *     source page of each image at a glance.
 *   • Vector graphics and text are NOT extracted — only raster images.
 */

import { registerFeature }                                         from '../core/registry.js'
import { readFile }                                                from '../core/fs.js'
import * as renderer                                               from '../core/renderer.js'
import * as pdfjsLib                                               from 'pdfjs-dist'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, parsePageRange }                                from '../core/utils.js'
import { get }                                                    from '../core/state.js'

const IMAGE_OPS = new Set()   // populated lazily — depends on pdfjsLib.OPS

function imageOpsFor(OPS) {
  if (IMAGE_OPS.size) return IMAGE_OPS
  ;[
    'paintImageXObject',
    'paintJpegXObject',
    'paintImageXObjectRepeat',
    'paintInlineImageXObject',
  ].forEach(n => { if (OPS[n] != null) IMAGE_OPS.add(OPS[n]) })
  return IMAGE_OPS
}

/**
 * Wait for `page.objs.get(name)` to return an image object.
 * PDF.js resolves these asynchronously; we poll with a callback.
 */
function getImageObj(page, name) {
  return new Promise((resolve, reject) => {
    try {
      page.objs.get(name, img => resolve(img))
    } catch (err) { reject(err) }
  })
}

/**
 * Draw an image object (PDF.js ImageData-like: { data, width, height, kind }) to
 * a fresh canvas and return the canvas. Handles both RGBA and RGB source data.
 */
function imageToCanvas(img) {
  const w = img.width
  const h = img.height
  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  const ctx     = canvas.getContext('2d')

  // If the image object is already an ImageBitmap / HTMLImage, draw directly.
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0, w, h)
    return canvas
  }
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
    ctx.drawImage(img, 0, 0, w, h)
    return canvas
  }

  // Otherwise convert raw pixel buffer → ImageData
  const src    = img.data
  const pixels = ctx.createImageData(w, h)
  const dst    = pixels.data

  // PDF.js `kind`: 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
  if (img.kind === 3 || (src.length === w * h * 4)) {
    dst.set(src)
  } else if (img.kind === 2 || src.length === w * h * 3) {
    for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
      dst[j    ] = src[i    ]
      dst[j + 1] = src[i + 1]
      dst[j + 2] = src[i + 2]
      dst[j + 3] = 255
    }
  } else if (src.length === w * h) {
    // Grayscale 8-bit
    for (let i = 0, j = 0; i < src.length; i++, j += 4) {
      dst[j] = dst[j + 1] = dst[j + 2] = src[i]
      dst[j + 3] = 255
    }
  } else {
    // Unknown layout — best-effort RGBA
    dst.set(src.subarray(0, Math.min(src.length, dst.length)))
  }
  ctx.putImageData(pixels, 0, 0)
  return canvas
}

registerFeature({
  id:          'extract-images',
  name:        'Extract Images',
  category:    'Extract',
  icon:        '🎨',
  description: 'Pull embedded images out of a PDF and save them as files',

  render(container) {
    const gf = get().currentFile
    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Extract Images</h2>
          <p class="feature-desc">Find raster images embedded in the PDF and save each one as a separate image file.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">🖼</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>
      `
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Extract Images</h2>
        <p class="feature-desc">
          Find raster images embedded in <strong style="color:var(--text);">${gf.name}</strong> and save each one as a separate
          image file. Text and vector graphics are not extracted — only bitmap
          images (photos, scans, logos).
        </p>
      </div>

      <div class="feature-split">

        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Source PDF</span></div>

          <div class="section-label" style="margin-top:14px;">Format</div>
          <div class="option-row">
            <label>Save as</label>
            <select id="ei-format" class="input" style="max-width:160px;">
              <option value="png" selected>PNG (lossless)</option>
              <option value="jpeg">JPEG (smaller)</option>
            </select>
          </div>

          <div class="option-row" id="ei-quality-row" style="display:none;">
            <label>JPEG quality <span id="ei-quality-val">92%</span></label>
            <input type="range" id="ei-quality" min="50" max="100" value="92" style="flex:1;">
          </div>

          <div class="section-label" style="margin-top:14px;">Pages</div>
          <div class="option-row">
            <label>Scan</label>
            <select id="ei-pages-sel" class="input" style="max-width:180px;">
              <option value="all">All pages</option>
              <option value="custom">Custom range…</option>
            </select>
          </div>
          <div id="ei-pages-custom-row" class="option-row" style="display:none;">
            <label>Range</label>
            <input type="text" id="ei-pages-custom" class="input"
              placeholder="e.g. 1-3, 5, 8-10" style="max-width:200px;">
          </div>

          <div class="section-label" style="margin-top:14px;">Filter</div>
          <div class="option-row">
            <label>Skip small</label>
            <select id="ei-min-size" class="input" style="max-width:200px;">
              <option value="0">Keep all images</option>
              <option value="64" selected>Skip under 64×64 px</option>
              <option value="128">Skip under 128×128 px</option>
              <option value="256">Skip under 256×256 px</option>
            </select>
          </div>
          <span class="status-text" style="display:block;margin-top:4px;">
            Useful for skipping tiny icons, bullets and background fills.
          </span>
        </div>

        <div class="panel">
          <div class="panel-header"><span class="panel-title">② Export to Folder</span></div>

          <div class="option-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
            <label style="min-width:unset;">Filename prefix</label>
            <input type="text" id="ei-prefix" class="input" placeholder="image">
            <span class="status-text" style="margin-top:2px;">
              Files will be named: <em>prefix_p01_1.png</em>, <em>prefix_p01_2.png</em>, …
            </span>
          </div>

          <div style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="ei-run"
              style="width:100%;justify-content:center;">
              Extract Images…
            </button>
            <div class="status-text" id="ei-status" style="text-align:center;margin-top:8px;">
              Ready.
            </div>
          </div>

          <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border);">
            <p style="font-size:12px;color:var(--text-subtle);line-height:1.7;">
              ℹ You will be asked to choose a destination folder. Duplicate images
              (the same logo reused on many pages) are saved only once.
              <br><br>
              If the PDF is a scan, every page is one big image — you'll get one
              image per page. For true "photos embedded in a document", this tool
              extracts each unique bitmap.
              <br><br>
              <strong style="color:var(--text-muted);">Resolution:</strong>
              Images are extracted at their <em>native embedded resolution</em> —
              exactly the pixel dimensions the author placed in the PDF. There is
              no source data to recover a higher resolution from.
              If you need high-resolution renderings of entire pages (e.g. for a
              scanned document), use <strong>PDF → Images</strong> at 300 dpi instead.
            </p>
          </div>
        </div>

      </div>
    `

    const runBtn   = container.querySelector('#ei-run')
    const statusEl = container.querySelector('#ei-status')

    container.querySelector('#ei-prefix').value = stripExt(gf.name)

    // Format toggles quality slider
    container.querySelector('#ei-format').addEventListener('change', e => {
      container.querySelector('#ei-quality-row').style.display =
        e.target.value === 'jpeg' ? 'flex' : 'none'
    })
    const qualitySlider = container.querySelector('#ei-quality')
    const qualityLabel  = container.querySelector('#ei-quality-val')
    qualitySlider.addEventListener('input', () => {
      qualityLabel.textContent = qualitySlider.value + '%'
    })

    // Pages selector
    container.querySelector('#ei-pages-sel').addEventListener('change', e => {
      container.querySelector('#ei-pages-custom-row').style.display =
        e.target.value === 'custom' ? 'flex' : 'none'
    })

    // ── Run ───────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      const { file: srcFile, pwd: srcPwd } = get().currentFile
      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(srcFile)
        let rDoc
        try {
          rDoc = await renderer.loadForRender(bytes)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          showProgress('Decrypting…')
          rDoc = await renderer.loadForRender(bytes, pwd)
        }

        const format    = container.querySelector('#ei-format').value
        const quality   = parseInt(qualitySlider.value) / 100
        const minSize   = parseInt(container.querySelector('#ei-min-size').value)
        const prefix    = container.querySelector('#ei-prefix').value.trim() || 'image'
        const mimeType  = format === 'jpeg' ? 'image/jpeg' : 'image/png'
        const ext       = format === 'jpeg' ? 'jpg' : 'png'
        const totalPgs  = rDoc.numPages

        // Resolve page list (1-based)
        let pageNums
        if (container.querySelector('#ei-pages-sel').value === 'custom') {
          const raw  = container.querySelector('#ei-pages-custom').value.trim()
          const idxs = parsePageRange(raw, totalPgs)
          if (!idxs.length) {
            toast('Invalid page range.', 'warning')
            rDoc.destroy(); hideProgress(); return
          }
          pageNums = idxs.map(i => i + 1)
        } else {
          pageNums = Array.from({ length: totalPgs }, (_, i) => i + 1)
        }

        // Ask user where to save
        updateProgress('Choose a destination folder…')
        let destDir
        try {
          destDir = await window.showDirectoryPicker({ mode: 'readwrite' })
        } catch {
          rDoc.destroy(); hideProgress(); return   // user cancelled
        }

        const OPS = pdfjsLib.OPS
        const imageOps = imageOpsFor(OPS)

        const seenNames = new Set()   // dedup
        let savedCount = 0
        let skippedSmall = 0

        for (let i = 0; i < pageNums.length; i++) {
          const pNum = pageNums[i]
          updateProgress(`Scanning page ${pNum} (${i + 1}/${pageNums.length}) — ${savedCount} image${savedCount === 1 ? '' : 's'} so far…`)

          const page = await rDoc.getPage(pNum)
          const ops  = await page.getOperatorList()

          // Collect image-op arguments in order: each is a [name, ...] tuple
          const imagesOnPage = []   // [{ name, inline }]
          for (let k = 0; k < ops.fnArray.length; k++) {
            if (!imageOps.has(ops.fnArray[k])) continue
            const args = ops.argsArray[k]
            const name = args?.[0]
            if (ops.fnArray[k] === OPS.paintInlineImageXObject) {
              // Inline images: the object itself is the first arg (not a name)
              imagesOnPage.push({ obj: name, inline: true })
            } else if (typeof name === 'string') {
              imagesOnPage.push({ name, inline: false })
            }
          }

          let pageIdx = 0
          for (const entry of imagesOnPage) {
            pageIdx++
            let img
            try {
              if (entry.inline) {
                img = entry.obj
              } else {
                if (seenNames.has(entry.name)) continue   // dedup
                seenNames.add(entry.name)
                img = await getImageObj(page, entry.name)
              }
            } catch {
              continue
            }
            if (!img || !img.width || !img.height) continue
            if (minSize && (img.width < minSize || img.height < minSize)) {
              skippedSmall++; continue
            }

            let canvas
            try {
              canvas = imageToCanvas(img)
            } catch (e) {
              console.warn('extract-images: failed to render', e)
              continue
            }

            const blob = await new Promise(res =>
              canvas.toBlob(res, mimeType, quality))
            if (!blob) continue

            const pPad  = String(pNum).padStart(String(totalPgs).length, '0')
            const fname = `${prefix}_p${pPad}_${pageIdx}.${ext}`

            const fh       = await destDir.getFileHandle(fname, { create: true })
            const writable = await fh.createWritable()
            await writable.write(blob)
            await writable.close()
            savedCount++
          }

          page.cleanup()
        }

        rDoc.destroy()

        if (savedCount === 0) {
          const hint = skippedSmall
            ? ` (${skippedSmall} tiny image${skippedSmall > 1 ? 's' : ''} skipped — lower the size filter to include them)`
            : ''
          toast(`No images found in the selected pages${hint}.`, 'warning', 5000)
          statusEl.textContent = 'Nothing to extract.'
        } else {
          const extra = skippedSmall ? ` (${skippedSmall} small skipped)` : ''
          toast(`${savedCount} image${savedCount > 1 ? 's' : ''} saved to "${destDir.name}"${extra}`, 'success')
          statusEl.textContent = `Done — ${savedCount} image${savedCount > 1 ? 's' : ''} extracted as ${ext.toUpperCase()}.`
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    })
  },
})
