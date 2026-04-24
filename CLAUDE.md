# Folio PDF — Claude Context

## What this is
Browser-based PDF utility. Builds to a single self-contained HTML file (`dist/folio.html`) with no server required. All PDF work happens client-side via **pdf-lib** (editing) and **PDF.js** (rendering/preview).

## Commands
```bash
node build.js          # production build → dist/folio.html
node test.js           # static analysis + build test (should always be 174/174)
npm run dev            # vite dev server (hot-reload)
```

## Architecture

```
src/
  core/
    app.js             # shell: sidebar file slot, nav, viewer, boot
    registry.js        # registerFeature() + getFeatures() / getFeature()
    state.js           # tiny pub/sub store  { currentFile, activeFeature }
    pdf.js             # pdf-lib helpers: load, save, loadForRender
    renderer.js        # PDF.js helpers: loadForRender, renderPage
    fs.js              # readFile (→ ArrayBuffer), saveAs (download)
    ui.js              # toast, showProgress, hideProgress, promptPassword
  features/
    index.js           # imports every feature (order = nav order)
    *.js               # one file per feature
  styles/
    base.css           # layout, design tokens, all component styles
    components.css     # additional component styles
  index.html           # shell HTML (no inline content — all rendered by JS)
build.js               # esbuild bundler → inlines CSS + JS + PDF.js worker
test.js                # static analysis + build verification
```

## Feature pattern

Every feature is a single file that calls `registerFeature()`:

```js
import { registerFeature } from '../core/registry.js'
import { get }             from '../core/state.js'

registerFeature({
  id:          'my-feature',   // matches filename (my-feature.js)
  name:        'My Feature',   // display name in nav
  category:    'Pages',        // must match LAYOUT category exactly (see below)
  icon:        '📄',
  description: 'One-line tooltip',

  render(container) {
    const gf = get().currentFile   // ALWAYS check this first

    // No-file guard — required for all single-file features
    if (!gf) {
      container.innerHTML = `
        <div class="feature-header"><h2>My Feature</h2>...</div>
        <div class="no-file-nudge">
          <span class="no-file-icon">📄</span>
          <p>Open a PDF from the sidebar to get started.</p>
        </div>`
      return
    }

    // Feature HTML + logic here
    // Access file:  gf.file (File), gf.name (string), gf.pwd (string|null), gf.pageCount (number)
    // At apply time re-read: const cf = get().currentFile
  }
})
```

## Nav layout — categories and order

**Exact strings required** (test.js verifies every feature's `category` field):

```
Pages      → organise, split, crop, n-up, poster
Stamp      → watermark, header-footer
Protect    → password, unlock, sign, redact
Extract    → extract-text, extract-images, fill-forms, table-csv
Convert    → compress, flatten, pdf-to-images, repair, normalise-pages, strip-elements, grayscale, ocr
Tools      → bookmarks, dark-reader, metadata
Multi-file → merge, overlay, images-to-pdf, pdf-compare, batch
```

`Multi-file` features must stay last in `src/features/index.js`. Multi-file features must **not** reference `currentFile` — they manage their own file inputs.

## Global file state

`state.js` holds `{ currentFile, activeFeature }`.

```js
// Shape of currentFile (null when no file open)
{
  file:      File,     // original File object
  name:      string,   // file.name
  pwd:       string|null,
  pageCount: number,
}
```

When a file is opened/swapped via the sidebar slot, `app.js` subscriber re-renders the current feature (if one is active) so the no-file nudge is automatically replaced by the real feature UI.

## Password / encryption pattern

```js
import { readFile }         from '../core/fs.js'
import * as pdf             from '../core/pdf.js'
import { loadForRender }    from '../core/renderer.js'
import { promptPassword }   from '../core/ui.js'

// load for editing (pdf-lib)
let doc
try {
  doc = await pdf.load(bytes, cf.pwd || undefined)
} catch (err) {
  if (err.code !== 'ENCRYPTED') throw err
  const pwd = await promptPassword(cf.name)
  if (!pwd) return
  doc = await pdf.load(bytes, pwd)
}

// load for rendering (PDF.js) — same try/catch pattern
rDoc = await loadForRender(bytes, cf.pwd || undefined)
```

## PDF Viewer (app.js)

Lives in `showViewer()`. Module-level state:
- `viewerZoom` — percent; 100 = fit width. Steps: `[25,33,50,67,75,100,125,150,200,300,400]`
- `viewerMode` — `'single'` | `'thumbs'`
- `viewerPage` — current 1-based page
- `viewerAbort` — AbortController for keyboard/scroll/fullscreen listeners (abort on navigate-away)

Scale formula: `fitScale * (viewerZoom / 100)` where `fitScale = availW / viewport.width`.

Thumbnail keyboard nav: `←→` (±1), `↑↓` (±colCount), `Home/End`, `Enter/Space` (open in single). Column count derived from `getComputedStyle(grid).gridTemplateColumns`.

Fullscreen targets `.main-area` — sidebar naturally disappears. `fullscreenchange` → re-render after 80 ms.

## CSS design tokens (base.css)

```css
--blue           accent colour
--red            destructive / error
--text           primary text
--text-muted     secondary text
--text-subtle    very muted (labels, hints)
--bg             page background
--surface        card / panel background
--border         default border
--border-dark    stronger border
--radius         large radius (panels)
--radius-sm      small radius (inputs, buttons)
--shadow-lg      canvas drop shadow
--font           system font stack
--transition     standard transition duration
```

## Key CSS classes

| Class | Purpose |
|---|---|
| `.feature-header` | `<h2>` + `.feature-desc` block at top of every feature |
| `.no-file-nudge` | Centred dashed placeholder when no file open |
| `.panel` | White card with border, padding, border-radius |
| `.panel-header` | `.panel-title` + optional `.status-text` row |
| `.section-label` | ALL-CAPS small label above a group of controls |
| `.action-bar` | Bottom row with primary action button |
| `.feature-split` | Two-column equal-width panel layout |
| `.status-text` | Muted helper / status line |
| `.btn` `.btn-primary` `.btn-sm` `.btn-lg` | Button variants |
| `.viewer-bar` | Sticky top bar inside the PDF viewer |
| `.viewer-content` | Scrollable page / thumbnail area |
| `.viewer-thumbs` | CSS grid for thumbnail cells |
| `.viewer-thumb-focused` | Blue outline on keyboard-focused thumbnail |
| `.rd-toolbar` | Redact feature: compact toolbar above canvas |
| `.hf-zone-row` | Header-footer: 3-column zone grid (L/C/R) |
| `.token-pill` | Header-footer: clickable token insertion button |
| `.welcome-drop-zone` | Welcome screen: large PDF drop/open area |
| `.sfs-open-btn` | Sidebar file slot: "Open PDF" button |

## Sidebar file slot (app.js → renderFileSlot)

- Empty: shows `[📄 Open PDF]` button + "or drag & drop" hint
- Loaded: shows filename, page count, × close button; click name → back to viewer
- Drag-and-drop works directly onto the slot at all times

Welcome screen (`showWelcome`) also has a full-size drop zone in the main content area.

## test.js — what it checks

1. All 29 feature files exist  
2. Every feature's `category` field matches the LAYOUT table above  
3. All single-file features: import `get` from `state.js`, read `currentFile`, pass password through  
4. Multi-file features: do NOT reference `currentFile`  
5. `src/features/index.js` imports every feature  
6. `node build.js` succeeds and the output contains expected markers  

Run `node test.js` after any structural change. **Must stay at 174/174.**

## Version

`package.json` → `"version": "0.3.0"`. Build stamps it into the HTML via `{{VERSION}}`.
