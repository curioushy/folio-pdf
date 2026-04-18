/**
 * Central application state with a simple pub/sub pattern.
 * Features read state.get() and subscribe() for reactive updates.
 */

const listeners = new Set()

const _state = {
  /** @type {FileSystemDirectoryHandle|null} */
  workspace: null,
  workspaceName: null,

  /** @type {Array<{name:string, path:string, handle:FileSystemFileHandle, dirHandle:FileSystemDirectoryHandle}>} */
  scannedFiles: [],

  /** @type {string|null} active feature id */
  activeFeature: null,

  /**
   * The globally open PDF — set by the sidebar file slot.
   * Single-file features read this so the user doesn't have to re-load the
   * same document when switching tools.
   * @type {{ file: File, name: string, pwd: string|null, pageCount: number }|null}
   */
  currentFile: null,
}

/** Read a shallow copy of current state. */
export function get() {
  return { ..._state }
}

/**
 * Merge a partial patch into state and notify all subscribers.
 * @param {Partial<typeof _state>} patch
 */
export function update(patch) {
  Object.assign(_state, patch)
  const snapshot = get()
  listeners.forEach(fn => fn(snapshot))
}

/**
 * Subscribe to state changes.
 * @param {(state: typeof _state) => void} fn
 * @returns {() => void} unsubscribe function
 */
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
