/**
 * Header / Footer — stamp text in any of six page zones.
 *
 * Zones (3 top + 3 bottom):
 *   Top-Left · Top-Center · Top-Right
 *   Bottom-Left · Bottom-Center · Bottom-Right
 *
 * Tokens: {page} current page · {total} total pages · {date} today · {filename} doc name
 *
 * Absorbs the former "Page Numbers" feature — just drop {page} in any zone.
 */

import { registerFeature }                              from '../core/registry.js'
import { readFile, saveAs }                             from '../core/fs.js'
import * as pdf                                         from '../core/pdf.js'
import { StandardFonts, rgb }                           from '@cantoo/pdf-lib'
import { toast, showProgress, hideProgress, promptPassword } from '../core/ui.js'
import { stripExt, parsePageRange }                    from '../core/utils.js'
import { get }                                         from '../core/state.js'

const ZONES = [
  { id: 'tl', label: 'Left',   row: 'top',    h: 'left',   defaultOn: false, defaultVal: '' },
  { id: 'tc', label: 'Center', row: 'top',    h: 'center', defaultOn: false, defaultVal: '' },
  { id: 'tr', label: 'Right',  row: 'top',    h: 'right',  defaultOn: false, defaultVal: '' },
  { id: 'bl', label: 'Left',   row: 'bottom', h: 'left',   defaultOn: false, defaultVal: '' },
  { id: 'bc', label: 'Center', row: 'bottom', h: 'center', defaultOn: true,  defaultVal: '{page} of {total}' },
  { id: 'br', label: 'Right',  row: 'bottom', h: 'right',  defaultOn: false, defaultVal: '' },
]

registerFeature({
  id:          'header-footer',
  name:        'Header / Footer',
  category:    'Stamp',
  icon:        '↕',
  description: 'Add text in any of six page zones — headers, footers, page numbers, dates',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Header / Footer</h2>
          <p class="feature-desc">Stamp text in any of six page zones. Tokens:
            <code>{page}</code> <code>{total}</code> <code>{date}</code> <code>{filename}</code></p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">📄</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>
      `
      return
    }

    // ── Pre-build zone HTML ──────────────────────────────────────────────────
    function zoneCell(z) {
      return `
        <div class="hf-zone">
          <label class="hf-zone-label">
            <input type="checkbox" id="hf-${z.id}-on"${z.defaultOn ? ' checked' : ''}>
            ${z.label}
          </label>
          <input type="text" id="hf-${z.id}-text" class="input hf-zone-input"
            value="${z.defaultVal}"
            placeholder="${z.defaultVal || 'e.g. {page} of {total}'}"
            ${z.defaultOn ? '' : 'disabled'}>
        </div>
      `
    }

    const topZones    = ZONES.filter(z => z.row === 'top').map(zoneCell).join('')
    const bottomZones = ZONES.filter(z => z.row === 'bottom').map(zoneCell).join('')

    container.innerHTML = `
      <div class="feature-header">
        <h2>Header / Footer</h2>
        <p class="feature-desc">
          Enable any zone and type your text. Click a token to insert it at the cursor.
          <strong style="color:var(--text);">${gf.name}</strong> —
          ${gf.pageCount} page${gf.pageCount !== 1 ? 's' : ''}
        </p>
      </div>

      <!-- Token pills -->
      <div class="panel" style="padding:10px 16px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:12px;color:var(--text-muted);font-weight:600;min-width:max-content;">Insert token:</span>
          <button class="token-pill" data-token="{page}"><code>{page}</code> <span>page number</span></button>
          <button class="token-pill" data-token="{total}"><code>{total}</code> <span>total pages</span></button>
          <button class="token-pill" data-token="{date}"><code>{date}</code> <span>today's date</span></button>
          <button class="token-pill" data-token="{filename}"><code>{filename}</code> <span>filename</span></button>
        </div>
      </div>

      <!-- Header zones -->
      <div class="panel" style="margin-top:0;">
        <div class="panel-header">
          <span class="panel-title">Header <span style="font-weight:400;color:var(--text-muted);">— top of page</span></span>
        </div>
        <div class="hf-zone-row">${topZones}</div>
      </div>

      <!-- Footer zones -->
      <div class="panel" style="margin-top:0;">
        <div class="panel-header">
          <span class="panel-title">Footer <span style="font-weight:400;color:var(--text-muted);">— bottom of page</span></span>
        </div>
        <div class="hf-zone-row">${bottomZones}</div>
      </div>

      <!-- Appearance -->
      <div class="panel" style="margin-top:0;">
        <div class="panel-header"><span class="panel-title">Appearance</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:12px 28px;align-items:center;">
          <div class="option-row" style="gap:8px;">
            <label>Font size</label>
            <input type="number" id="hf-size" class="input" min="6" max="36" value="9"
              style="max-width:72px;">
            <span class="status-text">pt</span>
          </div>
          <div class="option-row" style="gap:8px;">
            <label>Margin from edge</label>
            <input type="number" id="hf-margin" class="input" min="4" max="72" value="20"
              style="max-width:72px;">
            <span class="status-text">pt</span>
          </div>
          <div class="option-row" style="gap:8px;">
            <label>Colour</label>
            <input type="color" id="hf-color" value="#555555"
              style="width:44px;height:32px;padding:2px;border:1px solid var(--border);
                     border-radius:4px;background:none;cursor:pointer;">
          </div>
        </div>
      </div>

      <!-- Page range -->
      <div class="panel" style="margin-top:0;">
        <div class="panel-header"><span class="panel-title">Pages</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:12px 28px;align-items:center;">
          <div class="option-row" style="gap:8px;">
            <label>Apply to</label>
            <select id="hf-pages-sel" class="input" style="max-width:180px;">
              <option value="all">All pages</option>
              <option value="custom">Custom range…</option>
            </select>
          </div>
          <div id="hf-pages-row" class="option-row" style="display:none;gap:8px;">
            <label>Range</label>
            <input type="text" id="hf-pages-custom" class="input"
              placeholder="e.g. 2-10, 15" style="max-width:180px;">
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
            <input type="checkbox" id="hf-skip-first">
            Skip first page
            <span class="status-text" style="margin-left:2px;">(cover)</span>
          </label>
        </div>
      </div>

      <!-- Action -->
      <div style="padding:0 0 8px;">
        <button class="btn btn-primary btn-lg" id="hf-run" style="min-width:240px;">
          Apply Headers &amp; Footers
        </button>
        <div class="status-text" id="hf-status" style="margin-top:8px;"></div>
      </div>
    `

    // ── Zone enable/disable toggles ──────────────────────────────────────────
    ZONES.forEach(z => {
      const chk   = container.querySelector(`#hf-${z.id}-on`)
      const input = container.querySelector(`#hf-${z.id}-text`)
      chk.addEventListener('change', () => {
        input.disabled = !chk.checked
        if (chk.checked) input.focus()
      })
    })

    // ── Token insertion ──────────────────────────────────────────────────────
    let lastFocused = null
    ZONES.forEach(z => {
      const input = container.querySelector(`#hf-${z.id}-text`)
      input.addEventListener('focus', () => { lastFocused = input })
    })

    container.querySelectorAll('.token-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const token = pill.dataset.token
        const el    = lastFocused || container.querySelector('.hf-zone-input:not(:disabled)')
        if (!el || el.disabled) return
        const start = el.selectionStart ?? el.value.length
        const end   = el.selectionEnd   ?? el.value.length
        el.value = el.value.slice(0, start) + token + el.value.slice(end)
        el.selectionStart = el.selectionEnd = start + token.length
        el.focus()
        // Auto-enable the zone if it wasn't
        const zoneId = el.id.replace('hf-', '').replace('-text', '')
        const chk = container.querySelector(`#hf-${zoneId}-on`)
        if (chk && !chk.checked) { chk.checked = true; el.disabled = false }
      })
    })

    // ── Pages selector ───────────────────────────────────────────────────────
    container.querySelector('#hf-pages-sel').addEventListener('change', e => {
      container.querySelector('#hf-pages-row').style.display =
        e.target.value === 'custom' ? 'flex' : 'none'
    })

    // ── Apply ────────────────────────────────────────────────────────────────
    const runBtn   = container.querySelector('#hf-run')
    const statusEl = container.querySelector('#hf-status')

    runBtn.addEventListener('click', async () => {
      // Check at least one zone is enabled with text
      const activeZones = ZONES.filter(z => {
        const on  = container.querySelector(`#hf-${z.id}-on`).checked
        const txt = container.querySelector(`#hf-${z.id}-text`).value.trim()
        return on && txt
      })
      if (!activeZones.length) {
        toast('Enable at least one zone and enter some text.', 'warning')
        return
      }

      showProgress('Loading PDF…')
      try {
        const cf    = get().currentFile
        const bytes = await readFile(cf.file)
        let srcPwd  = cf.pwd
        let doc
        try {
          doc = await pdf.load(bytes, srcPwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          srcPwd = await promptPassword(cf.name)
          if (!srcPwd) return
          showProgress('Decrypting…')
          doc = await pdf.load(bytes, srcPwd)
        }

        const font      = await doc.embedFont(StandardFonts.Helvetica)
        const pages     = doc.getPages()
        const total     = pages.length
        const docTitle  = doc.getTitle() || ''
        const today     = new Date().toLocaleDateString()
        const skipFirst = container.querySelector('#hf-skip-first').checked
        const fontSize  = Math.max(6, parseFloat(container.querySelector('#hf-size').value)   || 9)
        const margin    = Math.max(4, parseFloat(container.querySelector('#hf-margin').value)  || 20)
        const hex       = container.querySelector('#hf-color').value
        const fontColor = rgb(
          parseInt(hex.slice(1, 3), 16) / 255,
          parseInt(hex.slice(3, 5), 16) / 255,
          parseInt(hex.slice(5, 7), 16) / 255,
        )

        // Resolve target page indices
        let targetIdx
        if (container.querySelector('#hf-pages-sel').value === 'custom') {
          const raw = container.querySelector('#hf-pages-custom').value.trim()
          targetIdx = parsePageRange(raw, total)
        } else {
          targetIdx = pages.map((_, i) => i)
        }
        if (skipFirst) targetIdx = targetIdx.filter(i => i !== 0)
        if (!targetIdx.length) { toast('No pages to stamp.', 'warning'); return }

        function resolveToken(tpl, pageNum) {
          return tpl
            .replace(/\{page\}/g,     String(pageNum))
            .replace(/\{n\}/g,        String(pageNum))   // backwards-compat
            .replace(/\{total\}/g,    String(total))
            .replace(/\{date\}/g,     today)
            .replace(/\{filename\}/g, cf.name)
            .replace(/\{title\}/g,    docTitle)
        }

        let counter = 1
        for (const i of targetIdx) {
          const page = pages[i]
          const { width, height } = page.getSize()

          for (const z of activeZones) {
            const rawText = container.querySelector(`#hf-${z.id}-text`).value
            const resolved = resolveToken(rawText, skipFirst ? i : counter)
            if (!resolved.trim()) continue
            const tw = font.widthOfTextAtSize(resolved, fontSize)
            let x
            if      (z.h === 'left')   x = margin
            else if (z.h === 'right')  x = width - tw - margin
            else                       x = (width - tw) / 2
            const y = z.row === 'top' ? height - margin - fontSize : margin
            page.drawText(resolved, { x, y, size: fontSize, font, color: fontColor })
          }
          counter++
        }

        const outBytes = await pdf.save(doc)
        const outName  = cf.name.replace(/\.pdf$/i, '_hf.pdf')
        await saveAs(outBytes, outName)
        const zoneCount = activeZones.length
        toast(`Stamped ${targetIdx.length} pages (${zoneCount} zone${zoneCount > 1 ? 's' : ''}) → ${outName}`, 'success')
        statusEl.textContent = `Done — ${targetIdx.length} pages updated.`

      } catch (err) {
        if (err.name !== 'AbortError') { console.error(err); toast('Failed: ' + err.message, 'error') }
      } finally {
        hideProgress()
      }
    })
  },
})
