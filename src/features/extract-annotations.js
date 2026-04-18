/**
 * Extract Annotations feature — collect all comments, highlights, notes, and
 * other annotations from a PDF and export them as .txt, .csv, or .json.
 *
 * Uses PDF.js getAnnotations() on each page. Widget annotations (form fields)
 * are skipped since those belong to fill-forms.js.
 */

import { registerFeature }                                          from '../core/registry.js'
import { get }                                                      from '../core/state.js'
import { loadForRender }                                            from '../core/renderer.js'
import { readFile }                                                 from '../core/fs.js'
import { toast, showProgress, updateProgress, hideProgress }       from '../core/ui.js'

// ── Annotation type labels ────────────────────────────────────────────────────

const TYPE_LABELS = {
  Text:           'Comment/Note',
  Highlight:      'Highlight',
  Underline:      'Underline',
  StrikeOut:      'Strikethrough',
  FreeText:       'Text Box',
  Square:         'Rectangle',
  Circle:         'Ellipse',
  Ink:            'Drawing',
  Stamp:          'Stamp',
  Link:           'Link',
  FileAttachment: 'File Attachment',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a PDF.js color array [r, g, b] (0–1 floats) to an rgb() string. */
function colorToRgb(color) {
  if (!color || !color.length) return ''
  const [r, g, b] = color
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
}

/** Escape a value for CSV — wrap in quotes if it contains commas, quotes, or newlines. */
function csvCell(val) {
  const s = String(val ?? '')
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

/** Trigger a browser file download from a Blob. */
function downloadBlob(blob, filename) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

/** Strip the .pdf extension from a filename for use in export names. */
function stripPdf(name) {
  return name.replace(/\.pdf$/i, '')
}

// ── Feature ───────────────────────────────────────────────────────────────────

registerFeature({
  id:          'extract-annotations',
  name:        'Annotations',
  category:    'Extract',
  icon:        '💬',
  description: 'Extract comments, highlights, notes, and other annotations from a PDF',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Extract Annotations</h2>
          <p class="feature-desc">Extract comments, highlights, notes, and other annotations from a PDF.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">💬</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>
      `
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Extract Annotations</h2>
        <p class="feature-desc">
          Extract comments, highlights, notes, and other annotations from a PDF.
          Form fields are excluded — use <strong>Fill Forms</strong> for those.
        </p>
      </div>

      <div class="panel" style="margin-bottom:16px;">
        <div class="panel-header">
          <span class="panel-title">${gf.name}</span>
          <span class="status-text">${gf.pageCount} page${gf.pageCount !== 1 ? 's' : ''}</span>
        </div>
        <div class="action-bar" style="padding-top:0;">
          <button class="btn btn-primary" id="annot-scan">💬 Scan for Annotations</button>
          <span class="status-text" id="annot-status" style="margin-left:12px;"></span>
        </div>
      </div>

      <div id="annot-results-panel" style="display:none;">
        <div class="panel" style="margin-bottom:16px;">
          <div class="panel-header">
            <span class="panel-title" id="annot-count-label"></span>
            <div style="display:flex;gap:6px;align-items:center;">
              <button class="btn btn-sm" id="annot-export-txt">⬇ .txt</button>
              <button class="btn btn-sm" id="annot-export-csv">⬇ .csv</button>
              <button class="btn btn-sm" id="annot-export-json">⬇ .json</button>
            </div>
          </div>

          <div id="annot-type-breakdown"
            style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;margin-bottom:4px;"></div>
        </div>

        <div id="annot-page-groups"></div>
      </div>
    `

    // ── Element refs ──────────────────────────────────────────────────────────
    const scanBtn       = container.querySelector('#annot-scan')
    const statusEl      = container.querySelector('#annot-status')
    const resultsPanel  = container.querySelector('#annot-results-panel')
    const countLabel    = container.querySelector('#annot-count-label')
    const breakdown     = container.querySelector('#annot-type-breakdown')
    const pageGroups    = container.querySelector('#annot-page-groups')

    /** All collected annotation objects — populated on scan. */
    let allAnnotations = []

    // ── Scan ──────────────────────────────────────────────────────────────────
    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true
      resultsPanel.style.display = 'none'
      allAnnotations = []

      showProgress('Loading PDF…')
      try {
        const cf    = get().currentFile
        const bytes = await readFile(cf.file)

        let doc
        try {
          doc = await loadForRender(bytes, gf.pwd || undefined)
        } catch (err) {
          hideProgress()
          toast('Failed to load PDF: ' + err.message, 'error')
          scanBtn.disabled = false
          return
        }

        const total = doc.numPages

        for (let p = 1; p <= total; p++) {
          updateProgress(`Scanning annotations: page ${p} of ${total}…`)
          const page        = await doc.getPage(p)
          const annotations = await page.getAnnotations()
          page.cleanup()

          for (const annot of annotations) {
            if (annot.subtype === 'Widget') continue   // form fields — skip

            allAnnotations.push({
              page:    p,
              type:    annot.subtype,
              author:  annot.titleObj?.str || annot.title || '',
              content: annot.contentsObj?.str || annot.contents || '',
              color:   annot.color ? colorToRgb(annot.color) : '',
            })
          }
        }

        doc.destroy()

        if (allAnnotations.length === 0) {
          statusEl.textContent = 'No annotations found.'
          toast('No annotations found.', 'warning')
          scanBtn.disabled = false
          return
        }

        statusEl.textContent = ''
        renderResults(allAnnotations, cf)
        toast(`Found ${allAnnotations.length} annotation${allAnnotations.length !== 1 ? 's' : ''}.`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Scan failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
        scanBtn.disabled = false
      }
    })

    // ── Render results ────────────────────────────────────────────────────────
    function renderResults(annotations, cf) {
      // Count label
      countLabel.textContent = `${annotations.length} annotation${annotations.length !== 1 ? 's' : ''} found`

      // Type breakdown badges
      const typeCounts = {}
      for (const a of annotations) {
        const label = TYPE_LABELS[a.type] || a.type
        typeCounts[label] = (typeCounts[label] || 0) + 1
      }
      breakdown.innerHTML = Object.entries(typeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) =>
          `<span class="badge badge-blue">${label}: ${count}</span>`
        ).join('')

      // Group by page
      const byPage = {}
      for (const a of annotations) {
        if (!byPage[a.page]) byPage[a.page] = []
        byPage[a.page].push(a)
      }

      pageGroups.innerHTML = Object.entries(byPage)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([pageNum, pageAnnots]) => `
          <div style="margin-bottom:20px;">
            <div style="
              background:var(--blue);
              color:#fff;
              padding:6px 12px;
              border-radius:var(--radius-sm);
              font-size:13px;
              font-weight:600;
              margin-bottom:8px;
            ">Page ${pageNum}</div>
            ${pageAnnots.map(a => renderAnnotCard(a)).join('')}
          </div>
        `).join('')

      // Export button wiring (re-wire on each scan)
      container.querySelector('#annot-export-txt').onclick  = () => exportTxt(annotations, cf)
      container.querySelector('#annot-export-csv').onclick  = () => exportCsv(annotations, cf)
      container.querySelector('#annot-export-json').onclick = () => exportJson(annotations, cf)

      resultsPanel.style.display = 'block'
    }

    // ── Annotation card ───────────────────────────────────────────────────────
    function renderAnnotCard(a) {
      const label       = TYPE_LABELS[a.type] || a.type
      const borderColor = a.color || 'var(--border-dark)'
      const authorHtml  = a.author
        ? `<span style="font-size:11px;color:var(--text-muted);margin-left:8px;">by ${escHtml(a.author)}</span>`
        : ''
      const contentHtml = a.content
        ? `<p style="margin:6px 0 0;font-size:13px;line-height:1.5;white-space:pre-wrap;">${escHtml(a.content)}</p>`
        : `<p style="margin:6px 0 0;font-size:13px;font-style:italic;color:var(--text-muted);">No text content</p>`

      return `
        <div style="
          border-left:4px solid ${borderColor};
          background:var(--surface);
          border-radius:var(--radius-sm);
          padding:10px 12px;
          margin-bottom:8px;
        ">
          <div style="display:flex;align-items:center;gap:0;">
            <span style="font-size:12px;font-weight:600;color:var(--text);">${escHtml(label)}</span>
            ${authorHtml}
          </div>
          ${contentHtml}
        </div>
      `
    }

    // ── HTML escaping ─────────────────────────────────────────────────────────
    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    // ── Exports ───────────────────────────────────────────────────────────────
    function exportTxt(annotations, cf) {
      const base  = stripPdf(cf.name)
      const lines = [`Annotations — ${cf.name}`, '']

      const byPage = {}
      for (const a of annotations) {
        if (!byPage[a.page]) byPage[a.page] = []
        byPage[a.page].push(a)
      }

      for (const [pageNum, pageAnnots] of Object.entries(byPage).sort(([a], [b]) => Number(a) - Number(b))) {
        lines.push(`── Page ${pageNum} ──`)
        for (const a of pageAnnots) {
          const label = TYPE_LABELS[a.type] || a.type
          lines.push(`[${label}]${a.author ? ` (${a.author})` : ''}`)
          lines.push(a.content || '(no text content)')
          lines.push('')
        }
      }

      downloadBlob(new Blob([lines.join('\n')], { type: 'text/plain' }), `${base}_annotations.txt`)
    }

    function exportCsv(annotations, cf) {
      const base = stripPdf(cf.name)
      const rows = [['Page', 'Type', 'Author', 'Content'].map(csvCell).join(',')]

      for (const a of annotations) {
        const label = TYPE_LABELS[a.type] || a.type
        rows.push([a.page, label, a.author, a.content].map(csvCell).join(','))
      }

      downloadBlob(new Blob([rows.join('\r\n')], { type: 'text/csv' }), `${base}_annotations.csv`)
    }

    function exportJson(annotations, cf) {
      const base = stripPdf(cf.name)
      downloadBlob(
        new Blob([JSON.stringify(allAnnotations, null, 2)], { type: 'application/json' }),
        `${base}_annotations.json`
      )
    }
  },
})
