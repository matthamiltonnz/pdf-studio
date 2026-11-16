/* PDF export with native annotations, optional flattening, and destructive redaction.
   Pages containing redactions are rasterised and rebuilt so the underlying
   text and objects are not present in the downloaded file. */
import {
  PDFDocument, PDFDict, PDFName, PDFString, StandardFonts, degrees, rgb, LineCapStyle,
} from 'pdf-lib';
import { annotationBounds, COMMENT_PAD } from './annotation.js';
import {
  pageContext, mapPoint, mapRect, colorOf, makeSanitizer, drawArrow, drawSignature,
  drawTextBlock, measurePdfText, finalizeDoc,
} from './pdf-ops.js';
import { clamp, hexToRgb01 } from './util.js';

const RECT_TYPES = new Set(['highlight', 'rect', 'mask', 'signature']);

/**
 * @param {Uint8Array} sourceBytes
 * @param {Object<number, Array>} annotationsByPage
 * @param {{flatten?: boolean, redactedPages?: Object, title?: string}} options
 */
export async function exportAnnotatedPdf(sourceBytes, annotationsByPage, options = {}) {
  const flatten = Boolean(options.flatten);
  const redactedPages = options.redactedPages || {};
  const title = options.title;
  if (Object.keys(redactedPages).length === 0) {
    return exportInPlace(sourceBytes, annotationsByPage, flatten, title);
  }
  return exportWithRedactions(sourceBytes, annotationsByPage, redactedPages, flatten, title);
}

async function exportInPlace(sourceBytes, annotationsByPage, flatten, title) {
  const doc = await PDFDocument.load(sourceBytes.slice(), { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sanitize = makeSanitizer(font);
  const imageCache = new Map();
  const pages = doc.getPages();
  ensureAcroFormFont(doc, font);

  for (let index = 0; index < pages.length; index += 1) {
    const annotations = annotationsByPage[index] || [];
    if (!annotations.length) continue;
    const page = pages[index];
    const ctx = pageContext(page);
    for (const ann of annotations) {
      if (ann.type === 'mask') {
        throw new Error('A redacted page was not rasterised. Please retry the export.');
      }
      if (flatten) {
        await drawAnnotationContent(doc, page, ann, ctx, font, sanitize, imageCache, 0, 0);
      } else {
        await addNativeAnnotation(doc, page, ann, ctx, font, sanitize, imageCache);
      }
    }
  }

  finalizeDoc(doc, title);
  return doc.save();
}

async function exportWithRedactions(sourceBytes, annotationsByPage, redactedPages, flatten, title) {
  const src = await PDFDocument.load(sourceBytes.slice(), { updateMetadata: false });
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const sanitize = makeSanitizer(font);
  const imageCache = new Map();
  ensureAcroFormFont(out, font);
  const pageCount = src.getPageCount();

  for (let index = 0; index < pageCount; index += 1) {
    const annotations = annotationsByPage[index] || [];
    const raster = redactedPages[index];
    if (raster) {
      const image = await out.embedJpg(raster.dataUrl);
      const page = out.addPage([raster.width, raster.height]);
      page.drawImage(image, { x: 0, y: 0, width: raster.width, height: raster.height });
      const ctx = pageContext(page);
      const masks = annotations.filter((ann) => ann.type === 'mask');
      const kept = annotations.filter((ann) => ann.type !== 'mask' && !masks.some((mask) => overlaps(ann, mask, raster.width, raster.height)));
      for (const ann of kept) {
        if (flatten) {
          await drawAnnotationContent(out, page, ann, ctx, font, sanitize, imageCache, 0, 0);
        } else {
          await addNativeAnnotation(out, page, ann, ctx, font, sanitize, imageCache);
        }
      }
    } else {
      if (annotations.some((ann) => ann.type === 'mask')) {
        throw new Error('A redacted page was not rasterised. Please retry the export.');
      }
      const [page] = await out.copyPages(src, [index]);
      out.addPage(page);
      const ctx = pageContext(page);
      for (const ann of annotations) {
        if (flatten) {
          await drawAnnotationContent(out, page, ann, ctx, font, sanitize, imageCache, 0, 0);
        } else {
          await addNativeAnnotation(out, page, ann, ctx, font, sanitize, imageCache);
        }
      }
    }
  }

  finalizeDoc(out, title);
  return out.save();
}
async function drawAnnotationContent(doc, page, ann, ctx, font, sanitize, cache, offsetX, offsetY) {
  const opacity = clamp(ann.opacity ?? 1, 0, 1);
  const color = colorOf(ann.color || '#111827');

  if (ann.type === 'highlight') {
    const rect = mapRect(ann.x, ann.y, ann.w, ann.h, ctx);
    page.drawRectangle({
      x: rect.x - offsetX,
      y: rect.y - offsetY,
      width: rect.width,
      height: rect.height,
      color,
      opacity,
    });
  } else if (ann.type === 'rect') {
    const rect = mapRect(ann.x, ann.y, ann.w, ann.h, ctx);
    page.drawRectangle({
      x: rect.x - offsetX,
      y: rect.y - offsetY,
      width: rect.width,
      height: rect.height,
      borderColor: color,
      borderWidth: Math.max(0.3, ann.width),
      opacity,
      borderOpacity: opacity,
    });
  } else if (ann.type === 'mask') {
    // Redactions are baked into a rasterised page, never drawn as annotations.
  } else if (ann.type === 'ink') {
    const points = ann.points || [];
    if (points.length === 1) {
      const point = mapPoint(points[0].x, points[0].y, ctx);
      page.drawCircle({
        x: point.x - offsetX,
        y: point.y - offsetY,
        size: Math.max(0.5, ann.width / 2),
        color,
        opacity,
      });
    }
    for (let i = 1; i < points.length; i += 1) {
      const start = mapPoint(points[i - 1].x, points[i - 1].y, ctx);
      const end = mapPoint(points[i].x, points[i].y, ctx);
      page.drawLine({
        start: { x: start.x - offsetX, y: start.y - offsetY },
        end: { x: end.x - offsetX, y: end.y - offsetY },
        thickness: Math.max(0.3, ann.width),
        color,
        opacity,
        lineCap: LineCapStyle.Round,
      });
    }
  } else if (ann.type === 'arrow') {
    drawArrow(page, ann, ctx, color, offsetX, offsetY);
  } else if (ann.type === 'text') {
    drawTextBlock(page, ann, ctx, font, sanitize, color, { opacity, offsetX, offsetY });
  } else if (ann.type === 'comment') {
    const fontSize = Math.max(2, ann.fontSize);
    const metrics = measurePdfText(font, sanitize(ann.text), fontSize);
    const boxW = metrics.width + COMMENT_PAD * 2;
    const boxH = metrics.height + COMMENT_PAD * 2;
    const rect = mapRect(ann.x, ann.y, boxW / ctx.Wd, boxH / ctx.Hd, ctx);
    page.drawRectangle({
      x: rect.x - offsetX,
      y: rect.y - offsetY,
      width: rect.width,
      height: rect.height,
      color: rgb(1, 0.965, 0.77),
      borderColor: color,
      borderWidth: 0.8,
      opacity,
      borderOpacity: opacity,
    });
    drawTextBlock(page, ann, ctx, font, sanitize, rgb(0.24, 0.22, 0.12), {
      padding: COMMENT_PAD,
      opacity,
      offsetX,
      offsetY,
    });
  } else if (ann.type === 'signature') {
    await drawSignature(doc, page, ann, ctx, cache, offsetX, offsetY);
  }
}
async function addNativeAnnotation(doc, page, ann, ctx, font, sanitize, cache) {
  if (ann.type === 'mask') return;
  let bounds;
  if (ann.type === 'text' || ann.type === 'comment') {
    const fontSize = Math.max(2, ann.fontSize);
    const metrics = measurePdfText(font, sanitize(ann.text), fontSize);
    const pad = ann.type === 'comment' ? COMMENT_PAD : 0;
    bounds = {
      x: ann.x,
      y: ann.y,
      w: (metrics.width + pad * 2) / ctx.Wd,
      h: (metrics.height + pad * 2) / ctx.Hd,
    };
    bounds = expandBounds(bounds, 1 / ctx.Wd, 1 / ctx.Hd);
  } else {
    bounds = annotationBounds(ann, ctx.Wd, ctx.Hd);
  }
  if (ann.type === 'rect') {
    const pad = Math.max(0.5, ann.width) / 2;
    bounds = expandBounds(bounds, pad / ctx.Wd, pad / ctx.Hd);
  }
  const rect = mapRect(bounds.x, bounds.y, bounds.w, bounds.h, ctx);
  if (rect.width < 0.5 || rect.height < 0.5) return;
  const apRef = await createAppearance(doc, ann, ctx, rect, font, sanitize, cache);
  const { red, green, blue } = hexToRgb01(ann.color || '#111827');
  const color = [red, green, blue];

  const dict = {
    Type: 'Annot',
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    F: 4,
    P: page.ref,
    T: PDFString.of('PDF Studio'),
    NM: PDFString.of(ann.id || `pdfstudio-${Date.now()}`),
    M: PDFString.of(pdfDate()),
    Contents: PDFString.of(annotationText(ann)),
  };
  if (apRef) dict.AP = { N: apRef };

  if (ann.type === 'highlight') {
    dict.Subtype = 'Highlight';
    dict.QuadPoints = quadPoints(bounds, ctx);
    dict.C = color;
    dict.CA = clamp(ann.opacity ?? 0.35, 0, 1);
  } else if (ann.type === 'rect') {
    dict.Subtype = 'Square';
    dict.C = color;
    dict.BS = { W: Math.max(0.5, ann.width), S: 'S' };
  } else if (ann.type === 'ink') {
    const points = (ann.points || []).map((point) => mapPoint(point.x, point.y, ctx));
    if (!points.length) return;
    const ink = points.length === 1 ? [points[0], points[0]] : points;
    dict.Subtype = 'Ink';
    dict.InkList = [ink.flatMap((point) => [point.x, point.y])];
    dict.C = color;
    dict.BS = { W: Math.max(0.5, ann.width), S: 'S' };
  } else if (ann.type === 'arrow') {
    const start = mapPoint(ann.x1, ann.y1, ctx);
    const end = mapPoint(ann.x2, ann.y2, ctx);
    dict.Subtype = 'Line';
    dict.L = [start.x, start.y, end.x, end.y];
    dict.LE = [PDFName.of('None'), PDFName.of('ClosedArrow')];
    dict.C = color;
    dict.BS = { W: Math.max(0.5, ann.width), S: 'S' };
  } else if (ann.type === 'text' || ann.type === 'comment') {
    dict.Subtype = 'FreeText';
    dict.DA = PDFString.of(`/Helv ${Math.max(2, ann.fontSize)} Tf ${red.toFixed(3)} ${green.toFixed(3)} ${blue.toFixed(3)} rg`);
    dict.Q = 0;
    dict.BS = { W: 0, S: 'S' };
    dict.Border = [0, 0, 0];
    if (ann.type === 'comment') dict.C = [1, 0.965, 0.77];
  } else if (ann.type === 'signature') {
    dict.Subtype = 'Stamp';
  } else {
    return;
  }

  const annotRef = doc.context.register(doc.context.obj(dict));
  page.node.addAnnot(annotRef);
}

async function createAppearance(doc, ann, ctx, rect, font, sanitize, cache) {
  const width = Math.max(0.5, rect.width);
  const height = Math.max(0.5, rect.height);
  const scratch = doc.addPage([width, height]);
  try {
    await drawAnnotationContent(doc, scratch, ann, ctx, font, sanitize, cache, rect.x, rect.y);
    const contents = scratch.node.Contents();
    const streamRef = contents && contents.get ? contents.get(0) : null;
    if (!streamRef) return null;
    const stream = doc.context.lookup(streamRef);
    stream.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
    stream.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
    stream.dict.set(PDFName.of('BBox'), doc.context.obj([0, 0, width, height]));
    const resources = scratch.node.Resources();
    if (resources) stream.dict.set(PDFName.of('Resources'), resources);
    return streamRef;
  } finally {
    try { doc.removePage(doc.getPageCount() - 1); } catch { /* ignore */ }
  }
}
function expandBounds(bounds, padX, padY) {
  return {
    x: bounds.x - padX,
    y: bounds.y - padY,
    w: bounds.w + padX * 2,
    h: bounds.h + padY * 2,
  };
}

function quadPoints(bounds, ctx) {
  const corners = [
    mapPoint(bounds.x, bounds.y, ctx),
    mapPoint(bounds.x + bounds.w, bounds.y, ctx),
    mapPoint(bounds.x + bounds.w, bounds.y + bounds.h, ctx),
    mapPoint(bounds.x, bounds.y + bounds.h, ctx),
  ];
  return corners.flatMap((point) => [point.x, point.y]);
}

function overlaps(a, b, width, height) {
  const A = annotationBounds(a, width, height);
  const B = annotationBounds(b, width, height);
  return A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y;
}

function annotationText(ann) {
  if (ann.type === 'text' || ann.type === 'comment') return String(ann.text || '');
  if (ann.type === 'highlight') return 'Highlight';
  if (ann.type === 'rect') return 'Rectangle';
  if (ann.type === 'ink') return 'Ink';
  if (ann.type === 'arrow') return 'Arrow';
  if (ann.type === 'signature') return 'Signature';
  return 'Annotation';
}

function pdfDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function ensureAcroFormFont(doc, font) {
  const catalog = doc.catalog;
  let acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) {
    acroForm = doc.context.obj({
      Fields: [],
      DA: PDFString.of('/Helv 0 Tf 0 g'),
    });
    catalog.set(PDFName.of('AcroForm'), doc.context.register(acroForm));
  }
  let dr = acroForm.lookupMaybe(PDFName.of('DR'), PDFDict);
  if (!dr) {
    dr = doc.context.obj({});
    acroForm.set(PDFName.of('DR'), dr);
  }
  let fonts = dr.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fonts) {
    fonts = doc.context.obj({});
    dr.set(PDFName.of('Font'), fonts);
  }
  fonts.set(PDFName.of('Helv'), font.ref);
}



