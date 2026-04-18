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
import { toast, showProgress, updateProgress, hideProgress, promptPassword } from '../core/ui.js'
import { get }                                                               from '../core/state.js'

registerFeature({
  id:          'unlock',
  name:        'Unlock',
  category:    'Protect',
  icon:        '🔓',
  description: 'Remove printing/copying restrictions from a PDF',

  render(container) {
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

        <div class="section-label">Select PDF</div>
        <div class="file-drop-zone" id="unlock-drop">
          Drag a PDF here, or
          <button class="btn btn-sm" id="unlock-browse">Browse</button>
          <input type="file" id="unlock-input" accept=".pdf" hidden>
        </div>
        <div id="unlock-filename" class="file-name-display"></div>

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
          <button class="btn btn-primary btn-lg" id="unlock-run" disabled>Unlock PDF</button>
        </div>

      </div>
    `

    // ── Drop zone ─────────────────────────────────────────────────────────────
    let srcFile = null
    let srcPwd  = null
    const dropZone = container.querySelector('#unlock-drop')
    const input    = container.querySelector('#unlock-input')
    const nameEl   = container.querySelector('#unlock-filename')
    const runBtn   = container.querySelector('#unlock-run')

    const setFile = file => {
      srcFile = file
      nameEl.textContent = file.name
      runBtn.disabled    = false
    }

    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over')
      const f = Array.from(e.dataTransfer.files).find(f => f.name.toLowerCase().endsWith('.pdf'))
      if (f) setFile(f)
    })
    container.querySelector('#unlock-browse').addEventListener('click', () => input.click())
    input.addEventListener('change', e => {
      if (e.target.files[0]) setFile(e.target.files[0])
      input.value = ''
    })

    // ── Auto-load from global file state ──────────────────────────────────
    const gf = get().currentFile
    if (gf) setTimeout(() => { setFile(gf.file); srcPwd = gf.pwd }, 0)

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
          if (!pwd) return
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
