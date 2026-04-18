/**
 * Build script — bundles the entire app into a single self-contained HTML file.
 * Output: dist/folio.html
 *
 * Run: node build.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import * as esbuild from 'esbuild'

// ── Auto-increment patch version ──────────────────────────────────────────────
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)
pkg.version = `${major}.${minor}.${patch + 1}`
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

const VERSION = pkg.version

async function build() {
  console.log(`\nBuilding Folio v${VERSION}...\n`)

  if (!existsSync('dist')) mkdirSync('dist')

  // ── 1. Read PDF.js worker source (inlined so dist file works fully offline) ─
  // The .mjs worker ends with `export{WorkerMessageHandler}` for ES-module usage,
  // but when we inline it as a blob URL PDF.js loads it as a classic worker script.
  // Firefox strictly rejects `export` in classic scripts; Chrome is lenient.
  // Stripping the export is safe — the worker already sets globalThis.pdfjsWorker
  // which is how PDF.js communicates with it in classic-script mode.
  const workerSrc = readFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'utf8')
    .replace(/;export\{[^}]+\};\s*$/, ';')
  console.log(`  PDF.js worker: ${(workerSrc.length / 1024).toFixed(1)} KB`)

  // ── 2. Bundle JS via esbuild ──────────────────────────────────────────────
  const result = await esbuild.build({
    entryPoints: ['src/core/app.js'],
    bundle: true,
    format: 'iife',
    write: false,
    minify: false,
    sourcemap: false,
    define: {
      'import.meta.env.DEV': 'false',
      '__APP_VERSION__':     JSON.stringify(VERSION),
      // Inlines the worker source so renderer.js can create a blob URL at runtime
      '__PDFJS_WORKER_SRC__': JSON.stringify(workerSrc),
    },
    // The else-branch in renderer.js uses import.meta.url for Vite dev only;
    // esbuild eliminates it as dead code — silence the harmless warning.
    logOverride: { 'empty-import-meta': 'silent' },
  })
  // Escape </script> sequences inside the bundle.
  // The PDF.js worker source (embedded as a string literal) contains "</script>"
  // which the browser's HTML parser treats as the end of the <script> block,
  // breaking the entire app. Replacing with "<\/script>" is transparent to the
  // JavaScript runtime (\/  === / inside strings) but invisible to the HTML parser.
  const appJs = result.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>')
  console.log(`  JS bundle: ${(appJs.length / 1024).toFixed(1)} KB`)

  // ── 2. Concatenate CSS ────────────────────────────────────────────────────
  const css = [
    readFileSync('src/styles/base.css', 'utf8'),
    readFileSync('src/styles/components.css', 'utf8'),
  ].join('\n')
  console.log(`  CSS: ${(css.length / 1024).toFixed(1)} KB`)

  // ── 3. Inline into HTML template ──────────────────────────────────────────
  let html = readFileSync('src/index.html', 'utf8')

  // Replace dev stylesheet links with inline styles
  // NOTE: use a replacer function (not a string) so that $ characters in the
  // CSS/JS content are never interpreted as replacement patterns ($&, $', etc.).
  html = html.replace(
    /<!-- STYLES:START -->[\s\S]*?<!-- STYLES:END -->/,
    () => `<style>\n${css}\n</style>`
  )

  // Replace dev module script with bundled IIFE
  html = html.replace(
    /<!-- APP:START -->[\s\S]*?<!-- APP:END -->/,
    () => `<script>\n${appJs}\n</script>`
  )

  // Stamp version
  html = html.replace(/\{\{VERSION\}\}/g, VERSION)

  // ── 4. Write output ───────────────────────────────────────────────────────
  const outPath = 'dist/folio.html'
  writeFileSync(outPath, html)
  writeFileSync('dist/index.html', html)   // Vercel serves this as site root
  const sizeKB = (readFileSync(outPath).length / 1024).toFixed(1)
  console.log(`\n  ✓ Built: ${outPath} (${sizeKB} KB total)\n`)
}

build().catch(err => {
  console.error('Build failed:', err.message)
  process.exit(1)
})
