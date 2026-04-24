/**
 * Local preview server for dist/folio.html.
 * Serves over HTTP so dynamic script loading (Tesseract WASM) works correctly.
 * Usage: node serve.js  →  http://localhost:4174
 */

import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { join, extname } from 'path'
import { exec } from 'child_process'

const PORT = 4174
const DIST = 'dist'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.wasm': 'application/wasm',
  '.gz':   'application/gzip',
  '.json': 'application/json',
  '.png':  'image/png',
  '.pdf':  'application/pdf',
}

createServer((req, res) => {
  const url  = req.url.split('?')[0]
  let   path = join(DIST, url === '/' ? 'index.html' : url)
  try {
    if (statSync(path).isDirectory()) path = join(path, 'index.html')
    const data = readFileSync(path)
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not found: ' + url)
  }
}).listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`
  console.log(`\n  Preview → ${url}\n  Ctrl+C to stop\n`)
  exec(`start ${url}`)
})
