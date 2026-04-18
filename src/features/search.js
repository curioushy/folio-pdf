/**
 * Search Text feature — full-text search across all pages of a PDF using PDF.js.
 *
 * Loads the PDF with PDF.js, iterates every page, extracts text content,
 * finds all occurrences of the query string (optionally case-sensitive),
 * and displays grouped snippets with the match highlighted in yellow.
 * Results can be exported as a plain-text .txt file.
 */

import { registerFeature }                                        from '../core/registry.js'
import { get }                                                    from '../core/state.js'
import { loadForRender }                                          from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress }      from '../core/ui.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** HTML-escape a plain string. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Return an HTML string with every occurrence of `query` inside `snippet`
 * wrapped in a yellow <mark> tag. Both snippet and query are HTML-escaped
 * before the replacement so no raw user content reaches the DOM as markup.
 *
 * @param {string} snippet     - The surrounding context text to display.
 * @param {string} query       - The search term to highlight.
 * @param {boolean} caseSensitive
 * @returns {string} HTML string safe to set as innerHTML.
 */
function buildHighlightedHtml(snippet, query, caseSensitive) {
  const escapedSnippet = escHtml(snippet)
  const escapedQuery   = escHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flags          = caseSensitive ? 'g' : 'gi'
  const re             = new RegExp(escapedQuery, flags)
  return escapedSnippet.replace(
    re,
    m => `<mark style="background:rgba(253,224,71,.6);border-radius:2px;padding:0 1px;">${m}</mark>`
  )
}

/**
 * Find all non-overlapping occurrences of `query` in `text`.
 * Returns an array of start indices.
 */
function findOccurrences(text, query, caseSensitive) {
  const haystack = caseSensitive ? text  : text.toLowerCase()
  const needle   = caseSensitive ? query : query.toLowerCase()
  const indices  = []
  let start = 0
  while (true) {
    const idx = haystack.indexOf(needle, start)
    if (idx === -1) break
    indices.push(idx)
    start = idx + needle.length
  }
  return indices
}

/**
 * Extract a snippet of text centred around `matchIdx`.
 * Returns up to `context` characters before and after the match.
 */
function extractSnippet(text, matchIdx, queryLen, context = 50) {
  const from = Math.max(0, matchIdx - context)
  const to   = Math.min(text.length, matchIdx + queryLen + context)
  let snippet = text.slice(from, to)
  if (from > 0)           snippet = '\u2026' + snippet
  if (to < text.length)   snippet = snippet + '\u2026'
  return snippet
}

// ── Feature ───────────────────────────────────────────────────────────────────

registerFeature({
  id:          'search',
  name:        'Search',
  category:    'Tools',
  icon:        '🔍',
  description: 'Full-text search across every page of a PDF',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Search Text</h2>
          <p class="feature-desc">Find every occurrence of a word or phrase across all pages of a PDF.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">🔍</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>
      `
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Search Text</h2>
        <p class="feature-desc">
          Find every occurrence of a word or phrase across all pages.
          Requires a built-in text layer — scanned (image-only) PDFs won't yield results.
          <strong style="color:var(--text);">${escHtml(gf.name)}</strong>
          &nbsp;&middot;&nbsp;${gf.pageCount} page${gf.pageCount !== 1 ? 's' : ''}
        </p>
      </div>

      <div class="panel">
        <div class="panel-header">
          <span class="panel-title">Search</span>
          <span class="status-text" id="search-status"></span>
        </div>

        <div class="section-label">Query</div>
        <div class="option-row" style="gap:8px;flex-wrap:wrap;margin-bottom:10px;">
          <input
            type="text"
            id="search-query"
            class="input"
            placeholder="Enter search term…"
            style="flex:1;min-width:200px;"
            autocomplete="off"
          >
          <button class="btn btn-primary" id="search-run">Search</button>
        </div>

        <div class="option-row" style="margin-bottom:4px;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;">
            <input type="checkbox" id="search-case" style="accent-color:var(--blue);">
            Case-sensitive
          </label>
        </div>
      </div>

      <div id="search-results" style="display:none;margin-top:16px;">
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title" id="search-results-title">Results</span>
            <button class="btn btn-sm" id="search-export">Export .txt</button>
          </div>
          <div id="search-results-body" style="margin-top:4px;"></div>
        </div>
      </div>
    `

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const queryEl      = container.querySelector('#search-query')
    const runBtn       = container.querySelector('#search-run')
    const caseEl       = container.querySelector('#search-case')
    const statusEl     = container.querySelector('#search-status')
    const resultsPanel = container.querySelector('#search-results')
    const resultsTitle = container.querySelector('#search-results-title')
    const resultsBody  = container.querySelector('#search-results-body')
    const exportBtn    = container.querySelector('#search-export')

    // Last search result data — used by the export handler.
    let lastResults  = []   // [{pageNum, matches:[{idx,snippet}], pageText}]
    let lastQuery    = ''
    let lastCase     = false

    // ── Search ────────────────────────────────────────────────────────────────
    async function runSearch() {
      const query = queryEl.value.trim()
      if (!query) {
        toast('Enter a search term first.', 'warning')
        queryEl.focus()
        return
      }

      const caseSensitive = caseEl.checked
      const cf = get().currentFile

      statusEl.textContent  = ''
      resultsPanel.style.display = 'none'

      showProgress('Loading PDF…')
      let doc
      try {
        const bytes = await cf.file.arrayBuffer()
        doc = await loadForRender(bytes, gf.pwd || undefined)
      } catch (err) {
        hideProgress()
        toast('Failed to load PDF: ' + err.message, 'error')
        return
      }

      const numPages   = doc.numPages
      const pageResults = []
      let totalMatches  = 0
      let pagesWithHits = 0

      try {
        for (let p = 1; p <= numPages; p++) {
          updateProgress(`Searching page ${p} of ${numPages}\u2026`)

          const page    = await doc.getPage(p)
          const content = await page.getTextContent()
          page.cleanup()

          // Join all text items into a single string for this page.
          const pageText = content.items
            .filter(item => 'str' in item)
            .map(item => item.str)
            .join('')

          const indices = findOccurrences(pageText, query, caseSensitive)
          if (indices.length > 0) {
            const matchData = indices.map(idx => ({
              idx,
              snippet: extractSnippet(pageText, idx, query.length),
            }))
            pageResults.push({ pageNum: p, matches: matchData, pageText })
            totalMatches  += indices.length
            pagesWithHits += 1
          }
        }
      } finally {
        doc.destroy()
        hideProgress()
      }

      lastResults = pageResults
      lastQuery   = query
      lastCase    = caseSensitive

      // ── Status text ───────────────────────────────────────────────────────
      if (totalMatches === 0) {
        statusEl.textContent = `No matches found in ${numPages} page${numPages !== 1 ? 's' : ''}.`
        toast('No matches found.', 'warning')
        return
      }

      statusEl.textContent =
        `${totalMatches} match${totalMatches !== 1 ? 'es' : ''} across ` +
        `${pagesWithHits} page${pagesWithHits !== 1 ? 's' : ''}.`

      // ── Build results HTML ────────────────────────────────────────────────
      resultsTitle.textContent =
        `Results \u2014 ${totalMatches} match${totalMatches !== 1 ? 'es' : ''}`

      const SNIPPETS_PER_PAGE = 5

      const sectionsHtml = pageResults.map(({ pageNum, matches }) => {
        const shown   = matches.slice(0, SNIPPETS_PER_PAGE)
        const extra   = matches.length - shown.length

        const snippetsHtml = shown.map(({ snippet }) => {
          const highlighted = buildHighlightedHtml(snippet, query, caseSensitive)
          return `
            <div style="
              font-size:12px;line-height:1.6;padding:5px 8px;
              border-left:2px solid var(--border);margin:4px 0;
              color:var(--text-muted);word-break:break-word;">
              ${highlighted}
            </div>
          `
        }).join('')

        const moreHtml = extra > 0
          ? `<div style="font-size:11px;color:var(--text-subtle);padding:2px 8px;margin-bottom:4px;">
               +${extra} more match${extra !== 1 ? 'es' : ''} on this page
             </div>`
          : ''

        return `
          <div style="margin-bottom:14px;">
            <div style="
              font-size:12px;font-weight:600;color:var(--blue);
              padding:4px 0 2px;border-bottom:1px solid var(--border);margin-bottom:4px;">
              Page ${pageNum}
              <span style="font-weight:400;color:var(--text-muted);">
                (${matches.length} match${matches.length !== 1 ? 'es' : ''})
              </span>
            </div>
            ${snippetsHtml}
            ${moreHtml}
          </div>
        `
      }).join('')

      resultsBody.innerHTML   = sectionsHtml
      resultsPanel.style.display = 'block'
      toast(`${totalMatches} match${totalMatches !== 1 ? 'es' : ''} found.`, 'success')
    }

    // ── Enter key triggers search ─────────────────────────────────────────────
    queryEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); runSearch() }
    })

    runBtn.addEventListener('click', () => runSearch())

    // ── Export .txt ───────────────────────────────────────────────────────────
    exportBtn.addEventListener('click', () => {
      if (!lastResults.length) return

      const cf    = get().currentFile
      const lines = []

      lines.push(`Search: "${lastQuery}"`)
      lines.push(`File: ${cf.name}`)
      lines.push(`Case-sensitive: ${lastCase ? 'yes' : 'no'}`)
      lines.push('')

      let grandTotal = 0
      for (const { pageNum, matches } of lastResults) {
        grandTotal += matches.length
      }
      lines.push(`Total matches: ${grandTotal} across ${lastResults.length} page${lastResults.length !== 1 ? 's' : ''}`)
      lines.push('')
      lines.push('─'.repeat(60))

      for (const { pageNum, matches } of lastResults) {
        lines.push('')
        lines.push(`Page ${pageNum} (${matches.length} match${matches.length !== 1 ? 'es' : ''})`)
        lines.push('─'.repeat(40))
        for (const { snippet } of matches) {
          lines.push(`  ${snippet}`)
        }
      }

      const content  = lines.join('\n')
      const blob     = new Blob([content], { type: 'text/plain' })
      const url      = URL.createObjectURL(blob)
      const a        = document.createElement('a')
      const safeName = cf.name.replace(/\.pdf$/i, '') + '_search.txt'
      a.href         = url
      a.download     = safeName
      a.click()
      URL.revokeObjectURL(url)
      toast(`Exported → ${safeName}`, 'success')
    })
  },
})
