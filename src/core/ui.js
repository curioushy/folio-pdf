/**
 * Shared UI services: toasts, modals, progress, prompts.
 * Features import these helpers instead of manipulating DOM directly.
 */

// ── Toast ─────────────────────────────────────────────────────────────────────

/**
 * Show a transient notification.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} [type]
 * @param {number} [duration] ms
 */
export function toast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container')
  if (!container) return

  const el = document.createElement('div')
  el.className = `toast toast-${type}`
  el.textContent = message
  container.appendChild(el)

  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('visible'))
  })

  setTimeout(() => {
    el.classList.remove('visible')
    setTimeout(() => el.remove(), 250)
  }, duration)
}

// ── Modal ─────────────────────────────────────────────────────────────────────

let _modalResolve = null

/**
 * Show a modal dialog and return a Promise resolving to the clicked action's value.
 * @param {{ title:string, content:string|HTMLElement, actions:Array<{label:string, variant?:string, value:any}> }} opts
 * @returns {Promise<any>}
 */
export function modal({ title, content, actions = [] }) {
  return new Promise(resolve => {
    _modalResolve = resolve

    const overlay  = document.getElementById('modal-overlay')
    const titleEl  = document.getElementById('modal-title')
    const bodyEl   = document.getElementById('modal-content')
    const actionsEl= document.getElementById('modal-actions')

    titleEl.textContent = title
    bodyEl.innerHTML    = ''
    actionsEl.innerHTML = ''

    if (typeof content === 'string') {
      bodyEl.innerHTML = content
    } else {
      bodyEl.appendChild(content)
    }

    actions.forEach(({ label, variant = 'secondary', value }) => {
      const btn = document.createElement('button')
      btn.className   = `btn btn-${variant}`
      btn.textContent = label
      btn.addEventListener('click', () => {
        closeModal()
        resolve(value)
      })
      actionsEl.appendChild(btn)
    })

    overlay.classList.add('visible')

    // Auto-focus first input if present
    setTimeout(() => {
      const first = bodyEl.querySelector('input, textarea, select')
      if (first) first.focus()
    }, 50)
  })
}

export function closeModal() {
  document.getElementById('modal-overlay')?.classList.remove('visible')
}

// ── Confirm ───────────────────────────────────────────────────────────────────

/** @returns {Promise<boolean>} */
export function confirm(message, title = 'Confirm') {
  return modal({
    title,
    content: `<p style="font-size:13.5px;line-height:1.6;">${message}</p>`,
    actions: [
      { label: 'Cancel', variant: 'secondary', value: false },
      { label: 'OK',     variant: 'primary',   value: true  },
    ],
  })
}

// ── Password prompt ───────────────────────────────────────────────────────────

/**
 * Prompt for a password to open a PDF.
 * @param {string} filename
 * @returns {Promise<string|null>} password, or null if cancelled
 */
export function promptPassword(filename) {
  const wrap = document.createElement('div')
  wrap.innerHTML = `
    <p style="font-size:13px;margin-bottom:12px;">
      <strong>${filename}</strong> is password-protected.
    </p>
    <div class="pwd-row">
      <label>Password</label>
      <input type="password" id="modal-pwd" class="input" placeholder="Enter password" autocomplete="off">
    </div>
  `

  return new Promise(resolve => {
    modal({
      title: 'Password Required',
      content: wrap,
      actions: [
        { label: 'Cancel', variant: 'secondary', value: '__cancel__' },
        { label: 'Open',   variant: 'primary',   value: '__open__'   },
      ],
    }).then(result => {
      if (result === '__open__') {
        resolve(document.getElementById('modal-pwd')?.value ?? null)
      } else {
        resolve(null)
      }
    })

    // Allow Enter key to submit
    setTimeout(() => {
      document.getElementById('modal-pwd')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          closeModal()
          resolve(e.target.value)
        }
      })
    }, 60)
  })
}

// ── Progress ──────────────────────────────────────────────────────────────────

export function showProgress(message = 'Processing…') {
  const overlay = document.getElementById('progress-overlay')
  const msgEl   = document.getElementById('progress-message')
  if (msgEl)   msgEl.textContent = message
  overlay?.classList.add('visible')
}

export function updateProgress(message) {
  const el = document.getElementById('progress-message')
  if (el) el.textContent = message
}

export function hideProgress() {
  document.getElementById('progress-overlay')?.classList.remove('visible')
}

// ── Workspace file picker modal ───────────────────────────────────────────────

/**
 * Show a modal listing workspace files for multi-selection.
 * @param {Array<{name:string, path:string}>} files
 * @returns {Promise<number[]>} selected indices
 */
export function pickFromWorkspace(files) {
  if (!files.length) return Promise.resolve([])

  const list = document.createElement('div')
  list.className = 'file-picker-list'
  list.innerHTML = files.map((f, i) => `
    <label class="file-picker-row">
      <input type="checkbox" value="${i}">
      <span title="${f.path}">${f.path}</span>
    </label>
  `).join('')

  // Select all toggle
  const header = document.createElement('div')
  header.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:6px;'
  header.innerHTML = `<button class="btn btn-sm" id="ws-select-all">Select all</button>`
  const wrap = document.createElement('div')
  wrap.appendChild(header)
  wrap.appendChild(list)

  header.querySelector('#ws-select-all').addEventListener('click', () => {
    list.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true })
  })

  return modal({
    title: `Add from workspace (${files.length} PDFs)`,
    content: wrap,
    actions: [
      { label: 'Cancel',       variant: 'secondary', value: null    },
      { label: 'Add selected', variant: 'primary',   value: 'add'   },
    ],
  }).then(result => {
    if (result !== 'add') return []
    return Array.from(list.querySelectorAll('input:checked'))
      .map(cb => parseInt(cb.value))
  })
}
