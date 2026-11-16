/* PDF operations that touch the file itself: merge, page copying and flattening. */
import { PDFDocument, StandardFonts, degrees, rgb, LineCapStyle } from 'pdf-lib';
import { LINE_HEIGHT, COMMENT_PAD } from './annotation.js';
import { clamp, hexToRgb01 } from './util.js';

const PDF_MAGIC = /%PDF-/;

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
    for (const page of pages) out.addPage(page);
  }
  finalizeDoc(out, title);
  return out.save();
}

export async function buildPdfFromPages(sourceBytes, pageRefs, title) {
  const src = await PDFDocument.load(sourceBytes.slice(), { updateMetadata: false });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageRefs.map((ref) => ref.src));
  copied.forEach((page, index) => {
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
    const copied = await doc.copyPages(src, group.map((ref) => ref.src));
    copied.forEach((page, i) => {
      page.setRotation(degrees(normalizeRotation(group[i].rotation)));
      doc.addPage(page);
    });
    finalizeDoc(doc, titleBase ? `${titleBase} ${index + 1}` : undefined);
    out.push({ bytes: await doc.save() });
  }
  return out;
}

function pageContext(page) {
  const box = page.getCropBox();
  const rotation = normalizeRotation(page.getRotation().angle);
  const displayWidth = rotation % 180 ? box.height : box.width;
  const displayHeight = rotation % 180 ? box.width : box.height;
  return { box, rotation, Wd: displayWidth, Hd: displayHeight };
}

function mapPoint(nx, ny, ctx) {
  const { box, rotation, Wd, Hd } = ctx;
  const xd = nx * Wd;
  const yd = ny * Hd;
  if (rotation === 90) return { x: box.x + yd, y: box.y + xd };
  if (rotation === 180) return { x: box.x + box.width - xd, y: box.y + yd };
  if (rotation === 270) return { x: box.x + box.width - yd, y: box.y + box.height - xd };
  return { x: box.x + xd, y: box.y + box.height - yd };
}

function mapRect(nx, ny, nw, nh, ctx) {
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

function colorOf(hex) {
  const { red, green, blue } = hexToRgb01(hex);
  return rgb(red, green, blue);
}

function makeSanitizer(font) {
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

function drawArrow(page, ann, ctx, color) {
  const start = mapPoint(ann.x1, ann.y1, ctx);
  const end = mapPoint(ann.x2, ann.y2, ctx);
  const thickness = Math.max(0.5, ann.width);
  page.drawLine({ start, end, thickness, color, opacity: ann.opacity ?? 1, lineCap: LineCapStyle.Round });

  const x1 = ann.x1 * ctx.Wd;
  const y1 = ann.y1 * ctx.Hd;
  const x2 = ann.x2 * ctx.Wd;
  const y2 = ann.y2 * ctx.Hd;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(9, 5 + thickness * 3);
  const wings = [angle - Math.PI / 7, angle + Math.PI / 7];
  for (const wing of wings) {
    const wx = (x2 - head * Math.cos(wing)) / ctx.Wd;
    const wy = (y2 - head * Math.sin(wing)) / ctx.Hd;
    page.drawLine({
      start: end,
      end: mapPoint(wx, wy, ctx),
      thickness,
      color,
      opacity: ann.opacity ?? 1,
      lineCap: LineCapStyle.Round,
    });
  }
}

async function drawSignature(doc, page, ann, ctx, cache) {
  if (!ann.src) return;
  let image = cache.get(ann.src);
  if (!image) {
    image = await doc.embedPng(ann.src);
    cache.set(ann.src, image);
  }
  const anchor = mapPoint(ann.x, ann.y + ann.h, ctx);
  page.drawImage(image, {
    x: anchor.x,
    y: anchor.y,
    width: ann.w * ctx.Wd,
    height: ann.h * ctx.Hd,
    rotate: degrees(ctx.rotation),
    opacity: clamp(ann.opacity ?? 1, 0, 1),
  });
}

function drawTextBlock(page, ann, ctx, font, sanitize, color, options = {}) {
  const fontSize = Math.max(2, ann.fontSize);
  const lineHeight = fontSize * LINE_HEIGHT;
  const pad = options.padding || 0;
  const lines = String(ann.text ?? '').split('\n');
  lines.forEach((line, i) => {
    const topY = ann.y + pad / ctx.Hd + (i * lineHeight) / ctx.Hd;
    const baselineY = topY + (fontSize * 0.8) / ctx.Hd;
    const point = mapPoint(ann.x + pad / ctx.Wd, baselineY, ctx);
    const text = sanitize(line);
    if (!text) return;
    page.drawText(text, {
      x: point.x,
      y: point.y,
      size: fontSize,
      font,
      color,
      rotate: degrees(ctx.rotation),
      opacity: options.opacity ?? 1,
    });
  });
}
/**
 * Draw annotations into a copy of the PDF and return the saved bytes.
 * Existing page content, links and form fields are left untouched.
 */
export async function flattenAnnotations(sourceBytes, annotationsByPage, title) {
  const doc = await PDFDocument.load(sourceBytes.slice(), { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sanitize = makeSanitizer(font);
  const imageCache = new Map();
  const pages = doc.getPages();

  for (let index = 0; index < pages.length; index += 1) {
    const annotations = annotationsByPage[index];
    if (!annotations || !annotations.length) continue;
    const page = pages[index];
    const ctx = pageContext(page);

    for (const ann of annotations) {
      const opacity = clamp(ann.opacity ?? 1, 0, 1);
      const color = colorOf(ann.color || '#111827');

      if (ann.type === 'highlight') {
        const rect = mapRect(ann.x, ann.y, ann.w, ann.h, ctx);
        page.drawRectangle({ ...rect, color, opacity });
      } else if (ann.type === 'rect') {
        const rect = mapRect(ann.x, ann.y, ann.w, ann.h, ctx);
        page.drawRectangle({
          ...rect,
          borderColor: color,
          borderWidth: Math.max(0.3, ann.width),
          opacity,
          borderOpacity: opacity,
        });
      } else if (ann.type === 'mask') {
        const rect = mapRect(ann.x, ann.y, ann.w, ann.h, ctx);
        page.drawRectangle({ ...rect, color: colorOf(ann.color || '#111827'), opacity: 1 });
      } else if (ann.type === 'ink') {
        const points = ann.points || [];
        if (points.length === 1) {
          const point = mapPoint(points[0].x, points[0].y, ctx);
          page.drawCircle({ x: point.x, y: point.y, size: Math.max(0.5, ann.width / 2), color, opacity });
        }
        for (let i = 1; i < points.length; i += 1) {
          page.drawLine({
            start: mapPoint(points[i - 1].x, points[i - 1].y, ctx),
            end: mapPoint(points[i].x, points[i].y, ctx),
            thickness: Math.max(0.3, ann.width),
            color,
            opacity,
            lineCap: LineCapStyle.Round,
          });
        }
      } else if (ann.type === 'arrow') {
        drawArrow(page, ann, ctx, color);
      } else if (ann.type === 'text') {
        drawTextBlock(page, ann, ctx, font, sanitize, color, { opacity });
      } else if (ann.type === 'comment') {
        const metrics = measurePdfText(font, sanitize(ann.text), Math.max(2, ann.fontSize));
        const boxW = metrics.width + COMMENT_PAD * 2;
        const boxH = metrics.height + COMMENT_PAD * 2;
        const rect = mapRect(ann.x, ann.y, boxW / ctx.Wd, boxH / ctx.Hd, ctx);
        page.drawRectangle({
          ...rect,
          color: rgb(1, 0.965, 0.77),
          borderColor: color,
          borderWidth: 0.8,
          opacity,
          borderOpacity: opacity,
        });
        drawTextBlock(page, ann, ctx, font, sanitize, rgb(0.24, 0.22, 0.12), { padding: COMMENT_PAD, opacity });
      } else if (ann.type === 'signature') {
        await drawSignature(doc, page, ann, ctx, imageCache);
      }
    }
  }

  finalizeDoc(doc, title);
  return doc.save();
}

function measurePdfText(font, text, size) {
  const lines = String(text ?? '').split('\n');
  let width = 0;
  for (const line of lines) width = Math.max(width, font.widthOfTextAtSize(line || ' ', size));
  return { lines, width, height: Math.max(1, lines.length) * size * LINE_HEIGHT };
}


