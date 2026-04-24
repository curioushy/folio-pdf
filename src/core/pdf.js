/**
 * pdf-lib wrapper — the only place pdf-lib is imported.
 * Features call these helpers, never pdf-lib directly.
 * If pdf-lib's API changes, only this file needs updating.
 *
 * NOTE — why @cantoo/pdf-lib instead of upstream pdf-lib:
 *   pdf-lib v1.17.1 declares `userPassword`/`ownerPassword`/`permissions` save
 *   options but never implements encryption (output has no /Encrypt dict).
 *   @cantoo/pdf-lib is a drop-in API-compatible fork that properly implements
 *   standard PDF encryption. Import shape and all methods we use are identical.
 *   (Decryption is still done in renderer.js via PDF.js — neither pdf-lib fork
 *   implements decryption of existing encrypted PDFs.)
 */

import {
  PDFDocument,
  EncryptedPDFError,
  PDFName,
  PDFNumber,
  PDFString,
  PDFArray,
  PDFNull,
  PDFBool,
  PDFRawStream,
  ViewerPreferences,
  rgb,
  degrees,
  StandardFonts,
  grayscale,
} from '@cantoo/pdf-lib'

// ── Loading ───────────────────────────────────────────────────────────────────

/**
 * Load a PDF from an ArrayBuffer.
 *
 * Error codes thrown:
 *   'ENCRYPTED'      — PDF is encrypted and no password was supplied
 *   'WRONG_PASSWORD' — a password was supplied but rejected
 *
 * @param {ArrayBuffer} bytes
 * @param {string|null} [password]
 * @returns {Promise<PDFDocument>}
 */
export async function load(bytes, password = null) {
  const opts = { ignoreEncryption: false }
  if (password) opts.password = password

  try {
    return await PDFDocument.load(bytes, opts)
  } catch (err) {
    if (err instanceof EncryptedPDFError) {
      throw Object.assign(new Error('PDF requires a password.'), { code: 'ENCRYPTED' })
    }
    // @cantoo/pdf-lib throws various messages when password is wrong
    // (invalid key, bad padding, etc). If we provided a password and load failed,
    // treat it as a wrong-password error.
    if (password) {
      throw Object.assign(
        new Error('Wrong password or unsupported encryption type.'),
        { code: 'WRONG_PASSWORD', cause: err }
      )
    }
    throw err
  }
}

// ── Saving ────────────────────────────────────────────────────────────────────

/**
 * Serialize a PDFDocument to Uint8Array.
 * @param {PDFDocument} doc
 * @param {object} [saveOpts] — passed directly to doc.save()
 * @returns {Promise<Uint8Array>}
 */
export async function save(doc, saveOpts = {}) {
  return doc.save(saveOpts)
}

// ── Page info ─────────────────────────────────────────────────────────────────

export function getPageCount(doc)        { return doc.getPageCount() }
export function getPageIndices(doc)      { return doc.getPageIndices() }

// ── Merge ─────────────────────────────────────────────────────────────────────

/**
 * Merge multiple PDFDocuments into one.
 * @param {PDFDocument[]} docs
 * @returns {Promise<PDFDocument>}
 */
export async function merge(docs) {
  const out = await PDFDocument.create()
  for (const doc of docs) {
    const indices = doc.getPageIndices()
    const copied  = await out.copyPages(doc, indices)
    copied.forEach(p => out.addPage(p))
  }
  return out
}

/**
 * Merge specific page ranges from multiple sources.
 * @param {Array<{doc: PDFDocument, pages: number[]}>} sources
 *   pages is 0-based indices
 * @returns {Promise<PDFDocument>}
 */
export async function mergePages(sources) {
  const out = await PDFDocument.create()
  for (const { doc, pages } of sources) {
    const copied = await out.copyPages(doc, pages)
    copied.forEach(p => out.addPage(p))
  }
  return out
}

// ── Split ─────────────────────────────────────────────────────────────────────

/**
 * Extract specific pages (0-based) from a document into a new document.
 * @param {PDFDocument} doc
 * @param {number[]} pageIndices 0-based
 * @returns {Promise<PDFDocument>}
 */
export async function extractPages(doc, pageIndices) {
  const out    = await PDFDocument.create()
  const copied = await out.copyPages(doc, pageIndices)
  copied.forEach(p => out.addPage(p))
  return out
}

// ── Rotate ────────────────────────────────────────────────────────────────────

/**
 * Rotate specific pages (or all) in-place.
 * @param {PDFDocument} doc
 * @param {number[]} pageIndices 0-based
 * @param {90|180|270} angle clockwise degrees to add
 */
export function rotatePages(doc, pageIndices, angle) {
  pageIndices.forEach(i => {
    const page    = doc.getPage(i)
    const current = page.getRotation().angle
    page.setRotation(degrees((current + angle) % 360))
  })
}

// ── Delete pages ──────────────────────────────────────────────────────────────

/**
 * Remove pages (0-based) from a document.
 * pdf-lib doesn't have a direct removePage; we copy the rest.
 * @param {PDFDocument} doc
 * @param {number[]} indicesToRemove
 * @returns {Promise<PDFDocument>}
 */
export async function deletePages(doc, indicesToRemove) {
  const toRemove = new Set(indicesToRemove)
  const keep     = doc.getPageIndices().filter(i => !toRemove.has(i))
  return extractPages(doc, keep)
}

// ── Reorder ───────────────────────────────────────────────────────────────────

/**
 * Reorder pages according to newOrder (array of original 0-based indices).
 * @param {PDFDocument} doc
 * @param {number[]} newOrder
 * @returns {Promise<PDFDocument>}
 */
export async function reorderPages(doc, newOrder) {
  return extractPages(doc, newOrder)
}

// ── Protect / Encrypt ─────────────────────────────────────────────────────────

/**
 * Save a document with password protection.
 *
 * API note: @cantoo/pdf-lib uses doc.encrypt(opts) BEFORE save(), not as a
 * save option. Permissions use booleans (except printing which is
 * 'highResolution' | 'lowResolution' | false).
 *
 * @param {PDFDocument} doc
 * @param {{ userPassword?:string, ownerPassword?:string, permissions?:object }} opts
 * @returns {Promise<Uint8Array>}
 */
export async function protect(doc, { userPassword, ownerPassword, permissions = {} } = {}) {
  const secOpts = {}
  if (userPassword)  secOpts.userPassword  = userPassword
  if (ownerPassword) secOpts.ownerPassword = ownerPassword

  secOpts.permissions = {
    // printing: false disables printing entirely; 'highResolution' allows full-quality print
    printing:             permissions.printing ? 'highResolution' : false,
    modifying:            Boolean(permissions.modifying),
    copying:              Boolean(permissions.copying),
    annotating:           permissions.annotating  !== false,
    fillingForms:         permissions.fillingForms !== false,
    contentAccessibility: true,
    documentAssembly:     Boolean(permissions.documentAssembly),
  }

  doc.encrypt(secOpts)
  return doc.save()
}

// ── Outline / Bookmarks ───────────────────────────────────────────────────────

/**
 * Write a flat (one-level) PDF outline into the document catalog.
 * Each entry becomes a top-level clickable bookmark jumping to a specific page.
 *
 * Must be called AFTER all pages are added — pageIndex is into the final doc.
 *
 * @param {PDFDocument} doc
 * @param {Array<{title: string, pageIndex: number}>} entries  0-based pageIndex
 */
export function setOutline(doc, entries) {
  if (!entries.length) return

  const context     = doc.context
  const pages       = doc.getPages()
  const itemRefs    = entries.map(() => context.nextRef())
  const outlinesRef = context.nextRef()

  entries.forEach((entry, i) => {
    const page = pages[entry.pageIndex]
    if (!page) return

    // Destination: [pageRef /XYZ null null null] → scroll to top of page
    const dest = PDFArray.withContext(context)
    dest.push(page.ref)
    dest.push(PDFName.of('XYZ'))
    dest.push(PDFNull)
    dest.push(PDFNull)
    dest.push(PDFNull)

    const item = context.obj({
      Title:  PDFString.of(entry.title),
      Parent: outlinesRef,
      Dest:   dest,
    })
    if (i > 0)                   item.set(PDFName.of('Prev'), itemRefs[i - 1])
    if (i < entries.length - 1)  item.set(PDFName.of('Next'), itemRefs[i + 1])
    context.assign(itemRefs[i], item)
  })

  const outlines = context.obj({
    Type:  PDFName.of('Outlines'),
    First: itemRefs[0],
    Last:  itemRefs[itemRefs.length - 1],
    Count: entries.length,
  })
  context.assign(outlinesRef, outlines)
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef)
}

// ── Watermark ─────────────────────────────────────────────────────────────────

/**
 * Add a text watermark to pages.
 *
 * @param {PDFDocument} doc
 * @param {string} text
 * @param {{
 *   opacity?:    number,          // 0–1, default 0.15
 *   fontSize?:   number,          // pt, default 60
 *   color?:      [r,g,b],         // 0–1 each, default mid-grey
 *   position?:   'diagonal'|'center'|'top'|'bottom',
 *   pageIndices?: number[]|null,  // 0-based; null = all pages
 * }} [opts]
 */
export async function addTextWatermark(doc, text, {
  opacity      = 0.15,
  fontSize     = 60,
  color        = [0.6, 0.6, 0.6],
  position     = 'diagonal',
  pageIndices  = null,
} = {}) {
  const font     = await doc.embedFont(StandardFonts.HelveticaBold)
  const allPages = doc.getPages()
  const targets  = pageIndices
    ? pageIndices.map(i => allPages[i]).filter(Boolean)
    : allPages
  const [r, g, b] = color

  const COS45 = Math.SQRT1_2   // cos(45°) = sin(45°) = 1/√2

  for (const page of targets) {
    const { width, height } = page.getSize()
    const textWidth = font.widthOfTextAtSize(text, fontSize)

    let x, y, rot

    if (position === 'diagonal') {
      // Centre of text (in text-local coords: textWidth/2, fontSize/2) must
      // map to page centre under 45° CCW rotation.
      // Solving: x = cx - (tw/2·cos - fs/2·sin)   y = cy - (tw/2·sin + fs/2·cos)
      x   = width  / 2 - (textWidth / 2 - fontSize / 2) * COS45
      y   = height / 2 - (textWidth / 2 + fontSize / 2) * COS45
      rot = degrees(45)
    } else if (position === 'top') {
      x   = (width - textWidth) / 2
      y   = height - fontSize - 24
      rot = degrees(0)
    } else if (position === 'bottom') {
      x   = (width - textWidth) / 2
      y   = 18
      rot = degrees(0)
    } else {                 // 'center'
      x   = (width  - textWidth) / 2
      y   = (height - fontSize)  / 2
      rot = degrees(0)
    }

    page.drawText(text, {
      x, y,
      size:   fontSize,
      font,
      color:  rgb(r, g, b),
      opacity,
      rotate: rot,
    })
  }
}

// ── Metadata ──────────────────────────────────────────────────────────────────

/**
 * Read document metadata.
 * @param {PDFDocument} doc
 */
export function getMetadata(doc) {
  return {
    title:    doc.getTitle()    ?? '',
    author:   doc.getAuthor()   ?? '',
    subject:  doc.getSubject()  ?? '',
    keywords: doc.getKeywords() ?? '',
    creator:  doc.getCreator()  ?? '',
    producer: doc.getProducer() ?? '',
    created:  doc.getCreationDate()?.toISOString() ?? '',
    modified: doc.getModificationDate()?.toISOString() ?? '',
    pages:    doc.getPageCount(),
  }
}

/**
 * Write document metadata.
 * @param {PDFDocument} doc
 * @param {{
 *   title?:string, author?:string, subject?:string,
 *   keywords?:string, creator?:string, language?:string,
 *   creationDate?:Date|null
 * }} meta
 */
export function setMetadata(doc, meta) {
  if (meta.title        !== undefined) doc.setTitle(meta.title)
  if (meta.author       !== undefined) doc.setAuthor(meta.author)
  if (meta.subject      !== undefined) doc.setSubject(meta.subject)
  if (meta.keywords     !== undefined) doc.setKeywords(meta.keywords ? [meta.keywords] : [])
  if (meta.creator      !== undefined) doc.setCreator(meta.creator)
  if (meta.language     !== undefined) doc.setLanguage(meta.language)
  if (meta.creationDate !== undefined && meta.creationDate instanceof Date) {
    doc.setCreationDate(meta.creationDate)
  }
}

/**
 * Read viewer/display settings from the document catalog.
 * @param {PDFDocument} doc
 * @returns {{ pageLayout:string, pageMode:string, displayDocTitle:boolean,
 *             fitWindow:boolean, centerWindow:boolean, hideToolbar:boolean, hideMenubar:boolean }}
 */
export function getViewerSettings(doc) {
  const catalog = doc.catalog

  // PDFName.toString() returns '/SinglePage' — strip the leading slash
  const getName = key => {
    const v = catalog.get(PDFName.of(key))
    return v ? v.toString().replace(/^\//, '') : ''
  }

  const vpRef  = catalog.get(PDFName.of('ViewerPreferences'))
  const vpDict = vpRef ? doc.context.lookup(vpRef) : null

  const getBool = key => {
    const v = vpDict?.get(PDFName.of(key))
    return v ? v.toString() === 'true' : false
  }

  return {
    pageLayout:      getName('PageLayout')  || 'SinglePage',
    pageMode:        getName('PageMode')    || 'UseNone',
    displayDocTitle: getBool('DisplayDocTitle'),
    fitWindow:       getBool('FitWindow'),
    centerWindow:    getBool('CenterWindow'),
    hideToolbar:     getBool('HideToolbar'),
    hideMenubar:     getBool('HideMenubar'),
  }
}

/**
 * Write viewer/display settings into the document catalog.
 * @param {PDFDocument} doc
 * @param {{ pageLayout?:string, pageMode?:string, displayDocTitle?:boolean,
 *           fitWindow?:boolean, centerWindow?:boolean,
 *           hideToolbar?:boolean, hideMenubar?:boolean }} settings
 */
export function setViewerSettings(doc, settings) {
  if (settings.pageLayout) {
    doc.catalog.set(PDFName.of('PageLayout'), PDFName.of(settings.pageLayout))
  }
  if (settings.pageMode) {
    doc.catalog.set(PDFName.of('PageMode'), PDFName.of(settings.pageMode))
  }

  const BOOL_KEYS = {
    displayDocTitle: 'DisplayDocTitle',
    fitWindow:       'FitWindow',
    centerWindow:    'CenterWindow',
    hideToolbar:     'HideToolbar',
    hideMenubar:     'HideMenubar',
  }
  const hasBool = Object.keys(BOOL_KEYS).some(k => settings[k] !== undefined)
  if (!hasBool) return

  // Get or create the ViewerPreferences dict
  let vpRef  = doc.catalog.get(PDFName.of('ViewerPreferences'))
  let vpDict = vpRef ? doc.context.lookup(vpRef) : null
  if (!vpDict) {
    const vp = ViewerPreferences.create(doc.context)
    vpRef    = doc.context.register(vp.dict)
    vpDict   = vp.dict
    doc.catalog.set(PDFName.of('ViewerPreferences'), vpRef)
  }

  Object.entries(BOOL_KEYS).forEach(([jsKey, pdfKey]) => {
    if (settings[jsKey] !== undefined) {
      vpDict.set(PDFName.of(pdfKey), settings[jsKey] ? PDFBool.True : PDFBool.False)
    }
  })
}

// ── Image Watermark ───────────────────────────────────────────────────────────

/**
 * Stamp an image (logo/stamp) onto pages as a watermark.
 *
 * @param {PDFDocument} doc
 * @param {ArrayBuffer} imageBytes
 * @param {'jpeg'|'png'} imageType
 * @param {{
 *   opacity?:     number,           // 0–1, default 0.25
 *   scale?:       number,           // fraction of page width, default 0.35
 *   position?:    'center'|'diagonal'|'top'|'bottom',
 *   pageIndices?: number[]|null,    // 0-based; null = all pages
 * }} [opts]
 */
export async function addImageWatermark(doc, imageBytes, imageType, {
  opacity     = 0.25,
  scale       = 0.35,
  position    = 'center',
  pageIndices = null,
} = {}) {
  const embedded = imageType === 'jpeg'
    ? await doc.embedJpg(imageBytes)
    : await doc.embedPng(imageBytes)

  const allPages = doc.getPages()
  const targets  = pageIndices
    ? pageIndices.map(i => allPages[i]).filter(Boolean)
    : allPages

  const COS45 = Math.SQRT1_2
  const SIN45 = Math.SQRT1_2

  for (const page of targets) {
    const { width, height } = page.getSize()

    // Scale image to target width; maintain aspect ratio
    const imgW = width * scale
    const imgH = imgW * (embedded.height / embedded.width)

    let x, y, rot

    if (position === 'diagonal') {
      // Offset so the image centre lands at the page centre after 45° CCW rotation
      x   = width  / 2 - (imgW / 2) * COS45 + (imgH / 2) * SIN45
      y   = height / 2 - (imgW / 2) * SIN45 - (imgH / 2) * COS45
      rot = degrees(45)
    } else if (position === 'top') {
      x   = (width  - imgW) / 2
      y   = height  - imgH - 24
      rot = degrees(0)
    } else if (position === 'bottom') {
      x   = (width  - imgW) / 2
      y   = 24
      rot = degrees(0)
    } else {   // 'center'
      x   = (width  - imgW) / 2
      y   = (height - imgH) / 2
      rot = degrees(0)
    }

    page.drawImage(embedded, { x, y, width: imgW, height: imgH, opacity, rotate: rot })
  }
}

// ── Page Numbers ─────────────────────────────────────────────────────────────

/**
 * Stamp page numbers (or any per-page text) onto a document.
 *
 * @param {PDFDocument} doc
 * @param {{
 *   format?:      string,    // template: {n} = page number, {total} = total pages
 *   position?:    string,    // 'bottom-center'|'bottom-left'|'bottom-right'|'top-center'|'top-left'|'top-right'
 *   fontSize?:    number,    // pt, default 10
 *   color?:       [r,g,b],   // 0–1 each, default dark-grey
 *   margin?:      number,    // pt from edge, default 28
 *   startAt?:     number,    // first number to stamp, default 1
 *   skipPages?:   number[],  // 0-based indices to leave unnumbered (e.g. [0] for cover)
 *   pageIndices?: number[]|null, // 0-based subset; null = all pages
 * }} [opts]
 */
export async function addPageNumbers(doc, {
  format      = '{n}',
  position    = 'bottom-center',
  fontSize    = 10,
  color       = [0.2, 0.2, 0.2],
  margin      = 28,
  startAt     = 1,
  skipPages   = [],
  pageIndices = null,
} = {}) {
  const font     = await doc.embedFont(StandardFonts.Helvetica)
  const allPages = doc.getPages()
  const total    = allPages.length
  const skipSet  = new Set(skipPages)

  const targets = pageIndices
    ? pageIndices.map(i => ({ page: allPages[i], pageIdx: i })).filter(t => t.page)
    : allPages.map((page, i) => ({ page, pageIdx: i }))

  const [vSide, hSide] = position.split('-')   // e.g. 'bottom', 'center'
  const [r, g, b]      = color
  let counter = startAt

  for (const { page, pageIdx } of targets) {
    if (skipSet.has(pageIdx)) continue   // leave unnumbered; don't advance counter

    const text      = format
      .replace(/\{n\}/g,     String(counter))
      .replace(/\{total\}/g, String(total))
    const { width, height } = page.getSize()
    const textWidth = font.widthOfTextAtSize(text, fontSize)

    let x, y
    if      (hSide === 'left')  x = margin
    else if (hSide === 'right') x = width - textWidth - margin
    else                        x = (width - textWidth) / 2   // center

    if (vSide === 'top')  y = height - margin - fontSize
    else                  y = margin                           // bottom

    page.drawText(text, { x, y, size: fontSize, font, color: rgb(r, g, b) })
    counter++
  }
}

// ── Surgical image compression ───────────────────────────────────────────────

/**
 * Walk every indirect object, find /XObject /Subtype /Image streams whose filter
 * is a single /DCTDecode (plain JPEG), decode → downsample via canvas → re-encode
 * as JPEG → swap the stream in place. Text, vectors, links, annotations untouched.
 *
 * Scope (v1, deliberately narrow):
 *   - /Filter /DCTDecode only (single filter). Flate/LZW pixel streams skipped.
 *   - /ColorSpace /DeviceRGB, /BitsPerComponent 8. CMYK/gray/ICC skipped.
 *   - No SMask / Mask. Alpha-masked images skipped (dimensions must match mask).
 *   - Tiny images (< 200px on both sides) skipped — no savings to be had.
 *   - If re-encoded JPEG is not smaller than the original, the image is left alone.
 *
 * @param {PDFDocument} doc
 * @param {{ maxPixels?: number, quality?: number, onProgress?: (n, total) => void }} [opts]
 * @returns {Promise<{ scanned: number, compressed: number, savedBytes: number }>}
 */
export async function compressImages(doc, {
  maxPixels  = 1800,
  quality    = 0.75,
  onProgress = null,
} = {}) {
  const ctx        = doc.context
  const candidates = []

  const NAME_Type    = PDFName.of('Type')
  const NAME_Subtype = PDFName.of('Subtype')
  const NAME_Filter  = PDFName.of('Filter')
  const NAME_SMask   = PDFName.of('SMask')
  const NAME_Mask    = PDFName.of('Mask')
  const NAME_BPC     = PDFName.of('BitsPerComponent')
  const NAME_CS      = PDFName.of('ColorSpace')
  const NAME_W       = PDFName.of('Width')
  const NAME_H       = PDFName.of('Height')
  const NAME_XObject = PDFName.of('XObject')
  const NAME_Image   = PDFName.of('Image')
  const NAME_DCT     = PDFName.of('DCTDecode')
  const NAME_RGB     = PDFName.of('DeviceRGB')

  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const dict = obj.dict

    if (dict.get(NAME_Subtype) !== NAME_Image)                             continue
    const t = dict.get(NAME_Type)
    if (t && t !== NAME_XObject)                                           continue

    const filter = dict.get(NAME_Filter)
    if (!(filter instanceof PDFName) || filter !== NAME_DCT)               continue

    if (dict.has(NAME_SMask) || dict.has(NAME_Mask))                       continue

    const bpc = dict.get(NAME_BPC)
    if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8)               continue

    let cs = dict.get(NAME_CS)
    if (cs && !(cs instanceof PDFName)) cs = ctx.lookup(cs)
    if (!(cs instanceof PDFName) || cs !== NAME_RGB)                       continue

    const wObj = dict.get(NAME_W), hObj = dict.get(NAME_H)
    if (!(wObj instanceof PDFNumber) || !(hObj instanceof PDFNumber))      continue
    const w = wObj.asNumber(), h = hObj.asNumber()
    if (Math.max(w, h) < 200)                                              continue

    candidates.push({ stream: obj, dict, w, h })
  }

  let compressed = 0
  let savedBytes = 0

  for (let i = 0; i < candidates.length; i++) {
    onProgress?.(i, candidates.length)
    const { stream, dict } = candidates[i]
    const orig = stream.getContents()

    let bitmap
    try {
      bitmap = await createImageBitmap(new Blob([orig], { type: 'image/jpeg' }))
    } catch { continue }

    const maxDim = Math.max(bitmap.width, bitmap.height)
    const scale  = maxDim > maxPixels ? maxPixels / maxDim : 1
    const newW   = Math.max(1, Math.round(bitmap.width  * scale))
    const newH   = Math.max(1, Math.round(bitmap.height * scale))

    const canvas  = document.createElement('canvas')
    canvas.width  = newW
    canvas.height = newH
    canvas.getContext('2d').drawImage(bitmap, 0, 0, newW, newH)
    bitmap.close?.()

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality))
    if (!blob) continue
    const next = new Uint8Array(await blob.arrayBuffer())
    if (next.length >= orig.length) continue

    stream.updateContents(next)
    dict.set(NAME_W, PDFNumber.of(newW))
    dict.set(NAME_H, PDFNumber.of(newH))

    savedBytes += orig.length - next.length
    compressed++
  }

  onProgress?.(candidates.length, candidates.length)
  return { scanned: candidates.length, compressed, savedBytes }
}

// ── Images → PDF ──────────────────────────────────────────────────────────────

/**
 * Create a PDF from an array of image Files (JPG / PNG).
 * Each image becomes one full page.
 * @param {File[]} imageFiles
 * @returns {Promise<PDFDocument>}
 */
export async function imagesToPdf(imageFiles) {
  const doc = await PDFDocument.create()

  for (const file of imageFiles) {
    const bytes    = await file.arrayBuffer()
    const isJpeg   = file.type === 'image/jpeg' || file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg')
    const embedded = isJpeg
      ? await doc.embedJpg(bytes)
      : await doc.embedPng(bytes)

    const page = doc.addPage([embedded.width, embedded.height])
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height })
  }

  return doc
}
