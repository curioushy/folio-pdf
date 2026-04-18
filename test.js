#!/usr/bin/env node
/**
 * Folio PDF — static analysis + build test.
 *
 * Checks:
 *   1. All expected feature files exist
 *   2. Feature categories match the agreed nav layout
 *   3. All single-file features have global-file wiring (state import + currentFile)
 *   4. Multi-file tools do NOT depend on currentFile
 *   5. features/index.js imports every active feature
 *   6. Build succeeds and output is well-formed
 *
 * Run:  node test.js
 */

import { readFileSync, existsSync } from 'fs'
import { execSync }                 from 'child_process'

// ── Expected nav layout ────────────────────────────────────────────────────

const LAYOUT = {
  'Pages':       ['organise', 'split', 'crop', 'n-up', 'poster'],
  'Stamp':       ['watermark', 'header-footer'],
  'Protect':     ['password', 'unlock', 'sign', 'redact'],
  'Extract':     ['extract-text', 'extract-images', 'fill-forms', 'table-csv'],
  'Convert':     ['compress', 'flatten', 'pdf-to-images', 'repair', 'normalise-pages', 'strip-elements'],
  'Tools':       ['bookmarks', 'dark-reader', 'metadata'],
  'Multi-file':  ['merge', 'overlay', 'images-to-pdf', 'pdf-compare', 'batch'],
}

const SINGLE_FILE = Object.entries(LAYOUT)
  .filter(([cat]) => cat !== 'Multi-file')
  .flatMap(([, ids]) => ids)

const ALL_IDS = Object.values(LAYOUT).flat()

// ── Result tracking ────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const log = []

function ok(label)         { passed++; log.push(`  ✓  ${label}`) }
function fail(label, hint) { failed++; log.push(`  ✗  ${label}${hint ? `  ← ${hint}` : ''}`) }
function check(label, cond, hint = '') { cond ? ok(label) : fail(label, hint) }

function src(id) {
  const p = `src/features/${id}.js`
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

// ── 1. Feature files exist ─────────────────────────────────────────────────

log.push('\n── 1. Feature files exist ───────────────────────────────────')
for (const id of ALL_IDS) {
  check(id, existsSync(`src/features/${id}.js`), 'file not found')
}

// ── 2. Feature categories ──────────────────────────────────────────────────

log.push('\n── 2. Feature categories ────────────────────────────────────')
for (const [cat, ids] of Object.entries(LAYOUT)) {
  for (const id of ids) {
    const s = src(id)
    if (!s) { fail(`${id} → ${cat}`, 'file missing'); continue }
    const m = s.match(/category:\s*['"]([^'"]+)['"]/)
    const actual = m?.[1] ?? '(not found)'
    check(`${id.padEnd(20)}→  ${cat}`, actual === cat, `got "${actual}"`)
  }
}

// ── 3. Single-file: global file wiring ────────────────────────────────────

log.push('\n── 3. Global-file wiring (single-file features) ─────────────')
for (const id of SINGLE_FILE) {
  const s = src(id)
  if (!s) continue
  const hasGet  = s.includes("from '../core/state.js'") &&
                  (s.includes('get(') || s.includes('{ get'))
  const hasCF   = s.includes('currentFile')
  const hasPwd  = s.includes('srcPwd') || s.includes('initialPwd') || s.includes('gf.pwd') || s.includes('cf.pwd')
  check(`${id.padEnd(22)}state import + get()`,  hasGet,  'missing')
  check(`${id.padEnd(22)}reads currentFile`,      hasCF,   'missing')
  check(`${id.padEnd(22)}passes pwd through`,     hasPwd,  'missing')
}

// ── 4. Multi-file: no global-file dependency ──────────────────────────────

log.push('\n── 4. Multi-file tools — independent (no currentFile) ───────')
for (const id of LAYOUT['Multi-file']) {
  const s = src(id)
  if (!s) continue
  check(`${id.padEnd(22)}no currentFile dep`, !s.includes('currentFile'))
}

// ── 5. features/index.js imports ──────────────────────────────────────────

log.push('\n── 5. features/index.js imports ────────────────────────────')
const indexSrc = readFileSync('src/features/index.js', 'utf8')
for (const id of ALL_IDS) {
  check(`import ./${id}.js`, indexSrc.includes(`'./${id}.js'`))
}

// ── 6. Build ───────────────────────────────────────────────────────────────

log.push('\n── 6. Build ─────────────────────────────────────────────────')
try {
  execSync('node build.js', { stdio: 'pipe' })
  ok('build completes without error')

  const html = readFileSync('dist/folio.html', 'utf8')
  const pkg  = JSON.parse(readFileSync('package.json', 'utf8'))

  check('version stamp present',           html.includes(`v${pkg.version}`))
  check('no unreplaced {{VERSION}}',       !html.includes('{{VERSION}}'))
  check('PDF.js worker inlined',           html.includes('pdf.worker'))
  check('"Multi-file" in nav bundle',      html.includes('Multi-file'))
  check('sidebar-file-slot in bundle',     html.includes('sidebar-file-slot'))
  check('no workspace-bar in bundle',      !html.includes('workspace-bar'))
  check('viewer-bar in bundle',            html.includes('viewer-bar'))
  check('viewer-content in bundle',        html.includes('viewer-content'))
  check('viewer-thumbs in bundle',         html.includes('viewer-thumbs'))
} catch (e) {
  fail('build completes without error', e.stderr?.toString().slice(0, 120) ?? e.message)
}

// ── Summary ────────────────────────────────────────────────────────────────

log.forEach(l => console.log(l))
console.log(`\n${'─'.repeat(56)}`)
console.log(`  ${passed} passed    ${failed} failed`)
console.log(`${'─'.repeat(56)}\n`)
process.exit(failed > 0 ? 1 : 0)
