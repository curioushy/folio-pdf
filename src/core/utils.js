/**
 * Shared utility helpers — no dependencies on other core modules.
 */

/**
 * Parse a human-readable page range string into 0-based page indices.
 * Input uses 1-based page numbers.
 *
 * Examples:  "1-3"        → [0,1,2]
 *            "1,3,5"      → [0,2,4]
 *            "1-3, 7, 10-12" → [0,1,2,6,9,10,11]
 *
 * @param {string} rangeStr
 * @param {number} totalPages
 * @returns {number[]} sorted 0-based indices, empty array if invalid
 */
export function parsePageRange(rangeStr, totalPages) {
  const indices = new Set()
  const parts   = rangeStr.split(',').map(s => s.trim()).filter(Boolean)

  for (const part of parts) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(n => parseInt(n.trim()))
      if (isNaN(a) || isNaN(b) || a > b) continue
      for (let i = a; i <= b; i++) {
        const zero = i - 1
        if (zero >= 0 && zero < totalPages) indices.add(zero)
      }
    } else {
      const n    = parseInt(part)
      const zero = n - 1
      if (!isNaN(n) && zero >= 0 && zero < totalPages) indices.add(zero)
    }
  }

  return [...indices].sort((a, b) => a - b)
}

/**
 * Sanitise a string for use as a filename (removes/replaces illegal characters).
 * @param {string} name
 * @returns {string}
 */
export function safeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'output'
}

/**
 * Strip the .pdf extension from a filename.
 * @param {string} filename
 * @returns {string}
 */
export function stripExt(filename) {
  return filename.replace(/\.pdf$/i, '')
}

/**
 * Ensure a filename ends with .pdf.
 * @param {string} filename
 * @returns {string}
 */
export function ensurePdf(filename) {
  return filename.toLowerCase().endsWith('.pdf') ? filename : filename + '.pdf'
}
