/**
 * Persistent settings via localStorage.
 * Stores: workspace bookmarks, operation presets, general settings.
 */

const KEY = 'folio-v1'

function load() {
  try   { return JSON.parse(localStorage.getItem(KEY) || '{}') }
  catch { return {} }
}

function save(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)) }
  catch (e) { console.warn('localStorage write failed:', e) }
}

// ── Workspaces ────────────────────────────────────────────────────────────────

/**
 * Save a named workspace (stores display name + last-used timestamp).
 * We can't persist FileSystemDirectoryHandle reliably across sessions,
 * so we store metadata only and re-prompt on next open.
 */
export function saveWorkspace(name) {
  const d = load()
  const list = d.workspaces || []
  const idx  = list.findIndex(w => w.name === name)
  const entry = { name, lastUsed: Date.now() }
  if (idx >= 0) list[idx] = entry
  else list.unshift(entry)
  save({ ...d, workspaces: list.slice(0, 10) }) // keep last 10
}

/** @returns {Array<{name:string, lastUsed:number}>} */
export function getWorkspaces() {
  return (load().workspaces || [])
}

// ── Presets ───────────────────────────────────────────────────────────────────

/**
 * Save a named operation preset.
 * @param {{ id:string, name:string, featureId:string, options:object }} preset
 */
export function savePreset(preset) {
  const d = load()
  const list = d.presets || []
  const idx  = list.findIndex(p => p.id === preset.id)
  if (idx >= 0) list[idx] = preset
  else list.push(preset)
  save({ ...d, presets: list })
}

export function getPresets(featureId = null) {
  const list = load().presets || []
  return featureId ? list.filter(p => p.featureId === featureId) : list
}

export function deletePreset(id) {
  const d = load()
  save({ ...d, presets: (d.presets || []).filter(p => p.id !== id) })
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function getSetting(key, defaultValue = null) {
  return (load().settings || {})[key] ?? defaultValue
}

export function saveSetting(key, value) {
  const d = load()
  save({ ...d, settings: { ...(d.settings || {}), [key]: value } })
}
