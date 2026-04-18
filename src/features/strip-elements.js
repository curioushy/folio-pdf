/**
 * Strip Elements — selectively remove PDF internals before sharing.
 *
 * Removable elements:
 *   • JavaScript actions      — eliminate macro-like scripts
 *   • Annotations             — comments, highlights, sticky notes, links
 *   • Bookmarks / Outline     — navigation tree in the sidebar
 *   • Embedded files          — file attachments inside the PDF
 *   • Form fields (AcroForm)  — interactive fields and their data
 *   • Document metadata       — Author, Title, Keywords, Creator, XMP stream
 *   • Digital signatures      — signature fields and SigFlags
 *
 * All operations use low-level pdf-lib catalog/page manipulation.
 * The original file is never modified.
 */

import { registerFeature }                              from '../core/registry.js'
import { readFile, saveAs }                             from '../core/fs.js'
import * as pdf                                         from '../core/pdf.js'
import { PDFName, PDFArray, PDFNull }                   from '@cantoo/pdf-lib'
import { toast, showProgress, hideProgress, promptPassword } from '../core/ui.js'
import { get }                                               from '../core/state.js'

registerFeature({
  id:          'strip-elements',
  name:        'Strip Elements',
  category:    'Convert',
  icon:        '🧹',
  description: 'Remove JS, annotations, bookmarks, metadata and more before sharing',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Strip Elements</h2>
        <p class="feature-desc">
          Selectively remove invisible or sensitive internals from a PDF before
          sharing — without changing the visible page content.
        </p>
      </div>

      <div class="feature-split">

        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Source PDF</span></div>
          <div class="file-drop-zone" id="se-drop">
            <span>Drag a PDF here, or</span>
            <button class="btn btn-sm" id="se-browse">Browse</button>
            <input type="file" id="se-input" accept=".pdf" hidden>
          </div>
          <div id="se-filename" class="file-name-display"></div>
          <div id="se-info" class="status-text" style="margin-top:4px;"></div>
        </div>

        <div class="panel">
          <div class="panel-header"><span class="panel-title">② What to Remove</span></div>

          <div style="display:flex;flex-direction:column;gap:10px;">

            <label class="option-row" style="cursor:pointer;user-select:none;">
              <input type="checkbox" id="se-js"   checked style="width:auto;margin-right:6px;">
              <div>
                <strong>JavaScript actions</strong>
                <div class="status-text">OpenAction, page /AA scripts, form JS</div>
              </div>
            </label>

            <label class="option-row" style="cursor:pointer;user-select:none;">
              <input type="checkbox" id="se-annots" checked style="width:auto;margin-right:6px;">
              <div>
                <strong>Annotations</strong>
                <div class="status-text">Comments, highlights, sticky notes, ink drawings, links</div>
              </div>
            </label>

            <label class="option-row" style="cursor:pointer;user-select:none;">
              <input type="checkbox" id="se-bookmarks" checked style="width:auto;margin-right:6px;">
              <div>
                <strong>Bookmarks / Outline</strong>
                <div class="status-text">Navigation tree shown in PDF reader sidebar</div>
              </div>
            </label>

            <label class="option-row" style="cursor:pointer;user-select:none;">
              <input type="checkbox" id="se-embedded" checked style="width:auto;margin-right:6px;">
              <div>
                <strong>Embedded files</strong>
                <div class="status-text">File attachments and portfolios</div>
              </div>
            </label>

            <label class="option-row" style="cursor:pointer;user-select:none;">
              <input type="checkbox" id="se-forms" style="width:auto;margin-right:6px;">
              <div>
                <strong>Form fields (AcroForm)</strong>
                <div class="status-text">Interactive fields and any filled-in data</div>
              </div>
            </label>

            <label class="option-row" style="cursor:pointer;user-select:none;">
              <input type="checkbox" id="se-meta" checked style="width:auto;margin-right:6px;">
              <div>
                <strong>Document metadata</strong>
                <div class="status-text">Author, Title, Keywords, Creator, Producer, XMP stream</div>
              </div>
            </label>

            <label class="option-row" style="cursor:pointer;user-select:none;">
              <input type="checkbox" id="se-sigs" checked style="width:auto;margin-right:6px;">
              <div>
                <strong>Digital signatures</strong>
                <div class="status-text">Signature fields and SigFlags (cryptographic cert removed)</div>
              </div>
            </label>

          </div>

          <div class="action-bar" style="margin-top:20px;">
            <button class="btn btn-primary btn-lg" id="se-run" disabled
              style="width:100%;justify-content:center;">
              Strip Selected Elements
            </button>
          </div>
        </div>

      </div>
    `

    let srcFile = null
    let srcPwd  = null
    const nameEl = container.querySelector('#se-filename')
    const infoEl = container.querySelector('#se-info')
    const runBtn = container.querySelector('#se-run')

    async function loadFile(file, initialPwd = null) {
      srcFile = file
      nameEl.textContent = file.name
      showProgress('Loading…')
      try {
        const bytes = await readFile(file)
        let pwd = initialPwd
        const doc   = await pdf.load(bytes, pwd || undefined).catch(async err => {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          pwd = await promptPassword(file.name)
          if (!pwd) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' })
          showProgress('Decrypting…')
          return pdf.load(bytes, pwd)
        })
        srcPwd = pwd
        const n = doc.getPageCount()
        infoEl.textContent = `${n} page${n > 1 ? 's' : ''}`
        runBtn.disabled = false
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    }

    const dropZone = container.querySelector('#se-drop')
    const input    = container.querySelector('#se-input')
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) loadFile(f)
    })
    container.querySelector('#se-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => {
      if (e.target.files[0]) { loadFile(e.target.files[0]); input.value = '' }
    })

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => loadFile(gf.file, gf.pwd), 0)

    runBtn.addEventListener('click', async () => {
      if (!srcFile) return
      const strip = {
        js:        container.querySelector('#se-js').checked,
        annots:    container.querySelector('#se-annots').checked,
        bookmarks: container.querySelector('#se-bookmarks').checked,
        embedded:  container.querySelector('#se-embedded').checked,
        forms:     container.querySelector('#se-forms').checked,
        meta:      container.querySelector('#se-meta').checked,
        sigs:      container.querySelector('#se-sigs').checked,
      }
      if (!Object.values(strip).some(Boolean)) {
        toast('Select at least one element to remove.', 'warning')
        return
      }

      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(srcFile)
        let doc
        try {
          doc = await pdf.load(bytes, srcPwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          const pwd = await promptPassword(srcFile.name)
          if (!pwd) return
          srcPwd = pwd
          showProgress('Decrypting…')
          doc = await pdf.load(bytes, pwd)
        }

        const catalog = doc.catalog
        const context = doc.context
        const pages   = doc.getPages()
        const removed = []

        // Helper: safely delete a key from a dict (no-op if missing)
        const del = (dict, key) => { try { dict.delete(PDFName.of(key)) } catch {} }

        // ── JavaScript ────────────────────────────────────────────────────────
        if (strip.js) {
          // Catalog-level: /OpenAction (if it's a JS action) and /AA
          del(catalog, 'OpenAction')
          del(catalog, 'AA')
          // /Names → /JavaScript
          try {
            const namesRef  = catalog.get(PDFName.of('Names'))
            const namesDict = namesRef ? context.lookup(namesRef) : null
            if (namesDict) del(namesDict, 'JavaScript')
          } catch {}
          // Per-page /AA
          for (const page of pages) {
            try { del(page.node, 'AA') } catch {}
          }
          removed.push('JavaScript')
        }

        // ── Annotations ───────────────────────────────────────────────────────
        if (strip.annots) {
          for (const page of pages) {
            try { del(page.node, 'Annots') } catch {}
          }
          removed.push('Annotations')
        }

        // ── Bookmarks ─────────────────────────────────────────────────────────
        if (strip.bookmarks) {
          del(catalog, 'Outlines')
          // Also reset PageMode so sidebar doesn't try to show a missing outline
          try {
            const pm = catalog.get(PDFName.of('PageMode'))?.toString()
            if (pm === '/UseOutlines') {
              catalog.set(PDFName.of('PageMode'), PDFName.of('UseNone'))
            }
          } catch {}
          removed.push('Bookmarks')
        }

        // ── Embedded files ────────────────────────────────────────────────────
        if (strip.embedded) {
          try {
            const namesRef  = catalog.get(PDFName.of('Names'))
            const namesDict = namesRef ? context.lookup(namesRef) : null
            if (namesDict) del(namesDict, 'EmbeddedFiles')
          } catch {}
          del(catalog, 'Collection')   // PDF portfolio
          removed.push('Embedded files')
        }

        // ── Form fields ───────────────────────────────────────────────────────
        if (strip.forms) {
          try {
            // Flatten first (bake values into page content), then delete AcroForm
            const form = doc.getForm()
            if (form.getFields().length > 0) {
              form.flatten()
            }
          } catch {}
          del(catalog, 'AcroForm')
          removed.push('Form fields')
        }

        // ── Metadata ──────────────────────────────────────────────────────────
        if (strip.meta) {
          try { doc.setTitle('')    } catch {}
          try { doc.setAuthor('')   } catch {}
          try { doc.setSubject('')  } catch {}
          try { doc.setKeywords([]) } catch {}
          try { doc.setCreator('')  } catch {}
          try { doc.setProducer('') } catch {}
          // Delete XMP metadata stream
          del(catalog, 'Metadata')
          removed.push('Metadata')
        }

        // ── Digital signatures ────────────────────────────────────────────────
        if (strip.sigs) {
          // Remove signature fields from AcroForm fields array
          try {
            const acroFormRef  = catalog.get(PDFName.of('AcroForm'))
            const acroFormDict = acroFormRef ? context.lookup(acroFormRef) : null
            if (acroFormDict) {
              // Clear SigFlags
              del(acroFormDict, 'SigFlags')
              // Filter out Sig fields from /Fields array
              const fieldsRef = acroFormDict.get(PDFName.of('Fields'))
              if (fieldsRef) {
                const fields = context.lookup(fieldsRef)
                if (fields instanceof PDFArray) {
                  const filtered = []
                  for (let i = 0; i < fields.size(); i++) {
                    const ref  = fields.get(i)
                    const fld  = context.lookup(ref)
                    const ft   = fld?.get?.(PDFName.of('FT'))?.toString?.()
                    if (ft !== '/Sig') filtered.push(ref)
                  }
                  // Replace array
                  const newArr = PDFArray.withContext(context)
                  filtered.forEach(r => newArr.push(r))
                  acroFormDict.set(PDFName.of('Fields'), newArr)
                }
              }
            }
          } catch {}
          removed.push('Digital signatures')
        }

        const outBytes = await pdf.save(doc)
        const outName  = srcFile.name.replace(/\.pdf$/i, '_stripped.pdf')
        await saveAs(outBytes, outName)

        toast(
          `Stripped: ${removed.join(', ')} → ${outName}`,
          'success', 5000
        )
      } catch (err) {
        if (err.name !== 'AbortError') { console.error(err); toast('Failed: ' + err.message, 'error') }
      } finally {
        hideProgress()
      }
    })
  },
})
