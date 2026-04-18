/**
 * Fill Forms — detect AcroForm fields in a PDF and let the user fill them.
 *
 * Supports all standard AcroForm field types:
 *   TextField    → <input type="text"> or <textarea>
 *   CheckBox     → <input type="checkbox">
 *   RadioGroup   → <input type="radio"> group
 *   Dropdown     → <select>
 *   OptionList   → <select multiple>
 *   PushButton   → shown as read-only label (submit/reset actions not supported)
 *   SignatureField → shown as read-only label
 *
 * On Save, all values are written back and `form.flatten()` is called to bake
 * them permanently into the page content (no longer interactive).
 */

import { registerFeature }                              from '../core/registry.js'
import { readFile, saveAs }                             from '../core/fs.js'
import * as pdf                                         from '../core/pdf.js'
import {
  PDFTextField, PDFCheckBox, PDFRadioGroup,
  PDFDropdown, PDFOptionList, PDFButton,
} from '@cantoo/pdf-lib'
import { toast, showProgress, hideProgress, promptPassword } from '../core/ui.js'
import { get }                                              from '../core/state.js'

registerFeature({
  id:          'fill-forms',
  name:        'Fill Forms',
  category:    'Extract',
  icon:        '📝',
  description: 'Fill PDF form fields (AcroForms) and flatten to a static PDF',

  render(container) {
    const gf = get().currentFile
    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Fill Forms</h2>
          <p class="feature-desc">Detect interactive form fields, fill them in, then save a flat PDF.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">📝</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>
      `
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Fill Forms</h2>
        <p class="feature-desc">
          Detect interactive form fields in <strong style="color:var(--text);">${gf.name}</strong>, fill them in, then save a flat PDF with
          the values baked into the page — no longer editable, readable in any viewer.
        </p>
      </div>

      <div class="feature-split">

        <div class="panel">
          <div class="panel-header"><span class="panel-title">① Open PDF</span></div>
          <div id="ff-info" class="status-text" style="margin-top:4px;"></div>

          <div class="option-row" style="margin-top:14px;">
            <label>After saving</label>
            <select id="ff-flatten" class="input" style="max-width:220px;">
              <option value="yes" selected>Flatten (lock fields permanently)</option>
              <option value="no">Keep fields interactive</option>
            </select>
          </div>
          <span class="status-text" style="display:block;margin-top:4px;">
            Flattening bakes values into the page and removes the form structure.
            Use "keep interactive" if you want others to continue editing.
          </span>
        </div>

        <div class="panel" style="display:flex;flex-direction:column;justify-content:flex-end;">
          <div class="action-bar" style="margin-top:0;">
            <button class="btn btn-primary btn-lg" id="ff-save"
              style="width:100%;justify-content:center;">
              Save Filled PDF
            </button>
          </div>
        </div>

      </div>

      <!-- Form fields render here -->
      <div id="ff-form-panel" style="display:none;">
        <div class="panel" style="margin-top:0;">
          <div class="panel-header">
            <span class="panel-title">② Fill in Fields</span>
            <span id="ff-field-count" class="status-text"></span>
          </div>
          <div id="ff-fields" style="display:flex;flex-direction:column;gap:14px;padding:4px 0;"></div>
        </div>
      </div>
    `

    let pdfDoc  = null

    const infoEl  = container.querySelector('#ff-info')
    const saveBtn = container.querySelector('#ff-save')
    const formPanel  = container.querySelector('#ff-form-panel')
    const fieldsEl   = container.querySelector('#ff-fields')
    const fieldCount = container.querySelector('#ff-field-count')

    // Auto-load from global file state
    ;(async () => {
      const { file, pwd: initialPwd } = get().currentFile
      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(file)
        let pwd = initialPwd
        try {
          pdfDoc = await pdf.load(bytes, pwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err
          hideProgress()
          pwd = await promptPassword(file.name)
          if (!pwd) return
          showProgress('Decrypting…')
          pdfDoc = await pdf.load(bytes, pwd)
        }

        const form   = pdfDoc.getForm()
        const fields = form.getFields()

        if (!fields.length) {
          infoEl.textContent = 'No interactive form fields found in this PDF.'
          toast('No form fields detected.', 'warning')
          return
        }

        infoEl.textContent  = `${pdfDoc.getPageCount()} pages`
        fieldCount.textContent = `${fields.length} field${fields.length > 1 ? 's' : ''}`
        formPanel.style.display = ''

        // ── Build form UI ───────────────────────────────────────────────────
        fieldsEl.innerHTML = ''

        for (const field of fields) {
          const name = field.getName()
          const wrap = document.createElement('div')
          wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;'

          const label = document.createElement('label')
          label.style.cssText = 'font-size:13px;font-weight:500;color:var(--text);'
          label.textContent   = name
          wrap.appendChild(label)

          if (field instanceof PDFTextField) {
            const isMulti = field.isMultiline?.() ?? false
            const el = isMulti
              ? document.createElement('textarea')
              : document.createElement('input')
            el.className = 'input'
            el.dataset.fieldName = name
            el.dataset.fieldType = 'text'
            if (!isMulti) el.type = 'text'
            else          el.rows = 3
            try { el.value = field.getText() || '' } catch {}
            try {
              if (field.isReadOnly?.()) {
                el.readOnly = true
                el.style.opacity = '.6'
                label.textContent += ' (read-only)'
              }
            } catch {}
            wrap.appendChild(el)

          } else if (field instanceof PDFCheckBox) {
            const row = document.createElement('div')
            row.style.cssText = 'display:flex;align-items:center;gap:8px;'
            const el = document.createElement('input')
            el.type = 'checkbox'
            el.style.width = 'auto'
            el.dataset.fieldName = name
            el.dataset.fieldType = 'checkbox'
            try { el.checked = field.isChecked() } catch {}
            const lbl = document.createElement('span')
            lbl.style.cssText = 'font-size:13px;color:var(--text-muted);'
            lbl.textContent   = el.checked ? 'Checked' : 'Unchecked'
            el.addEventListener('change', () => { lbl.textContent = el.checked ? 'Checked' : 'Unchecked' })
            row.appendChild(el)
            row.appendChild(lbl)
            wrap.appendChild(row)

          } else if (field instanceof PDFRadioGroup) {
            let options = []
            try { options = field.getOptions() } catch {}
            let selected = null
            try { selected = field.getSelected() } catch {}
            const radioWrap = document.createElement('div')
            radioWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;'
            radioWrap.dataset.fieldName = name
            radioWrap.dataset.fieldType = 'radio'
            for (const opt of options) {
              const row = document.createElement('label')
              row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;'
              const radio = document.createElement('input')
              radio.type  = 'radio'
              radio.name  = `ff-radio-${name}`
              radio.value = opt
              radio.style.width = 'auto'
              if (opt === selected) radio.checked = true
              const txt = document.createElement('span')
              txt.textContent = opt
              row.appendChild(radio)
              row.appendChild(txt)
              radioWrap.appendChild(row)
            }
            wrap.appendChild(radioWrap)

          } else if (field instanceof PDFDropdown) {
            const el = document.createElement('select')
            el.className = 'input'
            el.dataset.fieldName = name
            el.dataset.fieldType = 'dropdown'
            let options = []
            try { options = field.getOptions() } catch {}
            let selected = null
            try { selected = field.getSelected()?.[0] } catch {}
            for (const opt of options) {
              const o = document.createElement('option')
              o.value = opt; o.textContent = opt
              if (opt === selected) o.selected = true
              el.appendChild(o)
            }
            wrap.appendChild(el)

          } else if (field instanceof PDFOptionList) {
            const el = document.createElement('select')
            el.className = 'input'
            el.multiple  = true
            el.size      = Math.min(5, 3)
            el.dataset.fieldName = name
            el.dataset.fieldType = 'optionlist'
            let options  = []
            let selected = []
            try { options  = field.getOptions()  } catch {}
            try { selected = field.getSelected() ?? [] } catch {}
            for (const opt of options) {
              const o = document.createElement('option')
              o.value = opt; o.textContent = opt
              if (selected.includes(opt)) o.selected = true
              el.appendChild(o)
            }
            wrap.appendChild(el)

          } else {
            // Button / Signature / unknown — show read-only label
            const note = document.createElement('span')
            note.style.cssText = 'font-size:12px;color:var(--text-subtle);font-style:italic;'
            if (field instanceof PDFButton) {
              note.textContent = '(Push button — not fillable)'
            } else {
              note.textContent = '(Signature field — not fillable here)'
            }
            wrap.appendChild(note)
          }

          fieldsEl.appendChild(wrap)
        }

      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed to load: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })()

    // Save
    saveBtn.addEventListener('click', async () => {
      if (!pdfDoc) return
      showProgress('Applying values…')
      try {
        const form    = pdfDoc.getForm()
        let   filled  = 0

        // Write values from UI back to form
        fieldsEl.querySelectorAll('[data-field-name]').forEach(el => {
          const name = el.dataset.fieldName
          const type = el.dataset.fieldType
          try {
            if (type === 'text') {
              form.getTextField(name).setText(el.value)
              filled++
            } else if (type === 'checkbox') {
              el.checked ? form.getCheckBox(name).check() : form.getCheckBox(name).uncheck()
              filled++
            } else if (type === 'radio') {
              const checked = el.querySelector('input[type="radio"]:checked')
              if (checked) { form.getRadioGroup(name).select(checked.value); filled++ }
            } else if (type === 'dropdown') {
              form.getDropdown(name).select(el.value)
              filled++
            } else if (type === 'optionlist') {
              const vals = [...el.selectedOptions].map(o => o.value)
              if (vals.length) { form.getOptionList(name).select(vals); filled++ }
            }
          } catch (e) {
            console.warn(`fill-forms: could not set field "${name}":`, e)
          }
        })

        // Flatten if requested
        if (container.querySelector('#ff-flatten').value === 'yes') {
          updateProgress('Flattening…')
          try { form.flatten() } catch (e) { console.warn('flatten partial:', e) }
        }

        const outBytes = await pdf.save(pdfDoc)
        const outName  = get().currentFile.file.name.replace(/\.pdf$/i, '_filled.pdf')
        await saveAs(outBytes, outName)
        toast(`${filled} field${filled !== 1 ? 's' : ''} saved → ${outName}`, 'success')

      } catch (err) {
        if (err.name !== 'AbortError') { console.error(err); toast('Failed: ' + err.message, 'error') }
      } finally {
        hideProgress()
      }
    })
  },
})
