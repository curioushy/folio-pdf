/**
 * Extract Text feature — pull all text content from a PDF using PDF.js.
 *
 * Three layout modes:
 *   plain  — concatenate all text items, no added spacing
 *   lines  — respect visual line breaks via item.hasEOL  (default)
 *   table  — use x/y coordinates to reconstruct column structure with tabs
 *            (tab-separated output pastes directly into Excel / Sheets)
 */

import { registerFeature }                                         from '../core/registry.js'
import { readFile }                                                from '../core/fs.js'
import * as renderer                                               from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt }                                                from '../core/utils.js'
import { get }                                                    from '../core/state.js'

// ── Minimal DOCX builder (no external dependency) ─────────────────────────────
// A .docx is a ZIP file containing a handful of XML files.
// We build an uncompressed ZIP (stored) to avoid needing a compression library.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

function crc32(data) {
  let crc = 0xFFFFFFFF
  for (const b of data) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function concatBytes(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const a of arrays) { out.set(a, pos); pos += a.length }
  return out
}

function buildZip(files) {
  // files: [{ name: string, data: Uint8Array }]
  const enc   = new TextEncoder()
  const parts = []
  const dirs  = []
  let offset  = 0

  for (const { name, data } of files) {
    const nb  = enc.encode(name)
    const crc = crc32(data)

    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0,  0x04034b50, true);  lh.setUint16(4,  20, true)
    lh.setUint16(6,  0, true);           lh.setUint16(8,  0, true)
    lh.setUint16(10, 0, true);           lh.setUint16(12, 0, true)
    lh.setUint32(14, crc, true);         lh.setUint32(18, data.length, true)
    lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length,   true)
    lh.setUint16(28, 0, true)
    parts.push(new Uint8Array(lh.buffer), nb, data)

    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0,  0x02014b50, true);  cd.setUint16(4,  20, true)
    cd.setUint16(6,  20, true);          cd.setUint16(8,  0, true)
    cd.setUint16(10, 0, true);           cd.setUint16(12, 0, true)
    cd.setUint16(14, 0, true);           cd.setUint32(16, crc, true)
    cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true)
    cd.setUint16(28, nb.length, true);   cd.setUint16(30, 0, true)
    cd.setUint16(32, 0, true);           cd.setUint16(34, 0, true)
    cd.setUint16(36, 0, true);           cd.setUint32(38, 0, true)
    cd.setUint32(42, offset, true)
    dirs.push(new Uint8Array(cd.buffer), nb)

    offset += 30 + nb.length + data.length
  }

  const cdBytes  = concatBytes(dirs)
  const eocd     = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0,  0x06054b50, true); eocd.setUint16(4,  0, true)
  eocd.setUint16(6,  0, true);          eocd.setUint16(8,  files.length, true)
  eocd.setUint16(10, files.length, true)
  eocd.setUint32(12, cdBytes.length, true); eocd.setUint32(16, offset, true)
  eocd.setUint16(20, 0, true)

  return concatBytes([...parts, cdBytes, new Uint8Array(eocd.buffer)])
}

function escXml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
         .replace(/"/g,'&quot;').replace(/'/g,'&apos;')
}

function buildDocx(text) {
  const enc  = new TextEncoder()
  const enc8 = s => enc.encode(s)

  // Convert text to DOCX paragraphs: each \n → new paragraph
  const lines = text.split('\n')
  const paras = lines.map(line => {
    if (!line.trim()) return '<w:p/>'
    return `<w:p><w:r><w:t xml:space="preserve">${escXml(line)}</w:t></w:r></w:p>`
  }).join('')

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`

  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

  const wordRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`

  const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`

  return buildZip([
    { name: '[Content_Types].xml',         data: enc8(contentTypes) },
    { name: '_rels/.rels',                  data: enc8(rels) },
    { name: 'word/document.xml',            data: enc8(document) },
    { name: 'word/_rels/document.xml.rels', data: enc8(wordRels) },
  ])
}

// ── Text extraction helpers ───────────────────────────────────────────────────

/** Plain: concatenate every str in document order. */
function extractPlain(items) {
  return items
    .filter(i => 'str' in i)
    .map(i => i.str)
    .join('')
    .trim()
}

/** Lines: join text items and insert \n wherever PDF.js sets hasEOL. */
function extractLines(items) {
  let text = ''
  for (const item of items) {
    if (!('str' in item)) continue
    text += item.str
    if (item.hasEOL) text += '\n'
  }
  return text.trim()
}

/**
 * Table-aware: group items into rows by y-coordinate, sort each row left-to-right,
 * and insert a tab wherever the horizontal gap between adjacent items exceeds
 * COL_GAP points. Word-sized gaps get a regular space; overlapping items are
 * concatenated directly.
 *
 * Works best for grid-style tables. Free-flowing paragraphs will still be
 * readable but may have extra tabs in wide-margin layouts.
 */
function extractTable(items) {
  const ROW_SNAP = 4   // pt — y-diff ≤ this → same visual row
  const COL_GAP  = 8   // pt — x-gap  > this → new column (insert tab)

  const ti = items
    .filter(i => 'str' in i && i.str !== '')
    .map(i => ({
      str:   i.str,
      x:     i.transform[4],
      y:     i.transform[5],
      right: i.transform[4] + (i.width || 0),
    }))

  if (!ti.length) return ''

  // Sort by y descending (top of page = highest y in PDF coords)
  ti.sort((a, b) => b.y - a.y)

  // Bucket into rows: first item in each run sets the row's reference y
  const rows = []
  for (const item of ti) {
    const last = rows[rows.length - 1]
    if (!last || Math.abs(item.y - last.refY) > ROW_SNAP) {
      rows.push({ refY: item.y, items: [item] })
    } else {
      last.items.push(item)
    }
  }

  // Render each row left-to-right, inserting tabs at column gaps
  return rows.map(({ items: row }) => {
    row.sort((a, b) => a.x - b.x)

    let line      = ''
    let prevRight = null

    for (const item of row) {
      if (prevRight !== null) {
        const gap = item.x - prevRight
        if (gap > COL_GAP) {
          line += '\t'
        } else if (gap > 0 && !line.endsWith(' ') && !item.str.startsWith(' ')) {
          line += ' '   // narrow gap → ordinary word space
        }
        // gap ≤ 0 (overlap / tight kerning) → concatenate directly
      }
      line      += item.str
      prevRight  = item.right > item.x ? item.right : item.x  // guard zero-width items
    }
    return line
  }).join('\n')
}

// ── Feature ───────────────────────────────────────────────────────────────────

registerFeature({
  id:          'extract-text',
  name:        'Extract Text',
  category:    'Extract',
  icon:        '⌨',
  description: 'Copy all readable text from a PDF to clipboard or a .txt file',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Extract Text</h2>
          <p class="feature-desc">Pull all text from a PDF's built-in text layer.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">⌨</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>
      `
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Extract Text</h2>
        <p class="feature-desc">
          Pull all text from a PDF's built-in text layer. Scanned (image-only) PDFs
          won't yield text — OCR software is needed for those.
          <strong style="color:var(--text);">${gf.name}</strong>
        </p>
      </div>

      <div class="feature-split">

        <!-- ── Options ──────────────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header"><span class="panel-title">Options</span></div>

          <div class="section-label">Layout mode</div>
          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
            <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px;">
              <input type="radio" name="ext-mode" value="plain" style="margin-top:2px;accent-color:var(--blue);">
              <span>
                <strong>Plain</strong>
                <span style="color:var(--text-muted);"> — all text joined, no added spacing</span>
              </span>
            </label>
            <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px;">
              <input type="radio" name="ext-mode" value="lines" checked style="margin-top:2px;accent-color:var(--blue);">
              <span>
                <strong>Lines</strong>
                <span style="color:var(--text-muted);"> — visual line breaks preserved</span>
              </span>
            </label>
            <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px;">
              <input type="radio" name="ext-mode" value="table" style="margin-top:2px;accent-color:var(--blue);">
              <span>
                <strong>Table-aware</strong>
                <span style="color:var(--text-muted);"> — column gaps become tabs</span>
              </span>
            </label>
          </div>

          <div id="ext-table-hint" style="display:none;padding:8px 10px;
            background:var(--blue-light);border:1px solid var(--blue);
            border-radius:var(--radius-sm);font-size:12px;color:var(--blue);
            margin-bottom:10px;line-height:1.5;">
            📋 Output is tab-separated. Paste directly into
            <strong>Excel</strong> or <strong>Google Sheets</strong> to
            restore column layout.
          </div>

          <div class="option-row" style="align-items:center;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" id="ext-page-sep" checked>
              Add page separators
            </label>
          </div>

          <div style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="ext-run" disabled
              style="width:100%;justify-content:center;">
              Extract Text
            </button>
            <div class="status-text" id="ext-status" style="text-align:center;margin-top:8px;">
              Load a PDF to get started.
            </div>
          </div>

          <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border);">
            <p style="font-size:12px;color:var(--text-subtle);line-height:1.7;">
              ℹ Requires a built-in text layer. Scanned PDFs (images of pages) will
              produce no text — use OCR software for those.
              <br><br>
              Table-aware mode uses the x/y position of each character to detect column
              boundaries. It works well for grid tables; free-flowing prose may have
              extra tabs in wide-margin areas.
            </p>
          </div>
        </div>

        <!-- ── Preview + Export ─────────────────────────────────────────── -->
        <div class="panel" style="display:flex;flex-direction:column;">
          <div class="panel-header">
            <span class="panel-title">② Extracted Text</span>
            <div id="ext-actions" style="display:none;gap:6px;align-items:center;" class="ext-action-row">
              <button class="btn btn-sm" id="ext-copy">📋 Copy</button>
              <button class="btn btn-sm" id="ext-save">💾 .txt</button>
              <button class="btn btn-sm" id="ext-save-docx">📄 .docx</button>
            </div>
          </div>

          <textarea id="ext-preview" class="ext-textarea"
            placeholder="Extracted text will appear here after clicking Extract Text."
            readonly></textarea>
          <div class="status-text" id="ext-char-count"
            style="text-align:right;margin-top:6px;min-height:16px;"></div>
        </div>

      </div>
    `

    let lastText = ''
    const runBtn    = container.querySelector('#ext-run')
    const statusEl  = container.querySelector('#ext-status')
    const previewEl = container.querySelector('#ext-preview')
    const actionsEl = container.querySelector('#ext-actions')
    const charEl    = container.querySelector('#ext-char-count')
    const tableHint = container.querySelector('#ext-table-hint')

    // ── Mode change — show/hide table hint ────────────────────────────────────
    container.querySelectorAll('input[name="ext-mode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const isTable = container.querySelector('input[name="ext-mode"]:checked').value === 'table'
        tableHint.style.display = isTable ? 'block' : 'none'
      })
    })

    // File ready from global state — enable run button
    runBtn.disabled      = false
    statusEl.textContent = 'Ready.'

    // ── Run ───────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      showProgress('Loading PDF…')
      try {
        const cf    = get().currentFile
        const bytes = await readFile(cf.file)
        let rDoc
        try {
          rDoc = await renderer.loadForRender(bytes, cf.pwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(cf.name)
          if (!pwd) return
          showProgress('Decrypting…')
          rDoc = await renderer.loadForRender(bytes, pwd)
        }

        const mode       = container.querySelector('input[name="ext-mode"]:checked').value
        const pageSep    = container.querySelector('#ext-page-sep').checked
        const totalPages = rDoc.numPages
        const parts      = []

        for (let p = 1; p <= totalPages; p++) {
          updateProgress(`Extracting text: page ${p} of ${totalPages}…`)

          const page    = await rDoc.getPage(p)
          const content = await page.getTextContent()
          page.cleanup()

          let pageText
          if      (mode === 'plain') pageText = extractPlain(content.items)
          else if (mode === 'table') pageText = extractTable(content.items)
          else                       pageText = extractLines(content.items)

          const trimmed = pageText.trim()
          if (pageSep && trimmed) {
            parts.push(`── Page ${p} ──\n${trimmed}`)
          } else if (trimmed) {
            parts.push(trimmed)
          }
        }

        rDoc.destroy()

        lastText = parts.join('\n\n')
        previewEl.value = lastText

        const hasText = lastText.trim().length > 0
        charEl.textContent = hasText
          ? `${lastText.length.toLocaleString()} characters · ${totalPages} page${totalPages > 1 ? 's' : ''} · ${mode} mode`
          : ''

        actionsEl.style.display = hasText ? 'flex' : 'none'
        statusEl.textContent    = hasText
          ? `Done — ${totalPages} page${totalPages > 1 ? 's' : ''} extracted.`
          : 'Done — no text layer found. This may be a scanned PDF.'

        toast(hasText ? 'Text extracted.' : 'No text found (scanned PDF?).', hasText ? 'success' : 'warning')
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    })

    // ── Copy to clipboard ─────────────────────────────────────────────────────
    container.querySelector('#ext-copy').addEventListener('click', async () => {
      if (!lastText) return
      try {
        await navigator.clipboard.writeText(lastText)
        toast('Copied to clipboard.', 'success')
      } catch {
        toast('Clipboard unavailable — select all in the preview and copy manually.', 'warning')
      }
    })

    // ── Save .txt ─────────────────────────────────────────────────────────────
    container.querySelector('#ext-save').addEventListener('click', async () => {
      if (!lastText) return
      const mode = container.querySelector('input[name="ext-mode"]:checked').value
      const suggestedName = stripExt(get().currentFile.name) + (mode === 'table' ? '_table.txt' : '_text.txt')
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'Text file', accept: { 'text/plain': ['.txt'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(lastText)
        await writable.close()
        toast(`Saved → ${handle.name}`, 'success')
      } catch (e) {
        if (e.name !== 'AbortError') toast('Save failed: ' + e.message, 'error')
      }
    })

    // ── Save .docx ────────────────────────────────────────────────────────────
    container.querySelector('#ext-save-docx').addEventListener('click', async () => {
      if (!lastText) return
      const mode = container.querySelector('input[name="ext-mode"]:checked').value
      const suggestedName = stripExt(get().currentFile.name) + (mode === 'table' ? '_table.docx' : '_text.docx')
      try {
        const docxBytes = buildDocx(lastText)
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'Word Document', accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(docxBytes)
        await writable.close()
        toast(`Saved → ${handle.name}`, 'success')
      } catch (e) {
        if (e.name !== 'AbortError') toast('Save failed: ' + e.message, 'error')
      }
    })

  },
})
