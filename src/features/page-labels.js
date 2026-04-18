/**
 * Page Labels feature — set custom page numbering using the PDF /PageLabels
 * structure (PDF spec §12.4.2).
 *
 * Supports:
 *   D  — Arabic numerals  (1, 2, 3 …)
 *   r  — lowercase Roman  (i, ii, iii …)
 *   R  — uppercase Roman  (I, II, III …)
 *   a  — lowercase alpha  (a, b … z, aa …)
 *   A  — uppercase alpha  (A, B … Z, AA …)
 *   none — no numbering (useful for blank / intentionally un-numbered pages)
 *
 * Each label range has: start page (1-based), style, optional prefix, and
 * an optional start value (defaults to 1). Ranges are written as a flat
 * /PageLabels /Nums array in the PDF catalog — the canonical low-level way
 * that all major PDF readers understand.
 */

import { registerFeature }                              from '../core/registry.js'
import { get }                                          from '../core/state.js'
import { saveAs }                                       from '../core/fs.js'
import * as pdf                                         from '../core/pdf.js'
import { PDFName, PDFNumber, PDFString, PDFArray, PDFDict } from '@cantoo/pdf-lib'
import { toast, showProgress, hideProgress }            from '../core/ui.js'
import { stripExt, ensurePdf }                          from '../core/utils.js'

// ── Roman numeral helper ──────────────────────────────────────────────────────

const ROMAN_VALS = [
  [1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],
  [100,'c'], [90,'xc'], [50,'l'], [40,'xl'],
  [10,'x'],  [9,'ix'],  [5,'v'],  [4,'iv'],
  [1,'i'],
]

function toRoman(n) {
  if (n < 1 || n > 3999) return String(n)
  let result = ''
  for (const [val, sym] of ROMAN_VALS) {
    while (n >= val) { result += sym; n -= val }
  }
  return result
}

// ── Label value formatter ─────────────────────────────────────────────────────

function formatLabel(style, value, prefix) {
  prefix = prefix || ''
  switch (style) {
    case 'r':    return prefix + toRoman(value)
    case 'R':    return prefix + toRoman(value).toUpperCase()
    case 'a': {
      const cycle = Math.floor((value - 1) / 26) + 1
      const ch    = String.fromCharCode(97 + ((value - 1) % 26))
      return prefix + ch.repeat(cycle)
    }
    case 'A': {
      const cycle = Math.floor((value - 1) / 26) + 1
      const ch    = String.fromCharCode(65 + ((value - 1) % 26))
      return prefix + ch.repeat(cycle)
    }
    case 'none': return '–'
    default:     return prefix + String(value)   // D or ''
  }
}

// ── Low-level PDF writer ──────────────────────────────────────────────────────

async function applyLabels(doc, ranges) {
  const sorted = [...ranges].sort((a, b) => a.startPage - b.startPage)
  const ctx    = doc.context

  const numsArr = PDFArray.withContext(ctx)
  sorted.forEach(range => {
    numsArr.push(PDFNumber.of(range.startPage - 1))   // 0-based page index
    const dict = PDFDict.withContext(ctx)
    if (range.style && range.style !== 'none') dict.set(PDFName.of('S'), PDFName.of(range.style))
    if (range.prefix)                          dict.set(PDFName.of('P'), PDFString.of(range.prefix))
    if (range.startValue !== 1)                dict.set(PDFName.of('St'), PDFNumber.of(range.startValue))
    numsArr.push(dict)
  })

  const labelsDict = PDFDict.withContext(ctx)
  labelsDict.set(PDFName.of('Nums'), numsArr)
  doc.catalog.set(PDFName.of('PageLabels'), labelsDict)
}

// ── Feature registration ──────────────────────────────────────────────────────

registerFeature({
  id:          'page-labels',
  name:        'Page Labels',
  category:    'Pages',
  icon:        '🏷️',
  description: 'Set custom page numbering — Roman numerals, letter sequences, prefixes and restart points.',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Page Labels</h2>
          <p class="feature-desc">Set custom page numbering — Roman numerals, letter sequences, prefixes and restart points.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">🏷️</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>`
      return
    }

    const pageCount = gf.pageCount

    // ── Initial range state ───────────────────────────────────────────────────
    // One default range covering the whole document
    let ranges = [
      { id: Date.now(), startPage: 1, style: 'D', prefix: '', startValue: 1 },
    ]

    // ── Shell HTML ────────────────────────────────────────────────────────────
    container.innerHTML = `
      <div class="feature-header">
        <h2>Page Labels</h2>
        <p class="feature-desc">Set custom page numbering — Roman numerals, letter sequences, prefixes and restart points.</p>
      </div>

      <div class="feature-split">

        <!-- ── LEFT: Ranges editor ──────────────────────────────────────────── -->
        <div class="panel" style="display:flex;flex-direction:column;gap:0;">
          <div class="panel-header">
            <span class="panel-title">① Label Ranges</span>
            <span class="status-text" id="pl-file-info"></span>
          </div>

          <div id="pl-ranges-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;"></div>

          <div>
            <button class="btn btn-sm" id="pl-add-range">＋ Add range</button>
          </div>

          <div style="border-top:1px solid var(--border);margin:16px 0 12px;"></div>

          <div class="section-label">Output filename</div>
          <div class="option-row" style="margin-bottom:0;">
            <input type="text" id="pl-output" class="input" style="flex:1;" placeholder="output.pdf">
          </div>

          <div class="action-bar" style="margin-top:16px;">
            <button class="btn btn-primary btn-lg" id="pl-apply" style="width:100%;justify-content:center;">
              Apply Page Labels
            </button>
          </div>
        </div>

        <!-- ── RIGHT: Preview ───────────────────────────────────────────────── -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">② Preview</span>
          </div>
          <p class="status-text" style="margin-bottom:12px;">
            First labels generated for each range:
          </p>
          <div id="pl-preview" style="display:flex;flex-direction:column;gap:10px;"></div>
        </div>

      </div>
    `

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const fileInfoEl  = container.querySelector('#pl-file-info')
    const rangesList  = container.querySelector('#pl-ranges-list')
    const addBtn      = container.querySelector('#pl-add-range')
    const outputEl    = container.querySelector('#pl-output')
    const applyBtn    = container.querySelector('#pl-apply')
    const previewEl   = container.querySelector('#pl-preview')

    fileInfoEl.textContent = `${gf.name} — ${pageCount} page${pageCount !== 1 ? 's' : ''}`
    outputEl.value = ensurePdf(stripExt(gf.name) + '_labelled')

    // ── Range row renderer ────────────────────────────────────────────────────

    function renderRanges() {
      rangesList.innerHTML = ''

      ranges.forEach((range, idx) => {
        const row = document.createElement('div')
        row.style.cssText = `
          display:grid;
          grid-template-columns:auto 1fr auto 1fr auto;
          gap:6px;
          align-items:center;
          background:var(--bg);
          border:1px solid var(--border);
          border-radius:var(--radius-sm);
          padding:8px 10px;
        `
        row.innerHTML = `
          <label style="font-size:12px;color:var(--text-muted);white-space:nowrap;">Start p.</label>
          <input type="number" class="input pl-start" min="1" max="${pageCount}"
            value="${range.startPage}" style="max-width:72px;min-width:48px;">

          <label style="font-size:12px;color:var(--text-muted);white-space:nowrap;margin-left:6px;">Style</label>
          <select class="input pl-style" style="min-width:0;">
            <option value="D"    ${range.style === 'D'    ? 'selected' : ''}>Arabic  1, 2, 3</option>
            <option value="r"    ${range.style === 'r'    ? 'selected' : ''}>roman  i, ii, iii</option>
            <option value="R"    ${range.style === 'R'    ? 'selected' : ''}>Roman  I, II, III</option>
            <option value="a"    ${range.style === 'a'    ? 'selected' : ''}>alpha  a, b, c</option>
            <option value="A"    ${range.style === 'A'    ? 'selected' : ''}>Alpha  A, B, C</option>
            <option value="none" ${range.style === 'none' ? 'selected' : ''}>none  (no numbering)</option>
          </select>

          <button class="btn btn-sm pl-delete" title="Remove range"
            style="color:var(--red);padding:2px 7px;line-height:1;"
            ${ranges.length === 1 ? 'disabled' : ''}>✕</button>

          <label style="font-size:12px;color:var(--text-muted);white-space:nowrap;">Prefix</label>
          <input type="text" class="input pl-prefix" placeholder="e.g. A-"
            value="${range.prefix}" style="max-width:90px;min-width:48px;">

          <label style="font-size:12px;color:var(--text-muted);white-space:nowrap;margin-left:6px;">Start at</label>
          <input type="number" class="input pl-startval" min="1"
            value="${range.startValue}" style="max-width:72px;min-width:48px;">

          <span></span>
        `

        // Wire up inputs
        row.querySelector('.pl-start').addEventListener('input', e => {
          const v = parseInt(e.target.value)
          if (!isNaN(v) && v >= 1 && v <= pageCount) {
            ranges[idx].startPage = v
            renderPreview()
          }
        })

        row.querySelector('.pl-style').addEventListener('change', e => {
          ranges[idx].style = e.target.value
          renderPreview()
        })

        row.querySelector('.pl-prefix').addEventListener('input', e => {
          ranges[idx].prefix = e.target.value
          renderPreview()
        })

        row.querySelector('.pl-startval').addEventListener('input', e => {
          const v = parseInt(e.target.value)
          if (!isNaN(v) && v >= 1) {
            ranges[idx].startValue = v
            renderPreview()
          }
        })

        row.querySelector('.pl-delete').addEventListener('click', () => {
          if (ranges.length <= 1) return
          ranges.splice(idx, 1)
          renderRanges()
          renderPreview()
        })

        rangesList.appendChild(row)
      })
    }

    // ── Preview renderer ──────────────────────────────────────────────────────

    function renderPreview() {
      const sorted = [...ranges].sort((a, b) => a.startPage - b.startPage)
      previewEl.innerHTML = ''

      sorted.forEach((range, i) => {
        const nextStart = sorted[i + 1] ? sorted[i + 1].startPage : pageCount + 1
        const endPage   = Math.min(nextStart - 1, pageCount)
        const rangeLen  = endPage - range.startPage + 1

        // Show first 4 labels (or fewer if range is shorter)
        const sampleCount = Math.min(4, rangeLen)
        const samples = []
        for (let k = 0; k < sampleCount; k++) {
          samples.push(formatLabel(range.style, range.startValue + k, range.prefix))
        }

        const isLast   = i === sorted.length - 1
        const pageDesc = isLast
          ? `Pages ${range.startPage}–end`
          : `Pages ${range.startPage}–${endPage}`

        const sampleStr = rangeLen === 0
          ? '(no pages in range)'
          : samples.join(', ') + (rangeLen > sampleCount ? '…' : '')

        const block = document.createElement('div')
        block.style.cssText = `
          background:var(--bg);
          border:1px solid var(--border);
          border-radius:var(--radius-sm);
          padding:8px 12px;
        `
        block.innerHTML = `
          <span style="font-size:12px;color:var(--text-muted);">${pageDesc}</span>
          <span style="margin:0 6px;color:var(--border-dark);">→</span>
          <span style="font-size:13px;color:var(--text);font-variant-numeric:tabular-nums;">${sampleStr}</span>
        `
        previewEl.appendChild(block)
      })
    }

    // ── Add range button ──────────────────────────────────────────────────────

    addBtn.addEventListener('click', () => {
      const sorted    = [...ranges].sort((a, b) => a.startPage - b.startPage)
      const lastStart = sorted.length ? sorted[sorted.length - 1].startPage : 1
      const newStart  = Math.min(lastStart + 1, pageCount)
      ranges.push({
        id:         Date.now(),
        startPage:  newStart,
        style:      'D',
        prefix:     '',
        startValue: 1,
      })
      renderRanges()
      renderPreview()
    })

    // ── Apply button ──────────────────────────────────────────────────────────

    applyBtn.addEventListener('click', async () => {
      const cf = get().currentFile
      if (!cf) { toast('No file open.', 'warning'); return }

      // Validate: no two ranges share the same start page
      const starts = ranges.map(r => r.startPage)
      if (new Set(starts).size !== starts.length) {
        toast('Two or more ranges share the same start page. Please fix before applying.', 'warning')
        return
      }

      // Validate: all start pages within document
      if (ranges.some(r => r.startPage < 1 || r.startPage > pageCount)) {
        toast(`Start pages must be between 1 and ${pageCount}.`, 'warning')
        return
      }

      showProgress('Loading PDF…')
      try {
        const bytes = await cf.file.arrayBuffer()
        let doc
        try {
          doc = await pdf.load(bytes, cf.pwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const { promptPassword } = await import('../core/ui.js')
          const pwd = await promptPassword(cf.name)
          if (!pwd) return
          showProgress('Decrypting…')
          doc = await pdf.load(bytes, pwd)
        }

        await applyLabels(doc, ranges)

        const outBytes = await pdf.save(doc)
        const filename = ensurePdf(outputEl.value.trim() || stripExt(cf.name) + '_labelled')
        await saveAs(outBytes, filename)

        toast(`Page labels applied → ${filename}`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    })

    // ── Initial render ────────────────────────────────────────────────────────
    renderRanges()
    renderPreview()
  },
})
