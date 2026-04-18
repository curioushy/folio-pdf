/**
 * Document Stats feature — word count, reading time and text statistics.
 *
 * Runs automatically when the feature renders: loads the PDF via PDF.js,
 * extracts text content from every page, and displays aggregate stats plus
 * a per-page breakdown table.
 */

import { registerFeature }                                         from '../core/registry.js'
import { readFile }                                                from '../core/fs.js'
import { loadForRender }                                           from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress }       from '../core/ui.js'
import { get }                                                     from '../core/state.js'

const fmt = n => n.toLocaleString()

function readingTime(words) {
  const WPM     = 238
  const minutes = words / WPM
  if (minutes < 1)   return 'Under 1 min'
  if (minutes < 60)  return `~${Math.round(minutes)} min`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`
}

function statCard(label, value, sub) {
  return `
    <div style="
      background:var(--bg);
      border:1px solid var(--border);
      border-radius:var(--radius);
      padding:16px;
      text-align:center;
    ">
      <div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);letter-spacing:.5px;">${label}</div>
      <div style="font-size:28px;font-weight:700;color:var(--text);margin:4px 0;">${value}</div>
      ${sub ? `<div style="font-size:12px;color:var(--text-subtle);">${sub}</div>` : ''}
    </div>`
}

registerFeature({
  id:          'doc-stats',
  name:        'Doc Stats',
  category:    'Tools',
  icon:        '📊',
  description: 'Word count, reading time and text statistics for this PDF.',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Document Stats</h2>
          <p class="feature-desc">Word count, reading time and text statistics for this PDF.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">📊</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>`
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Document Stats</h2>
        <p class="feature-desc">
          Word count, reading time and text statistics for
          <strong style="color:var(--text);">${gf.name}</strong>
        </p>
      </div>
      <div id="ds-body">
        <div style="color:var(--text-muted);padding:32px 0;text-align:center;">Analysing…</div>
      </div>`

    // Run analysis immediately — no button needed
    runAnalysis(container, gf)
  },
})

async function runAnalysis(container, gf) {
  showProgress('Analysing PDF…')
  try {
    const bytes = await readFile(gf.file)

    let rDoc
    try {
      rDoc = await loadForRender(bytes, gf.pwd || undefined)
    } catch (err) {
      if (err.code !== 'ENCRYPTED') throw err
      // Encrypted but no password stored — surface error gracefully
      throw new Error('PDF is encrypted. Open it from the sidebar with its password first.')
    }

    const totalPages = rDoc.numPages
    const pageStats  = []

    for (let p = 1; p <= totalPages; p++) {
      updateProgress(`Extracting text: page ${p} of ${totalPages}…`)
      const page    = await rDoc.getPage(p)
      const content = await page.getTextContent()
      page.cleanup()

      // Join all text items with a space so word boundaries are preserved
      const rawText  = content.items.filter(i => 'str' in i).map(i => i.str).join(' ')
      const words    = rawText.split(/\s+/).filter(Boolean).length
      const chars    = rawText.replace(/\s+/g, '').length

      pageStats.push({ page: p, words, chars })
    }

    rDoc.destroy()

    const totalWords = pageStats.reduce((s, r) => s + r.words, 0)
    const totalChars = pageStats.reduce((s, r) => s + r.chars, 0)

    renderResults(container, gf, pageStats, totalWords, totalChars)
    toast('Analysis complete.', 'success')
  } catch (err) {
    if (err.name !== 'AbortError') {
      container.querySelector('#ds-body').innerHTML = `
        <div style="color:var(--red);padding:24px 0;text-align:center;">
          Failed to analyse PDF: ${err.message}
        </div>`
      toast('Analysis failed: ' + err.message, 'error')
    }
  } finally {
    hideProgress()
  }
}

function renderResults(container, gf, pageStats, totalWords, totalChars) {
  const body = container.querySelector('#ds-body')

  // ── Stat cards ────────────────────────────────────────────────────────────
  const cardsHtml = `
    <div style="
      display:grid;
      grid-template-columns:repeat(4,1fr);
      gap:12px;
      margin-bottom:20px;
    " class="ds-cards">
      ${statCard('Pages',        fmt(gf.pageCount),  null)}
      ${statCard('Words',        fmt(totalWords),     null)}
      ${statCard('Characters',   fmt(totalChars),     'non-whitespace')}
      ${statCard('Reading Time', readingTime(totalWords), 'at 238 wpm')}
    </div>
    <style>
      @media (max-width: 600px) {
        .ds-cards { grid-template-columns: repeat(2, 1fr) !important; }
      }
    </style>`

  // ── Per-page table ────────────────────────────────────────────────────────
  const maxWords = Math.max(...pageStats.map(r => r.words), 1)

  const rows = pageStats.map(({ page, words, chars }) => {
    const barPct = Math.round((words / maxWords) * 100)
    return `
      <tr>
        <td style="text-align:center;color:var(--text-muted);">${page}</td>
        <td style="text-align:right;">${fmt(words)}</td>
        <td style="text-align:right;">${fmt(chars)}</td>
        <td style="min-width:80px;">
          <div style="
            height:8px;
            background:var(--border);
            border-radius:4px;
            overflow:hidden;
          ">
            <div style="
              height:100%;
              width:${barPct}%;
              background:var(--blue);
              border-radius:4px;
            "></div>
          </div>
        </td>
      </tr>`
  }).join('')

  const tableHtml = `
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Per-page breakdown</span>
        <span class="status-text">${fmt(gf.pageCount)} page${gf.pageCount !== 1 ? 's' : ''}</span>
      </div>
      <div style="overflow-y:auto;max-height:300px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="position:sticky;top:0;background:var(--surface);z-index:1;">
              <th style="text-align:center;padding:6px 10px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);">Page</th>
              <th style="text-align:right;padding:6px 10px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);">Words</th>
              <th style="text-align:right;padding:6px 10px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);">Characters</th>
              <th style="padding:6px 10px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);">Density</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </div>`

  body.innerHTML = cardsHtml + tableHtml

  // Apply row padding via style injection (avoids new CSS classes)
  body.querySelectorAll('tbody tr td').forEach(td => {
    td.style.padding      = '5px 10px'
    td.style.borderBottom = '1px solid var(--border)'
  })
}
