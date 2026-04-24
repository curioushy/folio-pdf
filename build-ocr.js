/**
 * Builds dist/Folio-OCR.html — a fully self-contained offline OCR tool.
 * All Tesseract WASM, traineddata, and PDF.js assets are inlined so the file
 * works from file:// with no server or companion files required.
 *
 * Size: ~25 MB.  Run: node build-ocr.js
 *
 * Inline strategy:
 *   tesseract.min.js / pdf-lib.min.js  → raw <script> blocks
 *   pdf.min.mjs / pdf.worker.min.mjs   → Blob URLs (created at runtime)
 *   Tesseract worker                   → combined Blob URL:
 *       [preamble: fetch + importScripts overrides with inline base64 data]
 *     + [tesseract-core-simd-lstm.wasm.js  ← runs before worker.min.js]
 *     + [worker.min.js]
 *   WASM binary + eng.traineddata.gz   → base64 in the preamble; served via
 *       the overridden self.fetch() inside the worker
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'

const OCR = 'folio-ocr'
const SRC = '../folio-ocr.html'
const OUT = 'dist/Folio-OCR.html'

if (!existsSync(OCR)) {
  console.log(`  build-ocr: ${OCR}/ not found — skipping`)
  process.exit(0)
}
if (!existsSync(SRC)) {
  console.log(`  build-ocr: ${SRC} not found — skipping`)
  process.exit(0)
}

const txt = p => readFileSync(p, 'utf8')
const b64 = p => readFileSync(p).toString('base64')

// Raw JS embedded as a <script> block: escape </script> so the HTML parser
// doesn't see it as the end of the element.  The JS runtime ignores \/.
const esc = s => s.replace(/<\/script>/gi, '<\\/script>')

// A value embedded as a JS string literal inside a <script> block.
// JSON.stringify handles all JS escaping; \u003c prevents the HTML parser
// from treating </script> inside the string as an end tag.
const jsStr = s => JSON.stringify(s).replace(/</g, '\\u003c')

// ── Auto-increment OCR patch version ─────────────────────────────────────────
const pkg = JSON.parse(txt('package.json'))
const [maj, min, pat] = (pkg['ocr-version'] || '1.4.0').split('.').map(Number)
pkg['ocr-version'] = `${maj}.${min}.${pat + 1}`
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
const OCR_VERSION = `v${pkg['ocr-version']}`

console.log(`\nBuilding Folio-OCR ${OCR_VERSION} (self-contained)…\n`)

const tesseractJs  = txt(`${OCR}/tesseract.min.js`)
const pdfLibJs     = txt(`${OCR}/pdf-lib.min.js`)
const pdfMainJs    = txt(`${OCR}/pdf.min.mjs`)
const pdfWorkerJs  = txt(`${OCR}/pdf.worker.min.mjs`)
const workerJs     = txt(`${OCR}/worker.min.js`)
const wasmCoreJs   = txt(`${OCR}/tesseract-core-simd-lstm.wasm.js`)

console.log('  Reading binary assets (large — may take a moment)…')
const wasmB64 = b64(`${OCR}/tesseract-core-simd-lstm.wasm`)
const langB64 = b64(`${OCR}/lang/eng.traineddata.gz`)
console.log(`  WASM binary:    ${(wasmB64.length * 3/4 / 1024 / 1024).toFixed(1)} MB`)
console.log(`  Traineddata:    ${(langB64.length * 3/4 / 1024 / 1024).toFixed(1)} MB`)

// ── Worker preamble ───────────────────────────────────────────────────────────
// Runs before worker.min.js. Overrides:
//   self.fetch()         — serves WASM binary and traineddata from inline bytes
//   self.importScripts() — suppresses requests for tesseract-core JS files
//                          (they're already concatenated below the preamble)
const preamble = `;(function(){
function _d(s){var b=atob(s),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
var _W=${JSON.stringify(wasmB64)};
var _L=${JSON.stringify(langB64)};
var _f=self.fetch&&self.fetch.bind(self);
self.fetch=function(u,o){
  var s=typeof u==='string'?u:(u&&(u.url||String(u)))||'';
  if(/tesseract-core.*\\.wasm$/.test(s))
    return Promise.resolve(new Response(_d(_W),{status:200,headers:{'Content-Type':'application/wasm'}}));
  if(/traineddata/.test(s))
    return Promise.resolve(new Response(_d(_L),{status:200,headers:{'Content-Type':'application/octet-stream'}}));
  return _f?_f(u,o):Promise.reject(new Error('fetch unavailable'));
};
var _i=self.importScripts&&self.importScripts.bind(self);
self.importScripts=function(){
  var a=[].filter.call(arguments,function(u){return !/tesseract-core/.test(u)});
  if(a.length&&_i)_i.apply(self,a);
};
})();
`

// Combined worker script executed by the Web Worker at runtime
const workerBlob = preamble + wasmCoreJs + '\n' + workerJs
console.log(`  Worker blob:    ${(workerBlob.length / 1024 / 1024).toFixed(1)} MB`)

// ── Module script bootstrap ───────────────────────────────────────────────────
// Replaces the two static lines at the top of <script type="module">:
//   import * as pdfjsLib from './folio-ocr/pdf.min.mjs'
//   pdfjsLib.GlobalWorkerOptions.workerSrc = './folio-ocr/pdf.worker.min.mjs'
//
// Top-level await is valid inside <script type="module"> in all modern browsers.
const bootstrap = `    // ── Inline-asset bootstrap ─────────────────────────────────────────
    const _pdfWkBlob = new Blob([${jsStr(pdfWorkerJs)}], {type:'application/javascript'})
    const _pdfWkUrl  = URL.createObjectURL(_pdfWkBlob)
    const _pdfMjBlob = new Blob([${jsStr(pdfMainJs)}],  {type:'application/javascript'})
    const _pdfMjUrl  = URL.createObjectURL(_pdfMjBlob)
    const _tWkBlob   = new Blob([${jsStr(workerBlob)}], {type:'application/javascript'})
    const _tWkUrl    = URL.createObjectURL(_tWkBlob)
    const pdfjsLib   = await import(_pdfMjUrl)
    pdfjsLib.GlobalWorkerOptions.workerSrc = _pdfWkUrl
`

// ── Transform source HTML ─────────────────────────────────────────────────────

let html = txt(SRC).replace(/\r\n/g, '\n')

// Version stamp + cross-link
html = html.replace('{{OCR_VERSION}}', OCR_VERSION)
html = html.replace('./folio.html', './Folio-PDF.html')

// Inline tesseract.min.js and pdf-lib.min.js
// NOTE: use replacer functions — replacement strings with $ are misinterpreted by String.replace
const inlinedScripts = `  <script>\n${esc(tesseractJs)}\n  </script>\n  <script>\n${esc(pdfLibJs)}\n  </script>`
html = html.replace(
  `  <script src="./folio-ocr/tesseract.min.js"></script>\n  <script src="./folio-ocr/pdf-lib.min.js"></script>`,
  () => inlinedScripts
)

// Replace static import + workerSrc assignment with the inline bootstrap
const moduleHeader = `  <script type="module">\n    import * as pdfjsLib from './folio-ocr/pdf.min.mjs'\n\n    pdfjsLib.GlobalWorkerOptions.workerSrc = './folio-ocr/pdf.worker.min.mjs'\n`
const moduleReplacement = `  <script type="module">\n${bootstrap}`
html = html.replace(moduleHeader, () => moduleReplacement)

// Repoint Tesseract worker options to Blob URLs / empty paths
html = html
  .replace("workerPath: './folio-ocr/worker.min.js',", 'workerPath: _tWkUrl,')
  .replace("corePath:   './folio-ocr/',",               "corePath:   '',")
  .replace("langPath:   './folio-ocr/lang/',",           "langPath:   '',")

writeFileSync(OUT, html)
const sizeMB = (readFileSync(OUT).length / 1024 / 1024).toFixed(1)
console.log(`\n  ✓ Built: ${OUT} (${sizeMB} MB total)\n`)
