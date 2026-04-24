/**
 * Unlock feature — strip owner-password restrictions ("no printing", "no copying",
 * "no modifying", etc.) from a PDF, producing a clean unrestricted copy.
 *
 * How it works:
 *   PDFs can carry an /Encrypt dictionary with permission flags that viewers
 *   voluntarily honor. Loading with @cantoo/pdf-lib and re-saving (without any
 *   encryption options) simply doesn't emit those flags — the output is clean.
 *
 * If the PDF also has a user password (required to open), we prompt for it.
 * If it has only owner restrictions and no user password, no prompt is needed.
 */

import { registerFeature }                                          from '../core/registry.js'
import { readFile, saveAs }                                         from '../core/fs.js'
import * as pdf                                                     from '../core/pdf.js'
import { loadForRender, renderToUnencryptedPdf }                    from '../core/renderer.js'
import { toast, showProgress, updateProgress, hideProgress, promptPassword, confirm } from '../core/ui.js'
import { get }                                                               from '../core/state.js'

registerFeature({
  id:          'unlock',
  name:        'Unlock',
  category:    'Protect',
  icon:        '🔓',
  description: 'Remove printing/copying restrictions from a PDF',

  render(container) {
    const gf = get().currentFile

    if (!gf) {
      container.innerHTML = `
        <div class="feature-header">
          <h2>Unlock PDF</h2>
          <p class="feature-desc">
            Remove "no printing", "no copying", "no modifying" and other owner-password
            restrictions. Produces a clean, unrestricted copy you can print or edit
            normally in any PDF viewer.
          </p>
        </div>
        <div class="no-file-nudge">
          <span class="no-file-icon">🔓</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>`
      return
    }

    container.innerHTML = `
      <div class="feature-header">
        <h2>Unlock PDF</h2>
        <p class="feature-desc">
          Remove "no printing", "no copying", "no modifying" and other owner-password
          restrictions. Produces a clean, unrestricted copy you can print or edit
          normally in any PDF viewer.
        </p>
      </div>

      <div class="panel">

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
    `

    let srcFile = gf.file
    let srcPwd  = gf.pwd
    const runBtn = container.querySelector('#unlock-run')

    // ── Run ───────────────────────────────────────────────────────────────────
    runBtn.addEventListener('click', async () => {
      if (!srcFile) return

      showProgress('Loading PDF…')
      try {
        const bytes = await readFile(srcFile)

        // ── Tier 1: try to load without a password (owner-restrictions only) ──
        let doc
        let usedFallback = false
        try {
          doc = await pdf.load(bytes, srcPwd || undefined)
        } catch (err) {
          if (err.code !== 'ENCRYPTED') throw err

          // PDF has a user password — ask for it
          hideProgress()
          const pwd = await promptPassword(srcFile.name)

          if (!pwd) {
            // User cancelled — offer rasterized fallback. Works for owner-restricted
            // PDFs (empty user password) since PDF.js opens them without any prompt.
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
            toast(
              `Unlocked → ${outName} (${total} pages, image-based — text may not be selectable)`,
              'success', 5000
            )
            return
          }

          srcPwd = pwd

          showProgress('Decrypting…')
          try {
            doc = await pdf.load(bytes, pwd)
          } catch (err2) {
            if (err2.code !== 'WRONG_PASSWORD') throw err2

            // ── Tier 2: PDF.js fallback for non-standard ciphers ──────────
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
            toast(
              `Unlocked → ${outName} (${total} pages, image-based fallback — text may not be selectable)`,
              'success', 5000
            )
            return
          }
        }

        // ── Save without any encryption options → clean, unrestricted output ──
        updateProgress('Saving unlocked PDF…')
        const outBytes = await pdf.save(doc)
        const outName  = srcFile.name.replace(/\.pdf$/i, '_unlocked.pdf')
        await saveAs(outBytes, outName)

        toast(
          `Unlocked → ${outName} (${doc.getPageCount()} page${doc.getPageCount() > 1 ? 's' : ''})`,
          'success'
        )
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err)
          toast('Failed: ' + err.message, 'error')
        }
      } finally {
        hideProgress()
      }
    })
  },
})
