/* PDF operations that touch the file itself: merge, page copying and flattening. */
import {
  PDFDocument, PDFDict, PDFName, PDFString, StandardFonts, degrees, rgb, LineCapStyle,
} from 'pdf-lib';
import PDFObjectCopier from 'pdf-lib/cjs/core/PDFObjectCopier';
import { LINE_HEIGHT } from './annotation.js';
import { clamp, hexToRgb01 } from './util.js';

const PDF_MAGIC = /%PDF-/;

function copyPageAnnotations(sourcePage, targetPage, sourceDoc, targetDoc) {
  const annots = sourcePage.node.Annots();
  if (!annots) return;
  try {
    const copier = PDFObjectCopier.for(sourceDoc.context, targetDoc.context);
    targetPage.node.set(PDFName.of('Annots'), copier.copy(annots));
  } catch {
    // Keep the page even if an unusual annotation object cannot be copied.
  }
}

export async function inspectPdf(bytes) {
  if (!PDF_MAGIC.test(new TextDecoder('latin1').decode(bytes.slice(0, 1024)))) {
    throw new Error('This file does not look like a valid PDF.');
  }
  const doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false });
  return { pageCount: doc.getPageCount() };
}

export function finalizeDoc(doc, title) {
  doc.setCreator('PDF Studio');
  doc.setProducer('PDF Studio (local, browser-based)');
  doc.setModificationDate(new Date());
  if (title && !doc.getTitle()) doc.setTitle(title);
}

export function normalizeRotation(angle) {
  const value = Number(angle) || 0;
  return ((value % 360) + 360) % 360;
}

export async function getPageRotations(bytes) {
  const doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false });
  return doc.getPages().map((page) => normalizeRotation(page.getRotation().angle));
}

export async function mergePdfBuffers(entries, title) {
  const out = await PDFDocument.create();
  for (const entry of entries) {
    const src = await PDFDocument.load(entry.bytes.slice(), { updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((page, index) => {
      copyPageAnnotations(src.getPage(index), page, src, out);
      out.addPage(page);
    });
  }
  finalizeDoc(out, title);
  return out.save();
}

export async function buildPdfFromPages(sourceBytes, pageRefs, title) {
  const src = await PDFDocument.load(sourceBytes.slice(), { updateMetadata: false });
  const out = await PDFDocument.create();
  const sourceIndices = pageRefs.map((ref) => ref.src);
  const copied = await out.copyPages(src, sourceIndices);
  copied.forEach((page, index) => {
    copyPageAnnotations(src.getPage(sourceIndices[index]), page, src, out);
    page.setRotation(degrees(normalizeRotation(pageRefs[index].rotation)));
    out.addPage(page);
  });
  finalizeDoc(out, title);
  return out.save();
}

/**
 * Build one PDF per group. Each group is an array of { src, rotation } refs into
 * the source document. The source is loaded once for efficiency.
 * @returns {Promise<Array<{bytes: Uint8Array}>>}
 */
export async function buildPdfGroups(sourceBytes, groups, titleBase) {
  const src = await PDFDocument.load(sourceBytes.slice(), { updateMetadata: false });
  const out = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const doc = await PDFDocument.create();
    const sourceIndices = group.map((ref) => ref.src);
    const copied = await doc.copyPages(src, sourceIndices);
    copied.forEach((page, i) => {
      copyPageAnnotations(src.getPage(sourceIndices[i]), page, src, doc);
      page.setRotation(degrees(normalizeRotation(group[i].rotation)));
      doc.addPage(page);
    });
    finalizeDoc(doc, titleBase ? `${titleBase} ${index + 1}` : undefined);
    out.push({ bytes: await doc.save() });
  }
  return out;
}

export function pageContext(page) {
  const box = page.getCropBox();
  const rotation = normalizeRotation(page.getRotation().angle);
  const displayWidth = rotation % 180 ? box.height : box.width;
  const displayHeight = rotation % 180 ? box.width : box.height;
  return { box, rotation, Wd: displayWidth, Hd: displayHeight };
}

export function mapPoint(nx, ny, ctx) {
  const { box, rotation, Wd, Hd } = ctx;
  const xd = nx * Wd;
  const yd = ny * Hd;
  if (rotation === 90) return { x: box.x + yd, y: box.y + xd };
  if (rotation === 180) return { x: box.x + box.width - xd, y: box.y + yd };
  if (rotation === 270) return { x: box.x + box.width - yd, y: box.y + box.height - xd };
  return { x: box.x + xd, y: box.y + box.height - yd };
}

export function mapRect(nx, ny, nw, nh, ctx) {
  const { box, rotation, Wd, Hd } = ctx;
  const xd = nx * Wd;
  const yd = ny * Hd;
  const wd = nw * Wd;
  const hd = nh * Hd;
  if (rotation === 90) {
    return { x: box.x + yd, y: box.y + xd, width: hd, height: wd };
  }
  if (rotation === 180) {
    return { x: box.x + box.width - (xd + wd), y: box.y + yd, width: wd, height: hd };
  }
  if (rotation === 270) {
    return { x: box.x + box.width - (yd + hd), y: box.y + box.height - (xd + wd), width: hd, height: wd };
  }
  return { x: box.x + xd, y: box.y + box.height - (yd + hd), width: wd, height: hd };
}

export function colorOf(hex) {
  const { red, green, blue } = hexToRgb01(hex);
  return rgb(red, green, blue);
}

export function makeSanitizer(font) {
  let supported = null;
  try {
    supported = new Set(font.getCharacterSet());
  } catch {
    supported = null;
  }
  return (text) => {
    const value = String(text ?? '');
    if (!supported) return value;
    let result = '';
    for (const char of value) {
      if (char === '\n' || char === '\r') { result += char; continue; }
      result += supported.has(char.codePointAt(0)) ? char : '?';
    }
    return result;
  };
}

export function drawArrow(page, ann, ctx, color, offsetX = 0, offsetY = 0) {
  const startPoint = mapPoint(ann.x1, ann.y1, ctx);
  const endPoint = mapPoint(ann.x2, ann.y2, ctx);
  const start = { x: startPoint.x - offsetX, y: startPoint.y - offsetY };
  const end = { x: endPoint.x - offsetX, y: endPoint.y - offsetY };
  const thickness = Math.max(0.5, ann.width);
  page.drawLine({ start, end, thickness, color, opacity: ann.opacity ?? 1, lineCap: LineCapStyle.Round });

  const x1 = ann.x1 * ctx.Wd;
  const y1 = ann.y1 * ctx.Hd;
  const x2 = ann.x2 * ctx.Wd;
  const y2 = ann.y2 * ctx.Hd;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(9, 5 + thickness * 3);
  for (const wing of [angle - Math.PI / 7, angle + Math.PI / 7]) {
    const wx = (x2 - head * Math.cos(wing)) / ctx.Wd;
    const wy = (y2 - head * Math.sin(wing)) / ctx.Hd;
    const wingPoint = mapPoint(wx, wy, ctx);
    page.drawLine({
      start: end,
      end: { x: wingPoint.x - offsetX, y: wingPoint.y - offsetY },
      thickness,
      color,
      opacity: ann.opacity ?? 1,
      lineCap: LineCapStyle.Round,
    });
  }
}

export async function drawSignature(doc, page, ann, ctx, cache, offsetX = 0, offsetY = 0) {
  if (!ann.src) return;
  let image = cache.get(ann.src);
  if (!image) {
    image = await doc.embedPng(ann.src);
    cache.set(ann.src, image);
  }
  const anchorPoint = mapPoint(ann.x, ann.y + ann.h, ctx);
  page.drawImage(image, {
    x: anchorPoint.x - offsetX,
    y: anchorPoint.y - offsetY,
    width: ann.w * ctx.Wd,
    height: ann.h * ctx.Hd,
    rotate: degrees(ctx.rotation),
    opacity: clamp(ann.opacity ?? 1, 0, 1),
  });
}

export function drawTextBlock(page, ann, ctx, font, sanitize, color, options = {}) {
  const fontSize = Math.max(2, ann.fontSize);
  const lineHeight = fontSize * LINE_HEIGHT;
  const pad = options.padding || 0;
  const offsetX = options.offsetX || 0;
  const offsetY = options.offsetY || 0;
  const lines = String(ann.text ?? '').split('\n');
  lines.forEach((line, i) => {
    const topY = ann.y + pad / ctx.Hd + (i * lineHeight) / ctx.Hd;
    const baselineY = topY + (fontSize * 0.8) / ctx.Hd;
    const point = mapPoint(ann.x + pad / ctx.Wd, baselineY, ctx);
    const text = sanitize(line);
    if (!text) return;
    page.drawText(text, {
      x: point.x - offsetX,
      y: point.y - offsetY,
      size: fontSize,
      font,
      color,
      rotate: degrees(ctx.rotation),
      opacity: options.opacity ?? 1,
    });
  });
}
export function measurePdfText(font, text, size) {
  const lines = String(text ?? '').split('\n');
  let width = 0;
  for (const line of lines) width = Math.max(width, font.widthOfTextAtSize(line || ' ', size));
  return { lines, width, height: Math.max(1, lines.length) * size * LINE_HEIGHT };
}


