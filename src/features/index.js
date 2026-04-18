/**
 * Feature registry entrypoint.
 * Import this file once (from app.js) to register all features.
 * Import order controls the nav category sequence:
 *   Pages → Stamp → Protect → Extract → Convert → Tools → Multi-file
 *
 * IMPORTANT: Multi-file imports must stay at the very end so that category
 * appears last in the sidebar nav.
 */

// ── Pages ──────────────────────────────────────────────────────────────────
import './organise.js'
import './split.js'
import './crop.js'
import './n-up.js'
import './poster.js'
import './page-labels.js'

// ── Stamp ──────────────────────────────────────────────────────────────────
// Bates numbering is now the "#Bates" tab inside watermark.js
// Page numbers are now handled by header-footer.js via {page} token
import './watermark.js'
import './header-footer.js'

// ── Protect ────────────────────────────────────────────────────────────────
import './password.js'
import './unlock.js'
import './sign.js'
import './redact.js'

// ── Extract ────────────────────────────────────────────────────────────────
import './extract-text.js'
import './extract-images.js'
import './fill-forms.js'
import './table-csv.js'
import './extract-annotations.js'

// ── Convert ────────────────────────────────────────────────────────────────
import './compress.js'
import './flatten.js'
import './pdf-to-images.js'
import './repair.js'
import './normalise-pages.js'
import './strip-elements.js'
import './grayscale.js'

// ── Tools ──────────────────────────────────────────────────────────────────
import './bookmarks.js'
import './dark-reader.js'
import './metadata.js'
import './doc-stats.js'
import './search.js'

// ── Multi-file ─────────────────────────────────────────────────────────────
import './merge.js'
import './overlay.js'
import './images-to-pdf.js'
import './pdf-compare.js'
import './batch.js'
