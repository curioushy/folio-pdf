import { defineConfig }           from 'vite'
import { readFileSync, existsSync } from 'fs'
import { extname, resolve }       from 'path'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8'))

export default defineConfig({
  root: 'src',
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    {
      name: 'folio-html-version',
      transformIndexHtml: html => html.replace(/\{\{VERSION\}\}/g, version),
    },
    {
      // Dev only: serve ../folio-ocr.html and its asset folder so the sidebar
      // "Folio OCR" link works without a production build.
      name: 'folio-ocr-dev-proxy',
      configureServer(server) {
        const MIME = {
          '.html': 'text/html; charset=utf-8',
          '.js':   'application/javascript',
          '.mjs':  'application/javascript',
          '.css':  'text/css',
          '.wasm': 'application/wasm',
          '.gz':   'application/gzip',
          '.json': 'application/json',
          '.png':  'image/png',
          '.traineddata': 'application/octet-stream',
        }
        server.middlewares.use((req, res, next) => {
          const url = req.url.split('?')[0]
          let path
          if (url === '/Folio-OCR.html' || url === '/folio-ocr.html') {
            path = resolve('../folio-ocr.html')
          } else if (url.startsWith('/folio-ocr/')) {
            path = resolve('..' + url)
          } else {
            return next()
          }
          if (!existsSync(path)) return next()
          res.setHeader('Content-Type', MIME[extname(path)] ?? 'application/octet-stream')
          res.end(readFileSync(path))
        })
      },
    },
  ],
})
