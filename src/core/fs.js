/**
 * File System Access API wrapper.
 * All file I/O goes through here — features never call the API directly.
 */

import { get, update } from './state.js'
import { saveWorkspace } from './storage.js'

// ── Workspace ─────────────────────────────────────────────────────────────────

/**
 * Prompt user to pick a folder, then scan it for PDFs.
 * Updates state.workspace / workspaceName / scannedFiles.
 * @returns {FileSystemDirectoryHandle}
 */
export async function pickWorkspace() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  update({ workspace: handle, workspaceName: handle.name, scannedFiles: [], activeFeature: get().activeFeature })
  saveWorkspace(handle.name)
  return handle
}

/**
 * Recursively scan a directory for .pdf files.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} [basePath]
 * @returns {Promise<Array<{name:string, path:string, handle:FileSystemFileHandle, dirHandle:FileSystemDirectoryHandle}>>}
 */
export async function scanForPDFs(dirHandle, basePath = '') {
  const results = []
  try {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.pdf')) {
        results.push({
          name:      entry.name,
          path:      basePath ? `${basePath}/${entry.name}` : entry.name,
          handle:    entry,
          dirHandle,
        })
      } else if (entry.kind === 'directory') {
        const sub = basePath ? `${basePath}/${entry.name}` : entry.name
        const nested = await scanForPDFs(entry, sub)
        results.push(...nested)
      }
    }
  } catch {
    // Permission denied on a subfolder — skip it silently
  }
  return results
}

// ── Reading / writing ─────────────────────────────────────────────────────────

/**
 * Read a FileSystemFileHandle as ArrayBuffer.
 * @param {FileSystemFileHandle} fileHandle
 * @returns {Promise<ArrayBuffer>}
 */
export async function readHandle(fileHandle) {
  const file = await fileHandle.getFile()
  return file.arrayBuffer()
}

/**
 * Read a plain File object as ArrayBuffer.
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
export async function readFile(file) {
  return file.arrayBuffer()
}

/**
 * Write bytes back to the workspace.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} filename
 * @param {Uint8Array|ArrayBuffer} bytes
 */
export async function writeToWorkspace(dirHandle, filename, bytes) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true })
  const writable   = await fileHandle.createWritable()
  await writable.write(bytes)
  await writable.close()
}

/**
 * Prompt user to pick a save location (Save As dialog).
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} suggestedName
 * @returns {Promise<string>} saved filename
 */
export async function saveAs(bytes, suggestedName = 'output.pdf') {
  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [{
      description: 'PDF Document',
      accept: { 'application/pdf': ['.pdf'] },
    }],
  })
  const writable = await handle.createWritable()
  await writable.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  await writable.close()
  return handle.name
}

/**
 * Check if the File System Access API is available.
 * @returns {boolean}
 */
export function isSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}
