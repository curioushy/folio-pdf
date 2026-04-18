/**
 * Password feature — add or remove password protection on a PDF.
 *
 * Decryption strategy (two-tier):
 *   1. Preferred — @cantoo/pdf-lib natively decrypts via PDFDocument.load(bytes, { password }).
 *      Output keeps selectable text, form fields, bookmarks. Fast and lossless.
 *   2. Fallback  — PDF.js decrypts + we render each page to JPEG and repack.
 *      Only used when @cantoo can't handle the specific cipher (rare).
 *      Trade-off: output is image-based (no selectable text).
 *
 * Why a fallback at all: PDF.js has been hardened against the full range of
 * encryption schemes (RC4-40, RC4-128, AES-128, AES-256, AES-256-r6). If a
 * legacy or non-standard-encoded PDF slips past @cantoo, PDF.js usually copes.
 */

import { registerFeature } from '../core/registry.js'
import { readFile, saveAs } from '../core/fs.js'
import * as pdf from '../core/pdf.js'
import { loadForRender, renderToUnencryptedPdf } from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { get }                                                               from '../core/state.js'

registerFeature({
  id:          'password',
  name:        'Password',
  category:    'Protect',
  icon:        '🔒',
  description: 'Add or remove password protection on a PDF',

  render(container) {
    container.innerHTML = `
      <div class="feature-header">
        <h2>Password Protection</h2>
        <p class="feature-desc">Add a password to lock a PDF, or remove an existing one.</p>
      </div>

      <div class="panel">
        <div class="tab-group">
          <button class="tab active" data-tab="protect">Protect</button>
          <button class="tab"        data-tab="remove">Remove password</button>
        </div>

        <!-- ── Protect tab ── -->
        <div id="tab-protect" class="tab-content">
          <div class="section-label">Select PDF</div>
          <div class="file-drop-zone" id="protect-drop">
            Drag a PDF here, or
            <button class="btn btn-sm" id="protect-browse">Browse</button>
            <input type="file" id="protect-input" accept=".pdf" hidden>
          </div>
          <div id="protect-filename" class="file-name-display"></div>

          <div class="section-label">Passwords</div>
          <div class="option-row">
            <label>User password <small>(to open)</small></label>
            <input type="password" id="protect-user-pwd" class="input" placeholder="Required to open the PDF" style="max-width:260px;" autocomplete="new-password">
          </div>
          <div class="option-row">
            <label>Owner password <small>(to edit)</small></label>
            <input type="password" id="protect-owner-pwd" class="input" placeholder="Optional — restricts editing" style="max-width:260px;" autocomplete="new-password">
          </div>

          <div class="section-label" style="margin-top:14px;">Permissions</div>
          <label class="option-row"><input type="checkbox" id="perm-print"  checked> Allow printing</label>
          <label class="option-row"><input type="checkbox" id="perm-copy">           Allow copying text</label>
          <label class="option-row"><input type="checkbox" id="perm-modify">         Allow modifying</label>
          <label class="option-row"><input type="checkbox" id="perm-annot"  checked> Allow annotations</label>
          <label class="option-row"><input type="checkbox" id="perm-forms"  checked> Allow filling forms</label>

          <div class="action-bar">
            <button class="btn btn-primary btn-lg" id="protect-run" disabled>Protect PDF</button>
          </div>
        </div>

        <!-- ── Remove tab ── -->
        <div id="tab-remove" class="tab-content hidden">
          <div class="section-label">Select password-protected PDF</div>
          <div class="file-drop-zone" id="remove-drop">
            Drag a PDF here, or
            <button class="btn btn-sm" id="remove-browse">Browse</button>
            <input type="file" id="remove-input" accept=".pdf" hidden>
          </div>
          <div id="remove-filename" class="file-name-display"></div>

          <div class="section-label">Current password</div>
          <div class="option-row">
            <label>Password</label>
            <input type="password" id="remove-pwd" class="input"
              placeholder="Enter the PDF's current password"
              style="max-width:260px;" autocomplete="current-password">
          </div>

          <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin:12px 0;font-size:12.5px;color:var(--text-muted);">
            The unlocked PDF keeps selectable text and bookmarks when possible.
            If the PDF uses a non-standard cipher, we fall back to an image-based
            conversion (text no longer selectable) — a notice will appear.
          </div>

          <div class="action-bar">
            <button class="btn btn-primary btn-lg" id="remove-run" disabled>Remove password</button>
          </div>
        </div>
      </div>
    `

    // ── Tabs ─────────────────────────────────────────────────────────────────
    container.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
        container.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'))
        tab.classList.add('active')
        container.querySelector(`#tab-${tab.dataset.tab}`).classList.remove('hidden')
      })
    })

    // ── Shared drop zone helper ───────────────────────────────────────────────
    function setupDropZone(dropId, inputId, filenameId, runBtnId, onFile) {
      const dropZone = container.querySelector(`#${dropId}`)
      const input    = container.querySelector(`#${inputId}`)
      const nameEl   = container.querySelector(`#${filenameId}`)
      const runBtn   = container.querySelector(`#${runBtnId}`)

      const setFile = file => { onFile(file); nameEl.textContent = file.name; runBtn.disabled = false }

      dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
      dropZone.addEventListener('drop', e => {
        e.preventDefault(); dropZone.classList.remove('drag-over')
        const f = Array.from(e.dataTransfer.files).find(f => f.name.toLowerCase().endsWith('.pdf'))
        if (f) setFile(f)
      })
      dropZone.querySelector('button').addEventListener('click', () => input.click())
      input.addEventListener('change', e => { if (e.target.files[0]) setFile(e.target.files[0]); input.value = '' })
    }

    // ── Protect tab ──────────────────────────────────────────────────────────
    let protectFile = null
    let protectPwd  = null
    setupDropZone('protect-drop', 'protect-input', 'protect-filename', 'protect-run',
      f => { protectFile = f; protectPwd = null })

    container.querySelector('#protect-run').addEventListener('click', async () => {
      const userPwd  = container.querySelector('#protect-user-pwd').value
      const ownerPwd = container.querySelector('#protect-owner-pwd').value
      if (!userPwd && !ownerPwd) { toast('Enter at least one password.', 'warning'); return }

      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(protectFile)
        const doc = await loadWithOptionalDecrypt(bytes, protectFile.name, protectPwd)
        if (!doc) return   // user cancelled password prompt

        const permissions = {
          printing:     container.querySelector('#perm-print').checked,
          copying:      container.querySelector('#perm-copy').checked,
          modifying:    container.querySelector('#perm-modify').checked,
          annotating:   container.querySelector('#perm-annot').checked,
          fillingForms: container.querySelector('#perm-forms').checked,
        }

        updateProgress('Encrypting…')
        const outBytes = await pdf.protect(doc, { userPassword: userPwd, ownerPassword: ownerPwd, permissions })
        const outName  = protectFile.name.replace(/\.pdf$/i, '_protected.pdf')
        await saveAs(outBytes, outName)
        toast(`PDF protected → ${outName}`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') {
          toast(err.code === 'WRONG_PASSWORD' ? 'Wrong password.' : 'Failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    })

    /**
     * Load a PDF. If encrypted, prompt for the password and:
     *   1) Try pdf-lib native decrypt (keeps text). If successful → return loaded doc.
     *   2) Otherwise fall back to PDF.js + image render, then re-load the image-PDF.
     * Returns null if the user cancels the password prompt.
     */
    async function loadWithOptionalDecrypt(bytes, fileName, initialPwd = null) {
      try {
        return await pdf.load(bytes, initialPwd || undefined)
      } catch (err) {
        if (err.code !== 'ENCRYPTED') throw err
      }
      hideProgress()
      const pwd = await promptPassword(fileName)
      if (!pwd) return null

      // Preferred path — text preserved
      showProgress('Decrypting…')
      try {
        return await pdf.load(bytes, pwd)
      } catch (err) {
        if (err.code !== 'WRONG_PASSWORD') throw err
        // Might be a legitimate wrong password, OR an unsupported cipher.
        // Verify by trying PDF.js — it distinguishes the two cases clearly.
      }

      // Fallback — PDF.js decrypt + image render
      updateProgress('Decrypting via fallback renderer…')
      const renderDoc = await loadForRender(bytes, pwd)
      updateProgress('Converting pages to images…')
      const imageBytes = await renderToUnencryptedPdf(renderDoc, {
        onProgress: (n, t) => updateProgress(`Page ${n}/${t}…`),
      })
      renderDoc.destroy()
      toast('Used image-based fallback — text may not be selectable.', 'warning', 5000)
      return pdf.load(imageBytes)
    }

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) {
      setTimeout(() => {
        protectFile = gf.file
        protectPwd  = gf.pwd
        container.querySelector('#protect-filename').textContent = gf.file.name
        container.querySelector('#protect-run').disabled = false
      }, 0)
    }

    // ── Remove tab ───────────────────────────────────────────────────────────
    // Uses PDF.js for decryption since pdf-lib v1.x cannot decrypt any PDF.
    let removeFile = null
    setupDropZone('remove-drop', 'remove-input', 'remove-filename', 'remove-run',
      f => { removeFile = f })

    container.querySelector('#remove-run').addEventListener('click', async () => {
      const password = container.querySelector('#remove-pwd').value
      if (!password) { toast('Enter the current password.', 'warning'); return }

      showProgress('Loading encrypted PDF…')
      try {
        const bytes = await readFile(removeFile)

        // ── Tier 1: native @cantoo/pdf-lib decrypt (keeps selectable text) ──
        try {
          updateProgress('Decrypting…')
          const doc = await pdf.load(bytes, password)
          updateProgress('Saving unlocked PDF…')
          const outBytes = await pdf.save(doc)
          const outName  = removeFile.name.replace(/\.pdf$/i, '_unlocked.pdf')
          await saveAs(outBytes, outName)
          toast(`Password removed → ${outName} (${doc.getPageCount()} pages)`, 'success')
          return
        } catch (err) {
          if (err.code !== 'WRONG_PASSWORD') throw err
          // Could be an actual wrong password — or an unsupported cipher.
          // Fall through to PDF.js, which will distinguish the two.
        }

        // ── Tier 2: PDF.js decrypt → image-render fallback ──
        updateProgress('Using fallback renderer…')
        let renderDoc
        try {
          renderDoc = await loadForRender(bytes, password)
        } catch (err) {
          if (err.code === 'WRONG_PASSWORD') {
            toast('Wrong password — could not decrypt the PDF.', 'error')
            return
          }
          if (err.code === 'ENCRYPTED') {
            toast('This PDF requires a password. Please enter it above.', 'warning')
            return
          }
          throw err
        }

        const total = renderDoc.numPages
        const outBytes = await renderToUnencryptedPdf(renderDoc, {
          onProgress: (n, t) => updateProgress(`Rendering page ${n} of ${t}…`),
        })
        renderDoc.destroy()

        const outName = removeFile.name.replace(/\.pdf$/i, '_unlocked.pdf')
        await saveAs(outBytes, outName)
        toast(`Password removed → ${outName} (${total} pages, image-based fallback)`, 'success', 5000)
      } catch (err) {
        if (err.name !== 'AbortError') toast('Failed: ' + err.message, 'error')
      } finally {
        hideProgress()
      }
    })
  },
})

