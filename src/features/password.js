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
import { toast, showProgress, updateProgress, hideProgress, promptPassword, confirm } from '../core/ui.js'
import { get }                                                               from '../core/state.js'

registerFeature({
  id:          'password',
  name:        'Password',
  category:    'Protect',
  icon:        '🔒',
  description: 'Add or remove password protection on a PDF',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Password Protection</h2>
          <p class="feature-desc">Add a password to lock a PDF, or remove an existing one.</p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">🔒</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>`
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Password Protection</h2>
        <p class="feature-desc">Add a password to lock a PDF, or remove an existing one.</p>
      </div>

      <div class="panel">
        <div class="tab-group">
          <button class="tab active" data-tab="protect">Protect</button>
          <button class="tab"        data-tab="remove">Remove password</button>
          <button class="tab"        data-tab="unlock">Unlock</button>
        </div>

        <!-- ── Protect tab ── -->
        <div id="tab-protect" class="tab-content">
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
            <button class="btn btn-primary btn-lg" id="protect-run">Protect PDF</button>
          </div>
        </div>

        <!-- ── Remove tab ── -->
        <div id="tab-remove" class="tab-content hidden">
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
            <button class="btn btn-primary btn-lg" id="remove-run">Remove password</button>
          </div>
        </div>

        <!-- ── Unlock tab ── -->
        <div id="tab-unlock" class="tab-content hidden">
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;margin:14px 0;font-size:13px;color:var(--text-muted);line-height:1.6;">
            <strong style="color:var(--text);">What this does</strong><br>
            Re-saves the PDF without its permission flags. The output has the same
            pages, text, images and bookmarks — just no "locked" behavior in Acrobat
            or browser viewers.
            <br><br>
            <strong style="color:var(--text);">If the PDF has a user password</strong><br>
            You'll be asked to enter it. Only PDFs you have the right to open.
          </div>
          <div class="action-bar">
            <button class="btn btn-primary btn-lg" id="unlock-run">Unlock PDF</button>
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

    // ── Protect tab ──────────────────────────────────────────────────────────
    let protectFile = gf.file
    let protectPwd  = gf.pwd

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

    // ── Remove tab ───────────────────────────────────────────────────────────
    let removeFile = gf.file
    if (gf.pwd) container.querySelector('#remove-pwd').value = gf.pwd

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

    // ── Unlock tab ───────────────────────────────────────────────────────────
    container.querySelector('#unlock-run').addEventListener('click', async () => {
      const cf = get().currentFile
      if (!cf) return
      const srcFile = cf.file
      let srcPwd = cf.pwd

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

          if (!pwd) {
            const proceed = await confirm(
              'No password provided. Create a rasterized (image-based) copy instead? ' +
              'This works for PDFs that open without a password but have print/copy ' +
              'restrictions. Text in the output will not be selectable.',
              'Use Rasterized Version?'
            )
            if (!proceed) return
            showProgress('Opening PDF…')
            let renderDoc
            try {
              renderDoc = await loadForRender(bytes)
            } catch (errR) {
              if (errR.code === 'ENCRYPTED' || errR.code === 'WRONG_PASSWORD') {
                toast('This PDF needs a password to open — cannot create a rasterized copy.', 'error', 5000)
                return
              }
              throw errR
            }
            const total = renderDoc.numPages
            const outBytes = await renderToUnencryptedPdf(renderDoc, {
              onProgress: (n, t) => updateProgress(`Rendering page ${n} of ${t}…`),
            })
            renderDoc.destroy()
            const outName = srcFile.name.replace(/\.pdf$/i, '_unlocked.pdf')
            await saveAs(outBytes, outName)
            toast(`Unlocked → ${outName} (${total} pages, image-based — text may not be selectable)`, 'success', 5000)
            return
          }

          srcPwd = pwd
          showProgress('Decrypting…')
          try {
            doc = await pdf.load(bytes, pwd)
          } catch (err2) {
            if (err2.code !== 'WRONG_PASSWORD') throw err2
            updateProgress('Trying fallback renderer…')
            let renderDoc
            try {
              renderDoc = await loadForRender(bytes, pwd)
            } catch (err3) {
              if (err3.code === 'WRONG_PASSWORD') {
                toast('Wrong password — could not decrypt the PDF.', 'error')
                return
              }
              throw err3
            }
            const total = renderDoc.numPages
            const outBytes = await renderToUnencryptedPdf(renderDoc, {
              onProgress: (n, t) => updateProgress(`Rendering page ${n} of ${t}…`),
            })
            renderDoc.destroy()
            const outName = srcFile.name.replace(/\.pdf$/i, '_unlocked.pdf')
            await saveAs(outBytes, outName)
            toast(`Unlocked → ${outName} (${total} pages, image-based fallback — text may not be selectable)`, 'success', 5000)
            return
          }
        }

        updateProgress('Saving unlocked PDF…')
        const outBytes = await pdf.save(doc)
        const outName  = srcFile.name.replace(/\.pdf$/i, '_unlocked.pdf')
        await saveAs(outBytes, outName)
        toast(`Unlocked → ${outName} (${doc.getPageCount()} page${doc.getPageCount() > 1 ? 's' : ''})`, 'success')
      } catch (err) {
        if (err.name !== 'AbortError') { console.error(err); toast('Failed: ' + err.message, 'error') }
      } finally {
        hideProgress()
      }
    })
  },
})

